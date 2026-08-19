import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { OpenLoopService } from "../src/open-loop-service.ts";
import { runOpenLoopSweepForAllTenants } from "../src/open-loop-sweep.ts";

/**
 * UA-4 Native Jarvis Growth Core (D-74): "Reuse OpenLoopService... No
 * second task/reminder engine" - testmatrise for den nye
 * `marketing_spend_anomaly`-loop_type-regelen. Rene SQL-fixtures direkte
 * mot `marketing_campaigns`/`marketing_spend_events` (027_growth.sql) -
 * `@jarvis/business` importerer BEVISST IKKE `@jarvis/growth` (samme
 * arkitektur-presedens som contracts/support: OpenLoopService leser
 * tabellene direkte via raa SQL, ingen pakke-avhengighet på tvers av
 * domenegrensen).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let openLoops: OpenLoopService;

const TENANT_A = "tenant-ol-grw-a";
const TENANT_B = "tenant-ol-grw-b";

async function insertCampaign(tenantId: string, status = "active"): Promise<string> {
  const campaignId = `grw-cm-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO marketing_campaigns (campaign_id, tenant_id, memory_space_id, channel, name, status, owner_person_id)
       VALUES ($1, $2, 'business', 'google_ads', $3, $4, 'person-tobias')`,
      [campaignId, tenantId, `Kampanje ${campaignId}`, status]
    )
  );
  return campaignId;
}

async function insertSpendEvent(tenantId: string, campaignId: string, eventDate: string, spendOre: number): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO marketing_spend_events (spend_event_id, tenant_id, memory_space_id, campaign_id, event_date, spend_amount_ore)
       VALUES ($1, $2, 'business', $3, $4, $5)`,
      [`grw-se-${randomUUID()}`, tenantId, campaignId, eventDate, spendOre]
    )
  );
}

function isoDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-openloop-grw-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_openloop_grw_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_openloop_grw_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-a-business','${TENANT_A}','business'), ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_openloop_grw_test", password: "pw2" });
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: marketing_spend_anomaly - avvik over terskel", () => {
  it("en aktiv kampanje sin siste utgiftsdag vesentlig OVER det glidende 7-dagers-snittet blir et open loop (priority high)", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 1_000);
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 10_000); // ~10x snittet
    const result = await openLoops.detectSpendAnomalies(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.campaign_id === campaignId);
    expect(loop?.loop_type).toBe("marketing_spend_anomaly");
    expect(loop?.priority).toBe("high");
    expect(loop?.company_id).toBeNull(); // kampanjer er IKKE selskap-spesifikke
  });
  it("en aktiv kampanje sin siste utgiftsdag vesentlig UNDER snittet blir ogsaa et open loop (priority normal)", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 10_000);
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 500); // vesentlig under snittet
    await openLoops.detectSpendAnomalies(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.campaign_id === campaignId);
    expect(loop?.loop_type).toBe("marketing_spend_anomaly");
    expect(loop?.priority).toBe("normal");
  });
});

describe("B: ingen avvik gir INGEN open loop", () => {
  it("stabil utgift innenfor terskelen gir ikke et open loop", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 0; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 1_000);
    await openLoops.detectSpendAnomalies(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.campaign_id === campaignId)).toBeUndefined();
  });
  it("en pauset (ikke-aktiv) kampanje med avvikende utgift gir IKKE et open loop", async () => {
    const campaignId = await insertCampaign(TENANT_A, "paused");
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 1_000);
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 20_000);
    await openLoops.detectSpendAnomalies(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.campaign_id === campaignId)).toBeUndefined();
  });
  it("under beløps-gulvet (minBaselineOre) gir ingen støy-alarm selv ved stor prosentvis avvik", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 10); // 10 øre snitt - under gulvet
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 100);
    await openLoops.detectSpendAnomalies(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.campaign_id === campaignId)).toBeUndefined();
  });
});

describe("C: auto-resolve naar vilkaaret ikke lenger er sant", () => {
  it("en tidligere avvikende kampanje som stabiliserer seg resolves automatisk paa neste sveip", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 1_000);
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 10_000);
    await openLoops.detectSpendAnomalies(TENANT_A, "business");
    let loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.campaign_id === campaignId)).toBeTruthy();

    // Ny utgiftsdag der SISTE dags (rn=1) glidende 7-dagers-snitt naa inkluderer
    // den forrige avviks-dagen (10 000) - trailing_avg for nextDay er derfor
    // (6*1000 + 10000) / 7 ~= 2285.71, terskel-intervall [1523.81, 3428.57].
    // 2000 er trygt INNENFOR intervallet - beviser at REGELEN (ikke bare en
    // tilfeldig "lav verdi") avgjør resolve, ikke en for enkel fixture.
    const nextDay = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await insertSpendEvent(TENANT_A, campaignId, nextDay, 2_000);
    const result = await openLoops.detectSpendAnomalies(TENANT_A, "business");
    expect(result.auto_resolved).toBeGreaterThanOrEqual(1);
    loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.campaign_id === campaignId)).toBeUndefined();
  });

  // HOST FIX #1 (D-75): den ekte Windows/Docker-host-akseptansen brukte en
  // ANNEN spike-verdi (20 000, ikke 10 000) enn testen over, MEN samme
  // hardkodede "normaliserings"-verdi (2 000) - som IKKE lenger ligger
  // innenfor det korrekt reberegnede terskel-intervallet for DEN spiken
  // (trailing_avg for nextDay = (6*1000 + 20000) / 7 ~= 3714.29, intervall
  // [2476.19, 5571.43]; 2 000 < 2476.19). Dette var en feil i akseptanse-
  // scriptets fixture-forventning, IKKE en regresjon i den deterministiske
  // regelen - denne testen speiler den EKSAKTE host-scenarien for å hindre
  // at samme feilklasse (terskel-matte som ikke generaliserer på tvers av
  // ulike spike-størrelser) gjentas igjen.
  it("resolves korrekt ogsaa ved en STØRRE spike (20 000) - normaliseringsverdien maa reberegnes for DEN spikens vindu, ikke gjenbrukes fra en annen spike-størrelse", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 1_000);
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 20_000);
    await openLoops.detectSpendAnomalies(TENANT_A, "business");
    let loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.campaign_id === campaignId)).toBeTruthy();

    const nextDay = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await insertSpendEvent(TENANT_A, campaignId, nextDay, 3_500); // innenfor [2476.19, 5571.43]
    const result = await openLoops.detectSpendAnomalies(TENANT_A, "business");
    expect(result.auto_resolved).toBeGreaterThanOrEqual(1);
    loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.campaign_id === campaignId)).toBeUndefined();
  });
});

describe("D: runSweep inkluderer marketing_spend_anomaly (Q-27-trygg full sveip)", () => {
  it("runSweep() detekterer marketing_spend_anomaly UTEN et separat kall", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 1_000);
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 15_000);
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.campaign_id === campaignId)?.loop_type).toBe("marketing_spend_anomaly");
  });
  it("runOpenLoopSweepForAllTenants (Q-27, listBusinessTenantIds) isolerer en tenant sin feil fra resten", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 1_000);
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 15_000);
    const results = await runOpenLoopSweepForAllTenants(appPool, openLoops);
    expect(results[TENANT_A]).toBeDefined();
  });
});

describe("E: tenant-isolasjon", () => {
  it("TENANT_B faar ALDRI et open loop for TENANT_A sin kampanje", async () => {
    const campaignId = await insertCampaign(TENANT_A);
    for (let d = 8; d >= 1; d--) await insertSpendEvent(TENANT_A, campaignId, isoDate(d), 1_000);
    await insertSpendEvent(TENANT_A, campaignId, isoDate(0), 15_000);
    await openLoops.detectSpendAnomalies(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB.find((l) => l.campaign_id === campaignId)).toBeUndefined();
  });
});
