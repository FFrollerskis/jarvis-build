import type pg from "pg";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import { isUnknownOutcomeReason, type ToolGateway } from "../gateway.ts";
import { PersonalActionJournal, actionRequestDigest, type ActionDomain, type ActionSource, type ActionStatus, type PersonalActionRow } from "./action-journal.ts";
import type { CriticalOpSpec, Params } from "./critical-ops.ts";

/**
 * WP-G2 (D-464, UA-8): EKSEKUTOREN for eier-initierte kritiske fysiske handlinger (hjem/bil). Selve utførelsen går UTELUKKENDE via `ToolGateway.execute()` (policy, mål-autorisasjon, step-up, klasse D-kjeden med
 * idempotens/preflight/ventetid/readback/varsling, frys, kill switch) - denne funksjonen dupliserer INGEN sjekk og har INGEN direkte transport-vei (samme modell som `executeGrowthWrite`, WP-D3).
 * Den legger til Jarvis' EGEN kanoniske journal (`personal_action_journal`): forespørselens digest, FØR-/ETTER-tilstand fra gatewayens ledger, utfall og proveniens.
 *
 * UTFALL (feil sluttilstand vises UMIDDELBART - aldri en fabrikkert suksess):
 *  - `SUCCESS`  gatewayen verifiserte etterbetingelsen (readback viste den ønskede sluttilstanden). Journal `applied`.
 *  - `MISMATCH` kommandoen ble akseptert, men readback viste en ANNEN sluttilstand (jammed, fortsatt «closing», feil modus). Journal `outcome_unknown` (kode `postcondition_mismatch`): utstyret kan fortsatt være i bevegelse.
 *  - `UNKNOWN`  utfallet er uavklart (tidsavbrudd, `outcome_unknown:*`, uleselig readback, krasj midt i kallet). Journal `outcome_unknown`; en ny kommando med SAMME nøkkel utføres ALDRI.
 *  - `FAILED`   avvist FØR utstyret (mål ikke tillatt, step-up mangler, ugyldig før-tilstand, varsler ikke klar, frys, kill switch) eller avvist av utstyret/leverandøren uten bivirkning. Journal `failed`.
 * REPLAY (review-lærdom fra D3, N1): en avvisning fra en port FØR utstyret nedgraderer ALDRI en rad som kan ha vært utført (`outcome_unknown`, eller en ledger-rad som ikke er `failed`) - den forblir åpen og svaret er UKJENT.
 * Én nøkkel = ÉN forespørsel: samme nøkkel + annen forespørsel = `personal_action_idempotency_conflict`; samme nøkkel brukt av en annen verktøy-handling i ledgeren = `personal_action_idempotency_key_collision`.
 */
export type PersonalActionOutcome = "SUCCESS" | "MISMATCH" | "UNKNOWN" | "FAILED";

export interface PersonalActionIndexEntry {
  domain: ActionDomain;
  toolId: string;
  op: CriticalOpSpec;
}

/** Oppslag `domene.handling` -> (verktøy, handling). Eksekutoren avviser alt som ikke står her (aldri en vilkårlig verktøy-/handlingsstreng fra klienten). */
export function personalActionIndex(entries: ReadonlyArray<PersonalActionIndexEntry>): ReadonlyMap<string, PersonalActionIndexEntry> {
  return new Map(entries.map((e) => [`${e.domain}.${e.op.action}`, e] as const));
}

export interface PersonalActionExecutorDeps {
  pool: pg.Pool;
  gateway: Pick<ToolGateway, "execute" | "get">;
  journal: PersonalActionJournal;
  index: ReadonlyMap<string, PersonalActionIndexEntry>;
}

export interface ExecutePersonalActionInput {
  domain: string;
  action: string;
  parameters: Params;
  idempotency_key: string;
  source?: ActionSource;
  task_id?: string;
  session_id?: string;
  trace_id?: string;
}

export interface ExecutePersonalActionResult {
  action: PersonalActionRow;
  outcome: PersonalActionOutcome;
  reason: string | null;
  replayed: boolean;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

interface LedgerRow { tool_id: string; action: string; status: string; before: JsonValue | null; after: JsonValue | null; external_id: string | null }

async function readLedger(pool: pg.Pool, tenantId: string, key: string): Promise<LedgerRow | null> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const { rows } = await client.query(`SELECT tool_id, action, status, before_state, after_state, external_id FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key]);
    const row = rows[0] as { tool_id: string; action: string; status: string; before_state: JsonValue | null; after_state: JsonValue | null; external_id: string | null } | undefined;
    return row ? { tool_id: row.tool_id, action: row.action, status: row.status, before: row.before_state, after: row.after_state, external_id: row.external_id } : null;
  });
}

const safeCode = (reason: string): string => reason.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 160);

interface Classified { status: Exclude<ActionStatus, "requested">; outcome: PersonalActionOutcome }

function classify(result: { ok: true } | { ok: false; reason: string }, ledger: LedgerRow | null): Classified {
  if (result.ok) return { status: "applied", outcome: "SUCCESS" };
  const reason = result.reason;
  if (reason === "postcondition_mismatch") return { status: "outcome_unknown", outcome: "MISMATCH" };
  // Leverandøren/utstyret KAN ha utført kommandoen: ledgeren har en rad som ikke er `failed`, eller årsaken sier ukjent/uverifisert.
  const mayHaveActed = ledger !== null && ledger.status !== "failed";
  if (reason.startsWith("postcondition_") || isUnknownOutcomeReason(reason) || mayHaveActed) return { status: "outcome_unknown", outcome: "UNKNOWN" };
  return { status: "failed", outcome: "FAILED" };
}

export async function executePersonalAction(deps: PersonalActionExecutorDeps, identity: IdentityContext, input: ExecutePersonalActionInput): Promise<ExecutePersonalActionResult> {
  const entry = deps.index.get(`${String(input.domain)}.${String(input.action)}`);
  if (!entry) throw new Error(`personal_action_unknown_action:${String(input.action).slice(0, 60)}`);
  if (!deps.gateway.get(entry.toolId, entry.op.action)) throw new Error("personal_action_tool_not_registered");
  if (typeof input.idempotency_key !== "string" || !KEY.test(input.idempotency_key)) throw new Error("personal_action_idempotency_key_invalid");
  const tenantId = identity.tenant_id;
  const space = identity.memory_space_id as MemorySpace;
  const target = String(input.parameters[entry.op.targetParam] ?? "").slice(0, 200);
  if (target.length === 0) throw new Error("personal_action_target_missing");

  const begun = await deps.journal.begin(tenantId, space, {
    domain: entry.domain, tool_id: entry.toolId, action: entry.op.action, risk_class: "D", risk_direction: entry.op.direction(input.parameters), target_ref: target,
    idempotency_key: input.idempotency_key, request_digest: actionRequestDigest(entry.domain, entry.op.action, input.parameters), actor_person_id: identity.person_id, source: input.source ?? "owner_route",
    ...(input.task_id !== undefined ? { task_id: input.task_id } : {}), session_id: input.session_id ?? identity.session_id, ...(input.trace_id !== undefined ? { trace_id: input.trace_id } : {})
  });
  if (!begun.created && (begun.row.status === "applied" || begun.row.status === "failed")) {
    return { action: begun.row, outcome: begun.row.status === "applied" ? "SUCCESS" : "FAILED", reason: begun.row.failure_code, replayed: true };
  }

  // ToolGateway-ledgeren er nøklet på (tenant, nøkkel) ALENE: en annen verktøy-handling (eller et gatewaykall utenfor journalen) kan ha brukt nøkkelen, og gatewayen ville da svart «deduplisert» med en annen handlings resultat.
  const priorLedger = await readLedger(deps.pool, tenantId, input.idempotency_key);
  if (priorLedger !== null && (priorLedger.tool_id !== entry.toolId || priorLedger.action !== entry.op.action)) {
    const failed = begun.created ? await deps.journal.complete(tenantId, space, begun.row.action_id, { status: "failed", failure_code: "idempotency_key_collision" }) : begun.row;
    return { action: failed, outcome: "FAILED", reason: "personal_action_idempotency_key_collision", replayed: !begun.created };
  }

  const result = await deps.gateway.execute({
    identity, tool_id: entry.toolId, action: entry.op.action, parameters: input.parameters, idempotency_key: input.idempotency_key,
    ...(input.task_id !== undefined ? { task_id: input.task_id } : {}), ...(input.trace_id !== undefined ? { trace_id: input.trace_id } : {})
  });
  const ledger = await readLedger(deps.pool, tenantId, input.idempotency_key);
  const classified = classify(result, ledger);
  const reason = result.ok ? null : result.reason;

  // En avvisning FØR utstyret nedgraderer aldri en rad som kan ha vært utført (replay-lærdommen): raden står uendret og svaret er UKJENT.
  if (!begun.created && begun.row.status === "outcome_unknown" && classified.status === "failed") {
    return { action: begun.row, outcome: "UNKNOWN", reason, replayed: true };
  }
  const row = await deps.journal.complete(tenantId, space, begun.row.action_id, {
    status: classified.status, failure_code: reason === null ? null : safeCode(reason),
    ...(ledger?.before !== undefined && ledger?.before !== null ? { before_state: ledger.before } : {}), ...(ledger?.after !== undefined && ledger?.after !== null ? { after_state: ledger.after } : {}),
    external_id: (result.ok ? result.external_id : undefined) ?? ledger?.external_id ?? null
  });
  return { action: row, outcome: classified.outcome, reason, replayed: !begun.created };
}
