import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { LocalHashEmbedding, withMemoryTransaction } from "@jarvis/memory";
import { BusinessService, OpenLoopService, type BusinessOpenLoop } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/product pakkeavhengighet
// kun for en testfil) - samme presedens som contracts-erasure.test.ts sin
// import av AgreementsService.
import { ProductService } from "../../product/src/service.ts";

/**
 * UA-3 Native Jarvis Product Core (D-128) Q-20/Q-27: erasure av et
 * produktpunkt med en LINKET open-loop (`business_open_loops.product_item_id`,
 * 047_product.sql) - SAMME lærdom/presedens som contracts-erasure.test.ts,
 * løst FØRST i selve `plan.ts` denne gangen (ingen separat host-runde
 * nødvendig). Beviser FK-ordren (product_item_events FØR product_items,
 * business_open_loops FØR product_items) mot en EKTE embedded Postgres via
 * den EKTE `ErasureService.executeErasure()`-APIen.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let product: ProductService;
let openLoops: OpenLoopService;
let business: BusinessService;

const TENANT_A = "tenant-prd-erase-a";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "dev-prd-erase", channel: "api", auth_strength: "active"
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-prd-erasure-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // Garantert non-bypass rolle - beviser samtidig at 047-migrasjonens
  // GRANT DELETE faktisk holder for denne EKSAKTE rollekonstruksjonen.
  await adminPool.query("CREATE ROLE jarvis_prd_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_prd_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Prd Erasure Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-prd-erase-business','${TENANT_A}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_prd_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
  });
  product = new ProductService(appPool);
  openLoops = new OpenLoopService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: schema-drevet FK-audit - business_open_loops er DET ENESTE eksterne avhengighetspunktet mot product_items", () => {
  it("information_schema viser INGEN andre tabeller med en FK inn mot product_items enn business_open_loops (og product_item_events sin egen)", async () => {
    const { rows } = await adminPool.query(`
      SELECT tc.table_name AS dependent_table, ccu.table_name AS target_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'product_items'
    `);
    const known = new Set(["business_open_loops", "product_item_events"]);
    const unexpected = (rows as Array<{ dependent_table: string }>).filter((r) => !known.has(r.dependent_table));
    expect(unexpected).toHaveLength(0);
    expect((rows as Array<{ dependent_table: string }>).some((r) => r.dependent_table === "business_open_loops")).toBe(true);
  });
});

describe("B/C/D: erasure av et produktpunkt med LINKET open-loop lykkes, ingen FK-brudd", () => {
  it("executeErasure fjerner produktpunkt + events + den punkt-linkede open-loopen", async () => {
    const sentinel = `SentinelPrdErase${randomUUID().replace(/-/g, "")}`;
    const item = await product.createItem(TENANT_A, "business", { title: sentinel });
    await product.setOwner(TENANT_A, "business", item.item_id, "person-tobias");
    // RLS krever jarvis.tenant_id/jarvis.memory_spaces session-kontekst -
    // en rå appPool.query() UTENFOR withMemoryTransaction ser INGEN rader
    // (samme presedens som open-loop-product.test.ts sin insertProductItem-hjelper).
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE product_items SET created_at = now() - interval '10 days' WHERE tenant_id = $1 AND item_id = $2", [TENANT_A, item.item_id])
    );
    await openLoops.runSweep(TENANT_A, "business");

    const linkedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.product_item_id === item.item_id
    );
    expect(linkedBefore).toBeDefined();
    const linkedOpenLoopId = linkedBefore!.open_loop_id;

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-prd-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed"); // Ville rapportert "failed" ved en FK-regresjon.

    // §D: den linkede open-loop-raden er FAKTISK BORTE.
    const linkedGone = await adminPool.query("SELECT 1 FROM business_open_loops WHERE open_loop_id = $1", [linkedOpenLoopId]);
    expect(linkedGone.rowCount).toBe(0);
    const anyLinkedGone = await adminPool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE product_item_id = $1", [item.item_id]);
    expect((anyLinkedGone.rows[0] as { n: number }).n).toBe(0);

    // §B: selve produktpunktet er borte.
    const itemGone = await product.getItem(TENANT_A, "business", item.item_id);
    expect(itemGone).toBeNull();

    // §C: events er borte.
    const eventsGone = await adminPool.query("SELECT 1 FROM product_item_events WHERE item_id = $1", [item.item_id]);
    expect(eventsGone.rowCount).toBe(0);
  });
});

describe("D (utvidet): ingen dinglende FK-referanse noe sted i tenanten etter erasure", () => {
  it("ingen business_open_loops-rad i tenanten peker til en product_items-rad som ikke finnes", async () => {
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM business_open_loops bol
       WHERE bol.tenant_id = $1 AND bol.product_item_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM product_items p WHERE p.item_id = bol.product_item_id)`,
      [TENANT_A]
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("E: et erasert produktpunkt kan ikke gjenoppstaa - et nytt punkt faar en HELT NY item_id", () => {
  it("et nytt punkt opprettet etter erasure faar en ny id, aldri en gjenbruk av den slettede", async () => {
    const sentinel = `SentinelNoResurrectPrd${randomUUID().replace(/-/g, "")}`;
    const item = await product.createItem(TENANT_A, "business", { title: sentinel });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const erased = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-prd-erase-resurrect-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(erased.status).toBe("completed");

    const gone = await product.getItem(TENANT_A, "business", item.item_id);
    expect(gone).toBeNull();

    const fresh = await product.createItem(TENANT_A, "business", { title: sentinel });
    expect(fresh.item_id).not.toBe(item.item_id);
    const freshEvents = await product.listEvents(TENANT_A, "business", fresh.item_id);
    expect(freshEvents).toHaveLength(1); // KUN "item_created" - ingen historikk overlevde fra det slettede punktet.
  });
});

describe("F/G: urelaterte open-loops og urelatert business-data er UPAAVIRKET av en product-scoped erasure", () => {
  it("en urelatert (ikke-produkt-tilknyttet) open-loop og en urelatert followup forblir uendret", async () => {
    const sentinel = `SentinelUnrelatedPrd${randomUUID().replace(/-/g, "")}`;
    const followup = await business.createFollowup(TENANT_A, "business", {
      title: sentinel, due_at: new Date(Date.now() - 3_600_000).toISOString()
    });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const unrelatedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.followup_id === followup.followup_id
    );
    expect(unrelatedBefore).toBeDefined();
    expect(unrelatedBefore!.product_item_id).toBeNull();

    const item = await product.createItem(TENANT_A, "business", { title: `${sentinel}-item` });
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE product_items SET created_at = now() - interval '10 days' WHERE tenant_id = $1 AND item_id = $2", [TENANT_A, item.item_id])
    );
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-prd-erase-unrelated-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed");

    // §F: den urelaterte (followup-)loopen finnes FORTSATT, uendret.
    const unrelatedAfter = await openLoops.readOpenLoop(TENANT_A, "business", unrelatedBefore!.open_loop_id);
    expect(unrelatedAfter).not.toBeNull();

    // §G: den urelaterte business_followups-raden er urørt.
    const followupStillThere = await adminPool.query("SELECT 1 FROM business_followups WHERE followup_id = $1", [followup.followup_id]);
    expect(followupStillThere.rowCount).toBe(1);
  });
});

describe("H: idempotens - samme request_id kjørt to ganger paa et product-scoped erasure gir samme resultat", () => {
  it("andre kjøring er en idempotent replay, ingen dobbel sletting, ingen feil", async () => {
    const item = await product.createItem(TENANT_A, "business", { title: "Idempotent prd erasure" });
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE product_items SET created_at = now() - interval '10 days' WHERE tenant_id = $1 AND item_id = $2", [TENANT_A, item.item_id])
    );
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-prd-erase-idem-${randomUUID()}`;
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" } as const;
    const identity = identityFor(TENANT_A);

    const first = await service.executeErasure({ scope, requestId, identity });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);
  });
});
