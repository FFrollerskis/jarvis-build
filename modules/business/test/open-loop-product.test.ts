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
// Relativ, test-only import (IKKE en ny @jarvis/business -> @jarvis/product
// pakkeavhengighet - samme presedens som erasure/test/product-erasure.test.ts
// sin import av ProductService). Kun brukt her for aa bevise MERGE BLOCKER 1
// (arkitekt-review, D-128): ProductService sine no-op-kall maa IKKE kunne
// manufakturere friskhet ("updated_at") som stille undertrykker
// stagnasjonsregelen.
import { ProductService } from "../../product/src/service.ts";

/**
 * UA-3 Native Jarvis Product Core (D-128): "Reuse OpenLoopService... No
 * second task/reminder engine" - testmatrise for de to nye
 * product_item_*-loop_type-reglene. Rene SQL-fixtures direkte mot
 * `product_items` (047_product.sql) - `@jarvis/business` importerer BEVISST
 * IKKE `@jarvis/product` (samme arkitektur-presedens som
 * contracts/support_tickets: OpenLoopService leser tabellene direkte via
 * raa SQL, ingen pakke-avhengighet på tvers av domenegrensen).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let openLoops: OpenLoopService;
let product: ProductService;

const TENANT_A = "tenant-ol-prd-a";
const TENANT_B = "tenant-ol-prd-b";

async function insertProductItem(
  tenantId: string,
  fields: Partial<{ status: string; priority: string; created_at: string; updated_at: string; company_id: string | null }>
): Promise<string> {
  const itemId = `prd-it-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO product_items (item_id, tenant_id, memory_space_id, title, status, priority, owner_person_id, company_id, created_at, updated_at)
       VALUES ($1, $2, 'business', $3, $4, $5, 'person-tobias', $6, COALESCE($7, now()), COALESCE($8, now()))`,
      [
        itemId, tenantId, `Punkt ${itemId}`, fields.status ?? "new", fields.priority ?? "normal",
        fields.company_id ?? null, fields.created_at ?? null, fields.updated_at ?? null
      ]
    )
  );
  return itemId;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-openloop-prd-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_openloop_prd_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_openloop_prd_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-a-business','${TENANT_A}','business'), ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_openloop_prd_test", password: "pw2" });
  openLoops = new OpenLoopService(appPool);
  product = new ProductService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: product_item_needs_triage", () => {
  it("et punkt i 'new' uendret i over 7 dager blir et open loop", async () => {
    const itemId = await insertProductItem(TENANT_A, { created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    const result = await openLoops.detectProductItemsNeedingTriage(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.product_item_id === itemId);
    expect(loop?.loop_type).toBe("product_item_needs_triage");
  });
  it("et nylig opprettet punkt gir IKKE et triage-loop", async () => {
    const itemId = await insertProductItem(TENANT_A, {});
    await openLoops.detectProductItemsNeedingTriage(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.product_item_id === itemId)).toBeUndefined();
  });
  it("et allerede triagert punkt (status != 'new') gir IKKE et triage-loop selv om det er gammelt", async () => {
    const itemId = await insertProductItem(TENANT_A, { status: "triaged", created_at: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    await openLoops.detectProductItemsNeedingTriage(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.product_item_id === itemId)).toBeUndefined();
  });
});

describe("B: product_item_high_priority_stalled", () => {
  it("et high-prioritert, ikke-terminalt punkt uendret i over 14 dager blir et open loop med prioritet high", async () => {
    const itemId = await insertProductItem(TENANT_A, {
      status: "in_progress", priority: "high", updated_at: new Date(Date.now() - 20 * 86_400_000).toISOString()
    });
    const result = await openLoops.detectStalledHighPriorityProductItems(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.product_item_id === itemId);
    expect(loop?.loop_type).toBe("product_item_high_priority_stalled");
    expect(loop?.priority).toBe("high");
  });
  it("et shipped high-prioritert punkt (terminal status) gir IKKE et stagnasjons-loop", async () => {
    const itemId = await insertProductItem(TENANT_A, {
      status: "shipped", priority: "critical", updated_at: new Date(Date.now() - 60 * 86_400_000).toISOString()
    });
    await openLoops.detectStalledHighPriorityProductItems(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.product_item_id === itemId)).toBeUndefined();
  });
  it("et normal-prioritert punkt gir IKKE et stagnasjons-loop selv om det er gammelt", async () => {
    const itemId = await insertProductItem(TENANT_A, {
      status: "in_progress", priority: "normal", updated_at: new Date(Date.now() - 30 * 86_400_000).toISOString()
    });
    await openLoops.detectStalledHighPriorityProductItems(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.product_item_id === itemId)).toBeUndefined();
  });
});

describe("C: auto-resolve naar vilkaaret ikke lenger er sant", () => {
  it("et triagert punkt resolves automatisk paa neste sveip", async () => {
    const itemId = await insertProductItem(TENANT_A, { created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    await openLoops.detectProductItemsNeedingTriage(TENANT_A, "business");
    let loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.product_item_id === itemId)).toBeTruthy();

    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE product_items SET status = 'triaged' WHERE tenant_id = $1 AND item_id = $2", [TENANT_A, itemId])
    );
    const result = await openLoops.detectProductItemsNeedingTriage(TENANT_A, "business");
    expect(result.auto_resolved).toBeGreaterThanOrEqual(1);
    loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.product_item_id === itemId)).toBeUndefined();
  });
});

describe("D: runSweep inkluderer begge product-regler (Q-27-trygg full sveip)", () => {
  it("runSweep() detekterer product_item_needs_triage UTEN et separat kall", async () => {
    const itemId = await insertProductItem(TENANT_A, { created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.product_item_id === itemId)?.loop_type).toBe("product_item_needs_triage");
  });
  it("runOpenLoopSweepForAllTenants (Q-27, listBusinessTenantIds) isolerer en tenant sin feil fra resten", async () => {
    await insertProductItem(TENANT_A, { created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    const results = await runOpenLoopSweepForAllTenants(appPool, openLoops);
    expect(results[TENANT_A]).toBeDefined();
  });
});

describe("F (arkitekt-review MERGE BLOCKER 1): ProductService sine no-op-kall manufakturerer IKKE friskhet for stagnasjonsregelen", () => {
  it("et repetert setPriority-kall med SAMME prioritet paa et stagnert punkt endrer IKKE updated_at og flagges FORTSATT som stagnert", async () => {
    const itemId = await insertProductItem(TENANT_A, {
      status: "in_progress", priority: "high", updated_at: new Date(Date.now() - 20 * 86_400_000).toISOString()
    });
    const before = await product.getItem(TENANT_A, "business", itemId);
    // Gjentatt kall MED SAMME verdi - dette skal vaere en EKTE no-op (ingen ny updated_at),
    // ALDRI en stille "touch" som gjenoppfrisker punktet uten reell fremgang.
    const after = await product.setPriority(TENANT_A, "business", itemId, "high");
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());

    const result = await openLoops.detectStalledHighPriorityProductItems(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.product_item_id === itemId)?.loop_type).toBe("product_item_high_priority_stalled");
  });
});

describe("E: tenant-isolasjon", () => {
  it("TENANT_B faar ALDRI et open loop for TENANT_A sitt produktpunkt", async () => {
    const itemId = await insertProductItem(TENANT_A, { created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    await openLoops.detectProductItemsNeedingTriage(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB.find((l) => l.product_item_id === itemId)).toBeUndefined();
  });
});
