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

/**
 * Nøkkelen for målets lås: (domene, mål) UTEN tenant (fiks-runde 2, review A NY-3). Home Assistant og bil er GLOBALE fysiske enheter per API-instans, så to tenanter som styrer SAMME lås (eller samme bil) må serialiseres - en lås per
 * tenant ville latt `lock` fra den ene og `unlock` fra den andre nå utstyret samtidig. (Journalen og ledgeren forblir tenant-skopet: de er per-tenant bevis, ikke en lås.)
 */
export const personalTargetLockKey = (domain: string, target: string): string => `personal-action:${domain}:${target}`;

/**
 * Målets lås er PROSESS-LOKAL og holder INGEN databaseforbindelse (fiks-runde 2, review A NY-1 HIGH). Forrige versjon tok en `pg_try_advisory_lock` på en egen forbindelse fra den DELTE poolen (max 10, ingen timeout) og holdt den HELE
 * handlingen, mens journal/ledger/revisjon/varsel trengte flere forbindelser fra samme pool: N samtidige handlinger mot ulike mål = dødlås (idle 0, waiting N), og kommandoer som allerede var sendt til HA sto fast uten ferdigstilling
 * og uten eier-varsel til prosessen ble startet på nytt. En lås som ikke holder noen ressurs mens den venter KAN IKKE dødlåse: `holdTarget` er ikke-blokkerende (opptatt = avvist umiddelbart, FØR noe sendes), holder kun en rad i et `Set`
 * (ingen forbindelse, ingen kø), og slippes alltid (`finally`) - også når handlingen kaster. Etter at kommandoen er sendt trenger journal/ledger/varsel derfor aldri å vente på handlingens egne låser.
 *
 * Begrensning (ærlig, `DEFERRED`): låsen gjelder innen ÉN API-prosess - slik systemet kjøres (de kritiske handlingene registreres kun i API-prosessen). Kjørte flere API-instanser mot samme utstyr, trengtes en delt lås (egen liten lås-pool med
 * tidsavbrudd, eller en lease via journalen); journalens idempotensnøkkel og gatewayens ledger hindrer uansett at SAMME forespørsel utføres to ganger.
 */
const heldTargets = new Set<string>();

function holdTarget(key: string): (() => void) | null {
  if (heldTargets.has(key)) return null;
  heldTargets.add(key);
  return () => { heldTargets.delete(key); };
}

/** Antall mål som akkurat nå har en handling i flukt i denne prosessen (diagnostikk og tester: etter en ferdig/feilet handling skal det ikke ligge igjen noen lås). */
export const personalTargetLocksHeld = (): number => heldTargets.size;

export async function executePersonalAction(deps: PersonalActionExecutorDeps, identity: IdentityContext, input: ExecutePersonalActionInput): Promise<ExecutePersonalActionResult> {
  const entry = deps.index.get(`${String(input.domain)}.${String(input.action)}`);
  if (!entry) throw new Error(`personal_action_unknown_action:${String(input.action).slice(0, 60)}`);
  if (!deps.gateway.get(entry.toolId, entry.op.action)) throw new Error("personal_action_tool_not_registered");
  if (typeof input.idempotency_key !== "string" || !KEY.test(input.idempotency_key)) throw new Error("personal_action_idempotency_key_invalid");
  const target = String(input.parameters[entry.op.targetParam] ?? "").slice(0, 200);
  if (target.length === 0) throw new Error("personal_action_target_missing");
  const release = holdTarget(personalTargetLockKey(entry.domain, target));
  if (release === null) throw new Error("personal_action_target_busy");
  try {
    return await executeLocked(deps, identity, input, entry, target);
  } finally {
    release();
  }
}

/** Hvor lenge en `requested`-rad regnes som «underveis» hos en vinner (lengste gateway-frist er ca. 2 min; samme 5 min som gatewayens avstemming av `reserved`). Eldre = krasjet vinner. */
const IN_FLIGHT_GRACE_MS = 5 * 60_000;

const storedOutcome = (row: PersonalActionRow): PersonalActionOutcome => (row.status === "applied" ? "SUCCESS" : row.status === "failed" ? "FAILED" : "UNKNOWN");

async function executeLocked(deps: PersonalActionExecutorDeps, identity: IdentityContext, input: ExecutePersonalActionInput, entry: PersonalActionIndexEntry, target: string): Promise<ExecutePersonalActionResult> {
  const tenantId = identity.tenant_id;
  const space = identity.memory_space_id as MemorySpace;

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

  // Varslingsstatus fra klasse D-kjeden (også for MISMATCH/UKJENT, der resultatet ikke bærer den): lagres i journalen slik at et varsel som feilet ETTER handlingen ikke går tapt (fiks-runde review A LOW-8).
  let notification: { notified: boolean; error: string | null } | undefined;
  const result = await deps.gateway.execute({
    identity, tool_id: entry.toolId, action: entry.op.action, parameters: input.parameters, idempotency_key: input.idempotency_key,
    ...(input.task_id !== undefined ? { task_id: input.task_id } : {}), ...(input.trace_id !== undefined ? { trace_id: input.trace_id } : {}),
    onClassDNotification: (status) => { notification = status; }
  });
  const ledger = await readLedger(deps.pool, tenantId, input.idempotency_key);
  const classified = classify(result, ledger);
  const reason = result.ok ? null : result.reason;

  // En samtidig forespørsel med SAMME nøkkel (taperen): det er den som eier raden som ferdigstiller den. Er raden allerede terminal, gjelder det lagrede utfallet; er vinneren fortsatt underveis (`requested`) og svaret
  // bare sier «pågår/ukjent», skriver taperen INGENTING (vinneren ferdigstiller) - aldri et databaseunntak og aldri en for tidlig `outcome_unknown` på en rad som snart blir `applied` (review A LOW-5).
  if (!begun.created) {
    const current = (await deps.journal.findByKey(tenantId, space, input.idempotency_key)) ?? begun.row;
    if (current.status === "applied" || current.status === "failed") return { action: current, outcome: storedOutcome(current), reason: current.failure_code, replayed: true };
    // En `requested`-rad eldre enn gracen er en krasjet vinner (ikke «underveis»): den går videre og settes `outcome_unknown` som før.
    if (current.status === "requested" && classified.status === "outcome_unknown" && Date.now() - new Date(current.requested_at).getTime() < IN_FLIGHT_GRACE_MS) {
      return { action: current, outcome: "UNKNOWN", reason, replayed: true };
    }
  }
  // En avvisning FØR utstyret nedgraderer aldri en rad som kan ha vært utført (replay-lærdommen): raden står uendret og svaret er UKJENT.
  if (!begun.created && begun.row.status === "outcome_unknown" && classified.status === "failed") {
    return { action: begun.row, outcome: "UNKNOWN", reason, replayed: true };
  }
  const row = await deps.journal.complete(tenantId, space, begun.row.action_id, {
    status: classified.status, failure_code: reason === null ? null : safeCode(reason),
    ...(ledger?.before !== undefined && ledger?.before !== null ? { before_state: ledger.before } : {}), ...(ledger?.after !== undefined && ledger?.after !== null ? { after_state: ledger.after } : {}),
    external_id: (result.ok ? result.external_id : undefined) ?? ledger?.external_id ?? null,
    ...(notification !== undefined ? { notified: notification.notified, notify_error: notification.error } : {})
  });
  // Raden var allerede terminal (en annen forespørsel ferdigstilte den mellom vår lesing og skrivingen): det lagrede utfallet gjelder.
  if (row.status !== classified.status && (row.status === "applied" || row.status === "failed")) return { action: row, outcome: storedOutcome(row), reason: row.failure_code, replayed: true };
  return { action: row, outcome: classified.outcome, reason, replayed: !begun.created };
}
