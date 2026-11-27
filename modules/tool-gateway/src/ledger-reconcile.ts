import type pg from "pg";
import { SweepFailureCollector, correlationFields, type IdentityContext, type RunCorrelation } from "@jarvis/contracts";
import { listAllTenantIds, scanForSecrets, withTenantTransaction, writeAudit } from "@jarvis/core";
import { ownerStepUpDenial } from "./class-d-pipeline.ts";
import type { ToolGateway } from "./gateway.ts";
import { shortFingerprint } from "./request-digest-gate.ts";

/**
 * WP-T1 K5 (JARVIS-103, Q-63 pkt 7, D-497): AVSTEMMING og UTLØP av `reserved`- og `unverified`-rader i ToolGateway-ledgeren (`tool_executions`, migrasjon 154).
 *
 * Før: en `unverified`-rad (utført men ikke bekreftet) og en `reserved`-rad som aldri ble ferdigstilt (krasj midt i kallet) sto for alltid - samme-nøkkel-retry blokkert, ingen jobb, ingen liste for eieren.
 * Nå, KUN med `JARVIS_TOOL_LEDGER_RECONCILE=on` (standard AV: ingenting herfra kjører, ingen rad får de nye statusene):
 *  1. UTLØPSSVEIPET (`runLedgerReconcileForAllTenants`, daglig jobb): `reserved` eldre enn TTL -> `unknown_outcome` (utfallet er UKJENT), `unverified` eldre enn TTL -> `needs_resolution` (utført, ikke bekreftet, venter på
 *     eieren). ALDRI en automatisk retry og ALDRI et leverandørkall: sveipet kun flytter status og skriver en revisjonsrad (`tool.ledger_reconciled`) per rad. Idempotent (en ny kjøring finner ingenting), tenant-skopet (RLS),
 *     `FOR UPDATE SKIP LOCKED` (to prosesser tar aldri samme rad), med DATABASEGULV (migrasjon 154: 10 min / 1 time) slik at en feilkonfigurasjon aldri kan merke et kall som kan være under utførelse.
 *  2. KØEN (`listLedgerQueue`): eierens synlige liste over rader som venter på en avgjørelse (nøkkel, verktøy, handling, klasse, status, årsak, alder, hva som skal sjekkes hos leverandøren).
 *  3. EIERENS AVGJØRELSE (`resolveLedgerEntry`): etter en MANUELL sjekk hos leverandøren bekrefter eieren utfallet. `executed` -> `succeeded` (en retry med samme nøkkel gir det lagrede resultatet), `not_executed` -> `failed`
 *     (nøkkelen er frigitt: en retry med samme nøkkel utføres på nytt - eierens ansvar etter sjekken). KLASSE-BEVISST: kun den suverene eieren (`ownerGate`, fail-closed); for klasse C/D (og ukjent verktøy = som D) kreves i tillegg
 *     step-up (enhetssignert økt fra en eier-kanal, `ownerStepUpDenial`); en eksplisitt bekreftelse (`provider_checked: true`) kreves alltid. Revisjonsraden `tool.ledger_resolved` bærer hvem, hva og hvorfor (kun korte avtrykk av nøkkelen).
 * Ingenting her kaller en leverandør, en transport eller `ToolGateway.execute()`: avgjørelsen er en registrering i Jarvis' egen ledger.
 */

/** Standardverdier og grenser (config). Databasen har egne, strengere gulv (154) som gjelder uansett. */
export const LEDGER_RESERVED_TTL_DEFAULT_MINUTES = 60;
export const LEDGER_RESERVED_TTL_MIN_MINUTES = 15;
export const LEDGER_RESERVED_TTL_MAX_MINUTES = 10_080;
export const LEDGER_UNVERIFIED_TTL_DEFAULT_HOURS = 24;
export const LEDGER_UNVERIFIED_TTL_MIN_HOURS = 2;
export const LEDGER_UNVERIFIED_TTL_MAX_HOURS = 2_160;
/** Gulvet i databasen (trigger `tool_executions_guard`) for når en `reserved`-rad kan avstemmes/avgjøres: kortere enn dette kan et kall fortsatt være under utførelse. */
export const LEDGER_RESERVED_FLOOR_MINUTES = 10;
export const LEDGER_SWEEP_BATCH = 500;
/** Maks antall batcher per status og tenant i ÉN kjøring (taket er `LEDGER_SWEEP_BATCH` x dette = 10 000 rader); resten tas av neste kjøring (idempotent). */
export const LEDGER_SWEEP_MAX_BATCHES = 20;

export interface LedgerReconcileConfig {
  enabled: boolean;
  reservedTtlMinutes: number;
  unverifiedTtlHours: number;
}

function integerInRange(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  if (!/^[0-9]{1,6}$/.test(text)) throw new Error(`${name}_invalid:${text.slice(0, 20)}`);
  const value = Number(text);
  if (value < min || value > max) throw new Error(`${name}_out_of_range:${value} (${min}-${max})`);
  return value;
}

/**
 * Leser flagg og TTL-er. Standard AV. KUN eksakt `on` slår på; `off`/tom/usatt er av; en ANNEN verdi (typo) STOPPER oppstarten (aldri en stille «av» når eieren trodde den var på). TTL-ene valideres kun når flagget er på;
 * en ugyldig/utenfor-intervall-verdi stopper også oppstarten (aldri en stille standard).
 */
export function parseLedgerReconcileConfig(env: Record<string, string | undefined> = process.env): LedgerReconcileConfig {
  const raw = (env["JARVIS_TOOL_LEDGER_RECONCILE"] ?? "").trim().toLowerCase();
  if (raw !== "" && raw !== "off" && raw !== "on") throw new Error(`jarvis_tool_ledger_reconcile_invalid:${raw.slice(0, 20)} (forventet on eller off)`);
  if (raw !== "on") return { enabled: false, reservedTtlMinutes: LEDGER_RESERVED_TTL_DEFAULT_MINUTES, unverifiedTtlHours: LEDGER_UNVERIFIED_TTL_DEFAULT_HOURS };
  return {
    enabled: true,
    reservedTtlMinutes: integerInRange(env["JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES"], LEDGER_RESERVED_TTL_DEFAULT_MINUTES, LEDGER_RESERVED_TTL_MIN_MINUTES, LEDGER_RESERVED_TTL_MAX_MINUTES, "jarvis_tool_ledger_reserved_ttl_minutes"),
    unverifiedTtlHours: integerInRange(env["JARVIS_TOOL_LEDGER_UNVERIFIED_TTL_HOURS"], LEDGER_UNVERIFIED_TTL_DEFAULT_HOURS, LEDGER_UNVERIFIED_TTL_MIN_HOURS, LEDGER_UNVERIFIED_TTL_MAX_HOURS, "jarvis_tool_ledger_unverified_ttl_hours")
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. Utløpssveipet
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

export interface LedgerSweepResult {
  reserved_to_unknown: number;
  unverified_to_needs_resolution: number;
}

/**
 * Systemprinsipalen revisjonsskriveren merker `actor_kind: system` (en systemhandling, aldri en oppdiktet person; samme verdi som business-/support-/samtalegraf-synkene bruker). Navngitt konstant: denne filen kaller aldri `ToolGateway.execute()`,
 * den skriver kun egne revisjonsrader, så kildevakten for system-KALL (`wpk-054-system-caller-correlation`) gjelder ikke her - korrelasjonen (JARVIS-054) legges likevel på hver revisjonsrad (`correlation`).
 */
const SYSTEM_PERSON_ID = "system";
/** Revisjonsidentiteten for sveipet: en SYSTEMHANDLING, aldri en person. */
const sweepIdentity = (tenantId: string) => ({ tenant_id: tenantId, person_id: SYSTEM_PERSON_ID, session_id: "ledger-reconcile", device_id: "jarvis-core" });

interface MovedRow { idempotency_key: string; tool_id: string; action: string; age_minutes: number | string }

/**
 * Utløpssveipet for ÉN tenant. Idempotent og tenant-skopet; flytter kun status og skriver revisjon. Kaster ved databasefeil (kalleren isolerer per tenant). Tar `batch` rader om gangen (eldst først) og gjentar til en batch er
 * delvis eller `maxBatches` er nådd, slik at en etterslep (for eksempel første kjøring etter at flagget er slått på) tas i én kjøring uten én enorm setning.
 */
export async function sweepLedgerTenant(
  pool: pg.Pool, tenantId: string, config: Pick<LedgerReconcileConfig, "reservedTtlMinutes" | "unverifiedTtlHours">, batch = LEDGER_SWEEP_BATCH, maxBatches = LEDGER_SWEEP_MAX_BATCHES, correlation?: RunCorrelation
): Promise<LedgerSweepResult> {
  return withTenantTransaction(pool, tenantId, async (client): Promise<LedgerSweepResult> => {
    const moveBatch = async (from: "reserved" | "unverified", to: "unknown_outcome" | "needs_resolution", basis: string, olderThanSql: string, olderThanParam: number): Promise<number> => {
      const moved = await client.query<MovedRow>(
        `WITH due AS (
           SELECT idempotency_key FROM tool_executions
            WHERE tenant_id = $1 AND status = '${from}' AND executed_at < now() - ${olderThanSql}
            ORDER BY executed_at LIMIT $3 FOR UPDATE SKIP LOCKED
         )
         UPDATE tool_executions t
            SET status = '${to}', status_before_reconcile = '${from}', reconciled_at = now(), reconcile_basis = '${basis}'
           FROM due
          WHERE t.tenant_id = $1 AND t.idempotency_key = due.idempotency_key AND t.status = '${from}'
        RETURNING t.idempotency_key, t.tool_id, t.action, floor(extract(epoch FROM (now() - t.executed_at)) / 60)::int AS age_minutes`,
        [tenantId, olderThanParam, batch]
      );
      for (const row of moved.rows) {
        await writeAudit(client, sweepIdentity(tenantId), {
          type: "tool.ledger_reconciled", decision: "ALLOW", reason: basis, tool_id: row.tool_id, action: row.action, ...correlationFields(correlation),
          payload: { key_fp: shortFingerprint(row.idempotency_key), from_status: from, to_status: to, age_minutes: Number(row.age_minutes) }
        });
      }
      return moved.rowCount ?? moved.rows.length;
    };
    const move = async (from: "reserved" | "unverified", to: "unknown_outcome" | "needs_resolution", basis: string, olderThanSql: string, olderThanParam: number): Promise<number> => {
      let total = 0;
      for (let i = 0; i < maxBatches; i += 1) {
        const moved = await moveBatch(from, to, basis, olderThanSql, olderThanParam);
        total += moved;
        if (moved < batch) break;
      }
      return total;
    };
    const reserved = await move("reserved", "unknown_outcome", "reserved_ttl_exceeded", "make_interval(mins => $2::int)", config.reservedTtlMinutes);
    const unverified = await move("unverified", "needs_resolution", "unverified_ttl_exceeded", "make_interval(hours => $2::int)", config.unverifiedTtlHours);
    return { reserved_to_unknown: reserved, unverified_to_needs_resolution: unverified };
  });
}

export interface LedgerReconcileSummary extends LedgerSweepResult {
  tenants: number;
  failed_tenants: number;
}

/**
 * Daglig sveip over alle tenants (én tenant sin feil velter aldri de andre; feilene samles i `failures` slik at `failOnSweepFailures` gir nytt forsøk med backoff, jf. D-442). Idempotent: et nytt forsøk er trygt.
 * Skriver en logglinje med KUN tall.
 */
export async function runLedgerReconcileForAllTenants(
  pool: pg.Pool, config: Pick<LedgerReconcileConfig, "reservedTtlMinutes" | "unverifiedTtlHours">, failures?: SweepFailureCollector, correlation?: RunCorrelation,
  listTenants: (pool: pg.Pool) => Promise<string[]> = (p) => listAllTenantIds(p, 200)
): Promise<LedgerReconcileSummary> {
  const tenants = await listTenants(pool);
  const summary: LedgerReconcileSummary = { tenants: tenants.length, failed_tenants: 0, reserved_to_unknown: 0, unverified_to_needs_resolution: 0 };
  for (const tenantId of tenants) {
    try {
      const result = await sweepLedgerTenant(pool, tenantId, config, LEDGER_SWEEP_BATCH, LEDGER_SWEEP_MAX_BATCHES, correlation);
      summary.reserved_to_unknown += result.reserved_to_unknown;
      summary.unverified_to_needs_resolution += result.unverified_to_needs_resolution;
    } catch (err) {
      summary.failed_tenants += 1;
      failures?.record(tenantId, err);
      console.error(JSON.stringify({ msg: "tool_ledger_reconcile_failed", error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120) }));
    }
  }
  console.log(JSON.stringify({ msg: "tool_ledger_reconcile_done", ...summary }));
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. Eierens kø
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

export interface LedgerQueueEntry {
  idempotency_key: string;
  tool_id: string;
  action: string;
  /** Handlingens risikoklasse etter registeret (`null` = verktøyet er ikke registrert i denne prosessen: behandles som klasse D). */
  capability_class: string | null;
  /** Avgjørelsen krever step-up (klasse C/D eller ukjent verktøy). */
  step_up_required: boolean;
  status: "reserved" | "unverified" | "unknown_outcome" | "needs_resolution";
  status_before_reconcile: "reserved" | "unverified" | null;
  /** Gatewayens årsak (`postcondition_unverified:...`) - en fast kode, aldri leverandørtekst. */
  reason: string | null;
  /** Leverandørens egen referanse (om den finnes) - det eieren slår opp hos leverandøren. */
  external_id: string | null;
  executed_at: string;
  reconciled_at: string | null;
  age_minutes: number;
  /** Hva som skal gjøres/sjekkes for å rette opp (handlingens `rollback_procedure`). */
  recovery: string;
}

export interface LedgerQueue { total: number; entries: LedgerQueueEntry[] }

interface QueueRow {
  idempotency_key: string; tool_id: string; action: string; status: LedgerQueueEntry["status"]; status_before_reconcile: LedgerQueueEntry["status_before_reconcile"];
  postcondition_reason: string | null; external_id: string | null; executed_at: Date | string; reconciled_at: Date | string | null; age_minutes: number | string; total: number | string;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());
/** Faste koder kun (`a-z`, tall, `_:.-`): leverandørtekst når aldri eieren via køen. */
const safeCode = (value: string | null): string | null => (value === null ? null : value.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 120));
/** Er verktøyet klasse C/D (eller ukjent)? Da kreves step-up for å avgjøre raden. Ukjent verktøy er fail-closed (som D). */
function needsStepUp(capabilityClass: string | null): boolean {
  return capabilityClass === null || capabilityClass === "C" || capabilityClass === "D";
}

export async function listLedgerQueue(pool: pg.Pool, tenantId: string, gateway: Pick<ToolGateway, "get">, options: { limit?: number } = {}): Promise<LedgerQueue> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 200);
  const rows = await withTenantTransaction(pool, tenantId, async (client) =>
    (await client.query<QueueRow>(
      `SELECT idempotency_key, tool_id, action, status, status_before_reconcile, postcondition_reason, external_id, executed_at, reconciled_at,
              floor(extract(epoch FROM (now() - executed_at)) / 60)::int AS age_minutes, count(*) OVER ()::int AS total
         FROM tool_executions
        WHERE tenant_id = $1 AND (status IN ('unverified', 'unknown_outcome', 'needs_resolution') OR (status = 'reserved' AND executed_at < now() - make_interval(mins => $3::int)))
        ORDER BY executed_at ASC LIMIT $2`,
      [tenantId, limit, LEDGER_RESERVED_FLOOR_MINUTES]
    )).rows
  );
  const entries = rows.map((r): LedgerQueueEntry => {
    const definition = gateway.get(r.tool_id, r.action);
    const capabilityClass = definition?.capability_class ?? null;
    return {
      idempotency_key: r.idempotency_key, tool_id: r.tool_id, action: r.action, capability_class: capabilityClass, step_up_required: needsStepUp(capabilityClass),
      status: r.status, status_before_reconcile: r.status_before_reconcile, reason: safeCode(r.postcondition_reason), external_id: r.external_id === null ? null : r.external_id.slice(0, 200),
      executed_at: iso(r.executed_at) as string, reconciled_at: iso(r.reconciled_at), age_minutes: Number(r.age_minutes),
      recovery: definition?.rollback_procedure ?? "ukjent verktøy - manuell oppfølging"
    };
  });
  return { total: rows.length === 0 ? 0 : Number(rows[0]!.total), entries };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 3. Eierens avgjørelse
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

export type LedgerResolution = "executed" | "not_executed";

export interface ResolveLedgerInput {
  idempotency_key: string;
  resolution: LedgerResolution;
  /** Eierens uttrykkelige bekreftelse: «jeg har sjekket hos leverandøren». Kreves for begge avgjørelsene. */
  provider_checked: boolean;
  /** Eierens egen merknad (kuttes, renses for kontrolltegn; lagres kun i revisjonsraden). */
  note?: string;
}

export type ResolveLedgerFailure =
  | "owner_required" | "invalid_idempotency_key" | "invalid_resolution" | "provider_check_not_confirmed" | "not_found" | "not_resolvable" | "resolve_too_early" | "concurrent_change"
  | `step_up_required:${string}`;

export type ResolveLedgerResult =
  | { ok: true; idempotency_key: string; tool_id: string; action: string; from_status: string; to_status: "succeeded" | "failed"; resolution: LedgerResolution; capability_class: string | null }
  | { ok: false; reason: ResolveLedgerFailure; status?: string };

export interface ResolveLedgerDeps {
  pool: pg.Pool;
  gateway: Pick<ToolGateway, "get">;
  /** Den suverene eieren (samme predikat som kontrollsentrene). FAIL-CLOSED: mangler den, kaster den eller svarer den noe annet enn `true`, er kalleren ikke eieren. */
  ownerGate: ((identity: IdentityContext) => boolean) | undefined;
}

const NOTE_MAX = 200;
/** Skanneren får aldri mer enn dette (kuttet er langt over det som beholdes, så en hemmelighet som krysser grensen kastes uansett i det siste kuttet). */
const NOTE_SCAN_MAX = 4_096;
/**
 * Eierens merknad som én kort linje. REKKEFØLGE (som `redactVendorText`): den SENTRALE hemmelighetsskanneren FØRST (en token eieren limte inn lagres aldri i revisjonen), så kontrolltegn, linjeskift, usynlige
 * formateringstegn og ensomme surrogater fjernes/erstattes, og lengden kuttes SIST på kodepunkt-grense.
 */
export function sanitizeLedgerNote(note: string | undefined): string | null {
  if (typeof note !== "string") return null;
  const scanned = scanForSecrets(note.slice(0, NOTE_SCAN_MAX)).text;
  // eslint-disable-next-line no-control-regex
  const flat = scanned.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\p{Cf}/gu, "").replace(/\p{Cs}/gu, "?").replace(/ {2,}/g, " ").trim();
  if (flat === "") return null;
  const points = Array.from(flat);
  return points.length > NOTE_MAX ? `${points.slice(0, NOTE_MAX - 1).join("")}\u2026` : flat;
}

/** Nøkkelen er valgt av kalleren (ikke alltid ASCII uten mellomrom): hvilken som helst tekst på 1-300 kodepunkter uten kontrolltegn og uten ensomme surrogater. Oppslaget er et eksakt, bundet spørringsparameter. */
// eslint-disable-next-line no-control-regex
const KEY_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cs}]{1,300}$/u;
const RESOLVABLE = new Set(["reserved", "unverified", "unknown_outcome", "needs_resolution"]);

interface ResolveRow { tool_id: string; action: string; status: string; postcondition_reason: string | null; past_floor: boolean }

export async function resolveLedgerEntry(deps: ResolveLedgerDeps, identity: IdentityContext, input: ResolveLedgerInput): Promise<ResolveLedgerResult> {
  let isOwner = false;
  try {
    isOwner = deps.ownerGate !== undefined && deps.ownerGate(identity) === true;
  } catch {
    isOwner = false;
  }
  if (!isOwner) return { ok: false, reason: "owner_required" };
  if (typeof input.idempotency_key !== "string" || !KEY_PATTERN.test(input.idempotency_key)) return { ok: false, reason: "invalid_idempotency_key" };
  if (input.resolution !== "executed" && input.resolution !== "not_executed") return { ok: false, reason: "invalid_resolution" };
  if (input.provider_checked !== true) return { ok: false, reason: "provider_check_not_confirmed" };
  const note = sanitizeLedgerNote(input.note);
  const tenantId = identity.tenant_id;

  return withTenantTransaction(deps.pool, tenantId, async (client): Promise<ResolveLedgerResult> => {
    const found = await client.query<ResolveRow>(
      `SELECT tool_id, action, status, postcondition_reason, (executed_at <= now() - make_interval(mins => $3::int)) AS past_floor
         FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [tenantId, input.idempotency_key, LEDGER_RESERVED_FLOOR_MINUTES]
    );
    const row = found.rows[0];
    if (row === undefined) return { ok: false, reason: "not_found" };
    if (!RESOLVABLE.has(row.status)) return { ok: false, reason: "not_resolvable", status: row.status };
    if (row.status === "reserved" && !row.past_floor) return { ok: false, reason: "resolve_too_early", status: row.status };
    const capabilityClass = deps.gateway.get(row.tool_id, row.action)?.capability_class ?? null;
    // KLASSE-BEVISST: klasse C/D (og ukjent verktøy, fail-closed) krever en enhetssignert økt fra en eier-kanal; klasse A/B holder med eierporten.
    const stepUp = needsStepUp(capabilityClass) ? ownerStepUpDenial(identity) : undefined;
    if (stepUp !== undefined) return { ok: false, reason: `step_up_required:${stepUp.replace(/^step_up_required:/, "").slice(0, 60)}` as ResolveLedgerFailure };

    const toStatus = input.resolution === "executed" ? "succeeded" : "failed";
    const updated = await client.query(
      `UPDATE tool_executions SET status = $3, resolved_at = now(), resolved_by = $4, resolution = $5
        WHERE tenant_id = $1 AND idempotency_key = $2 AND status = $6`,
      [tenantId, input.idempotency_key, toStatus, identity.person_id, input.resolution, row.status]
    );
    if (updated.rowCount !== 1) return { ok: false, reason: "concurrent_change" };
    await writeAudit(client, identity, {
      type: "tool.ledger_resolved", decision: "ALLOW", reason: input.resolution, tool_id: row.tool_id, action: row.action, ...(capabilityClass !== null ? { capability_class: capabilityClass } : {}),
      payload: {
        key_fp: shortFingerprint(input.idempotency_key), from_status: row.status, to_status: toStatus, resolution: input.resolution, provider_checked: true,
        step_up: needsStepUp(capabilityClass), previous_reason: safeCode(row.postcondition_reason), ...(note !== null ? { note } : {})
      }
    });
    return { ok: true, idempotency_key: input.idempotency_key, tool_id: row.tool_id, action: row.action, from_status: row.status, to_status: toStatus, resolution: input.resolution, capability_class: capabilityClass };
  });
}
