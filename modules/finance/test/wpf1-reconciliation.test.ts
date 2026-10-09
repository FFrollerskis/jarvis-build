import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { firstWaveTools } from "@jarvis/tool-gateway";
import {
  FinanceReconciliationService,
  FinanceService,
  FinanceTransport,
  compareWithFiken,
  createFikenPostingReader,
  detectDuplicateFindings,
  detectIntentFindings,
  detectOverSumFindings,
  detectWebhookFindings,
  fikenPostingDescription,
  fikenPostingMarker,
  fikenPostingToken,
  findingKey,
  formatOre,
  mapFikenJournalEntries,
  parseFikenPostingMarker,
  reconcileFlagFor,
  runFinanceReconciliationForAllTenants,
  type FikenIntentRow,
  type FikenPostingListing,
  type FikenPostingReader,
  type FinanceAlertNotifier,
  type IntentRow
} from "../src/index.ts";
import { FikenFake } from "./wpf1-fakes.ts";

/**
 * WP-F1 (D-453, UA-6 akseptanse): deterministisk avstemming av penger. Rene detektorer og Fiken-sammenligning (A, B), og ekte embedded Postgres som app-rolle (C-F): funn for
 * manglende/ekstra/uoverensstemmende beløp, ukjent utfall, dobbeltbetaling mistenkt og avviste hendelser; idempotens (samme funn oppdateres, aldri duplisert), gjenåpning,
 * autolukking KUN innenfor sjekker som kjørte, varsel kun for nye funn, dormant Fiken (uten credentials / ufullstendig liste) og tenant-isolasjon.
 */

const now = (over: Partial<IntentRow>): IntentRow => ({
  payment_intent_id: "fin-pi-11111111-1111-4111-8111-111111111111", provider: "stripe", state: "settled", amount_ore: 10_000, currency: "NOK", provider_ref: "pi_1",
  provider_reported_amount_ore: 10_000, provider_reported_currency: "NOK", reconciliation_state: "matched", anomaly_flags: [], submitted_age_ms: 5_000_000, settled_age_days: 1, ...over
});

describe("A: Fiken-markør og rene detektorer", () => {
  it("markør: stabil token fra intensjons-id, beskrivelsen beholder markøren og kuttes aldri midt i den, og parse gir tokenen tilbake", () => {
    const id = "fin-pi-3f2c9a2e-5b1d-4c3e-8a9f-0123456789ab";
    expect(fikenPostingToken(id)).toBe("3f2c9a2e5b1d");
    expect(fikenPostingMarker(id)).toBe("[J:3f2c9a2e5b1d]");
    expect(fikenPostingDescription("Faktura 42 fra leverandør", id)).toBe("Faktura 42 fra leverandør [J:3f2c9a2e5b1d]");
    const long = fikenPostingDescription("x".repeat(500), id);
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith("[J:3f2c9a2e5b1d]")).toBe(true);
    expect(parseFikenPostingMarker(long)).toBe("3f2c9a2e5b1d");
    expect(fikenPostingDescription("   \n  ", id)).toBe("Jarvis [J:3f2c9a2e5b1d]");
    expect(fikenPostingDescription("a\n\nb   c", id)).toBe("a b c [J:3f2c9a2e5b1d]");
    for (const bad of [null, undefined, "", "uten markør", "[J:xx]", "[J:UPPERCASE12]", "J:3f2c9a2e5b1d", "[J:3f2c9a2e5b1d99999]"]) expect(parseFikenPostingMarker(bad as string)).toBeNull();
  });

  it("formatOre bruker heltallsaritmetikk (tusenskille, to desimaler, negativt) og gir ikke et falskt tall for ugyldig input", () => {
    expect(formatOre(123_456, "NOK")).toBe("1 234,56 NOK");
    expect(formatOre(5, "NOK")).toBe("0,05 NOK");
    expect(formatOre(-250, "EUR")).toBe("-2,50 EUR");
    expect(formatOre(1.5, "NOK")).toBe("ugyldig beløp NOK");
  });

  it("intensjonsdetektorer: beløp/valuta/leverandør-ID/ukjent utfall/uavstemt - og INGENTING for en ren, bekreftet intensjon", () => {
    expect(detectIntentFindings([now({})])).toEqual([]);
    const kinds = (rows: IntentRow[]) => detectIntentFindings(rows).map((d) => d.kind);
    expect(kinds([now({ provider_reported_amount_ore: 9_999 })])).toEqual(["provider_amount_mismatch"]);
    expect(kinds([now({ provider_reported_currency: "EUR" })])).toEqual(["provider_currency_mismatch"]);
    expect(kinds([now({ state: "provider_acknowledged", provider_ref: null })])).toEqual(["provider_ref_missing"]);
    expect(kinds([now({ state: "settled", provider_ref: "" })])).toEqual(["provider_ref_missing"]);
    // ukjent utfall: flagget, eller en reservasjon eldre enn leasen uten leverandørsvar - men IKKE en fersk (pågående) reservasjon
    expect(kinds([now({ state: "draft", provider_ref: null, anomaly_flags: ["SUBMIT_OUTCOME_UNKNOWN"] })])).toEqual(["submit_outcome_unknown"]);
    expect(kinds([now({ state: "submitted", provider_ref: null, submitted_age_ms: 600_000 })])).toEqual(["submit_outcome_unknown"]);
    expect(kinds([now({ state: "submitted", provider_ref: null, submitted_age_ms: 5_000 })])).toEqual([]);
    expect(kinds([now({ state: "submitted", provider_ref: null, submitted_age_ms: null })])).toEqual(["submit_outcome_unknown"]);
    // oppgjort uten avstemming: først etter terskelen, og kun som info
    expect(detectIntentFindings([now({ reconciliation_state: "unreconciled", settled_age_days: 6.9 })])).toEqual([]);
    expect(detectIntentFindings([now({ reconciliation_state: "unreconciled", settled_age_days: 7 })]).map((d) => [d.kind, d.severity])).toEqual([["settled_unreconciled", "info"]]);
    expect(detectIntentFindings([now({ reconciliation_state: "mismatched", settled_age_days: 30 })])).toEqual([]);
    // alvorlighet og REDIGERT sammendrag
    const d = detectIntentFindings([now({ provider_reported_amount_ore: 12_345 })])[0]!;
    expect(d.severity).toBe("critical");
    expect(d.summary).toContain("123,45 NOK");
    expect(findingKey(d)).toBe("provider_amount_mismatch:payment_intent:fin-pi-11111111-1111-4111-8111-111111111111");
    expect(reconcileFlagFor("provider_amount_mismatch")).toBe("RECONCILE_PROVIDER_AMOUNT_MISMATCH");
  });

  it("refusjon/capture-summer, dobbeltbetaling og webhook-rader", () => {
    expect(detectOverSumFindings([
      { payment_intent_id: "a", amount_ore: 10_000, currency: "NOK", refunded_ore: 10_000, captured_ore: 10_000 },
      { payment_intent_id: "b", amount_ore: 10_000, currency: "NOK", refunded_ore: 10_001, captured_ore: 10_001 }
    ]).map((d) => [d.kind, d.subject_id])).toEqual([["over_refunded", "b"], ["over_captured", "b"]]);
    const dup = detectDuplicateFindings([{ later_id: "fin-pi-2", earlier_id: "fin-pi-1", provider: "stripe", amount_ore: 5_000, currency: "NOK" }]);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ kind: "possible_duplicate_payment", severity: "warning", subject_id: "fin-pi-2", discriminator: "fin-pi-1" });
    expect(findingKey(dup[0]!)).toBe("possible_duplicate_payment:payment_intent:fin-pi-2:fin-pi-1");
    const wh = detectWebhookFindings([
      { provider: "stripe", key: "evt_1", status: "rejected", error_message: "amount_invalid:amount_negative" },
      { provider: "wallester", key: "k2", status: "failed_retryable", error_message: "boom" }
    ]);
    expect(wh.map((d) => [d.kind, d.subject_id])).toEqual([["webhook_rejected", "stripe:evt_1"], ["webhook_unprocessed", "wallester:k2"]]);
  });
});

describe("B: Fiken-sammenligning - positive funn uten komplett liste, fravær kun med komplett liste", () => {
  const A = "fin-pi-aaaaaaaa-1111-4111-8111-111111111111";
  const B = "fin-pi-bbbbbbbb-2222-4222-8222-222222222222";
  const intents: FikenIntentRow[] = [
    { payment_intent_id: A, state: "settled", provider_ref: "100", amount_ore: 50_000, currency: "NOK" },
    { payment_intent_id: B, state: "submitted", provider_ref: null, amount_ore: 7_000, currency: "NOK" }
  ];
  const entry = (id: string, description: string | null, debitTotalOre: number | null = null) => ({ journalEntryId: id, description, date: "2026-10-01", debitTotalOre });
  const listing = (entries: ReturnType<typeof entry>[], complete = false): FikenPostingListing => ({ entries, complete });

  it("bilag uten Jarvis-markør ignoreres; riktig koblet bilag gir ingen funn", () => {
    expect(compareWithFiken(intents, listing([entry("1", "Manuell føring av regnskapsfører"), entry("100", `Leie ${fikenPostingMarker(A)}`)], true))).toEqual([]);
  });

  it("markør uten kjent intensjon -> critical unlinked; markør som passer flere intensjoner -> warning (kan ikke knyttes entydig)", () => {
    const orphan = compareWithFiken(intents, listing([entry("200", "Ukjent [J:cafebabe0000]")]));
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatchObject({ kind: "fiken_posting_unlinked", severity: "critical", subject_type: "fiken_journal_entry", subject_id: "200", payment_intent_id: null });
    const ambiguous = compareWithFiken([...intents, { ...intents[0]!, payment_intent_id: `${A}-dup` }], listing([entry("300", `X ${fikenPostingMarker(A)}`)]));
    expect(ambiguous.map((d) => [d.kind, d.severity])).toEqual([["fiken_posting_unlinked", "warning"]]);
  });

  it("utfall som kan avklares: intensjon uten bilags-ID, men Fiken har bilaget med markøren (positivt funn, ingen komplett liste kreves)", () => {
    const found = compareWithFiken(intents, listing([entry("555", `Test ${fikenPostingMarker(B)}`)]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "fiken_posting_unlinked", severity: "critical", subject_id: "555", payment_intent_id: B });
    expect(found[0]!.summary).toContain("utfallet kan avklares");
  });

  it("dobbeltpostering: to bilag med samme markør for én intensjon; bilag for en intensjon som aldri ble sendt", () => {
    const dbl = compareWithFiken(intents, listing([entry("100", `Leie ${fikenPostingMarker(A)}`), entry("101", `Leie ${fikenPostingMarker(A)}`)]));
    expect(dbl).toHaveLength(1);
    expect(dbl[0]).toMatchObject({ kind: "fiken_posting_unlinked", subject_id: "101", payment_intent_id: A });
    expect(dbl[0]!.summary).toContain("mulig dobbeltpostering");
    const cancelled = compareWithFiken([{ ...intents[1]!, state: "cancelled" }], listing([entry("9", `X ${fikenPostingMarker(B)}`)]));
    expect(cancelled[0]!.summary).toContain("ikke sendt");
  });

  it("beløp: avviker bokført debet fra intensjonen -> mismatch; ukjent beløp (null) avstemmes aldri", () => {
    const bad = compareWithFiken(intents, listing([entry("100", `Leie ${fikenPostingMarker(A)}`, 49_999)]));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ kind: "fiken_posting_mismatch", severity: "critical", payment_intent_id: A, discriminator: "100" });
    expect(bad[0]!.summary).toContain("499,99 NOK");
    expect(compareWithFiken(intents, listing([entry("100", `Leie ${fikenPostingMarker(A)}`, 50_000)]))).toEqual([]);
    expect(compareWithFiken(intents, listing([entry("100", `Leie ${fikenPostingMarker(A)}`, null)]))).toEqual([]);
  });

  it("manglende bilag konkluderes KUN med en komplett liste; en ufullstendig liste gir aldri «mangler»", () => {
    expect(compareWithFiken(intents, listing([], false))).toEqual([]);
    const missing = compareWithFiken(intents, listing([entry("77", "Noe annet")], true));
    expect(missing.map((d) => [d.kind, d.subject_id])).toEqual([["fiken_posting_missing", A]]); // B er ikke bekreftet (submitted uten ID) - ingen «mangler»
  });

  it("leser-adapteren: ingen credentials => null (dormant); ufullstendig liste alltid; id-er og beløp parses strengt, ukjent form hoppes over", async () => {
    expect(await createFikenPostingReader({ getCredentials: async () => null }).listPostings("t")).toBeNull();
    const reader = createFikenPostingReader({ getCredentials: async () => ({ refreshToken: "x", companySlug: "y" }) }, () => ({
      listJournalEntries: async () => [
        { journalEntryId: 7, description: "Leie [J:abcdef123456]", date: "2026-10-02T00:00:00Z", lines: [{ account: "6540", amount: 5_000 }, { account: "1920", amount: -5_000 }] },
        { journalEntryId: "8", description: 5, lines: [{ account: "6540", amount: 1.5 }] },
        { journalEntryId: 9.5 }, { journalEntryId: "bad id" }, null, "streng", { description: "uten id" }
      ]
    }));
    const listing = (await reader.listPostings("t"))!;
    expect(listing.complete).toBe(false);
    expect(listing.entries).toEqual([
      { journalEntryId: "7", description: "Leie [J:abcdef123456]", date: "2026-10-02", debitTotalOre: 5_000 },
      { journalEntryId: "8", description: null, date: null, debitTotalOre: null }
    ]);
    expect(mapFikenJournalEntries([])).toEqual([]);
  });
});

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-wpf1-rec";
const TENANT_B = "tenant-wpf1-rec-b";
const TENANT_EMPTY = "tenant-wpf1-rec-empty";
let finance: FinanceService;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-rec-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_rec LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_rec");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 rec', 'business'), ('${TENANT_B}', 'WPF1 rec B', 'business'), ('${TENANT_EMPTY}', 'WPF1 rec tom', 'business')`);
  appPool = createPool({ ...base, user: "jarvis_wpf1_rec", password: "pw2" });
  finance = new FinanceService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

class FakeNotifier implements FinanceAlertNotifier {
  sent: Array<{ tenant_id: string; run_id: string; text: string }> = [];
  fail = false;
  async notify(a: { tenant_id: string; run_id: string; text: string }) {
    if (this.fail) throw new Error("telegram_down");
    this.sent.push(a);
  }
}
class FakeFiken implements FikenPostingReader {
  listing: FikenPostingListing | null = { entries: [], complete: false };
  fail: Error | null = null;
  async listPostings(): Promise<FikenPostingListing | null> {
    if (this.fail) throw this.fail;
    return this.listing;
  }
}

const sql = async (text: string, params: unknown[] = []) => (await adminPool.query(text, params)).rows as Array<Record<string, unknown>>;
async function intent(tenant: string, over: Record<string, unknown> = {}, set: string = ""): Promise<string> {
  const row = await finance.createPaymentIntent(tenant, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "WPF1 avstemming", amount_ore: 10_000, vendor_name: `Lev ${randomUUID().slice(0, 8)} AS`, account_code: "kategori", provider: "stripe", ...over
  } as never);
  if (set) await sql(`UPDATE payment_intents SET ${set} WHERE payment_intent_id = $1`, [row.payment_intent_id]);
  return row.payment_intent_id;
}
const findings = async (tenant: string, status = "open") => sql("SELECT kind, severity, subject_id, payment_intent_id, status, reopen_count FROM finance_reconciliation_findings WHERE tenant_id = $1 AND status = $2 ORDER BY kind, subject_id", [tenant, status]);
const flagsOf = async (id: string) => ((await sql("SELECT anomaly_flags FROM payment_intents WHERE payment_intent_id = $1", [id]))[0]!["anomaly_flags"] as string[]);

describe("C: tom tenant og dormante sjekker er SYNLIGE, ikke grønne", () => {
  it("tom tenant: kjøringen fullføres uten funn; Fiken uten leser = skipped_not_configured; rapport viser aldri-kjørt før første kjøring", async () => {
    const svc = new FinanceReconciliationService(appPool);
    const before = await svc.getReconciliationStatus(TENANT_EMPTY);
    expect(before).toMatchObject({ ever_run: false, last_run: null, open_counts: { critical: 0, warning: 0, info: 0 }, open_findings: [] });
    const report = await svc.reconcileFinance(TENANT_EMPTY, "business", "manual");
    expect(report).toMatchObject({ status: "completed", findings_open: 0, findings_new: 0, notified: null, checks: { local: "ok", fiken: "skipped_not_configured" } });
    const after = await svc.getReconciliationStatus(TENANT_EMPTY);
    expect(after.ever_run).toBe(true);
    expect(after.last_run).toMatchObject({ status: "completed", trigger: "manual", checks: { local: "ok", fiken: "skipped_not_configured" } });
  });

  it("Fiken-leser uten credentials (null) = skipped_no_credentials; lesefeil = failed:<kode> og kjøringen fullføres likevel", async () => {
    const fiken = new FakeFiken();
    const svc = new FinanceReconciliationService(appPool, { fiken });
    fiken.listing = null;
    expect((await svc.reconcileFinance(TENANT_EMPTY)).checks).toEqual({ local: "ok", fiken: "skipped_no_credentials" });
    fiken.fail = new Error("fiken_api_failed_503: tjeneste utilgjengelig!");
    const failed = await svc.reconcileFinance(TENANT_EMPTY);
    expect(failed.status).toBe("completed");
    expect(failed.checks["fiken"]).toBe("failed:fiken_api_failed_503:_tjeneste_utilgjengelig_");
    fiken.fail = null;
    fiken.listing = { entries: [], complete: false };
    expect((await svc.reconcileFinance(TENANT_EMPTY)).checks["fiken"]).toBe("incomplete");
    fiken.listing = { entries: [], complete: true };
    expect((await svc.reconcileFinance(TENANT_EMPTY)).checks["fiken"]).toBe("ok");
  });
});

describe("D: lokale funn - registrert, flagget, varslet én gang, idempotent, autolukket, gjenåpnet", () => {
  it("manglende/ekstra/uoverensstemmende beløp og ukjent utfall oppdages; RECONCILE_*-flagg settes; kun NYE funn varsles; ny kjøring dupliserer ingenting", async () => {
    const notifier = new FakeNotifier();
    const svc = new FinanceReconciliationService(appPool, { notifier });
    const clean = await intent(TENANT, {}, "state = 'settled', provider_ref = 'pi_ok', provider_status = 'succeeded', provider_reported_amount_ore = 10000, provider_reported_currency = 'NOK', settled_at = now(), reconciliation_state = 'matched'");
    const wrongAmount = await intent(TENANT, {}, "state = 'provider_acknowledged', provider_ref = 'pi_amt', provider_reported_amount_ore = 9000, provider_reported_currency = 'NOK'");
    const noRef = await intent(TENANT, {}, "state = 'settled', provider_ref = NULL, settled_at = now(), reconciliation_state = 'matched'");
    const unknown = await intent(TENANT, { provider: "fiken", account_code: "6540", counter_account_code: "1920", vendor_provider_ref: "k-1" }, "state = 'submitted', submitted_at = now() - interval '1 hour'");
    const inFlight = await intent(TENANT, {}, "state = 'submitted', submitted_at = now()");
    // en draft som ble rullet tilbake etter et ukjent utfall (Stripe/Vipps) bærer flagget - fanges av SQL-uttrykket `anomaly_flags ? 'SUBMIT_OUTCOME_UNKNOWN'`
    const rolledBack = await intent(TENANT, {}, `anomaly_flags = '["SUBMIT_OUTCOME_UNKNOWN"]'::jsonb`);
    const overRefunded = await intent(TENANT, {}, "state = 'settled', provider_ref = 'pi_over', provider_reported_amount_ore = 10000, provider_reported_currency = 'NOK', settled_at = now(), reconciliation_state = 'matched'");
    await sql("INSERT INTO stripe_refunds (refund_id, tenant_id, payment_intent_id, idempotency_key, state, amount_ore, currency) VALUES ($1, $2, $3, $4, 'settled', 6000, 'NOK'), ($5, $2, $3, $6, 'provider_acknowledged', 5000, 'NOK'), ($7, $2, $3, $8, 'failed', 90000, 'NOK')",
      [`fin-rf-${randomUUID()}`, TENANT, overRefunded, `k-${randomUUID()}`, `fin-rf-${randomUUID()}`, `k-${randomUUID()}`, `fin-rf-${randomUUID()}`, `k-${randomUUID()}`]);
    await sql("INSERT INTO stripe_webhook_events (stripe_event_id, tenant_id, event_type, status, stripe_created_at, error_message) VALUES ($1, $2, 'payment_intent.succeeded', 'rejected', now(), 'amount_invalid:amount_negative'), ($3, $2, 'x.y', 'failed_retryable', now(), 'boom')",
      [`evt_${randomUUID().slice(0, 10)}`, TENANT, `evt_${randomUUID().slice(0, 10)}`]);
    await sql("UPDATE stripe_webhook_events SET received_at = now() - interval '5 hours' WHERE status = 'failed_retryable' AND tenant_id = $1", [TENANT]);

    const run1 = await svc.reconcileFinance(TENANT);
    expect(run1.checks).toEqual({ local: "ok", fiken: "skipped_not_configured" });
    const open = await findings(TENANT);
    const kinds = open.map((f) => `${f["kind"]}:${f["subject_id"] === unknown ? "unknown" : f["subject_id"] === wrongAmount ? "amount" : f["subject_id"] === noRef ? "noref" : f["subject_id"] === overRefunded ? "over" : "webhook"}`);
    expect(kinds).toEqual(expect.arrayContaining(["provider_amount_mismatch:amount", "provider_ref_missing:noref", "submit_outcome_unknown:unknown", "over_refunded:over", "webhook_rejected:webhook", "webhook_unprocessed:webhook"]));
    expect(open.some((f) => f["subject_id"] === clean)).toBe(false); // ren intensjon: ingen funn
    expect(open.some((f) => f["subject_id"] === inFlight)).toBe(false); // pågående reservasjon er ikke «ukjent utfall»
    expect(open.some((f) => f["kind"] === "over_refunded" && f["severity"] !== "critical")).toBe(false);
    expect(run1.findings_new).toBe(open.length);
    expect(run1.findings_open).toBe(open.length);
    // flagg på intensjonene (kun warning/critical med intensjon), rører ikke andre
    expect(await flagsOf(wrongAmount)).toContain("RECONCILE_PROVIDER_AMOUNT_MISMATCH");
    expect(await flagsOf(noRef)).toContain("RECONCILE_PROVIDER_REF_MISSING");
    expect(await flagsOf(unknown)).toContain("RECONCILE_SUBMIT_OUTCOME_UNKNOWN");
    expect(open.some((f) => f["subject_id"] === rolledBack && f["kind"] === "submit_outcome_unknown")).toBe(true);
    expect(await flagsOf(rolledBack)).toEqual(expect.arrayContaining(["SUBMIT_OUTCOME_UNKNOWN", "RECONCILE_SUBMIT_OUTCOME_UNKNOWN"]));
    expect(await flagsOf(overRefunded)).toContain("RECONCILE_OVER_REFUNDED");
    expect((await flagsOf(clean)).filter((f) => f.startsWith("RECONCILE_"))).toEqual([]); // ren intensjon: ingen avstemmingsflagg (opprettelsesflagg fra tjenesten røres ikke)
    // ett aggregert varsel for kjøringen, uten kontonummer/KID, med beløp
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.text).toContain("Finansavstemming");
    expect(notifier.sent[0]!.text).toContain("Ingen automatisk korreksjon");
    expect(run1.notified).toBe(true);

    // ny kjøring: samme funn oppdateres (aldri duplisert), ingen nye varsler
    const run2 = await svc.reconcileFinance(TENANT);
    expect(run2.findings_new).toBe(0);
    expect(run2.findings_open).toBe(open.length);
    expect((await findings(TENANT)).length).toBe(open.length);
    expect(notifier.sent).toHaveLength(1);

    // retting av kilden -> funnet lukkes og flagget fjernes
    await sql("UPDATE payment_intents SET provider_reported_amount_ore = 10000 WHERE payment_intent_id = $1", [wrongAmount]);
    const run3 = await svc.reconcileFinance(TENANT);
    expect(run3.findings_resolved).toBeGreaterThanOrEqual(1);
    expect((await findings(TENANT, "resolved")).some((f) => f["kind"] === "provider_amount_mismatch" && f["subject_id"] === wrongAmount)).toBe(true);
    expect(await flagsOf(wrongAmount)).not.toContain("RECONCILE_PROVIDER_AMOUNT_MISMATCH");

    // brytes igjen -> gjenåpnet (reopen_count 1) og varslet på nytt
    await sql("UPDATE payment_intents SET provider_reported_amount_ore = 9500 WHERE payment_intent_id = $1", [wrongAmount]);
    const run4 = await svc.reconcileFinance(TENANT);
    expect(run4.findings_reopened).toBe(1);
    expect(run4.new_findings.map((f) => f.reopened)).toEqual([true]);
    const reopened = (await findings(TENANT)).find((f) => f["kind"] === "provider_amount_mismatch" && f["subject_id"] === wrongAmount)!;
    expect(reopened["reopen_count"]).toBe(1);
    expect(notifier.sent).toHaveLength(2);
    expect(await flagsOf(wrongAmount)).toContain("RECONCILE_PROVIDER_AMOUNT_MISMATCH");

    // rapporten: åpne funn sortert etter alvorlighet, redigert, med hvilke sjekker som kjørte
    const status = await svc.getReconciliationStatus(TENANT);
    expect(status.ever_run).toBe(true);
    expect(status.last_run!.checks).toEqual({ local: "ok", fiken: "skipped_not_configured" });
    expect(status.open_counts.critical).toBeGreaterThanOrEqual(4);
    expect(status.open_findings[0]!.severity).toBe("critical");
    expect(JSON.stringify(status)).not.toMatch(/sk_(live|test)_|vendor_provider_ref|account_number/); // ingen hemmeligheter eller kontoidentifikatorer i rapporten
  });

  it("mulig dobbeltbetaling: to sendte intensjoner mot samme leverandør/beløp innen 24 t -> warning på den siste; en tredje lenger unna gir ingenting", async () => {
    const svc = new FinanceReconciliationService(appPool);
    const vendor = `Dobbel ${randomUUID().slice(0, 6)} AS`;
    const first = await intent(TENANT, { vendor_name: vendor, amount_ore: 77_700 }, "state = 'settled', provider_ref = 'pi_d1', provider_reported_amount_ore = 77700, provider_reported_currency = 'NOK', settled_at = now(), reconciliation_state = 'matched'");
    const second = await intent(TENANT, { vendor_name: vendor.toUpperCase(), amount_ore: 77_700 }, "state = 'provider_acknowledged', provider_ref = 'pi_d2', provider_reported_amount_ore = 77700, provider_reported_currency = 'NOK'");
    const farAway = await intent(TENANT, { vendor_name: vendor, amount_ore: 77_700 }, "state = 'settled', provider_ref = 'pi_d3', provider_reported_amount_ore = 77700, provider_reported_currency = 'NOK', settled_at = now(), reconciliation_state = 'matched', created_at = now() - interval '5 days'");
    await svc.reconcileFinance(TENANT);
    const dups = (await findings(TENANT)).filter((f) => f["kind"] === "possible_duplicate_payment");
    expect(dups.some((f) => f["subject_id"] === second && f["severity"] === "warning")).toBe(true);
    expect(dups.some((f) => f["subject_id"] === first || f["subject_id"] === farAway)).toBe(false);
    expect(await flagsOf(second)).toContain("RECONCILE_POSSIBLE_DUPLICATE_PAYMENT");
  });

  it("varslerfeil gjør kjøringen SYNLIG (notified=false i rapport og kjøringsrad) men ruller aldri tilbake funnene; uten varsler koblet = notified=false", async () => {
    const tenant = TENANT_B;
    const notifier = new FakeNotifier();
    notifier.fail = true;
    const svc = new FinanceReconciliationService(appPool, { notifier });
    const bad = await intent(tenant, {}, "state = 'provider_acknowledged', provider_ref = 'pi_n', provider_reported_amount_ore = 1, provider_reported_currency = 'NOK'");
    const report = await svc.reconcileFinance(tenant);
    expect(report.notified).toBe(false);
    expect((await findings(tenant)).some((f) => f["subject_id"] === bad)).toBe(true);
    const run = (await sql("SELECT summary FROM finance_reconciliation_runs WHERE run_id = $1", [report.run_id]))[0]!["summary"] as Record<string, unknown>;
    expect(run["notified"]).toBe(false);
    expect((await new FinanceReconciliationService(appPool).reconcileFinance(tenant)).notified).toBeNull(); // ingen NYE funn => ingenting å varsle
    await sql("UPDATE finance_reconciliation_findings SET status = 'resolved' WHERE tenant_id = $1", [tenant]);
    expect((await new FinanceReconciliationService(appPool).reconcileFinance(tenant)).notified).toBe(false); // gjenåpnet funn, men ingen varsler koblet
  });

  it("to samtidige kjøringer for samme tenant: serialisert (rådgivende lås), ingen duplikate funn, begge fullføres", async () => {
    const tenant = TENANT_B;
    const svc = new FinanceReconciliationService(appPool);
    await intent(tenant, {}, "state = 'provider_acknowledged', provider_ref = 'pi_c', provider_reported_amount_ore = 2, provider_reported_currency = 'NOK'");
    const [a, b] = await Promise.all([svc.reconcileFinance(tenant), svc.reconcileFinance(tenant)]);
    expect([a.status, b.status]).toEqual(["completed", "completed"]);
    const keys = (await sql("SELECT finding_key, count(*)::int AS n FROM finance_reconciliation_findings WHERE tenant_id = $1 GROUP BY finding_key HAVING count(*) > 1", [tenant]));
    expect(keys).toEqual([]);
  });
});

describe("E: Fiken mot ekte database - markør, ukjent utfall som kan avklares, dormant og ufullstendig liste", () => {
  it("submitPaymentIntent sender beskrivelsen med Jarvis-markør, og avstemmingen finner igjen bilaget etter et ukjent utfall (intensjon uten bilags-ID)", async () => {
    const fikenFake = new FikenFake();
    const svcFinance = new FinanceService(appPool, () => fikenFake);
    const row = await svcFinance.createPaymentIntent(TENANT, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "Husleie oktober", amount_ore: 1_500_000, vendor_name: `Utleier ${randomUUID().slice(0, 6)}`, account_code: "6300",
      counter_account_code: "1920", vendor_provider_ref: "kontakt-1", provider: "fiken"
    } as never);
    let sentDescription = "";
    const capture = new FinanceService(appPool, () => ({ createGeneralJournalEntry: async (i: { description: string }) => { sentDescription = i.description; return { journalEntryId: 4321, description: i.description, date: "2026-10-09" }; }, listCompanies: async () => [] }));
    await capture.submitPaymentIntent(TENANT, "business", row.payment_intent_id, { getCredentials: async () => ({ refreshToken: "t", companySlug: "firma" }) });
    expect(sentDescription).toBe(`Husleie oktober ${fikenPostingMarker(row.payment_intent_id)}`);
    expect(parseFikenPostingMarker(sentDescription)).toBe(fikenPostingToken(row.payment_intent_id));

    // simuler «ukjent utfall»: intensjonen står igjen som submitted uten bilags-ID, mens Fiken HAR bilaget
    const lost = await intent(TENANT, { provider: "fiken", account_code: "6540", counter_account_code: "1920", vendor_provider_ref: "k-lost", purpose: "Tapt svar" }, "state = 'submitted', submitted_at = now() - interval '2 hours'");
    const fiken = new FakeFiken();
    fiken.listing = { entries: [{ journalEntryId: "9001", description: `Tapt svar ${fikenPostingMarker(lost)}`, date: "2026-10-09", debitTotalOre: null }], complete: false };
    const svc = new FinanceReconciliationService(appPool, { fiken });
    const report = await svc.reconcileFinance(TENANT);
    expect(report.checks["fiken"]).toBe("incomplete");
    const f = (await findings(TENANT)).find((x) => x["kind"] === "fiken_posting_unlinked" && x["subject_id"] === "9001");
    expect(f).toMatchObject({ severity: "critical", payment_intent_id: lost });
    expect(await flagsOf(lost)).toEqual(expect.arrayContaining(["RECONCILE_FIKEN_POSTING_UNLINKED", "RECONCILE_SUBMIT_OUTCOME_UNKNOWN"]));

    // en UFULLSTENDIG liste lukker aldri et Fiken-funn (bilaget kan bare ligge utenfor vinduet)
    fiken.listing = { entries: [], complete: false };
    await svc.reconcileFinance(TENANT);
    expect((await findings(TENANT)).some((x) => x["kind"] === "fiken_posting_unlinked" && x["subject_id"] === "9001")).toBe(true);
    // en feilet Fiken-lesing rører heller ikke Fiken-funn
    fiken.fail = new Error("fiken_down");
    await svc.reconcileFinance(TENANT);
    expect((await findings(TENANT)).some((x) => x["kind"] === "fiken_posting_unlinked" && x["subject_id"] === "9001")).toBe(true);
    // en KOMPLETT liste uten bilaget lukker det
    fiken.fail = null;
    fiken.listing = { entries: [], complete: true };
    await svc.reconcileFinance(TENANT);
    expect((await findings(TENANT)).some((x) => x["kind"] === "fiken_posting_unlinked" && x["subject_id"] === "9001")).toBe(false);
  });

  it("komplett liste uten et bekreftet bilag -> fiken_posting_missing; samme liste med bilaget gir ingenting", async () => {
    const id = await intent(TENANT, { provider: "fiken", account_code: "6540", counter_account_code: "1920", vendor_provider_ref: "k-m", amount_ore: 33_300 }, "state = 'provider_acknowledged', provider_ref = '12345'");
    const fiken = new FakeFiken();
    const svc = new FinanceReconciliationService(appPool, { fiken });
    fiken.listing = { entries: [{ journalEntryId: "12345", description: `ok ${fikenPostingMarker(id)}`, date: null, debitTotalOre: 33_300 }], complete: true };
    await svc.reconcileFinance(TENANT);
    expect((await findings(TENANT)).some((x) => x["subject_id"] === id && String(x["kind"]).startsWith("fiken_"))).toBe(false);
    fiken.listing = { entries: [], complete: true };
    await svc.reconcileFinance(TENANT);
    expect((await findings(TENANT)).find((x) => x["subject_id"] === id && x["kind"] === "fiken_posting_missing")).toMatchObject({ severity: "critical", payment_intent_id: id });
    fiken.listing = { entries: [{ journalEntryId: "12345", description: `ok ${fikenPostingMarker(id)}`, date: null, debitTotalOre: 99 }], complete: true };
    await svc.reconcileFinance(TENANT);
    expect((await findings(TENANT)).some((x) => x["subject_id"] === id && x["kind"] === "fiken_posting_mismatch")).toBe(true);
    expect((await findings(TENANT)).some((x) => x["subject_id"] === id && x["kind"] === "fiken_posting_missing")).toBe(false);
  });
});

describe("F: tenant-isolasjon, app-rolle, verktøy og sveip", () => {
  it("annen tenant ser ingenting (RLS), ikke engang med direkte SQL som app-rolle; tabellene er RLS-tvunget", async () => {
    const svc = new FinanceReconciliationService(appPool);
    const mine = await svc.getReconciliationStatus(TENANT);
    expect(mine.open_findings.length).toBeGreaterThan(0);
    const other = await svc.getReconciliationStatus(TENANT_EMPTY);
    expect(other.open_findings.every((f) => !mine.open_findings.some((m) => m.finding_id === f.finding_id))).toBe(true);
    const seen = await withMemoryTransaction(appPool, TENANT_EMPTY, ["business"], async (client) => ({
      findings: (await client.query("SELECT count(*)::int AS n FROM finance_reconciliation_findings WHERE tenant_id = $1", [TENANT])).rows[0],
      runs: (await client.query("SELECT count(*)::int AS n FROM finance_reconciliation_runs WHERE tenant_id = $1", [TENANT])).rows[0]
    }));
    expect(seen).toEqual({ findings: { n: 0 }, runs: { n: 0 } });
    // feil tenant-kontekst kan heller ikke SKRIVE et funn for en annen tenant
    await expect(withMemoryTransaction(appPool, TENANT_EMPTY, ["business"], (client) =>
      client.query(`INSERT INTO finance_reconciliation_runs (run_id, tenant_id) VALUES ('fin-rec-x', $1)`, [TENANT]))).rejects.toThrow();
    const rls = await sql("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('finance_reconciliation_runs', 'finance_reconciliation_findings') ORDER BY relname");
    expect(rls).toEqual([
      { relname: "finance_reconciliation_findings", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "finance_reconciliation_runs", relrowsecurity: true, relforcerowsecurity: true }
    ]);
  });

  it("verktøyet finance.get_reconciliation_status er klasse A (kun lesing) og returnerer rapporten; uten konfigurert tjeneste feiler det synlig", async () => {
    const svc = new FinanceReconciliationService(appPool);
    const transport = new FinanceTransport(finance, { getCredentials: async () => null }, svc);
    const def = firstWaveTools({ finance: transport }).find((t) => t.tool_id === "finance" && t.action === "get_reconciliation_status")!;
    expect(def.capability_class).toBe("A");
    expect(def.output_trust).toBe("internal");
    const out = await transport.invoke("get_reconciliation_status", { tenant_id: TENANT });
    expect((out.data as { ever_run: boolean }).ever_run).toBe(true);
    await expect(new FinanceTransport(finance, { getCredentials: async () => null }).invoke("get_reconciliation_status", { tenant_id: TENANT })).rejects.toThrow("finance_reconciliation_not_configured");
  });

  it("sveipet kjører for alle bedrifts-tenants, isolerer feil per tenant og melder Fiken-lesefeil til oppsamleren", async () => {
    const fiken = new FakeFiken();
    fiken.fail = new Error("fiken_503");
    const svc = new FinanceReconciliationService(appPool, { fiken });
    const recorded: Array<{ tenant: string; what: unknown }> = [];
    const results = await runFinanceReconciliationForAllTenants(appPool, svc, { record: (tenant: string, what: unknown) => { recorded.push({ tenant, what }); } } as never);
    expect(Object.keys(results)).toEqual(expect.arrayContaining([TENANT, TENANT_B, TENANT_EMPTY]));
    expect(results[TENANT]!.checks["fiken"]).toMatch(/^failed:fiken_503/);
    expect(recorded.some((r) => r.tenant === TENANT && String(r.what).includes("Fiken-avstemming feilet"))).toBe(true);
  });

  it("en kjøring som døde midt i (står som `running` > 1 time) markeres som forlatt av neste kjøring; en fersk `running` røres ikke", async () => {
    await sql("INSERT INTO finance_reconciliation_runs (run_id, tenant_id, status, started_at) VALUES ('fin-rec-old-wpf1', $1, 'running', now() - interval '2 hours'), ('fin-rec-fresh-wpf1', $1, 'running', now() - interval '5 minutes')", [TENANT_EMPTY]);
    await new FinanceReconciliationService(appPool).reconcileFinance(TENANT_EMPTY);
    const rows = await sql("SELECT run_id, status, error_message FROM finance_reconciliation_runs WHERE run_id IN ('fin-rec-old-wpf1', 'fin-rec-fresh-wpf1') ORDER BY run_id");
    expect(rows).toEqual([{ run_id: "fin-rec-fresh-wpf1", status: "running", error_message: null }, { run_id: "fin-rec-old-wpf1", status: "failed", error_message: "abandoned" }]);
    await sql("DELETE FROM finance_reconciliation_runs WHERE run_id = 'fin-rec-fresh-wpf1'"); // fixture-opprydding (så sluttsjekken under ikke ser en ekte hengende kjøring)
  });

  it("en kjøring som feiler midt i markeres failed med årsak (aldri hengende `running`) og kaster videre", async () => {
    const fiken = new FakeFiken();
    // en id som bryter funn-tabellens CHECK (subject_id <= 300 tegn) tvinger skrivefasen til å feile ETTER at kjøringen er registrert
    fiken.listing = { entries: [{ journalEntryId: "9".repeat(400), description: "x [J:deadbeef0000]", date: null, debitTotalOre: null }], complete: false };
    const svc = new FinanceReconciliationService(appPool, { fiken });
    await expect(svc.reconcileFinance(TENANT_EMPTY)).rejects.toThrow();
    const latest = (await sql("SELECT status, error_message, finished_at FROM finance_reconciliation_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1", [TENANT_EMPTY]))[0]!;
    expect(latest["status"]).toBe("failed");
    expect(String(latest["error_message"])).toMatch(/subject_id|check/i);
    expect(latest["finished_at"]).not.toBeNull();
    expect((await sql("SELECT count(*)::int AS n FROM finance_reconciliation_runs WHERE status = 'running'"))[0]!["n"]).toBe(0);
    await expect(new FinanceReconciliationService(appPool).reconcileFinance("tenant-finnes-ikke-wpf1")).rejects.toThrow(); // ukjent tenant: avvist før noe registreres
  });
});
