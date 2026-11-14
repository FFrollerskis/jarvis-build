// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  controlAction, controlItem, controlSection, unknownControlSection,
  type ControlAction, type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus
} from "@jarvis/executive";
import { SUBMIT_INFLIGHT_LEASE_MS } from "@jarvis/finance";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { actionRequiresStepUp } from "../step-up.ts";
import { readFinanceKillSwitch } from "./authority.ts";
import {
  DAY_MS, HOUR_MS, NON_HEALTH_SPACES, bySeverityThenLabel, countsNo, mergeBy, relativeNo, riskOf, safeCategory, settle, tenantRead, tenantSpaceRead, toInt, toIso,
  type ControlCenterPool, type Settled
} from "./shared.ts";

/**
 * WP-H1 (UA-11 Admin Control Center, masterplan v4.0 kap. 21) - FINANCE CENTER: intensjoner, forbruk, avvik, leverandører/kontoer, avstemming og finans-nødbryteren (TILSTAND + den eksisterende bryteren).
 *
 * Kun LESING av eksisterende tabeller (WP-F1 / migrasjon 038-045 og 099-101) - ingen nye eksterne kall, ingen skriving. Hver seksjon oppgir kilden og når den ble målt; en kilde som ikke kan leses gir
 * `UNKNOWN` (aldri «i orden»).
 *
 * INNHOLDSVERN: leverandørnavn, formål, beskrivelser, motpartsnavn, referansetekster, kontonavn/-identifikatorer, funn-sammendrag og råe leverandørnyttelaster leses ALDRI. Kun antall, beløp i øre, tilstander,
 * avviksflagg (kategorinavn fra egen kode, filtrert gjennom `safeCategory`), tidsstempler og interne id-er. Kontonummer/KID/kortdata finnes ikke i noen av spørringene.
 *
 * HANDLINGER: kun finans-nødbryteren (`enable_finance_kill_switch` / `disable_finance_kill_switch` på `/executive/mutate`, samme bryter som Autoritet-senteret viser: samme risikoklasse, samme step-up-regel).
 * DEFERRED (ikke stille utelatt): manuell disposisjon av en intensjon med ukjent utfall (ikke bygget i WP-F1 - eieren avstemmer i leverandørens portal), og avstemmingskjøring på forespørsel herfra
 * (kjøres av den planlagte sveipen `finance-reconcile-sweep`).
 */

const SPEND_WINDOW_DAYS = 30;
const WEBHOOK_WINDOW_DAYS = 7;
/** Avstemmingen kjører daglig (`finance-reconcile-sweep`); eldre enn dette er en advarsel. */
export const RECONCILE_STALE_MS = 48 * HOUR_MS;
/** En avstemmingskjøring som fortsatt står som «running» etter så lang tid er sannsynligvis død. */
export const RECONCILE_RUNNING_STALE_MS = 30 * 60_000;
/** Et bankssamtykke som utløper innen så lang tid må fornyes. */
export const CONSENT_EXPIRY_WARN_MS = 14 * DAY_MS;
/** Utgiftssynken (`finance-spend-integrity-sweep`) kjører daglig. */
export const SPEND_SYNC_STALE_MS = 48 * HOUR_MS;
const MAX_CONSENT_ITEMS = 20;

const FINANCE_LOOP_TYPES = [
  "marketing_spend_anomaly", "payment_intent_anomaly", "payment_intent_reconciliation_mismatch", "finance_spend_unexpected", "finance_spend_amount_deviation",
  "finance_recurring_charge_missing", "finance_recurring_charge_duplicate", "finance_spend_correction_conflict"
] as const;

const INTENT_STATES = ["draft", "submitted", "provider_acknowledged", "settled", "failed", "cancelled"] as const;
const STATE_NO: Readonly<Record<string, string>> = {
  draft: "Utkast", submitted: "Sendt (venter svar)", provider_acknowledged: "Bekreftet av leverandør", settled: "Oppgjort", failed: "Feilet", cancelled: "Avbrutt"
};
const FINDING_KIND_NO: Readonly<Record<string, string>> = {
  provider_amount_mismatch: "beløp avviker fra leverandøren", provider_currency_mismatch: "valuta avviker fra leverandøren", provider_ref_missing: "leverandørreferanse mangler",
  submit_outcome_unknown: "utfall av innsending er ukjent", over_refunded: "refundert mer enn innbetalt", over_captured: "belastet mer enn autorisert",
  possible_duplicate_payment: "mulig dobbeltbetaling", settled_unreconciled: "oppgjort men ikke avstemt", webhook_rejected: "avvist leverandørvarsel", webhook_unprocessed: "ubehandlet leverandørvarsel",
  fiken_posting_missing: "bilag mangler i Fiken", fiken_posting_unlinked: "Fiken-bilag uten intensjon", fiken_posting_mismatch: "Fiken-bilag avviker"
};

// ---------------------------------------------------------------------------------------------------------------------
// Lesere (ekte SQL mot ekte tabeller - bevist som app-rolle i wph1-finance-center-db.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface IntentsRead {
  by_state: Array<{ state: string; n: number; ore: number }>;
  by_provider: Array<{ provider: string; n: number }>;
  outcome_unknown: number;
  in_flight: number;
  flagged: number;
  settled_unreconciled: number;
  failed_7d: number;
  created_30d: number;
  provider_objects: Array<{ kind: string; state: string; n: number }>;
}

export async function readIntents(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<IntentsRead> {
  const lease = new Date(nowMs - SUBMIT_INFLIGHT_LEASE_MS);
  const d7 = new Date(nowMs - 7 * DAY_MS);
  const d30 = new Date(nowMs - SPEND_WINDOW_DAYS * DAY_MS);
  return tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => {
    const states = await query(`SELECT state, (count(*))::int AS n, coalesce(sum(amount_ore), 0)::text AS ore FROM payment_intents WHERE tenant_id = $1 GROUP BY state`, [tenantId]);
    const providers = await query(`SELECT provider, (count(*))::int AS n FROM payment_intents WHERE tenant_id = $1 GROUP BY provider`, [tenantId]);
    const flags = await query(
      `SELECT
         (count(*) FILTER (WHERE state = 'submitted' AND provider_ref IS NULL AND submitted_at IS NOT NULL AND submitted_at < $2))::int AS outcome_unknown,
         (count(*) FILTER (WHERE state IN ('submitted', 'provider_acknowledged')))::int AS in_flight,
         (count(*) FILTER (WHERE jsonb_typeof(anomaly_flags) = 'array' AND jsonb_array_length(anomaly_flags) > 0))::int AS flagged,
         (count(*) FILTER (WHERE state = 'settled' AND reconciliation_state <> 'matched'))::int AS settled_unreconciled,
         (count(*) FILTER (WHERE state = 'failed' AND coalesce(failed_at, updated_at) >= $3))::int AS failed_7d,
         (count(*) FILTER (WHERE created_at >= $4))::int AS created_30d
       FROM payment_intents WHERE tenant_id = $1`,
      [tenantId, lease, d7, d30]
    );
    const objects = await query(
      `SELECT 'stripe_refund' AS kind, state, (count(*))::int AS n FROM stripe_refunds WHERE tenant_id = $1 GROUP BY state
       UNION ALL SELECT 'vipps_capture', state, (count(*))::int FROM vipps_captures WHERE tenant_id = $1 GROUP BY state
       UNION ALL SELECT 'vipps_refund', state, (count(*))::int FROM vipps_refunds WHERE tenant_id = $1 GROUP BY state`,
      [tenantId]
    );
    const f = flags[0] ?? {};
    return {
      by_state: states.map((r) => ({ state: safeCategory(r["state"]), n: toInt(r["n"]), ore: toInt(r["ore"]) })),
      by_provider: providers.map((r) => ({ provider: safeCategory(r["provider"]), n: toInt(r["n"]) })),
      outcome_unknown: toInt(f["outcome_unknown"]), in_flight: toInt(f["in_flight"]), flagged: toInt(f["flagged"]), settled_unreconciled: toInt(f["settled_unreconciled"]),
      failed_7d: toInt(f["failed_7d"]), created_30d: toInt(f["created_30d"]),
      provider_objects: objects.map((r) => ({ kind: safeCategory(r["kind"]), state: safeCategory(r["state"]), n: toInt(r["n"]) }))
    };
  });
}

export interface SpendRead {
  by_category: Array<{ category: string; n: number; ore: number; estimated: number; unreconciled: number; conflicts: number }>;
  cursors: Array<{ source_family: string; last_synced_at: string | null }>;
  commitments: Array<{ state: string; n: number; overdue: number }>;
  procurement: Array<{ status: string; n: number; overdue: number }>;
}

export async function readSpend(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<SpendRead> {
  const since = new Date(nowMs - SPEND_WINDOW_DAYS * DAY_MS);
  const now = new Date(nowMs);
  const today = now.toISOString().slice(0, 10);
  const main = await tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => ({
    spend: await query(
      `SELECT category, (count(*))::int AS n, coalesce(sum(amount_ore), 0)::text AS ore,
              (count(*) FILTER (WHERE source_amount_status = 'estimated'))::int AS estimated,
              (count(*) FILTER (WHERE reconciliation_state <> 'matched'))::int AS unreconciled,
              (count(*) FILTER (WHERE source_correction_state = 'correction_conflict'))::int AS conflicts
         FROM finance_spend_records WHERE tenant_id = $1 AND occurred_at >= $2 GROUP BY category`,
      [tenantId, since]
    ),
    commitments: await query(
      `SELECT state, (count(*))::int AS n, (count(*) FILTER (WHERE state = 'active' AND next_expected_charge_at IS NOT NULL AND next_expected_charge_at < $2))::int AS overdue
         FROM finance_recurring_commitments WHERE tenant_id = $1 GROUP BY state`,
      [tenantId, new Date(nowMs - 7 * DAY_MS)]
    ),
    procurement: await query(
      `SELECT status, (count(*))::int AS n, (count(*) FILTER (WHERE status = 'expected' AND (expected_date + expected_window_days) < $2::date))::int AS overdue
         FROM finance_procurement_items WHERE tenant_id = $1 GROUP BY status`,
      [tenantId, today]
    )
  }));
  const cursors = await tenantRead(pool, tenantId, (query) => query(`SELECT source_family, last_synced_at FROM finance_spend_sync_cursors WHERE tenant_id = $1 ORDER BY source_family`, [tenantId]));
  return {
    by_category: main.spend.map((r) => ({
      category: safeCategory(r["category"]), n: toInt(r["n"]), ore: toInt(r["ore"]), estimated: toInt(r["estimated"]), unreconciled: toInt(r["unreconciled"]), conflicts: toInt(r["conflicts"])
    })),
    cursors: cursors.map((r) => ({ source_family: safeCategory(r["source_family"]), last_synced_at: toIso(r["last_synced_at"]) })),
    commitments: main.commitments.map((r) => ({ state: safeCategory(r["state"]), n: toInt(r["n"]), overdue: toInt(r["overdue"]) })),
    procurement: main.procurement.map((r) => ({ status: safeCategory(r["status"]), n: toInt(r["n"]), overdue: toInt(r["overdue"]) }))
  };
}

export interface AnomaliesRead {
  flags: Array<{ source: string; flag: string; n: number }>;
  open_loops: Array<{ loop_type: string; n: number }>;
}

/** Tabellene som bærer `anomaly_flags` (jsonb-liste med kategorinavn fra egen kode). Navnene er faste - aldri bygget fra data. */
const FLAG_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["intents", "payment_intents"], ["spend", "finance_spend_records"], ["commitments", "finance_recurring_commitments"], ["procurement", "finance_procurement_items"],
  ["bank", "bank_transactions"], ["stripe_refunds", "stripe_refunds"], ["vipps_captures", "vipps_captures"], ["vipps_refunds", "vipps_refunds"],
  ["cards", "provider_cards"], ["card_authorizations", "card_authorizations"]
];

export async function readAnomalies(pool: ControlCenterPool, tenantId: string): Promise<AnomaliesRead> {
  const union = FLAG_SOURCES.map(([label, table]) =>
    `SELECT '${label}' AS source, f AS flag FROM ${table}, jsonb_array_elements_text(CASE WHEN jsonb_typeof(anomaly_flags) = 'array' THEN anomaly_flags ELSE '[]'::jsonb END) AS f WHERE tenant_id = $1`
  ).join(" UNION ALL ");
  return tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => {
    const flags = await query(`SELECT source, flag, (count(*))::int AS n FROM (${union}) x GROUP BY source, flag ORDER BY n DESC, source, flag LIMIT 60`, [tenantId]);
    const loops = await query(
      `SELECT loop_type, (count(*))::int AS n FROM business_open_loops WHERE tenant_id = $1 AND status = 'open' AND loop_type = ANY($2::text[]) GROUP BY loop_type ORDER BY loop_type`,
      [tenantId, [...FINANCE_LOOP_TYPES]]
    );
    return {
      flags: mergeBy(
        flags.map((r) => ({ source: safeCategory(r["source"]), flag: safeCategory(r["flag"]), n: toInt(r["n"]) })),
        (f) => `${f.source}\u0000${f.flag}`, (a, b) => ({ ...a, n: a.n + b.n })
      ),
      open_loops: loops.map((r) => ({ loop_type: safeCategory(r["loop_type"]), n: toInt(r["n"]) }))
    };
  });
}

export interface VendorsAccountsRead {
  vendors: number;
  vendors_unbound: number;
  bindings: Array<{ provider: string; status: string; n: number }>;
  consents: Array<{ consent_id: string; state: string; expires_at: string | null; last_verified_at: string | null }>;
  accounts: { total: number; active: number; last_synced_at: string | null };
  cards: Array<{ state: string; n: number }>;
}

export async function readVendorsAccounts(pool: ControlCenterPool, tenantId: string): Promise<VendorsAccountsRead> {
  return tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => {
    const counts = await query(
      `SELECT (SELECT (count(*))::int FROM finance_vendors WHERE tenant_id = $1) AS vendors,
              (SELECT (count(*))::int FROM finance_vendors v WHERE v.tenant_id = $1
                 AND NOT EXISTS (SELECT 1 FROM finance_vendor_provider_bindings b WHERE b.tenant_id = v.tenant_id AND b.vendor_id = v.vendor_id AND b.status = 'active')) AS vendors_unbound`,
      [tenantId]
    );
    const bindings = await query(`SELECT provider, status, (count(*))::int AS n FROM finance_vendor_provider_bindings WHERE tenant_id = $1 GROUP BY provider, status ORDER BY provider, status`, [tenantId]);
    const consents = await query(
      `SELECT consent_id, state, expires_at, last_verified_at FROM bank_consents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT ${MAX_CONSENT_ITEMS}`, [tenantId]
    );
    const accounts = await query(
      `SELECT (count(*))::int AS total, (count(*) FILTER (WHERE active))::int AS active, max(last_synced_at) AS last_synced_at FROM bank_accounts WHERE tenant_id = $1`, [tenantId]
    );
    const cards = await query(`SELECT state, (count(*))::int AS n FROM provider_cards WHERE tenant_id = $1 GROUP BY state ORDER BY state`, [tenantId]);
    const a = accounts[0] ?? {};
    return {
      vendors: toInt(counts[0]?.["vendors"]), vendors_unbound: toInt(counts[0]?.["vendors_unbound"]),
      bindings: bindings.map((r) => ({ provider: safeCategory(r["provider"]), status: safeCategory(r["status"]), n: toInt(r["n"]) })),
      consents: consents.map((r) => ({ consent_id: String(r["consent_id"]), state: safeCategory(r["state"]), expires_at: toIso(r["expires_at"]), last_verified_at: toIso(r["last_verified_at"]) })),
      accounts: { total: toInt(a["total"]), active: toInt(a["active"]), last_synced_at: toIso(a["last_synced_at"]) },
      cards: cards.map((r) => ({ state: safeCategory(r["state"]), n: toInt(r["n"]) }))
    };
  });
}

export interface ReconciliationRead {
  last_run: { run_id: string; status: string; trigger: string; started_at: string | null; finished_at: string | null; checks: Array<{ check: string; outcome: string }>; has_error: boolean } | null;
  open_findings: Array<{ severity: string; kind: string; n: number; oldest_at: string | null; max_reopen: number }>;
  resolved_7d: number;
  bank_unmatched: Array<{ state: string; n: number }>;
  webhooks_unhealthy: Array<{ provider: string; status: string; n: number }>;
}

export async function readReconciliation(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<ReconciliationRead> {
  const since = new Date(nowMs - WEBHOOK_WINDOW_DAYS * DAY_MS);
  return tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => {
    const run = await query(
      `SELECT run_id, status, trigger, started_at, finished_at, checks, (error_message IS NOT NULL) AS has_error
         FROM finance_reconciliation_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [tenantId]
    );
    const findings = await query(
      `SELECT severity, kind, (count(*))::int AS n, min(first_seen_at) AS oldest_at, (max(reopen_count))::int AS max_reopen
         FROM finance_reconciliation_findings WHERE tenant_id = $1 AND status = 'open' GROUP BY severity, kind ORDER BY severity, kind`,
      [tenantId]
    );
    const resolved = await query(`SELECT (count(*))::int AS n FROM finance_reconciliation_findings WHERE tenant_id = $1 AND status = 'resolved' AND resolved_at >= $2`, [tenantId, since]);
    const bank = await query(`SELECT reconciliation_state AS state, (count(*))::int AS n FROM bank_transactions WHERE tenant_id = $1 AND reconciliation_state <> 'matched' GROUP BY reconciliation_state`, [tenantId]);
    const webhooks = await query(
      `SELECT provider, status, (count(*))::int AS n FROM (
         SELECT 'stripe' AS provider, status, received_at FROM stripe_webhook_events WHERE tenant_id = $1
         UNION ALL SELECT 'vipps', status, received_at FROM vipps_webhook_events WHERE tenant_id = $1
         UNION ALL SELECT 'neonomics', status, received_at FROM neonomics_webhook_events WHERE tenant_id = $1
         UNION ALL SELECT 'wallester', status, received_at FROM wallester_webhook_events WHERE tenant_id = $1
       ) w WHERE received_at >= $2 AND status IN ('failed_retryable', 'rejected', 'unsupported') GROUP BY provider, status ORDER BY provider, status`,
      [tenantId, since]
    );
    const r = run[0];
    const checksRaw = r?.["checks"];
    const checks = checksRaw !== null && typeof checksRaw === "object" && !Array.isArray(checksRaw)
      ? mergeBy(Object.entries(checksRaw as Record<string, unknown>).slice(0, 20).map(([check, outcome]) => ({ check: safeCategory(check), outcome: safeCategory(outcome) })), (c) => c.check, (a) => a)
      : [];
    return {
      last_run: r
        ? { run_id: String(r["run_id"]), status: safeCategory(r["status"]), trigger: safeCategory(r["trigger"]), started_at: toIso(r["started_at"]), finished_at: toIso(r["finished_at"]), checks, has_error: r["has_error"] === true }
        : null,
      open_findings: findings.map((x) => ({ severity: safeCategory(x["severity"]), kind: safeCategory(x["kind"]), n: toInt(x["n"]), oldest_at: toIso(x["oldest_at"]), max_reopen: toInt(x["max_reopen"]) })),
      resolved_7d: toInt(resolved[0]?.["n"]),
      bank_unmatched: bank.map((x) => ({ state: safeCategory(x["state"]), n: toInt(x["n"]) })),
      webhooks_unhealthy: webhooks.map((x) => ({ provider: safeCategory(x["provider"]), status: safeCategory(x["status"]), n: toInt(x["n"]) }))
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------

export interface FinanceCenterDeps {
  pool: ControlCenterPool;
  /** Risikoklassene til nødbryter-handlingene leses fra verktøydefinisjonene (aldri en kopi). */
  toolGateway: Pick<ToolGateway, "get">;
}

const KILL_SECTION = "kill_switch";

export function createFinanceCenter(deps: FinanceCenterDeps): ControlCenterDefinition {
  return {
    id: "finance",
    title_no: "Finans",
    description_no: "Betalingsintensjoner, forbruk, avvik, leverandører og kontoer, avstemming og finans-nødbryteren (lesing; nødbryteren bruker den eksisterende ruten)",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const rel = (iso: string | null | undefined): string => relativeNo(iso, nowMs);
      const failed = (r: Settled<unknown>): string => (r.ok ? "" : ` (${r.category})`);

      const [intentsR, spendR, anomaliesR, vendorsR, reconR, killR] = await Promise.all([
        settle(() => readIntents(deps.pool, tenantId, nowMs)),
        settle(() => readSpend(deps.pool, tenantId, nowMs)),
        settle(() => readAnomalies(deps.pool, tenantId)),
        settle(() => readVendorsAccounts(deps.pool, tenantId)),
        settle(() => readReconciliation(deps.pool, tenantId, nowMs)),
        settle(() => readFinanceKillSwitch(deps.pool, tenantId))
      ]);

      const sections: ControlSection[] = [];
      const actions: ControlAction[] = [];

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 1. Betalingsintensjoner
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (intentsR.ok) {
        const v = intentsR.value;
        const items: ControlItem[] = [];
        for (const state of INTENT_STATES) {
          const row = v.by_state.find((s) => s.state === state);
          items.push(controlItem({
            id: `state:${state}`, label: STATE_NO[state] ?? state, status: "OK",
            detail_no: `${row?.n ?? 0} intensjoner. Beløpet står i måledata (amount_ore, øre) og vises aldri til en modell.`, facts: { count: row?.n ?? 0, amount_ore: row?.ore ?? 0 }
          }));
        }
        items.push(controlItem({
          id: "outcome_unknown", label: "Utfall ukjent (sendt, ingen svar fra leverandøren)", status: v.outcome_unknown > 0 ? "FAIL" : "OK",
          detail_no: v.outcome_unknown > 0
            ? `${v.outcome_unknown} intensjon(er) står som «sendt» uten leverandørreferanse etter at innsendingsleasen er utløpt - det er ukjent om pengene beveget seg. Avstem i leverandørens portal; Jarvis sender den aldri på nytt av seg selv.`
            : "Ingen intensjoner med ukjent utfall.",
          facts: { count: v.outcome_unknown, lease_ms: SUBMIT_INFLIGHT_LEASE_MS }
        }));
        items.push(controlItem({
          id: "flagged", label: "Intensjoner med avviksflagg", status: v.flagged > 0 ? "WARN" : "OK",
          detail_no: v.flagged > 0 ? `${v.flagged} intensjon(er) har deterministiske avviksflagg (se Avvik).` : "Ingen avviksflagg.", facts: { count: v.flagged }
        }));
        items.push(controlItem({
          id: "settled_unreconciled", label: "Oppgjort men ikke avstemt", status: v.settled_unreconciled > 0 ? "WARN" : "OK",
          detail_no: v.settled_unreconciled > 0 ? `${v.settled_unreconciled} oppgjorte intensjon(er) er ikke avstemt mot leverandør/regnskap.` : "Alle oppgjorte intensjoner er avstemt.", facts: { count: v.settled_unreconciled }
        }));
        items.push(controlItem({
          id: "failed_7d", label: "Feilet siste 7 døgn", status: v.failed_7d > 0 ? "WARN" : "OK",
          detail_no: v.failed_7d > 0 ? `${v.failed_7d} intensjon(er) feilet siste 7 døgn.` : "Ingen feilede intensjoner siste 7 døgn.", facts: { count: v.failed_7d }
        }));
        if (v.provider_objects.length > 0) {
          const open = v.provider_objects.filter((o) => o.state === "submitted" || o.state === "provider_acknowledged").reduce((a, o) => a + o.n, 0);
          const failedObjects = v.provider_objects.filter((o) => o.state === "failed").reduce((a, o) => a + o.n, 0);
          items.push(controlItem({
            id: "provider_objects", label: "Refusjoner og belastninger hos leverandør (Stripe/Vipps)", status: failedObjects > 0 ? "WARN" : "OK",
            detail_no: `${v.provider_objects.reduce((a, o) => a + o.n, 0)} objekter, ${open} under behandling, ${failedObjects} feilet.`,
            facts: { total: v.provider_objects.reduce((a, o) => a + o.n, 0), in_flight: open, failed: failedObjects }
          }));
        }
        items.sort(bySeverityThenLabel);
        const total = v.by_state.reduce((a, s) => a + s.n, 0);
        sections.push(controlSection({
          id: "intents", title_no: "Betalingsintensjoner", observed_at: nowIso, items,
          source: "payment_intents + stripe_refunds/vipps_captures/vipps_refunds (tenant + minnerom-RLS; formål, leverandørnavn og kontoer leses aldri)",
          summary_no: `${total} intensjoner (${v.created_30d} nye siste 30 døgn), ${v.in_flight} under behandling. ${v.outcome_unknown > 0 ? `${v.outcome_unknown} med UKJENT utfall. ` : ""}Leverandører: ${v.by_provider.map((p) => `${p.provider} ${p.n}`).join(", ") || "ingen"}. Ingen finans-credentials = intensjonene blir stående som utkast (dvale).`
        }));
      } else {
        sections.push(unknownControlSection("intents", "Betalingsintensjoner", "payment_intents (tenant + minnerom-RLS)", `kunne ikke leses${failed(intentsR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 2. Forbruk og faste kostnader
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (spendR.ok) {
        const v = spendR.value;
        const items: ControlItem[] = [];
        for (const c of v.by_category) {
          items.push(controlItem({
            id: `category:${c.category}`, label: `Forbruk siste ${SPEND_WINDOW_DAYS} døgn: ${c.category}`, status: c.conflicts > 0 ? "WARN" : "OK",
            detail_no: `${c.n} poster${c.estimated > 0 ? ` (${c.estimated} estimerte)` : ""}${c.unreconciled > 0 ? `, ${c.unreconciled} ikke avstemt` : ""}${c.conflicts > 0 ? `, ${c.conflicts} med korreksjonskonflikt` : ""}.`,
            facts: { count: c.n, amount_ore: c.ore, estimated: c.estimated, unreconciled: c.unreconciled, correction_conflicts: c.conflicts }
          }));
        }
        for (const family of ["marketing", "model_cost"]) {
          const cursor = v.cursors.find((c) => c.source_family === family);
          const age = cursor?.last_synced_at ? nowMs - Date.parse(cursor.last_synced_at) : null;
          const status: ControlStatus = cursor?.last_synced_at ? (age !== null && age > SPEND_SYNC_STALE_MS ? "WARN" : "OK") : "UNKNOWN";
          items.push(controlItem({
            id: `sync:${family}`, label: `Utgiftssynk: ${family === "marketing" ? "markedsføring" : "modellkostnad"}`, status, observed_at: cursor?.last_synced_at ?? null,
            detail_no: cursor?.last_synced_at ? `Sist synket ${rel(cursor.last_synced_at)}${status === "WARN" ? " - synken kjører daglig, så den står trolig fast" : ""}.` : "Aldri synket (ikke målt): ingen utgiftsposter fra denne kilden finnes ennå.",
            facts: { last_synced_at: cursor?.last_synced_at ?? null }
          }));
        }
        const commitmentTotal = v.commitments.reduce((a, c) => a + c.n, 0);
        const commitmentOverdue = v.commitments.reduce((a, c) => a + c.overdue, 0);
        items.push(controlItem({
          id: "commitments", label: "Faste trekk (abonnement)", status: commitmentOverdue > 0 ? "WARN" : "OK",
          detail_no: `${commitmentTotal} faste trekk (${v.commitments.map((c) => `${c.state} ${c.n}`).join(", ") || "ingen"}).${commitmentOverdue > 0 ? ` ${commitmentOverdue} aktive trekk har ikke kommet på over 7 døgn etter forventet dato.` : ""}`,
          facts: { total: commitmentTotal, overdue_7d: commitmentOverdue }
        }));
        const procurementTotal = v.procurement.reduce((a, c) => a + c.n, 0);
        const procurementOverdue = v.procurement.reduce((a, c) => a + c.overdue, 0);
        items.push(controlItem({
          id: "procurement", label: "Forventede innkjøp", status: procurementOverdue > 0 ? "WARN" : "OK",
          detail_no: `${procurementTotal} innkjøp (${v.procurement.map((c) => `${c.status} ${c.n}`).join(", ") || "ingen"}).${procurementOverdue > 0 ? ` ${procurementOverdue} er forfalt uten at utgiften er sett.` : ""}`,
          facts: { total: procurementTotal, overdue: procurementOverdue }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "spend", title_no: "Forbruk og faste kostnader", observed_at: nowIso, items,
          source: "finance_spend_records + finance_recurring_commitments + finance_procurement_items + finance_spend_sync_cursors (tenant + minnerom-RLS; leverandørnavn og beskrivelser leses aldri)",
          summary_no: `${v.by_category.reduce((a, c) => a + c.n, 0)} forbruksposter siste ${SPEND_WINDOW_DAYS} døgn (markedsføring og modellkostnad slik utgiftssynken ser dem - ikke regnskapet; beløpene står i måledata). ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("spend", "Forbruk og faste kostnader", "finance_spend_records + faste trekk + innkjøp (tenant + minnerom-RLS)", `kunne ikke leses${failed(spendR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 3. Avvik
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (anomaliesR.ok) {
        const v = anomaliesR.value;
        const items: ControlItem[] = v.flags.map((f) => controlItem({
          id: `flag:${f.source}:${f.flag}`, label: `${f.flag} (${f.source})`, status: "WARN",
          detail_no: `${f.n} rad(er) i «${f.source}» har avviksflagget ${f.flag}. Flaggene settes av deterministisk kode (aldri en modell).`, facts: { source: f.source, flag: f.flag, count: f.n }
        }));
        for (const l of v.open_loops) {
          items.push(controlItem({
            id: `loop:${l.loop_type}`, label: `Åpen sak: ${l.loop_type}`, status: "WARN",
            detail_no: `${l.n} åpne finanssaker av typen ${l.loop_type} venter på deg (Business OS).`, facts: { loop_type: l.loop_type, count: l.n }
          }));
        }
        items.sort(bySeverityThenLabel);
        const flagTotal = v.flags.reduce((a, f) => a + f.n, 0);
        sections.push(controlSection({
          id: "anomalies", title_no: "Avvik", observed_at: nowIso, items,
          source: "anomaly_flags i 10 finanstabeller (kun kategorinavn) + business_open_loops (åpne finanssaker; tenant + minnerom-RLS)",
          summary_no: items.length === 0 ? "Ingen avviksflagg og ingen åpne finanssaker." : `${flagTotal} flaggede rader fordelt på ${v.flags.length} flaggtyper, ${v.open_loops.reduce((a, l) => a + l.n, 0)} åpne finanssaker.`
        }));
      } else {
        sections.push(unknownControlSection("anomalies", "Avvik", "anomaly_flags + business_open_loops (tenant + minnerom-RLS)", `kunne ikke leses${failed(anomaliesR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 4. Leverandører og kontoer
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (vendorsR.ok) {
        const v = vendorsR.value;
        const items: ControlItem[] = [];
        items.push(controlItem({
          id: "vendors", label: "Leverandørregister", status: v.vendors_unbound > 0 ? "WARN" : "OK",
          detail_no: `${v.vendors} leverandører, ${v.vendors_unbound} uten aktiv binding til en betalingsleverandør (kan ikke brukes i en intensjon før den er bundet).`,
          facts: { vendors: v.vendors, unbound: v.vendors_unbound, active_bindings: v.bindings.filter((b) => b.status === "active").reduce((a, b) => a + b.n, 0), revoked_bindings: v.bindings.filter((b) => b.status === "revoked").reduce((a, b) => a + b.n, 0) }
        }));
        for (const c of v.consents) {
          const expMs = c.expires_at ? Date.parse(c.expires_at) : null;
          const expired = c.state === "expired" || (expMs !== null && expMs < nowMs);
          const soon = !expired && c.state === "active" && expMs !== null && expMs - nowMs < CONSENT_EXPIRY_WARN_MS;
          items.push(controlItem({
            id: `consent:${c.consent_id}`, label: `Banksamtykke ${c.consent_id.slice(0, 14)}`, status: c.state === "active" && !expired ? (soon ? "WARN" : "OK") : c.state === "revoked" || c.state === "rejected" ? "OK" : "WARN", observed_at: c.last_verified_at,
            detail_no: `Tilstand: ${c.state}${c.expires_at ? `; utløper ${c.expires_at}` : ""}${expired && c.state === "active" ? " - UTLØPT, fornyes hos banken" : soon ? " - utløper snart, må fornyes" : ""}.`,
            facts: { state: c.state, expires_at: c.expires_at, last_verified_at: c.last_verified_at }
          }));
        }
        items.push(controlItem({
          id: "bank_accounts", label: "Bankkontoer (lesetilgang)", status: "OK", observed_at: v.accounts.last_synced_at,
          detail_no: `${v.accounts.total} kontoer (${v.accounts.active} aktive); sist synket ${rel(v.accounts.last_synced_at)}. Kontonavn og -nummer vises aldri.`,
          facts: { total: v.accounts.total, active: v.accounts.active, last_synced_at: v.accounts.last_synced_at }
        }));
        if (v.cards.length > 0) {
          const frozen = v.cards.filter((c) => c.state === "frozen").reduce((a, c) => a + c.n, 0);
          items.push(controlItem({
            id: "cards", label: "Kort (Wallester)", status: "OK", detail_no: `${v.cards.reduce((a, c) => a + c.n, 0)} kort (${v.cards.map((c) => `${c.state} ${c.n}`).join(", ")}); ${frozen} fryst.`,
            facts: { total: v.cards.reduce((a, c) => a + c.n, 0), frozen }
          }));
        }
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "vendors_accounts", title_no: "Leverandører og kontoer", observed_at: nowIso, items,
          source: "finance_vendors + finance_vendor_provider_bindings + bank_consents + bank_accounts + provider_cards (tenant + minnerom-RLS; navn og kontonumre leses aldri)",
          summary_no: `${v.vendors} leverandører, ${v.accounts.total} bankkontoer, ${v.consents.length} samtykker, ${v.cards.reduce((a, c) => a + c.n, 0)} kort. ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("vendors_accounts", "Leverandører og kontoer", "finance_vendors + bank_consents + bank_accounts + provider_cards (tenant + minnerom-RLS)", `kunne ikke leses${failed(vendorsR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 5. Avstemming
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (reconR.ok) {
        const v = reconR.value;
        const items: ControlItem[] = [];
        const run = v.last_run;
        if (run === null) {
          items.push(controlItem({
            id: "last_run", label: "Siste avstemmingskjøring", status: "UNKNOWN",
            detail_no: "Ingen avstemmingskjøring er registrert (den planlagte sveipen finance-reconcile-sweep har ikke kjørt, eller er av). Ukjent om pengene stemmer - dette er IKKE «i orden».", facts: { has_run: false }
          }));
        } else {
          const startedMs = run.started_at ? Date.parse(run.started_at) : null;
          const ageMs = startedMs === null ? null : nowMs - startedMs;
          const runningStale = run.status === "running" && ageMs !== null && ageMs > RECONCILE_RUNNING_STALE_MS;
          const status: ControlStatus = run.status === "failed" ? "FAIL" : runningStale ? "WARN" : ageMs !== null && ageMs > RECONCILE_STALE_MS ? "WARN" : run.status === "completed" || run.status === "running" ? "OK" : "UNKNOWN";
          items.push(controlItem({
            id: "last_run", label: "Siste avstemmingskjøring", status, observed_at: run.finished_at ?? run.started_at,
            detail_no: `${run.trigger === "manual" ? "Manuell" : "Planlagt"} kjøring ${run.status}, startet ${rel(run.started_at)}${run.status === "failed" ? " - kjøringen feilet" : ""}${runningStale ? " - står som «pågår» uten å bli ferdig" : ""}${ageMs !== null && ageMs > RECONCILE_STALE_MS ? " - avstemmingen skal kjøre daglig" : ""}.`,
            facts: { run_id: run.run_id, status: run.status, trigger: run.trigger, started_at: run.started_at, finished_at: run.finished_at, had_error: run.has_error }
          }));
          for (const c of run.checks) {
            const outcome = c.outcome;
            const cStatus: ControlStatus = outcome === "ok" ? "OK" : outcome.startsWith("failed") ? "FAIL" : outcome === "incomplete" ? "WARN" : outcome === "skipped_no_credentials" ? "UNKNOWN" : "UNKNOWN";
            items.push(controlItem({
              id: `check:${c.check}`, label: `Avstemmingssjekk: ${c.check}`, status: cStatus,
              detail_no: outcome === "ok" ? "Utført uten funn om selve kjøringen." : outcome === "skipped_no_credentials" ? "Hoppet over: mangler credentials hos leverandøren (dvale) - denne delen er IKKE målt." : outcome === "incomplete" ? "Ufullstendig: leverandørlisten er ikke bevist komplett." : `Resultat: ${outcome}.`,
              facts: { check: c.check, outcome }
            }));
          }
        }
        for (const f of v.open_findings) {
          items.push(controlItem({
            id: `finding:${f.severity}:${f.kind}`, label: `Funn: ${FINDING_KIND_NO[f.kind] ?? f.kind}`, status: f.severity === "critical" ? "FAIL" : f.severity === "warning" ? "WARN" : "OK", observed_at: f.oldest_at,
            detail_no: `${f.n} åpne funn (${f.severity}), eldste sett ${rel(f.oldest_at)}${f.max_reopen > 0 ? `, gjenåpnet opptil ${f.max_reopen} ganger` : ""}. Funnene er observasjoner - ingenting korrigeres automatisk.`,
            facts: { severity: f.severity, kind: f.kind, count: f.n, oldest_at: f.oldest_at, max_reopen_count: f.max_reopen }
          }));
        }
        for (const b of v.bank_unmatched) {
          items.push(controlItem({
            id: `bank:${b.state}`, label: `Banktransaksjoner: ${b.state}`, status: "WARN", detail_no: `${b.n} banktransaksjoner er ${b.state} mot intensjonene.`, facts: { state: b.state, count: b.n }
          }));
        }
        for (const w of v.webhooks_unhealthy) {
          items.push(controlItem({
            id: `webhook:${w.provider}:${w.status}`, label: `Leverandørvarsler: ${w.provider} (${w.status})`, status: "WARN",
            detail_no: `${w.n} varsler fra ${w.provider} siste ${WEBHOOK_WINDOW_DAYS} døgn er ${w.status} (ikke behandlet).`, facts: { provider: w.provider, status: w.status, count: w.n }
          }));
        }
        items.sort(bySeverityThenLabel);
        const critical = v.open_findings.filter((f) => f.severity === "critical").reduce((a, f) => a + f.n, 0);
        const warning = v.open_findings.filter((f) => f.severity === "warning").reduce((a, f) => a + f.n, 0);
        sections.push(controlSection({
          id: "reconciliation", title_no: "Avstemming", observed_at: nowIso, items,
          source: "finance_reconciliation_runs + finance_reconciliation_findings + bank_transactions + *_webhook_events (tenant + minnerom-RLS; funn-sammendrag leses aldri)",
          summary_no: `${critical} kritiske og ${warning} advarselsfunn åpne; ${v.resolved_7d} løst siste 7 døgn. Avstemming er observasjon: ingen automatisk korreksjon. Manuell disposisjon av ukjent utfall er DEFERRED (ikke bygget).`
        }));
      } else {
        sections.push(unknownControlSection("reconciliation", "Avstemming", "finance_reconciliation_runs + finance_reconciliation_findings (tenant + minnerom-RLS)", `kunne ikke leses${failed(reconR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 6. Finans-nødbryter (TILSTAND + den eksisterende bryteren; samme handling som Autoritet-senteret)
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (killR.ok) {
        const k = killR.value;
        sections.push(controlSection({
          id: KILL_SECTION, title_no: "Finans-nødbryter", observed_at: nowIso, status: k.enabled ? "WARN" : "OK",
          source: "finance_kill_switch (tenant-RLS)",
          summary_no: k.enabled ? `AKTIV siden ${rel(k.enabled_at)}: alle spend-muliggjørende finans- og kort-handlinger er stanset.` : "Av: finans kjører normalt (hver penge-handling krever fortsatt egen signert godkjenning og step-up).",
          items: [controlItem({
            id: "finance_kill_switch", label: "Finans-nødbryter", status: k.enabled ? "WARN" : "OK", observed_at: k.enabled_at,
            detail_no: k.enabled ? "Aktiv - ingen nye penge-handlinger slippes gjennom." : "Av.", facts: { enabled: k.enabled, since: k.enabled_at }
          })]
        }));
        actions.push(k.enabled
          ? controlAction({
            id: "finance.kill_switch.disable", label: "Opphev finans-nødbryter", endpoint: "/executive/mutate", body: { action: "disable_finance_kill_switch", parameters: {} },
            risk_class: riskOf(deps.toolGateway, "executive", "disable_finance_kill_switch"), requires_step_up: actionRequiresStepUp("disable_finance_kill_switch"), reversible: true,
            description_no: "Opphever finans-nødbryteren: spend-muliggjørende handlinger kan igjen utføres (med sine egne godkjenninger).", rollback_no: "Aktiver finans-nødbryteren igjen.", section_id: KILL_SECTION, item_id: "finance_kill_switch"
          })
          : controlAction({
            id: "finance.kill_switch.enable", label: "Aktiver finans-nødbryter", endpoint: "/executive/mutate", body: { action: "enable_finance_kill_switch", parameters: { reason: "Stanset av eier fra kontrollsenteret" } },
            risk_class: riskOf(deps.toolGateway, "executive", "enable_finance_kill_switch"), requires_step_up: actionRequiresStepUp("enable_finance_kill_switch"), reversible: true,
            description_no: "Stanser ALLE spend-muliggjørende finans- og kort-handlinger for tenanten umiddelbart.", rollback_no: "Opphev finans-nødbryteren (krever signert enhetsøkt).", section_id: KILL_SECTION, item_id: "finance_kill_switch"
          }));
      } else {
        sections.push(unknownControlSection(KILL_SECTION, "Finans-nødbryter", "finance_kill_switch (tenant-RLS)", `kunne ikke leses${failed(killR)} - behandles ikke som «av»`));
      }

      return { sections, actions };
    }
  };
}
