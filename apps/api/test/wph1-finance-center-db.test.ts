import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { createFinanceCenter, readAnomalies, readIntents, readReconciliation, readSpend, readVendorsAccounts } from "../src/control-center/finance.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H1 Finance Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder). Beviser at:
 *  - alle lesespørringene kjører med rollens faktiske GRANT-er og kolonner (intensjoner, forbruk, avvik, leverandører/kontoer, avstemming, bryter);
 *  - tenant-isolasjon: A ser kun egne rader - aldri B sine, i noen seksjon;
 *  - innholdsvern: leverandørnavn, formål, motpart, referansetekst, kontoidentifikatorer og funn-sammendrag leses aldri og når aldri rapporten;
 *  - senteret skriver ingenting (radtall i alle berørte tabeller er uendret).
 */
let db: H0Db;
const TENANT_A = "tenant-fin-a";
const TENANT_B = "tenant-fin-b";
const NOW = new Date();
const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const ahead = (ms: number): Date => new Date(NOW.getTime() + ms);
const idA: IdentityContext = { person_id: "person-fin-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-fin-b", tenant_id: TENANT_B };
const defs = productionToolDefinitions();
const HIDDEN_VENDOR = "Hemmelig Leverandør AS";
const HIDDEN_PURPOSE = "privat formål som aldri skal vises";
const HIDDEN_COUNTERPARTY = "Hemmelig Motpart";
const HIDDEN_REF = "KID-9988776655-hemmelig";
const HIDDEN_SUMMARY = "funn-sammendrag med kontonummer 12345678901";
const HIDDEN_ACCOUNT = "NO9386011117947-hemmelig";

const TABLES_TOUCHED = [
  "payment_intents", "stripe_refunds", "vipps_captures", "vipps_refunds", "finance_spend_records", "finance_recurring_commitments", "finance_procurement_items", "finance_spend_sync_cursors",
  "finance_vendors", "finance_vendor_provider_bindings", "bank_consents", "bank_accounts", "bank_transactions", "provider_cards", "card_authorizations", "finance_reconciliation_runs",
  "finance_reconciliation_findings", "stripe_webhook_events", "vipps_webhook_events", "neonomics_webhook_events", "wallester_webhook_events", "business_open_loops", "finance_kill_switch"
] as const;

async function intent(id: string, tenant: string, over: Record<string, unknown> = {}): Promise<void> {
  const row = {
    state: "draft", amount_ore: 10_000, provider: "fiken", reconciliation_state: "unreconciled", provider_ref: null, submitted_at: null, failed_at: null, anomaly_flags: [], ...over
  };
  await db.adminPool.query(
    `INSERT INTO payment_intents (payment_intent_id, tenant_id, idempotency_key, state, purpose, amount_ore, vendor_name, account_code, provider, provider_ref, reconciliation_state, submitted_at, failed_at, anomaly_flags)
     VALUES ($1, $2, $1, $3, $4, $5, $6, '6300', $7, $8, $9, $10, $11, $12::jsonb)`,
    [id, tenant, row.state, HIDDEN_PURPOSE, row.amount_ore, HIDDEN_VENDOR, row.provider, row.provider_ref, row.reconciliation_state, row.submitted_at, row.failed_at, JSON.stringify(row.anomaly_flags)]
  );
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES_TOUCHED) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
}

beforeAll(async () => {
  db = await startH0Db("fin");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }]);

  // Intensjoner (A): oppgjort+avstemt, oppgjort+uavstemt, ukjent utfall (sendt for 10 min siden uten referanse), pågående (sendt for 30 s siden), feilet for 2 døgn siden, utkast med avviksflagg
  await intent("pi-a-settled", TENANT_A, { state: "settled", amount_ore: 150_000, reconciliation_state: "matched", provider_ref: "ref-1" });
  await intent("pi-a-unrec", TENANT_A, { state: "settled", amount_ore: 50_000, provider: "stripe", provider_ref: "ref-2" });
  await intent("pi-a-unknown", TENANT_A, { state: "submitted", amount_ore: 20_000, submitted_at: ago(10 * MIN) });
  await intent("pi-a-inflight", TENANT_A, { state: "submitted", amount_ore: 5_000, submitted_at: ago(30_000) });
  await intent("pi-a-failed", TENANT_A, { state: "failed", amount_ore: 7_000, failed_at: ago(2 * D) });
  await intent("pi-a-flag", TENANT_A, { state: "draft", amount_ore: 1_000, anomaly_flags: ["vendor_provider_ref_missing_at_submission", { hemmelig: HIDDEN_REF }] });
  await intent("pi-b-1", TENANT_B, { state: "settled", amount_ore: 999_000, reconciliation_state: "matched" });
  await intent("pi-b-unknown", TENANT_B, { state: "submitted", amount_ore: 888, submitted_at: ago(20 * MIN), anomaly_flags: ["b_only_flag"] });

  await admin.query(`INSERT INTO stripe_refunds (refund_id, tenant_id, payment_intent_id, idempotency_key, state, amount_ore, currency) VALUES ('sr-a-1', $1, 'pi-a-unrec', 'sr-a-1', 'submitted', 1000, 'NOK'), ('sr-a-2', $1, 'pi-a-unrec', 'sr-a-2', 'failed', 500, 'NOK')`, [TENANT_A]);
  await admin.query(`INSERT INTO vipps_captures (capture_id, tenant_id, payment_intent_id, idempotency_key, state, amount_ore, currency) VALUES ('vc-b-1', $1, 'pi-b-1', 'vc-b-1', 'failed', 100, 'NOK')`, [TENANT_B]);

  // Forbruk
  await admin.query(
    `INSERT INTO finance_spend_records (spend_record_id, tenant_id, source_family, source_record_id, occurred_at, amount_ore, category, source_amount_status, source_correction_state, reconciliation_state, anomaly_flags)
     VALUES ('sp-a-1', $1, 'marketing', 'm1', $2, 20000, 'marketing_spend', 'settled', 'original', 'matched', '[]'::jsonb),
            ('sp-a-2', $1, 'model_cost', 'c1', $2, 3000, 'ai_api_cost', 'estimated', 'correction_conflict', 'unreconciled', '["spend_amount_deviation"]'::jsonb),
            ('sp-a-old', $1, 'model_cost', 'c0', $3, 999999, 'ai_api_cost', 'settled', 'original', 'matched', '[]'::jsonb),
            ('sp-b-1', $4, 'marketing', 'mb', $2, 777000, 'marketing_spend', 'settled', 'original', 'matched', '[]'::jsonb)`,
    [TENANT_A, ago(2 * D), ago(60 * D), TENANT_B]
  );
  await admin.query(`INSERT INTO finance_spend_sync_cursors (tenant_id, source_family, last_synced_at) VALUES ($1, 'marketing', $2), ($1, 'model_cost', $3), ($4, 'marketing', $2)`, [TENANT_A, ago(3 * H), ago(5 * D), TENANT_B]);
  await admin.query(
    `INSERT INTO finance_recurring_commitments (commitment_id, tenant_id, vendor_name, description, cadence, expected_amount_ore, start_date, state, next_expected_charge_at, anomaly_flags)
     VALUES ('rc-a-1', $1, $2, 'abonnement', 'monthly', 9900, '2026-01-01', 'active', $3, '["recurring_missing"]'::jsonb), ('rc-a-2', $1, $2, 'x', 'monthly', 100, '2026-01-01', 'paused', NULL, '[]'::jsonb), ('rc-b-1', $4, $2, 'y', 'monthly', 100, '2026-01-01', 'active', $3, '[]'::jsonb)`,
    [TENANT_A, HIDDEN_VENDOR, ago(10 * D), TENANT_B]
  );
  await admin.query(
    `INSERT INTO finance_procurement_items (procurement_item_id, tenant_id, vendor_name, description, expected_amount_ore, expected_date, expected_window_days, status)
     VALUES ('pr-a-1', $1, $2, 'innkjøp', 50000, '2026-01-01', 2, 'expected'), ('pr-a-2', $1, $2, 'innkjøp2', 50000, '2026-01-01', 2, 'fulfilled'), ('pr-b-1', $3, $2, 'z', 1, '2026-01-01', 0, 'expected')`,
    [TENANT_A, HIDDEN_VENDOR, TENANT_B]
  );

  // Avvik: åpne finanssaker
  await admin.query(
    `INSERT INTO business_open_loops (open_loop_id, tenant_id, loop_type, detection_key, reason) VALUES ('ol-a-1', $1, 'finance_spend_unexpected', 'k1', 'privat grunn'), ('ol-a-2', $1, 'finance_spend_unexpected', 'k2', 'privat grunn'), ('ol-a-3', $1, 'overdue_followup', 'k3', 'ikke finans'), ('ol-b-1', $2, 'payment_intent_anomaly', 'kb', 'b')`,
    [TENANT_A, TENANT_B]
  );

  // Leverandører og kontoer
  await admin.query(`INSERT INTO finance_vendors (vendor_id, tenant_id, name) VALUES ('v-a-1', $1, $3), ('v-a-2', $1, $3), ('v-b-1', $2, $3)`, [TENANT_A, TENANT_B, HIDDEN_VENDOR]);
  await admin.query(
    `INSERT INTO finance_vendor_provider_bindings (binding_id, tenant_id, vendor_id, provider, provider_vendor_ref, status) VALUES ('b-a-1', $1, 'v-a-1', 'stripe', 'ref-stripe-1', 'active'), ('b-a-2', $1, 'v-a-2', 'fiken', 'ref-fiken-2', 'revoked'), ('b-b-1', $2, 'v-b-1', 'stripe', 'ref-stripe-b', 'active')`,
    [TENANT_A, TENANT_B]
  );
  await admin.query(
    `INSERT INTO bank_consents (consent_id, tenant_id, bank_id, bank_name, state, expires_at, last_verified_at) VALUES
       ('bc-a-active', $1, 'bank-x', $3, 'active', $4, $5), ('bc-a-soon', $1, 'bank-y', $3, 'active', $6, $5), ('bc-a-expired', $1, 'bank-z', $3, 'expired', $7, $5), ('bc-b-1', $2, 'bank-b', $3, 'active', $4, $5)`,
    [TENANT_A, TENANT_B, HIDDEN_VENDOR, ahead(60 * D), ago(H), ahead(3 * D), ago(5 * D)]
  );
  await admin.query(
    `INSERT INTO bank_accounts (bank_account_id, tenant_id, provider_account_id, consent_id, bank_id, account_name, account_identifier_masked, active, last_synced_at) VALUES
       ('ba-a-1', $1, 'pa-1', 'bc-a-active', 'bank-x', $3, $4, true, $5), ('ba-a-2', $1, 'pa-2', 'bc-a-soon', 'bank-y', $3, $4, false, NULL), ('ba-b-1', $2, 'pa-b', 'bc-b-1', 'bank-b', $3, $4, true, $5)`,
    [TENANT_A, TENANT_B, HIDDEN_VENDOR, HIDDEN_ACCOUNT, ago(2 * H)]
  );
  await admin.query(
    `INSERT INTO bank_transactions (bank_transaction_id, tenant_id, bank_account_id, provider_transaction_id, direction, amount_ore, currency, counterparty_name, reference_text, reconciliation_state, anomaly_flags) VALUES
       ('bt-a-1', $1, 'ba-a-1', 'pt-1', 'debit', 100, 'NOK', $3, $4, 'unmatched', '["bank_unexpected_debit"]'::jsonb), ('bt-a-2', $1, 'ba-a-1', 'pt-2', 'credit', 200, 'NOK', $3, $4, 'matched', '[]'::jsonb),
       ('bt-b-1', $2, 'ba-b-1', 'pt-b', 'debit', 100, 'NOK', $3, $4, 'ambiguous', '[]'::jsonb)`,
    [TENANT_A, TENANT_B, HIDDEN_COUNTERPARTY, HIDDEN_REF]
  );
  await admin.query(
    `INSERT INTO provider_cards (card_id, tenant_id, idempotency_key, name, purpose, card_type, state, vendor_name) VALUES
       ('pc-a-1', $1, 'k1', $3, $4, 'virtual', 'active', $3), ('pc-a-2', $1, 'k2', $3, $4, 'virtual', 'frozen', $3), ('pc-b-1', $2, 'k3', $3, $4, 'virtual', 'frozen', $3)`,
    [TENANT_A, TENANT_B, HIDDEN_VENDOR, HIDDEN_PURPOSE]
  );
  await admin.query(
    `INSERT INTO card_authorizations (authorization_id, tenant_id, card_id, provider_authorization_id, status, amount_ore, currency, merchant_name, anomaly_flags) VALUES ('ca-a-1', $1, 'pc-a-1', 'pa-1', 'approved', 100, 'EUR', $2, '["card_declined_burst"]'::jsonb)`,
    [TENANT_A, HIDDEN_COUNTERPARTY]
  );

  // Avstemming: A har en fullført kjøring (Fiken hoppet over uten credentials, lokal ok) og åpne/løste funn; B har et eget funn
  await admin.query(
    `INSERT INTO finance_reconciliation_runs (run_id, tenant_id, status, trigger, started_at, finished_at, checks, summary) VALUES
       ('rr-a-old', $1, 'completed', 'sweep', $2, $2, '{"local":"ok"}'::jsonb, '{}'::jsonb),
       ('rr-a-new', $1, 'completed', 'sweep', $3, $3, '{"local":"ok","fiken":"skipped_no_credentials","stripe":"failed:timeout"}'::jsonb, '{}'::jsonb),
       ('rr-b-1', $4, 'failed', 'manual', $3, $3, '{}'::jsonb, '{}'::jsonb)`,
    [TENANT_A, ago(3 * D), ago(2 * H), TENANT_B]
  );
  await admin.query(
    `INSERT INTO finance_reconciliation_findings (finding_id, tenant_id, finding_key, kind, severity, subject_type, subject_id, payment_intent_id, summary, status, first_seen_at, last_seen_at, resolved_at, reopen_count) VALUES
       ('rf-a-1', $1, 'k:1', 'submit_outcome_unknown', 'critical', 'payment_intent', 'pi-a-unknown', 'pi-a-unknown', $3, 'open', $4, $4, NULL, 2),
       ('rf-a-2', $1, 'k:2', 'settled_unreconciled', 'info', 'payment_intent', 'pi-a-unrec', 'pi-a-unrec', $3, 'open', $4, $4, NULL, 0),
       ('rf-a-3', $1, 'k:3', 'webhook_rejected', 'warning', 'webhook_event', 'stripe:x', NULL, $3, 'resolved', $4, $4, $5, 0),
       ('rf-b-1', $2, 'k:4', 'over_refunded', 'critical', 'payment_intent', 'pi-b-1', 'pi-b-1', $3, 'open', $4, $4, NULL, 0)`,
    [TENANT_A, TENANT_B, HIDDEN_SUMMARY, ago(5 * D), ago(D)]
  );
  await admin.query(`INSERT INTO stripe_webhook_events (stripe_event_id, tenant_id, event_type, stripe_created_at, status, received_at) VALUES ('se-a-1', $1, 'charge.failed', $3, 'rejected', $3), ('se-a-2', $1, 'x', $3, 'processed', $3), ('se-a-old', $1, 'x', $4, 'rejected', $4), ('se-b-1', $2, 'x', $3, 'rejected', $3)`, [TENANT_A, TENANT_B, ago(H), ago(30 * D)]);
  await admin.query(`INSERT INTO vipps_webhook_events (dedupe_key, tenant_id, event_name, status, received_at) VALUES ('ve-a-1', $1, 'x', 'failed_retryable', $2)`, [TENANT_A, ago(H)]);
  await admin.query(`INSERT INTO neonomics_webhook_events (dedupe_key, tenant_id, provider_payment_id, payment_status, status, received_at) VALUES ('ne-a-1', $1, 'p1', 's', 'unsupported', $2), ('ne-b-1', $3, 'p1', 's', 'rejected', $2)`, [TENANT_A, ago(H), TENANT_B]);
  await admin.query(`INSERT INTO wallester_webhook_events (dedupe_key, tenant_id, event_type, provider_object_id, status, received_at) VALUES ('we-a-1', $1, 'x', 'o', 'rejected', $2), ('we-null', NULL, 'x', 'o', 'rejected', $2)`, [TENANT_A, ago(H)]);
  await admin.query(`INSERT INTO finance_kill_switch (tenant_id, enabled, enabled_by_person_id, enabled_at, reason) VALUES ($1, true, $2, $3, $4)`, [TENANT_A, idA.person_id, ago(4 * H), HIDDEN_PURPOSE]);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

function center(): ReturnType<typeof createFinanceCenter> {
  return createFinanceCenter({ pool: db.appPool, toolGateway: { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) } });
}
async function report(identity: IdentityContext): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center());
  return (await registry.report("finance", identity)) as ControlCenterReport;
}
const sec = (r: ControlCenterReport, id: string) => r.sections.find((s) => s.id === id)!;
const item = (r: ControlCenterReport, section: string, id: string) => sec(r, section).items.find((i) => i.id === id)!;

describe("lesespørringene som app-rolle (ekte SQL, ekte GRANT-er, RLS)", () => {
  it("intensjoner: tilstander, beløp, ukjent utfall (kun etter leasen), pågående, uavstemt, feilet, flagg - kun A", async () => {
    const v = await readIntents(db.appPool, TENANT_A, NOW.getTime());
    expect(Object.fromEntries(v.by_state.map((s) => [s.state, s.n]))).toEqual({ settled: 2, submitted: 2, failed: 1, draft: 1 });
    expect(v.by_state.find((s) => s.state === "settled")?.ore).toBe(200_000);
    expect(v).toMatchObject({ outcome_unknown: 1, in_flight: 2, flagged: 1, settled_unreconciled: 1, failed_7d: 1, created_30d: 6 });
    expect(Object.fromEntries(v.by_provider.map((p) => [p.provider, p.n]))).toEqual({ fiken: 5, stripe: 1 });
    expect(v.provider_objects).toEqual(expect.arrayContaining([{ kind: "stripe_refund", state: "submitted", n: 1 }, { kind: "stripe_refund", state: "failed", n: 1 }]));
    expect(v.provider_objects.some((o) => o.kind === "vipps_capture")).toBe(false); // B sin capture
    const b = await readIntents(db.appPool, TENANT_B, NOW.getTime());
    expect(b).toMatchObject({ outcome_unknown: 1, flagged: 1 });
    expect(b.by_state.find((s) => s.state === "settled")?.ore).toBe(999_000);
  });

  it("forbruk: kun siste 30 døgn, estimert/uavstemt/korreksjonskonflikt telles, synk-markører og forfalte trekk/innkjøp", async () => {
    const v = await readSpend(db.appPool, TENANT_A, NOW.getTime());
    expect(v.by_category).toEqual(expect.arrayContaining([
      { category: "marketing_spend", n: 1, ore: 20_000, estimated: 0, unreconciled: 0, conflicts: 0 },
      { category: "ai_api_cost", n: 1, ore: 3_000, estimated: 1, unreconciled: 1, conflicts: 1 }
    ]));
    expect(v.by_category).toHaveLength(2); // den 60 døgn gamle raden er utenfor vinduet, og B sin rad er aldri med
    expect(v.cursors.map((c) => c.source_family)).toEqual(["marketing", "model_cost"]);
    expect(v.commitments).toEqual(expect.arrayContaining([{ state: "active", n: 1, overdue: 1 }, { state: "paused", n: 1, overdue: 0 }]));
    expect(v.procurement).toEqual(expect.arrayContaining([{ status: "expected", n: 1, overdue: 1 }, { status: "fulfilled", n: 1, overdue: 0 }]));
  });

  it("avvik: flaggkategorier fra alle tabeller (kun strenger, ikke-streng-innhold blir «annet»), åpne finanssaker - aldri B sine", async () => {
    const v = await readAnomalies(db.appPool, TENANT_A);
    const flags = new Map(v.flags.map((f) => [`${f.source}:${f.flag}`, f.n]));
    expect(flags.get("intents:vendor_provider_ref_missing_at_submission")).toBe(1);
    expect(flags.get("intents:annet")).toBe(1); // jsonb-objektet i flaggene er ikke en gyldig kategori
    expect(flags.get("spend:spend_amount_deviation")).toBe(1);
    expect(flags.get("commitments:recurring_missing")).toBe(1);
    expect(flags.get("bank:bank_unexpected_debit")).toBe(1);
    expect(flags.get("card_authorizations:card_declined_burst")).toBe(1);
    expect([...flags.keys()].some((k) => k.includes("b_only_flag"))).toBe(false);
    expect(v.open_loops).toEqual([{ loop_type: "finance_spend_unexpected", n: 2 }]); // overdue_followup er ikke finans, B sin sak er ikke med
  });

  it("leverandører og kontoer: antall, uten aktiv binding, samtykker, kontoer, kort", async () => {
    const v = await readVendorsAccounts(db.appPool, TENANT_A);
    expect(v.vendors).toBe(2);
    expect(v.vendors_unbound).toBe(1); // v-a-2 har kun en tilbakekalt binding
    expect(v.bindings).toEqual(expect.arrayContaining([{ provider: "stripe", status: "active", n: 1 }, { provider: "fiken", status: "revoked", n: 1 }]));
    expect(v.consents.map((c) => c.consent_id).sort()).toEqual(["bc-a-active", "bc-a-expired", "bc-a-soon"]);
    expect(v.accounts).toMatchObject({ total: 2, active: 1 });
    expect(v.cards).toEqual(expect.arrayContaining([{ state: "active", n: 1 }, { state: "frozen", n: 1 }]));
  });

  it("avstemming: siste kjøring (A), sjekkresultater, åpne funn per alvorlighet/art, løste siste 7 døgn, uavstemte banktransaksjoner, uhelsemessige varsler siste 7 døgn", async () => {
    const v = await readReconciliation(db.appPool, TENANT_A, NOW.getTime());
    expect(v.last_run).toMatchObject({ run_id: "rr-a-new", status: "completed", trigger: "sweep" });
    expect(v.last_run?.checks).toEqual(expect.arrayContaining([{ check: "local", outcome: "ok" }, { check: "fiken", outcome: "skipped_no_credentials" }, { check: "stripe", outcome: "failed:timeout" }]));
    expect(v.open_findings.map((f) => `${f.severity}:${f.kind}:${f.n}`).sort()).toEqual(["critical:submit_outcome_unknown:1", "info:settled_unreconciled:1"]);
    expect(v.open_findings.find((f) => f.kind === "submit_outcome_unknown")?.max_reopen).toBe(2);
    expect(v.resolved_7d).toBe(1);
    expect(v.bank_unmatched).toEqual([{ state: "unmatched", n: 1 }]);
    expect(v.webhooks_unhealthy.map((w) => `${w.provider}:${w.status}:${w.n}`).sort()).toEqual(["neonomics:unsupported:1", "stripe:rejected:1", "vipps:failed_retryable:1", "wallester:rejected:1"]);
    const b = await readReconciliation(db.appPool, TENANT_B, NOW.getTime());
    expect(b.last_run).toMatchObject({ run_id: "rr-b-1", status: "failed" });
  });
});

describe("senteret som helhet (registeret → rapport)", () => {
  it("ingen seksjon er ukjent når alt kan leses; handlingen er den eksisterende nødbryteren (aktiv: Opphev)", async () => {
    const r = await report(idA);
    expect(r.center).toBe("finance");
    expect(r.sections.map((s) => s.id)).toEqual(["intents", "spend", "anomalies", "vendors_accounts", "reconciliation", "kill_switch"]);
    expect(r.sections.every((s) => s.measured)).toBe(true);
    expect(r.actions.map((a) => a.id)).toEqual(["finance.kill_switch.disable"]);
    expect(r.actions[0]).toMatchObject({ endpoint: "/executive/mutate", body: { action: "disable_finance_kill_switch", parameters: {} }, risk_class: "D", requires_step_up: true, reversible: true });
  });

  it("ukjent utfall og kritiske funn gir FAIL; manglende credentials-sjekk er UKJENT (aldri OK); utløpt/utløpende samtykke er advarsel; forfalte trekk er advarsel", async () => {
    const r = await report(idA);
    expect(item(r, "intents", "outcome_unknown")).toMatchObject({ status: "FAIL", facts: { count: 1 } });
    expect(item(r, "intents", "settled_unreconciled").status).toBe("WARN");
    expect(item(r, "reconciliation", "check:fiken").status).toBe("UNKNOWN");
    expect(item(r, "reconciliation", "check:stripe").status).toBe("FAIL");
    expect(item(r, "reconciliation", "check:local").status).toBe("OK");
    expect(item(r, "reconciliation", "finding:critical:submit_outcome_unknown").status).toBe("FAIL");
    expect(sec(r, "reconciliation").status).toBe("FAIL");
    expect(item(r, "vendors_accounts", "consent:bc-a-active").status).toBe("OK");
    expect(item(r, "vendors_accounts", "consent:bc-a-soon").status).toBe("WARN");
    expect(item(r, "vendors_accounts", "consent:bc-a-expired").status).toBe("WARN");
    expect(item(r, "spend", "commitments").status).toBe("WARN");
    expect(item(r, "spend", "procurement").status).toBe("WARN");
    expect(item(r, "spend", "sync:model_cost").status).toBe("WARN"); // sist synket for 5 døgn siden
    expect(item(r, "spend", "sync:marketing").status).toBe("OK");
    expect(sec(r, "kill_switch").status).toBe("WARN");
    expect(r.status).toBe("FAIL");
  });

  it("tenant-isolasjon: B sin rapport viser kun B (egne tall, ingen bryter, ingen A-rader), og A sin viser aldri B sine beløp", async () => {
    const a = JSON.stringify(await report(idA));
    const bReport = await report(idB);
    const b = JSON.stringify(bReport);
    expect(a).not.toContain("999000");
    expect(a).not.toContain("b_only_flag");
    expect(a).not.toContain("777000");
    expect(b).not.toContain("pi-a-");
    expect(b).not.toContain("bc-a-");
    expect(item(bReport, "intents", "state:settled").facts).toMatchObject({ amount_ore: 999_000 });
    expect(sec(bReport, "kill_switch").status).toBe("OK");
    expect(bReport.actions.map((x) => x.id)).toEqual(["finance.kill_switch.enable"]);
  });

  it("innholdsvern: leverandørnavn, formål, motpart, referansetekst, kontoidentifikator, funn-sammendrag og bryterbegrunnelse når aldri rapporten", async () => {
    const text = JSON.stringify(await report(idA));
    for (const secret of [HIDDEN_VENDOR, HIDDEN_PURPOSE, HIDDEN_COUNTERPARTY, HIDDEN_REF, HIDDEN_SUMMARY, HIDDEN_ACCOUNT]) expect(text, secret).not.toContain(secret);
    expect(text.toLowerCase()).not.toContain("hemmelig");
  });

  it("senteret skriver ingenting: radtall i alle berørte tabeller er uendret etter flere bygginger", async () => {
    const before = await counts();
    await report(idA);
    await report(idB);
    expect(await counts()).toEqual(before);
  });

  it("en kilde som svikter gir UKJENT kun for den seksjonen (aldri OK, aldri hele senteret)", async () => {
    await db.adminPool.query("REVOKE SELECT ON finance_reconciliation_runs FROM jarvis_app");
    try {
      const r = await report(idA);
      expect(sec(r, "reconciliation")).toMatchObject({ status: "UNKNOWN", measured: false });
      expect(sec(r, "intents").measured).toBe(true);
      expect(sec(r, "kill_switch").measured).toBe(true);
    } finally {
      await db.adminPool.query("GRANT SELECT ON finance_reconciliation_runs TO jarvis_app");
    }
  });
});

describe("rene tilstander", () => {
  it("en tenant uten noen finansdata: alt er målt (0 rader), ingenting er «ukjent» - men synk uten markør og ingen avstemmingskjøring er UKJENT (aldri OK)", async () => {
    await db.adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-fin-empty', 'e', 'business')");
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(center());
    const r = (await registry.report("finance", { ...idA, tenant_id: "tenant-fin-empty" })) as ControlCenterReport;
    expect(sec(r, "intents").measured).toBe(true);
    expect(item(r, "intents", "state:settled").facts).toMatchObject({ count: 0 });
    expect(item(r, "reconciliation", "last_run").status).toBe("UNKNOWN");
    expect(item(r, "spend", "sync:marketing").status).toBe("UNKNOWN");
    expect(r.status).toBe("UNKNOWN");
  });
});
