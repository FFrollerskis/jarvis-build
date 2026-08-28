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
 * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2) §10:
 * "Reuse OpenLoopService... no separate shadow task system" - testmatrise
 * for de fem nye `finance_spend_unexpected`/`finance_spend_amount_deviation`/
 * `finance_recurring_charge_missing`/`finance_recurring_charge_duplicate`/
 * `finance_spend_correction_conflict`-loop_type-reglene. Rene SQL-fixtures
 * DIREKTE mot `finance_spend_records`/`finance_recurring_commitments`
 * (039_finance_spend_integrity.sql, avviksflagg satt DIREKTE - disse fem
 * metodene SURFACER allerede-beregnede flagg, beregner INGENTING selv, se
 * open-loop-service.ts-JSDoc) - `@jarvis/business` importerer BEVISST IKKE
 * `@jarvis/finance` (samme presedens som `open-loop-finance.test.ts`).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let openLoops: OpenLoopService;

const TENANT_A = "tenant-ol-spend-a";
const TENANT_B = "tenant-ol-spend-b";

async function insertSpendRecord(tenantId: string, opts: { anomalyFlags?: string[]; campaignId?: string | null } = {}): Promise<string> {
  const id = `fin-sr-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO finance_spend_records
         (spend_record_id, tenant_id, memory_space_id, source_family, source_record_id, occurred_at, amount_ore, currency, category, campaign_id, anomaly_flags)
       VALUES ($1, $2, 'business', 'model_cost', $1, now(), 5000, 'NOK', 'ai_api_cost', $3, $4)`,
      [id, tenantId, opts.campaignId ?? null, JSON.stringify(opts.anomalyFlags ?? [])]
    )
  );
  return id;
}

async function insertCommitment(tenantId: string, opts: { anomalyFlags?: string[] } = {}): Promise<string> {
  const id = `fin-rc-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO finance_recurring_commitments
         (commitment_id, tenant_id, memory_space_id, vendor_name, description, cadence, expected_amount_ore, start_date, anomaly_flags, owner_person_id)
       VALUES ($1, $2, 'business', 'Vendor', 'D', 'monthly', 10000, '2026-01-01', $3, 'person-tobias')`,
      [id, tenantId, JSON.stringify(opts.anomalyFlags ?? [])]
    )
  );
  return id;
}

/** UA-6 closeout (D-115): `finance_procurement_items` fixture. */
async function insertProcurementItem(tenantId: string, opts: { anomalyFlags?: string[] } = {}): Promise<string> {
  const id = `fin-pi-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO finance_procurement_items
         (procurement_item_id, tenant_id, memory_space_id, vendor_name, description, expected_amount_ore, expected_date, anomaly_flags, owner_person_id)
       VALUES ($1, $2, 'business', 'Vendor', 'Anskaffelse', 20000, '2026-01-01', $3, 'person-tobias')`,
      [id, tenantId, JSON.stringify(opts.anomalyFlags ?? [])]
    )
  );
  return id;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-openloop-spend-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_openloop_spend_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_openloop_spend_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-a-business','${TENANT_A}','business'), ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_openloop_spend_test", password: "pw2" });
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: finance_spend_unexpected", () => {
  it("en spend-record med UNEXPECTED_SPEND-flagget blir et open loop (priority high)", async () => {
    const id = await insertSpendRecord(TENANT_A, { anomalyFlags: ["UNEXPECTED_SPEND"] });
    const result = await openLoops.detectUnexpectedSpend(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.finance_spend_record_id === id);
    expect(loop?.loop_type).toBe("finance_spend_unexpected");
    expect(loop?.priority).toBe("high");
  });
  it("en spend-record UTEN flagget gir INGEN open loop", async () => {
    const id = await insertSpendRecord(TENANT_A, { anomalyFlags: [] });
    await openLoops.detectUnexpectedSpend(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_spend_record_id === id)).toBeUndefined();
  });
});

describe("B: finance_spend_amount_deviation", () => {
  it("en spend-record med AMOUNT_DEVIATION-flagget blir et open loop (priority normal)", async () => {
    const id = await insertSpendRecord(TENANT_A, { anomalyFlags: ["AMOUNT_DEVIATION"] });
    const result = await openLoops.detectSpendAmountDeviation(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_spend_record_id === id)?.loop_type).toBe("finance_spend_amount_deviation");
  });
});

describe("C: finance_spend_correction_conflict", () => {
  it("en spend-record med SOURCE_CORRECTION_CONFLICT-flagget blir et open loop (priority high)", async () => {
    const id = await insertSpendRecord(TENANT_A, { anomalyFlags: ["SOURCE_CORRECTION_CONFLICT"] });
    const result = await openLoops.detectSpendCorrectionConflicts(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.finance_spend_record_id === id);
    expect(loop?.loop_type).toBe("finance_spend_correction_conflict");
    expect(loop?.priority).toBe("high");
  });
});

describe("D: finance_recurring_charge_missing", () => {
  it("en forpliktelse med MISSING_EXPECTED_SPEND-flagget blir et open loop (priority high)", async () => {
    const id = await insertCommitment(TENANT_A, { anomalyFlags: ["MISSING_EXPECTED_SPEND"] });
    const result = await openLoops.detectMissingRecurringCharges(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.finance_recurring_commitment_id === id);
    expect(loop?.loop_type).toBe("finance_recurring_charge_missing");
    expect(loop?.priority).toBe("high");
    expect(loop?.campaign_id).toBeNull();
  });
  it("en forpliktelse UTEN flagget gir INGEN open loop", async () => {
    const id = await insertCommitment(TENANT_A, { anomalyFlags: [] });
    await openLoops.detectMissingRecurringCharges(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_recurring_commitment_id === id)).toBeUndefined();
  });
});

describe("E: finance_recurring_charge_duplicate", () => {
  it("en forpliktelse med DUPLICATE_RECURRING_CHARGE-flagget blir et open loop (priority high)", async () => {
    const id = await insertCommitment(TENANT_A, { anomalyFlags: ["DUPLICATE_RECURRING_CHARGE"] });
    const result = await openLoops.detectDuplicateRecurringCharges(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_recurring_commitment_id === id)?.loop_type).toBe("finance_recurring_charge_duplicate");
  });
});

describe("I: finance_procurement_missing (UA-6 closeout, D-115)", () => {
  it("en anskaffelse med MISSING_EXPECTED_SPEND-flagget blir et open loop (priority high)", async () => {
    const id = await insertProcurementItem(TENANT_A, { anomalyFlags: ["MISSING_EXPECTED_SPEND"] });
    const result = await openLoops.detectMissingProcurementFulfillment(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.finance_procurement_item_id === id);
    expect(loop?.loop_type).toBe("finance_procurement_missing");
    expect(loop?.priority).toBe("high");
    expect(loop?.campaign_id).toBeNull();
  });
  it("en anskaffelse UTEN flagget gir INGEN open loop", async () => {
    const id = await insertProcurementItem(TENANT_A, { anomalyFlags: [] });
    await openLoops.detectMissingProcurementFulfillment(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_procurement_item_id === id)).toBeUndefined();
  });
  it("runSweep() detekterer finance_procurement_missing UTEN et separat kall", async () => {
    const id = await insertProcurementItem(TENANT_A, { anomalyFlags: ["MISSING_EXPECTED_SPEND"] });
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_procurement_item_id === id)?.loop_type).toBe("finance_procurement_missing");
  });
  it("TENANT_B faar ALDRI et open loop for TENANT_A sin anskaffelse", async () => {
    const id = await insertProcurementItem(TENANT_A, { anomalyFlags: ["MISSING_EXPECTED_SPEND"] });
    await openLoops.detectMissingProcurementFulfillment(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB.find((l) => l.finance_procurement_item_id === id)).toBeUndefined();
  });
});

describe("F: auto-resolve naar vilkaaret ikke lenger er sant", () => {
  it("et tidligere UNEXPECTED_SPEND-flagg som klareres resolves automatisk", async () => {
    const id = await insertSpendRecord(TENANT_A, { anomalyFlags: ["UNEXPECTED_SPEND"] });
    await openLoops.detectUnexpectedSpend(TENANT_A, "business");
    let loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_spend_record_id === id)).toBeTruthy();

    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(`UPDATE finance_spend_records SET anomaly_flags = '[]'::jsonb WHERE spend_record_id = $1`, [id])
    );
    const result = await openLoops.detectUnexpectedSpend(TENANT_A, "business");
    expect(result.auto_resolved).toBeGreaterThanOrEqual(1);
    loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_spend_record_id === id)).toBeUndefined();
  });
});

describe("G: runSweep inkluderer de fem finans-utgifts-reglene (Q-27-trygg full sveip)", () => {
  it("runSweep() detekterer finance_spend_unexpected UTEN et separat kall", async () => {
    const id = await insertSpendRecord(TENANT_A, { anomalyFlags: ["UNEXPECTED_SPEND"] });
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.finance_spend_record_id === id)?.loop_type).toBe("finance_spend_unexpected");
  });
  it("runOpenLoopSweepForAllTenants isolerer en tenant sin feil fra resten", async () => {
    await insertSpendRecord(TENANT_A, { anomalyFlags: ["AMOUNT_DEVIATION"] });
    const results = await runOpenLoopSweepForAllTenants(appPool, openLoops);
    expect(results[TENANT_A]).toBeDefined();
  });
});

describe("H: tenant-isolasjon", () => {
  it("TENANT_B faar ALDRI et open loop for TENANT_A sin utgiftspost", async () => {
    const id = await insertSpendRecord(TENANT_A, { anomalyFlags: ["UNEXPECTED_SPEND"] });
    await openLoops.detectUnexpectedSpend(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB.find((l) => l.finance_spend_record_id === id)).toBeUndefined();
  });
  it("TENANT_B faar ALDRI et open loop for TENANT_A sin forpliktelse", async () => {
    const id = await insertCommitment(TENANT_A, { anomalyFlags: ["MISSING_EXPECTED_SPEND"] });
    await openLoops.detectMissingRecurringCharges(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB.find((l) => l.finance_recurring_commitment_id === id)).toBeUndefined();
  });
});
