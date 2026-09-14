import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { CommitmentNotFoundError, MissingCadenceIntervalError, ProcurementItemNotFoundError } from "../src/spend-types.ts";
import { InvalidCommitmentTransitionError, InvalidProcurementTransitionError } from "../src/spend-state-machine.ts";
import { InvalidAmountError, InvalidCurrencyError } from "../src/types.ts";
import { SpendService } from "../src/spend-service.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): ekte
 * Postgres/RLS-integrasjonsbevis for `SpendService` (SAMME mønster som
 * `service-rls.test.ts` - IKKE en `fakePool()`-mock). Kildehendelser
 * skrives DIREKTE mot `marketing_spend_events`/`cost_events` (samme rader
 * en ekte `GrowthService.recordSpendEvent()`/`ModelGateway.recordCost()`
 * ville produsert) for å bevise synk-koden mot de EKTE skjemaene, ikke en
 * antatt form.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: SpendService;

const TENANT_A = "tenant-spend-svc-a";
const TENANT_B = "tenant-spend-svc-b";
let campaignA: string;
let campaignB: string;

/** `occurred_at` er `timestamptz` - pg returnerer den som et `Date`-objekt (IKKE en streng, til tross for FinanceSpendRecord sin TS-type - se spend-service.ts sin syncMarketingSpend-JSDoc for samme presisering). */
function isoDate(value: unknown): string {
  return new Date(value as string | Date).toISOString().slice(0, 10);
}

async function insertMarketingSpend(campaignId: string, eventDate: string, amountOre: number, sourceType = "manual", currency = "NOK") {
  await adminPool.query(
    `INSERT INTO marketing_spend_events (spend_event_id, tenant_id, campaign_id, event_date, spend_amount_ore, currency, source_type)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7)
     ON CONFLICT (tenant_id, campaign_id, event_date, source_type) DO UPDATE SET spend_amount_ore = EXCLUDED.spend_amount_ore, currency = EXCLUDED.currency, updated_at = now()
     RETURNING spend_event_id`,
    [`grw-se-${Math.random().toString(36).slice(2)}`, TENANT_A, campaignId, eventDate, amountOre, currency, sourceType]
  );
}

/** Egen, unik kampanje per test som trenger deterministisk 1:1-matching - deler ALDRI campaignA med andre forpliktelses-mappede tester (ville skapt EKTE, tilsiktet tvetydighet - se matchAndReconcile()-JSDoc §9). */
async function createCampaign(): Promise<string> {
  const campaignId = `camp-spend-${Math.random().toString(36).slice(2)}`;
  await adminPool.query(
    `INSERT INTO marketing_campaigns (campaign_id, tenant_id, channel, name) VALUES ($1, $2, 'google_ads', 'Isolated Test Campaign')`,
    [campaignId, TENANT_A]
  );
  return campaignId;
}

async function insertCostEvent(tenantId: string, amountOre: number, provider = "anthropic", model = "claude", currency = "NOK") {
  const { rows } = await adminPool.query(
    `INSERT INTO cost_events (tenant_id, kind, amount_ore, currency, provider, model) VALUES ($1, 'model:test', $2, $3, $4, $5) RETURNING cost_id`,
    [tenantId, amountOre, currency, provider, model]
  );
  return String((rows[0] as { cost_id: string }).cost_id);
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-spend-svc-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_spend_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_spend_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Spend Svc A', 'business'), ('${TENANT_B}', 'Spend Svc B', 'business')`
  );
  await adminPool.query(
    `INSERT INTO marketing_campaigns (campaign_id, tenant_id, channel, name) VALUES ('camp-spend-a', '${TENANT_A}', 'google_ads', 'Campaign A'), ('camp-spend-b', '${TENANT_B}', 'google_ads', 'Campaign B') RETURNING campaign_id`
  );
  campaignA = "camp-spend-a";
  campaignB = "camp-spend-b";

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_spend_svc_test", password: "pw2" });
  service = new SpendService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: markedsføringsutgifts-synk (§4 - inkrementell/retry-trygg/idempotent)", () => {
  it("første synk-kjøring henter alle eksisterende kilderader og normaliserer dem", async () => {
    await insertMarketingSpend(campaignA, "2026-01-10", 5_000);
    const result = await service.syncMarketingSpend(TENANT_A, "business");
    expect(result.inserted).toBeGreaterThanOrEqual(1);
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing" });
    expect(records.some((r) => r.campaign_id === campaignA && Number(r.amount_ore) === 5_000)).toBe(true);
  });
  it("retry (samme kilderad, ingen endring) oppdaterer SAMME rad, oppretter aldri en duplikat", async () => {
    await insertMarketingSpend(campaignA, "2026-01-11", 7_000);
    await service.syncMarketingSpend(TENANT_A, "business");
    const before = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing" });
    await service.syncMarketingSpend(TENANT_A, "business");
    await service.syncMarketingSpend(TENANT_A, "business");
    const after = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing" });
    expect(after.length).toBe(before.length);
  });
  it("backfill (cursor null) henter FULL historikk uten duplikater ved påfølgende inkrementell synk", async () => {
    await insertMarketingSpend(campaignA, "2025-06-01", 1_000);
    const first = await service.syncMarketingSpend(TENANT_A, "business");
    expect(first.scanned).toBeGreaterThan(0);
    const second = await service.syncMarketingSpend(TENANT_A, "business");
    expect(second.scanned).toBe(0);
  });
  it("en sen-korrigert kilderad (UPDATE av spend_amount_ore) blir hentet på nytt og markert 'corrected' (ikke stille overskrevet)", async () => {
    const eventDate = "2026-01-15";
    await insertMarketingSpend(campaignA, eventDate, 2_000);
    await service.syncMarketingSpend(TENANT_A, "business");
    await insertMarketingSpend(campaignA, eventDate, 9_999); // korrigering av SAMME (campaign, dato, source_type)
    const result = await service.syncMarketingSpend(TENANT_A, "business");
    expect(result.corrected).toBeGreaterThanOrEqual(1);
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing" });
    const record = records.find((r) => r.campaign_id === campaignA && isoDate(r.occurred_at) === eventDate);
    expect(Number(record?.amount_ore)).toBe(9_999);
    expect(record?.source_correction_state).toBe("corrected");
  });
  it("en korrigering ETTER at posten allerede er avstemt/matched markeres 'correction_conflict', ALDRI stille overskrevet", async () => {
    const eventDate = "2026-01-20";
    await insertMarketingSpend(campaignA, eventDate, 3_000);
    await service.syncMarketingSpend(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing" });
    const record = records.find((r) => r.campaign_id === campaignA && isoDate(r.occurred_at) === eventDate)!;
    await service.reconcileSpendRecord(TENANT_A, "business", record.spend_record_id, true);
    await insertMarketingSpend(campaignA, eventDate, 7_777);
    await service.syncMarketingSpend(TENANT_A, "business");
    const updated = await service.getSpendRecord(TENANT_A, "business", record.spend_record_id);
    expect(updated?.source_correction_state).toBe("correction_conflict");
  });
  it("tenant-separasjon: tenant B ser ALDRI tenant A sine utgiftsposter", async () => {
    await insertMarketingSpend(campaignB, "2026-02-01", 4_000);
    await adminPool.query(`UPDATE marketing_spend_events SET tenant_id = $1 WHERE campaign_id = $2`, [TENANT_B, campaignB]);
    const syncResultB = await service.syncMarketingSpend(TENANT_B, "business");
    expect(syncResultB.inserted).toBeGreaterThanOrEqual(1);
    const recordsA = await service.listSpendRecords(TENANT_A, "business");
    expect(recordsA.every((r) => r.tenant_id === TENANT_A)).toBe(true);
  });
});

describe("B: AI/API-leverandørkostnads-synk (§5 - append-only kilde, ingen korrigering mulig)", () => {
  it("henter cost_events inkrementelt via cost_id-cursor, ingen duplikat ved retry", async () => {
    await insertCostEvent(TENANT_A, 250);
    const first = await service.syncModelCost(TENANT_A, "business");
    expect(first.inserted).toBeGreaterThanOrEqual(1);
    const second = await service.syncModelCost(TENANT_A, "business");
    expect(second.inserted).toBe(0);
    expect(second.scanned).toBe(0);
  });
  it("bevarer eksakt kildesporbarhet (source_record_id = cost_id, provider/model bevart)", async () => {
    const costId = await insertCostEvent(TENANT_A, 900, "openai", "gpt-test");
    await service.syncModelCost(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "model_cost" });
    const record = records.find((r) => r.source_record_id === costId);
    expect(record?.source_provider).toBe("openai");
    expect(record?.source_model_or_service).toBe("gpt-test");
    expect(record?.category).toBe("ai_api_cost");
  });
  it("source_amount_status forblir 'settled' - ALDRI et fabrikkert 'estimated' (Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false)", async () => {
    await insertCostEvent(TENANT_A, 100);
    await service.syncModelCost(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "model_cost" });
    expect(records.every((r) => r.source_amount_status === "settled")).toBe(true);
  });
});

describe("C: pengeintegritet (bigint øre, ingen flyttallskorrupsjon, valuta bevart)", () => {
  it("store beløp bevares eksakt (ingen flyttalls-avrunding)", async () => {
    await insertCostEvent(TENANT_A, 999_999_999);
    await service.syncModelCost(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "model_cost", limit: 200 });
    expect(records.some((r) => Number(r.amount_ore) === 999_999_999)).toBe(true);
  });
  it("valuta bevares uendret gjennom synk", async () => {
    await insertMarketingSpend(campaignA, "2026-03-01", 500, "manual", "USD");
    await service.syncMarketingSpend(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing" });
    expect(records.some((r) => isoDate(r.occurred_at) === "2026-03-01" && r.currency === "USD")).toBe(true);
  });
});

describe("D: abonnements-/gjentakende forpliktelses-register (§6) - CRUD + deterministiske state-overganger", () => {
  it("oppretter en forpliktelse med monthly-kadanse", async () => {
    const commitment = await service.createCommitment(TENANT_A, "business", {
      vendor_name: "SaaS Leverandør", description: "Test-abonnement", cadence: "monthly", expected_amount_ore: 29_900, start_date: "2026-01-01"
    });
    expect(commitment.state).toBe("active");
    expect(commitment.next_expected_charge_at).not.toBeNull();
  });
  it("custom_days-kadanse UTEN eksplisitt intervall kastes deterministisk FØR databasen", async () => {
    await expect(
      service.createCommitment(TENANT_A, "business", { vendor_name: "X", description: "Y", cadence: "custom_days", expected_amount_ore: 100, start_date: "2026-01-01" })
    ).rejects.toThrow(MissingCadenceIntervalError);
  });
  it("ugyldig beløp/valuta kastes deterministisk (samme mønster som payment_intents)", async () => {
    await expect(
      service.createCommitment(TENANT_A, "business", { vendor_name: "X", description: "Y", cadence: "monthly", expected_amount_ore: -1, start_date: "2026-01-01" })
    ).rejects.toThrow(InvalidAmountError);
    await expect(
      service.createCommitment(TENANT_A, "business", { vendor_name: "X", description: "Y", cadence: "monthly", expected_amount_ore: 100, currency: "nok", start_date: "2026-01-01" })
    ).rejects.toThrow(InvalidCurrencyError);
  });
  it("pause -> resume -> cancel følger den deterministiske state-maskinen, ugyldige overganger kastes", async () => {
    const commitment = await service.createCommitment(TENANT_A, "business", { vendor_name: "V", description: "D", cadence: "yearly", expected_amount_ore: 100_000, start_date: "2026-01-01" });
    const paused = await service.pauseCommitment(TENANT_A, "business", commitment.commitment_id);
    expect(paused.state).toBe("paused");
    const resumed = await service.resumeCommitment(TENANT_A, "business", commitment.commitment_id);
    expect(resumed.state).toBe("active");
    const cancelled = await service.cancelCommitment(TENANT_A, "business", commitment.commitment_id);
    expect(cancelled.state).toBe("cancelled");
    await expect(service.resumeCommitment(TENANT_A, "business", commitment.commitment_id)).rejects.toThrow(InvalidCommitmentTransitionError);
  });
  it("ukjent commitment_id kastes deterministisk (CommitmentNotFoundError)", async () => {
    await expect(service.pauseCommitment(TENANT_A, "business", "fin-rc-does-not-exist")).rejects.toThrow(CommitmentNotFoundError);
  });
  it("tenant-isolasjon: tenant B ser ALDRI tenant A sine forpliktelser", async () => {
    await service.createCommitment(TENANT_A, "business", { vendor_name: "Kun A", description: "D", cadence: "monthly", expected_amount_ore: 1_000, start_date: "2026-01-01" });
    const listB = await service.listCommitments(TENANT_B, "business");
    expect(listB.every((c) => c.vendor_name !== "Kun A")).toBe(true);
  });
});

describe("E: anskaffelses-/forventet-utgifts-register (§7) - lifecycle", () => {
  it("oppretter, oppfyller og kansellerer anskaffelser med deterministiske overganger", async () => {
    const item = await service.createProcurementItem(TENANT_A, "business", {
      vendor_name: "Utstyr AS", description: "Ny laptop", expected_amount_ore: 1_500_000, expected_date: "2026-04-01"
    });
    expect(item.status).toBe("expected");
    const fulfilled = await service.fulfillProcurementItem(TENANT_A, "business", item.procurement_item_id);
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.fulfilled_at).not.toBeNull();
    await expect(service.cancelProcurementItem(TENANT_A, "business", item.procurement_item_id)).rejects.toThrow(InvalidProcurementTransitionError);
  });
  it("ukjent procurement_item_id kastes deterministisk", async () => {
    await expect(service.cancelProcurementItem(TENANT_A, "business", "fin-pr-does-not-exist")).rejects.toThrow(ProcurementItemNotFoundError);
  });
  it("tenant-isolasjon for anskaffelser", async () => {
    await service.createProcurementItem(TENANT_A, "business", { vendor_name: "Kun A", description: "D", expected_amount_ore: 1_000, expected_date: "2026-05-01" });
    const listB = await service.listProcurementItems(TENANT_B, "business");
    expect(listB.every((p) => p.vendor_name !== "Kun A")).toBe(true);
  });
});

describe("F: deterministisk avviksdeteksjon (§8) - alle syv typer, REN SQL", () => {
  it("AMOUNT_DEVIATION: koblet utgift utenfor forpliktelsens toleranse flagges", async () => {
    const campaign = await createCampaign();
    const commitment = await service.createCommitment(TENANT_A, "business", {
      vendor_name: "Deviation Vendor", description: "D", cadence: "monthly", expected_amount_ore: 10_000, amount_tolerance_ore: 500,
      source_mapping: { campaign_id: campaign }, start_date: "2026-01-01"
    });
    await insertMarketingSpend(campaign, "2026-06-01", 50_000);
    await service.syncMarketingSpend(TENANT_A, "business");
    await service.matchAndReconcile(TENANT_A, "business");
    await service.runAnomalyDetection(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing", limit: 200 });
    const record = records.find((r) => r.recurring_commitment_id === commitment.commitment_id);
    expect(record?.anomaly_flags).toContain("AMOUNT_DEVIATION");
  });
  it("CURRENCY_MISMATCH: koblet utgift med annen valuta enn forpliktelsen flagges", async () => {
    const campaign = await createCampaign();
    const commitment = await service.createCommitment(TENANT_A, "business", {
      vendor_name: "Currency Vendor", description: "D", cadence: "monthly", expected_amount_ore: 5_000, currency: "NOK",
      amount_tolerance_ore: 100_000_000, source_mapping: { campaign_id: campaign }, start_date: "2026-01-01"
    });
    await insertMarketingSpend(campaign, "2026-06-15", 5_000, "manual", "USD");
    await service.syncMarketingSpend(TENANT_A, "business");
    await service.matchAndReconcile(TENANT_A, "business");
    await service.runAnomalyDetection(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing", limit: 200 });
    const record = records.find((r) => r.recurring_commitment_id === commitment.commitment_id && r.currency === "USD");
    expect(record?.anomaly_flags).toContain("CURRENCY_MISMATCH");
  });
  it("MISSING_EXPECTED_SPEND (procurement): forventet dato + vindu passert uten koblet utgift flagges på anskaffelsen", async () => {
    const item = await service.createProcurementItem(TENANT_A, "business", {
      vendor_name: "Missing Vendor", description: "D", expected_amount_ore: 1_000, expected_date: "2020-01-01", expected_window_days: 1
    });
    await service.runAnomalyDetection(TENANT_A, "business");
    const updated = await service.getProcurementItem(TENANT_A, "business", item.procurement_item_id);
    expect(updated?.anomaly_flags).toContain("MISSING_EXPECTED_SPEND");
  });
  it("SOURCE_CORRECTION_CONFLICT: promoteres til anomaly_flags ved deteksjonskjøring", async () => {
    const eventDate = "2026-07-01";
    await insertMarketingSpend(campaignA, eventDate, 1_000);
    await service.syncMarketingSpend(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing", limit: 200 });
    const record = records.find((r) => r.campaign_id === campaignA && isoDate(r.occurred_at) === eventDate)!;
    await service.reconcileSpendRecord(TENANT_A, "business", record.spend_record_id, true);
    await insertMarketingSpend(campaignA, eventDate, 8_888);
    await service.syncMarketingSpend(TENANT_A, "business");
    await service.runAnomalyDetection(TENANT_A, "business");
    const updated = await service.getSpendRecord(TENANT_A, "business", record.spend_record_id);
    expect(updated?.anomaly_flags).toContain("SOURCE_CORRECTION_CONFLICT");
  });
  it("rekjøring av deteksjon er selv-korrigerende: et avvik hvis vilkår ikke lenger er sant forsvinner (idempotent, aldri stille akkumulerende)", async () => {
    const item = await service.createProcurementItem(TENANT_A, "business", {
      vendor_name: "Self Correcting", description: "D", expected_amount_ore: 2_000, expected_date: "2020-06-01", expected_window_days: 1
    });
    await service.runAnomalyDetection(TENANT_A, "business");
    let updated = await service.getProcurementItem(TENANT_A, "business", item.procurement_item_id);
    expect(updated?.anomaly_flags).toContain("MISSING_EXPECTED_SPEND");
    await service.fulfillProcurementItem(TENANT_A, "business", item.procurement_item_id);
    await service.runAnomalyDetection(TENANT_A, "business");
    updated = await service.getProcurementItem(TENANT_A, "business", item.procurement_item_id);
    expect(updated?.anomaly_flags).not.toContain("MISSING_EXPECTED_SPEND");
  });
});

describe("G: avstemming/matching (§9) - deterministisk, tvetydige tilfeller forblir uløst", () => {
  it("uttrykkelig eier-konfigurert source_mapping kobler utgift til forpliktelse og fremdriver forfallsvinduet", async () => {
    const campaign = await createCampaign();
    const commitment = await service.createCommitment(TENANT_A, "business", {
      vendor_name: "Match Vendor", description: "D", cadence: "monthly", expected_amount_ore: 3_000,
      source_mapping: { campaign_id: campaign }, start_date: "2026-01-01"
    });
    await insertMarketingSpend(campaign, "2026-08-01", 3_000);
    await service.syncMarketingSpend(TENANT_A, "business");
    const before = await service.getCommitment(TENANT_A, "business", commitment.commitment_id);
    const result = await service.matchAndReconcile(TENANT_A, "business");
    expect(result.matched).toBeGreaterThanOrEqual(1);
    const after = await service.getCommitment(TENANT_A, "business", commitment.commitment_id);
    expect(after?.next_expected_charge_at).not.toBe(before?.next_expected_charge_at);
  });
  it("uten source_mapping forblir spend-record ukoblet (tvetydig - forblir uløst, IKKE gjettet)", async () => {
    await service.createCommitment(TENANT_A, "business", { vendor_name: "No Mapping", description: "D", cadence: "monthly", expected_amount_ore: 1, start_date: "2026-01-01" });
    await insertMarketingSpend(campaignA, "2026-08-05", 1_234);
    await service.syncMarketingSpend(TENANT_A, "business");
    await service.matchAndReconcile(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing", limit: 200 });
    const record = records.find((r) => r.campaign_id === campaignA && isoDate(r.occurred_at) === "2026-08-05");
    expect(record?.recurring_commitment_id).toBeNull();
  });
  it("manuell reconcileSpendRecord() setter matched/mismatched deterministisk", async () => {
    await insertMarketingSpend(campaignA, "2026-08-10", 999);
    await service.syncMarketingSpend(TENANT_A, "business");
    const records = await service.listSpendRecords(TENANT_A, "business", { source_family: "marketing", limit: 200 });
    const record = records.find((r) => r.campaign_id === campaignA && isoDate(r.occurred_at) === "2026-08-10")!;
    const mismatched = await service.reconcileSpendRecord(TENANT_A, "business", record.spend_record_id, false);
    expect(mismatched.reconciliation_state).toBe("mismatched");
  });
});

describe("H: finans-kill-switch-distinksjon (§13) - PASSIV observasjon er ALDRI påvirket", () => {
  it("synk/matching/deteksjon fortsetter uendret selv om finans-kill-switchen er aktivert (kun aktiv utførelse skal gates)", async () => {
    await adminPool.query(
      `INSERT INTO finance_kill_switch (tenant_id, enabled, enabled_at, reason) VALUES ($1, true, now(), 'test') ON CONFLICT (tenant_id) DO UPDATE SET enabled = true`,
      [TENANT_A]
    );
    await insertMarketingSpend(campaignA, "2026-09-01", 1_111);
    const syncResult = await service.syncMarketingSpend(TENANT_A, "business");
    expect(syncResult.inserted + syncResult.updated).toBeGreaterThanOrEqual(0); // fullfører uten å kaste - kill switch rører ALDRI denne koden
    await expect(service.runAnomalyDetection(TENANT_A, "business")).resolves.toBeDefined();
    await expect(service.matchAndReconcile(TENANT_A, "business")).resolves.toBeDefined();
    await adminPool.query(`UPDATE finance_kill_switch SET enabled = false WHERE tenant_id = $1`, [TENANT_A]);
  });
});

describe("I: full sveip (§12) - trygt å kjøre gjentatte ganger", () => {
  it("runFullSweep() kjører synk+matching+deteksjon for begge kilder uten å kaste, idempotent ved rekjøring", async () => {
    const first = await service.runFullSweep(TENANT_A, "business");
    expect(first.marketing).toBeDefined();
    expect(first.model_cost).toBeDefined();
    const second = await service.runFullSweep(TENANT_A, "business");
    expect(second.marketing.scanned).toBe(0);
    expect(second.model_cost.scanned).toBe(0);
  });
});
