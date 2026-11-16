import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { isUnknownOutcomeReason, type ToolGateway } from "@jarvis/tool-gateway";
import type { CampaignChannel } from "../types.ts";
import type { GrowthProvider } from "./config.ts";
import { GrowthWriteJournal, writeRequestDigest, type GrowthWriteRow, type JournalSpendEffect, type WriteSource } from "./journal.ts";
import type { OpSpec, ProviderToolSpec } from "./tool-factory.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): EKSEKUTOREN for eier-initierte skrivinger mot annonse-/analyseplattformene. Selve utførelsen går UTELUKKENDE via `ToolGateway.execute()` (policy, mål-autorisasjon, step-up,
 * klasse D-kjeden med idempotens/preflight/readback/varsling, frys, kill switch) - denne funksjonen dupliserer INGEN sjekk og har INGEN direkte transport-vei (samme modell som `executeCloudMutation`, WP-E1).
 * Den legger til Jarvis' EGEN kanoniske journal (`growth_write_journal`): forespørselens digest, FØR-/ETTER-tilstand fra gatewayens ledger, utfall, tidslinjehendelse på kampanjen og - kun med bevis -
 * `executed` på en utførelses-kommando (D-87/migrasjon 114). Utfall: `applied` bare når gatewayen verifiserte etterbetingelsen; «utfall ukjent» og «mutasjonen skjedde men verifiseringen feilet» blir
 * `outcome_unknown` (aldri en fabrikkert suksess); alt annet er `failed`. Én nøkkel = ÉN forespørsel: samme nøkkel + annen forespørsel = `growth_write_idempotency_conflict`.
 */
type Params = Record<string, JsonValue>;
export type GrowthWriteOutcome = "SUCCESS" | "NOOP" | "UNKNOWN" | "PARTIAL" | "FAILED";

export interface GrowthWriteExecutorDeps {
  pool: pg.Pool;
  gateway: Pick<ToolGateway, "execute" | "get">;
  journal: GrowthWriteJournal;
  index: ReadonlyMap<string, { spec: ProviderToolSpec; op: OpSpec }>;
  /** Slår opp en Growth-kampanje på (kanal, ekstern id) for tidslinje og kommando-binding. Valgfri. */
  findCampaign?: (tenantId: string, memorySpace: MemorySpace, channel: CampaignChannel, externalCampaignId: string) => Promise<{ campaign_id: string } | null>;
}

export interface ExecuteGrowthWriteInput {
  provider: string;
  action: string;
  parameters: Params;
  idempotency_key: string;
  command_id?: string;
  experiment_id?: string;
  variant_id?: string;
  source?: WriteSource;
  task_id?: string;
  session_id?: string;
  trace_id?: string;
}

export interface ExecuteGrowthWriteResult {
  write: GrowthWriteRow;
  outcome: GrowthWriteOutcome;
  reason: string | null;
  replayed: boolean;
  command_status: "executed" | "execution_unknown" | null;
}

/** Budsjett-parameteren i handlinger som kan binde en `reduce_budget`-kommando (kampanjenivå). Andre handlinger kan ikke binde en kommando. */
export const COMMAND_BUDGET_PARAM: Readonly<Record<string, string>> = {
  "google_ads.set_campaign_budget": "amount_ore",
  "linkedin.set_campaign_daily_budget": "daily_budget_ore",
  "tiktok.set_campaign_budget": "budget_ore"
};
const CAMPAIGN_CHANNELS: ReadonlySet<string> = new Set(["google_ads", "meta_ads", "linkedin", "tiktok"]);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
/** Review M1: nøkkelen er allerede brukt av noe annet enn denne vekstskrivingen (annen tool/handling i ToolGateway-ledgeren, eller et gatewaykall utenfor journalen). */
const KEY_COLLISION = "growth_write_idempotency_key_collision";

function spendEffect(op: OpSpec): JournalSpendEffect {
  return op.spend === undefined ? "none" : op.spend === "directional" ? "unknown" : op.spend;
}

interface LedgerRow { tool_id: string; action: string; status: string; before: JsonValue | null; after: JsonValue | null; external_id: string | null }

async function readLedger(pool: pg.Pool, tenantId: string, key: string): Promise<LedgerRow | null> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const { rows } = await client.query(`SELECT tool_id, action, status, before_state, after_state, external_id FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key]);
    const row = rows[0] as { tool_id: string; action: string; status: string; before_state: JsonValue | null; after_state: JsonValue | null; external_id: string | null } | undefined;
    return row ? { tool_id: row.tool_id, action: row.action, status: row.status, before: row.before_state, after: row.after_state, external_id: row.external_id } : null;
  });
}

export async function executeGrowthWrite(deps: GrowthWriteExecutorDeps, identity: IdentityContext, input: ExecuteGrowthWriteInput): Promise<ExecuteGrowthWriteResult> {
  // Kun registrerte skrivehandlinger (Map-oppslag: «constructor»/«__proto__» treffer aldri). Lesehandlinger har sin egen rute.
  const entry = deps.index.get(`${String(input.provider)}.${String(input.action)}`);
  if (!entry || entry.op.risk === "A") throw new Error(`growth_write_unknown_action:${String(input.action).slice(0, 60)}`);
  if (!deps.gateway.get(entry.spec.toolId, input.action)) throw new Error("growth_write_tool_not_registered");
  if (typeof input.idempotency_key !== "string" || !KEY.test(input.idempotency_key)) throw new Error("growth_write_idempotency_key_invalid");
  const tenantId = identity.tenant_id;
  const space = identity.memory_space_id as MemorySpace;
  const provider = entry.spec.provider as GrowthProvider;
  const target = entry.op.target?.(input.parameters) ?? `${provider}:${input.action}`;
  const digest = writeRequestDigest(provider, input.action, input.parameters);

  // Kampanje-kobling (kun når kampanjen finnes i Growth-registeret) og kommando-binding FØR noe sendes.
  const externalCampaignId = typeof input.parameters["campaign_id"] === "string" ? (input.parameters["campaign_id"] as string) : null;
  const campaign = externalCampaignId !== null && CAMPAIGN_CHANNELS.has(provider) && deps.findCampaign ? await deps.findCampaign(tenantId, space, provider as CampaignChannel, externalCampaignId) : null;
  if (input.command_id !== undefined) await assertCommandBinding(deps.pool, tenantId, space, input, provider, campaign?.campaign_id ?? null);

  const begun = await deps.journal.begin(tenantId, space, {
    provider, action: input.action, risk_class: entry.op.risk as "C" | "D", spend_effect: spendEffect(entry.op), target_ref: target, idempotency_key: input.idempotency_key, request_digest: digest,
    actor_person_id: identity.person_id, source: input.source ?? "owner_route", campaign_id: campaign?.campaign_id ?? null, experiment_id: input.experiment_id ?? null, variant_id: input.variant_id ?? null,
    command_id: input.command_id ?? null, ...(input.task_id !== undefined ? { task_id: input.task_id } : {}), ...(input.session_id !== undefined ? { session_id: input.session_id } : { session_id: identity.session_id }),
    ...(input.trace_id !== undefined ? { trace_id: input.trace_id } : {})
  });
  if (!begun.created && (begun.row.status === "applied" || begun.row.status === "failed")) {
    return { write: begun.row, outcome: begun.row.status === "applied" ? "SUCCESS" : "FAILED", reason: begun.row.failure_code, replayed: true, command_status: null };
  }

  // Review M1: ToolGateway-ledgeren er nøklet på (tenant, nøkkel) ALENE - en ANNEN tool (eller et direkte gateway-kall utenfor journalen) kan ha brukt nøkkelen, og gatewayen ville da svart `deduplicated: true` med
  // en FREMMED rad som om det var vår skriving (falsk `applied`, ingen mutasjon, kommando `executed`). Her nektes alt vi ikke kan bevise er vårt: en ledger-rad for nøkkelen som tilhører en annen tool/handling, og
  // enhver ledger-rad når journalraden er NY (ingen tidligere vekstskriving har brukt nøkkelen). Ingenting sendes; nøkkelen er brent og eieren bruker en ny.
  const toolId = entry.spec.toolId;
  const belongsToUs = (row: LedgerRow | null): row is LedgerRow => row !== null && row.tool_id === toolId && row.action === input.action;
  const collide = async (): Promise<ExecuteGrowthWriteResult> => {
    const write = await deps.journal.complete(tenantId, space, begun.row.write_id, { status: "failed", failure_code: KEY_COLLISION });
    return { write, outcome: "FAILED", reason: KEY_COLLISION, replayed: !begun.created, command_status: null };
  };
  const prior = await readLedger(deps.pool, tenantId, input.idempotency_key);
  if (prior !== null && (begun.created || !belongsToUs(prior))) return collide();

  const result = await deps.gateway.execute({
    identity, tool_id: toolId, action: input.action, parameters: input.parameters, idempotency_key: input.idempotency_key,
    ...(input.task_id !== undefined ? { task_id: input.task_id } : {}), ...(input.trace_id !== undefined ? { trace_id: input.trace_id } : {})
  });
  const seen = await readLedger(deps.pool, tenantId, input.idempotency_key);
  const ledger = belongsToUs(seen) ? seen : null;
  // Samme sjekk ETTER kallet (en annen tool kan ha tatt nøkkelen mellom sjekken og gatewayens reservasjon): et dedupe-svar på en ny journalrad eller en fremmed rad er aldri «applied». Har VI utført (`ok` uten
  // `deduplicated`), er etikett-/rad-forskjellen kosmetisk og utfallet gjelder.
  if ((seen !== null && ledger === null && !(result.ok && !result.deduplicated)) || (result.ok && result.deduplicated && begun.created)) return collide();
  const externalId = (result.ok ? result.external_id : undefined) ?? ledger?.external_id ?? null;

  let outcome: GrowthWriteOutcome;
  let status: "applied" | "failed" | "outcome_unknown";
  let reason: string | null = null;
  if (result.ok) {
    const unchanged = typeof result.data === "object" && result.data !== null && !Array.isArray(result.data) && (result.data as Record<string, JsonValue>)["unchanged"] === true;
    outcome = unchanged ? "NOOP" : "SUCCESS";
    status = "applied";
  } else if (isUnknownOutcomeReason(result.reason)) {
    outcome = "UNKNOWN"; status = "outcome_unknown"; reason = result.reason;
  } else if (result.reason.startsWith("postcondition_")) {
    // Mutasjonen LYKTES hos leverandøren, men etterbetingelsen kunne ikke bekreftes: aldri «applied».
    outcome = "PARTIAL"; status = "outcome_unknown"; reason = result.reason;
  } else {
    outcome = "FAILED"; status = "failed"; reason = result.reason;
  }

  const write = await deps.journal.complete(tenantId, space, begun.row.write_id, {
    status, failure_code: reason, before_state: ledger?.before ?? null, after_state: ledger?.after ?? null, external_id: externalId
  });
  if (campaign) await insertTimelineEvent(deps.pool, tenantId, space, campaign.campaign_id, write, outcome);
  let commandStatus: "executed" | "execution_unknown" | null = null;
  if (input.command_id !== undefined && (status === "applied" || status === "outcome_unknown")) commandStatus = await markCommand(deps.pool, tenantId, space, input.command_id, write, status === "applied");
  return { write, outcome, reason, replayed: !begun.created, command_status: commandStatus };
}

async function assertCommandBinding(pool: pg.Pool, tenantId: string, space: MemorySpace, input: ExecuteGrowthWriteInput, provider: string, campaignId: string | null): Promise<void> {
  const param = COMMAND_BUDGET_PARAM[`${provider}.${input.action}`];
  if (param === undefined) throw new Error("growth_command_binding_unsupported_action");
  if (campaignId === null) throw new Error("growth_command_binding_campaign_not_linked");
  await withMemoryTransaction(pool, tenantId, [space], async (client) => {
    const { rows } = await client.query(`SELECT status, campaign_id, proposed_budget_ore FROM marketing_campaign_execution_commands WHERE tenant_id = $1 AND command_id = $2`, [tenantId, input.command_id]);
    const command = rows[0] as { status: string; campaign_id: string; proposed_budget_ore: string } | undefined;
    if (!command) throw new Error("growth_command_not_found");
    if (command.campaign_id !== campaignId) throw new Error("growth_command_campaign_mismatch");
    if (command.status !== "pending_execution") throw new Error(`growth_command_not_pending:${command.status}`);
    if (String(input.parameters[param]) !== String(command.proposed_budget_ore)) throw new Error("growth_command_amount_mismatch");
  });
}

async function markCommand(pool: pg.Pool, tenantId: string, space: MemorySpace, commandId: string, write: GrowthWriteRow, applied: boolean): Promise<"executed" | "execution_unknown" | null> {
  return withMemoryTransaction(pool, tenantId, [space], async (client) => {
    const next = applied ? "executed" : "execution_unknown";
    const { rows } = await client.query(
      `UPDATE marketing_campaign_execution_commands SET status = $3, executed_at = CASE WHEN $3 = 'executed' THEN now() ELSE executed_at END, execution_write_id = $4, updated_at = now()
        WHERE tenant_id = $1 AND command_id = $2 AND status IN ('pending_execution', 'execution_unknown') RETURNING status`,
      [tenantId, commandId, next, write.write_id]
    );
    return rows[0] ? next : null;
  });
}

/**
 * Review M2 (CLAUDE.md regel 7): tidslinjen (`marketing_campaign_events`) leses av modellen via `growth.list_events` (chat-lesenivået, `output_trust: internal`). Leverandørtekst (kampanjenavn, annonsetekst)
 * er UBETRODD og skal aldri nå noe en modell kan lese - sanitering (kontrolltegn/lengde/hemmeligheter) fjerner ikke en instruksjon i klartekst. Derfor bærer tidslinjehendelsen KUN id-er, statuser og tall: en
 * fast hvitliste av nøkler, der verdien må være et endelig tall, en boolsk verdi eller en enum-formet statuskode (`ENABLED`, `PAUSED` ...; aldri en setning), og valutakoder på tre store bokstaver. Alt annet
 * (navn, tekster, URL-er) hoppes over - den fulle (redigerte) før-/ettertilstanden ligger i skrivejournalen, som kun eieren når (`/growth/writes/list`), og aldri på en modellflate.
 */
const TIMELINE_NUMBER_KEYS: ReadonlySet<string> = new Set(["budget_amount_micros", "cpc_bid_micros", "daily_budget_minor", "lifetime_budget_minor", "bid_amount_minor", "daily_budget_ore", "budget_ore"]);
const TIMELINE_BOOLEAN_KEYS: ReadonlySet<string> = new Set(["budget_shared"]);
const TIMELINE_STATUS_KEYS: ReadonlySet<string> = new Set(["status", "effective_status", "campaign_status", "ad_set_status", "ad_group_status", "serving_status", "bid_strategy", "bidding_strategy_type", "budget_mode", "channel_type"]);
const STATUS_CODE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

export function timelineProjection(state: JsonValue | null): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  if (typeof state !== "object" || state === null || Array.isArray(state)) return out;
  for (const [key, value] of Object.entries(state as Record<string, JsonValue>)) {
    if (TIMELINE_NUMBER_KEYS.has(key) && typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (TIMELINE_BOOLEAN_KEYS.has(key) && typeof value === "boolean") out[key] = value;
    else if (TIMELINE_STATUS_KEYS.has(key) && typeof value === "string" && STATUS_CODE.test(value)) out[key] = value;
    else if (key === "currency" && typeof value === "string" && CURRENCY_CODE.test(value)) out[key] = value;
  }
  return out;
}

async function insertTimelineEvent(pool: pg.Pool, tenantId: string, space: MemorySpace, campaignId: string, write: GrowthWriteRow, outcome: GrowthWriteOutcome): Promise<void> {
  const type = outcome === "SUCCESS" || outcome === "NOOP" ? "provider_write_applied" : outcome === "FAILED" ? "provider_write_failed" : "provider_write_unknown";
  await withMemoryTransaction(pool, tenantId, [space], async (client) => {
    await client.query(
      `INSERT INTO marketing_campaign_events (event_id, tenant_id, memory_space_id, campaign_id, event_type, summary, actor_person_id, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        `grw-ev-${randomUUID()}`, tenantId, space, campaignId, type, `${write.provider}.${write.action}: ${outcome} (${write.target_ref})`.slice(0, 500), write.actor_person_id,
        JSON.stringify({ write_id: write.write_id, provider: write.provider, action: write.action, outcome, risk_class: write.risk_class, before: timelineProjection(write.before_state), after: timelineProjection(write.after_state) })
      ]
    );
  });
}
