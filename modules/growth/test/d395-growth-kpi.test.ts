import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { GrowthService } from "../src/service.ts";

/**
 * D-395 (JARVIS-083): CAC/ROAS-feil mot ekte Postgres/RLS - (1) utgift dobbelttalt når samme dag har rader fra flere kildetyper,
 * (2) fremmed valuta ble summert rett oppå NOK, (3) inntekt dobbelttalt når samme opportunity er tilskrevet under begge modeller.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: GrowthService;
const TENANT = "tenant-grw-kpi";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-growth-kpi-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_grw_kpi_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_grw_kpi_test");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'KPI', 'business')`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_grw_kpi_test", password: "pw2" });
  service = new GrowthService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

async function insertOpportunity(id: string, stage: string, valueOre: number): Promise<void> {
  await withMemoryTransaction(appPool, TENANT, ["business"], (client) =>
    client.query(`INSERT INTO business_opportunities (opportunity_id, tenant_id, memory_space_id, title, stage, value_ore) VALUES ($1, $2, 'business', 'Opp', $3, $4)`, [id, TENANT, stage, valueOre])
  );
}

describe("utgift telles én gang per dato (kilde med høyest tillit vinner)", () => {
  it("manual + provider_sync samme dag: kun provider_sync teller (tidligere summert = dobbelt)", async () => {
    const c = await service.createCampaign(TENANT, "business", { channel: "google_ads", name: "Dedup" });
    await service.recordSpendEvent(TENANT, "business", c.campaign_id, { event_date: "2026-09-01", spend_amount_ore: 100_000, source_type: "manual" });
    await service.recordSpendEvent(TENANT, "business", c.campaign_id, { event_date: "2026-09-01", spend_amount_ore: 120_000, source_type: "provider_sync" });
    await service.recordSpendEvent(TENANT, "business", c.campaign_id, { event_date: "2026-09-02", spend_amount_ore: 50_000, source_type: "manual" });
    const perf = await service.campaignPerformance(TENANT, "business", c.campaign_id);
    expect(perf?.total_spend_ore).toBe("170000"); // 120 000 (provider) + 50 000 (kun manuell den dagen)
  });

  it("csv_import slår manual, men taper mot provider_sync", async () => {
    const c = await service.createCampaign(TENANT, "business", { channel: "google_ads", name: "Precedence" });
    for (const [type, amount] of [["manual", 10], ["csv_import", 20], ["provider_sync", 30]] as const) {
      await service.recordSpendEvent(TENANT, "business", c.campaign_id, { event_date: "2026-09-03", spend_amount_ore: amount, source_type: type });
    }
    expect((await service.campaignPerformance(TENANT, "business", c.campaign_id))?.total_spend_ore).toBe("30");
  });
});

describe("valuta", () => {
  it("fremmed valuta summeres IKKE inn i NOK-utgiften, og CAC/ROAS blir udefinerte (null) - ikke en fabrikkert blanding", async () => {
    const c = await service.createCampaign(TENANT, "business", { channel: "meta_ads", name: "USD" });
    await service.recordSpendEvent(TENANT, "business", c.campaign_id, { event_date: "2026-09-04", spend_amount_ore: 100_000, currency: "NOK" });
    await service.recordSpendEvent(TENANT, "business", c.campaign_id, { event_date: "2026-09-05", spend_amount_ore: 9_999_999, currency: "USD" });
    await insertOpportunity("opp-kpi-usd", "won", 500_000);
    await service.attributeToCampaign(TENANT, "business", c.campaign_id, { entity_type: "opportunity", entity_id: "opp-kpi-usd" });
    const perf = await service.campaignPerformance(TENANT, "business", c.campaign_id);
    expect(perf?.total_spend_ore).toBe("100000");
    expect(perf?.spend_currencies).toEqual(["NOK", "USD"]);
    expect(perf?.cac_ore).toBeNull();
    expect(perf?.roas).toBeNull();
  });

  it("kun NOK: ratioene beregnes som før, og spend_currencies = [NOK]", async () => {
    const c = await service.createCampaign(TENANT, "business", { channel: "google_ads", name: "NOK only" });
    await service.recordSpendEvent(TENANT, "business", c.campaign_id, { event_date: "2026-09-06", spend_amount_ore: 100_000 });
    await insertOpportunity("opp-kpi-nok", "won", 400_000);
    await service.attributeToCampaign(TENANT, "business", c.campaign_id, { entity_type: "opportunity", entity_id: "opp-kpi-nok" });
    const perf = await service.campaignPerformance(TENANT, "business", c.campaign_id);
    expect(perf?.spend_currencies).toEqual(["NOK"]);
    expect(perf?.cac_ore).toBe(100_000);
    expect(perf?.roas).toBe(4);
  });
});

describe("inntekt telles én gang per opportunity", () => {
  it("samme vunne opportunity tilskrevet under first_touch OG last_touch teller én gang", async () => {
    const c = await service.createCampaign(TENANT, "business", { channel: "google_ads", name: "Both models" });
    await service.recordSpendEvent(TENANT, "business", c.campaign_id, { event_date: "2026-09-07", spend_amount_ore: 100_000 });
    await insertOpportunity("opp-kpi-both", "won", 300_000);
    await service.attributeToCampaign(TENANT, "business", c.campaign_id, { entity_type: "opportunity", entity_id: "opp-kpi-both", attribution_model: "first_touch" });
    await service.attributeToCampaign(TENANT, "business", c.campaign_id, { entity_type: "opportunity", entity_id: "opp-kpi-both", attribution_model: "last_touch" });
    const perf = await service.campaignPerformance(TENANT, "business", c.campaign_id);
    expect(perf?.attributed_revenue_ore).toBe("300000"); // tidligere 600 000
    expect(perf?.won_opportunities).toBe(1);
    expect(perf?.attributed_opportunities).toBe(1);
    expect(perf?.roas).toBe(3);
    expect(perf?.cac_ore).toBe(100_000);
  });
});
