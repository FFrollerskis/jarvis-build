import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { OpenLoopService } from "../src/open-loop-service.ts";
import { runOpenLoopSweepForAllTenants } from "../src/open-loop-sweep.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway (D-107): "Reuse OpenLoopService...
 * No second task/reminder engine" - testmatrise for de to nye
 * `payment_intent_anomaly`/`payment_intent_reconciliation_mismatch`-
 * loop_type-reglene. Rene SQL-fixtures direkte mot `payment_intents`
 * (038_finance.sql) - `@jarvis/business` importerer BEVISST IKKE
 * `@jarvis/finance` (samme arkitektur-presedens som growth/contracts:
 * OpenLoopService leser tabellen direkte via raa SQL, ingen pakke-
 * avhengighet på tvers av domenegrensen).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let openLoops: OpenLoopService;

const TENANT_A = "tenant-ol-fin-a";
const TENANT_B = "tenant-ol-fin-b";

async function insertPaymentIntent(
  tenantId: string,
  opts: { state?: string; reconciliationState?: string; anomalyFlags?: string[] } = {}
): Promise<string> {
  const id = `fin-pi-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO payment_intents
         (payment_intent_id, tenant_id, memory_space_id, idempotency_key, purpose, amount_ore, vendor_name, account_code, state, reconciliation_state, anomaly_flags, owner_person_id)
       VALUES ($1, $2, 'business', $1, 'Test', 10000, 'Leverandør', '6540', $3, $4, $5, 'person-tobias')`,
      [id, tenantId, opts.state ?? "draft", opts.reconciliationState ?? "unreconciled", JSON.stringify(opts.anomalyFlags ?? [])]
    )
  );
  return id;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-openloop-fin-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_openloop_fin_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_openloop_fin_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-a-business','${TENANT_A}','business'), ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_openloop_fin_test", password: "pw2" });
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: payment_intent_anomaly - avviksflagget, ikke-terminal intensjon", () => {
  it("en draft-intensjon med anomaly_flags blir et open loop (priority normal)", async () => {
    const id = await insertPaymentIntent(TENANT_A, { anomalyFlags: ["vendor_provider_ref_missing_at_creation"] });
    const result = await openLoops.detectPaymentAnomalies(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.payment_intent_id === id);
    expect(loop?.loop_type).toBe("payment_intent_anomaly");
    expect(loop?.priority).toBe("normal");
    expect(loop?.campaign_id).toBeNull();
  });
  it("en intensjon UTEN avviksflagg gir INGEN open loop", async () => {
    const id = await insertPaymentIntent(TENANT_A, { anomalyFlags: [] });
    await openLoops.detectPaymentAnomalies(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.payment_intent_id === id)).toBeUndefined();
  });
  it("en SETTLED intensjon med (historiske) avviksflagg gir INGEN nytt open loop - allerede oppgjort trenger ingen ny handling", async () => {
    const id = await insertPaymentIntent(TENANT_A, { state: "settled", anomalyFlags: ["vendor_provider_ref_missing_at_creation"] });
    await openLoops.detectPaymentAnomalies(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.payment_intent_id === id)).toBeUndefined();
  });
});

describe("B: payment_intent_reconciliation_mismatch", () => {
  it("en mismatched-avstemt intensjon blir et open loop (priority high)", async () => {
    const id = await insertPaymentIntent(TENANT_A, { state: "settled", reconciliationState: "mismatched" });
    const result = await openLoops.detectPaymentAnomalies(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.payment_intent_id === id);
    expect(loop?.loop_type).toBe("payment_intent_reconciliation_mismatch");
    expect(loop?.priority).toBe("high");
  });
  it("en matched-avstemt intensjon gir INGEN open loop", async () => {
    const id = await insertPaymentIntent(TENANT_A, { state: "settled", reconciliationState: "matched" });
    await openLoops.detectPaymentAnomalies(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.payment_intent_id === id)).toBeUndefined();
  });
});

describe("C: auto-resolve naar vilkaaret ikke lenger er sant", () => {
  it("en tidligere mismatched intensjon som rettes til matched resolves automatisk", async () => {
    const id = await insertPaymentIntent(TENANT_A, { state: "settled", reconciliationState: "mismatched" });
    await openLoops.detectPaymentAnomalies(TENANT_A, "business");
    let loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.payment_intent_id === id)).toBeTruthy();

    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(`UPDATE payment_intents SET reconciliation_state = 'matched' WHERE payment_intent_id = $1`, [id])
    );
    const result = await openLoops.detectPaymentAnomalies(TENANT_A, "business");
    expect(result.auto_resolved).toBeGreaterThanOrEqual(1);
    loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.payment_intent_id === id)).toBeUndefined();
  });
});

describe("D: runSweep inkluderer finans-reglene (Q-27-trygg full sveip)", () => {
  it("runSweep() detekterer payment_intent_anomaly UTEN et separat kall", async () => {
    const id = await insertPaymentIntent(TENANT_A, { anomalyFlags: ["counter_account_code_missing_at_creation"] });
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.payment_intent_id === id)?.loop_type).toBe("payment_intent_anomaly");
  });
  it("runOpenLoopSweepForAllTenants isolerer en tenant sin feil fra resten", async () => {
    await insertPaymentIntent(TENANT_A, { anomalyFlags: ["vendor_provider_ref_missing_at_creation"] });
    const results = await runOpenLoopSweepForAllTenants(appPool, openLoops);
    expect(results[TENANT_A]).toBeDefined();
  });
});

describe("E: tenant-isolasjon", () => {
  it("TENANT_B faar ALDRI et open loop for TENANT_A sin betalingsintensjon", async () => {
    const id = await insertPaymentIntent(TENANT_A, { anomalyFlags: ["vendor_provider_ref_missing_at_creation"] });
    await openLoops.detectPaymentAnomalies(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB.find((l) => l.payment_intent_id === id)).toBeUndefined();
  });
});
