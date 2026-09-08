import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { LocalHashEmbedding, withMemoryTransaction } from "@jarvis/memory";
import { BusinessService, OpenLoopService, type BusinessOpenLoop } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/operations
// pakkeavhengighet kun for en testfil) - samme presedens som
// product-erasure.test.ts sin import av ProductService.
import { OperationsService } from "../../operations/src/service.ts";

/**
 * UA-3 Native Jarvis Operations Core (D-129) Q-20/Q-27: erasure av en
 * driftsoppgave med en LINKET open-loop (`business_open_loops.operations_task_id`,
 * 048_operations.sql), samt leverandør-/runbook-registrene - SAMME lærdom/
 * presedens som product-erasure.test.ts. Beviser FK-ordren
 * (operations_task_events FØR operations_tasks, business_open_loops FØR
 * operations_tasks, operations_tasks FØR operations_runbooks/operations_vendors,
 * operations_runbooks FØR operations_vendors) mot en EKTE embedded Postgres
 * via den EKTE `ErasureService.executeErasure()`-APIen.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let operations: OperationsService;
let openLoops: OpenLoopService;
let business: BusinessService;

const TENANT_A = "tenant-ops-erase-a";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "dev-ops-erase", channel: "api", auth_strength: "active"
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ops-erasure-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // Garantert non-bypass rolle - beviser samtidig at 048-migrasjonens
  // GRANT DELETE faktisk holder for denne EKSAKTE rollekonstruksjonen.
  await adminPool.query("CREATE ROLE jarvis_ops_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ops_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Ops Erasure Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-ops-erase-business','${TENANT_A}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ops_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
  });
  operations = new OperationsService(appPool);
  openLoops = new OpenLoopService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: schema-drevet FK-audit - business_open_loops/operations_task_events er DE ENESTE eksterne avhengighetspunktene mot operations_tasks", () => {
  it("information_schema viser INGEN andre tabeller med en FK inn mot operations_tasks enn de kjente", async () => {
    const { rows } = await adminPool.query(`
      SELECT tc.table_name AS dependent_table, ccu.table_name AS target_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'operations_tasks'
    `);
    const known = new Set(["business_open_loops", "operations_task_events"]);
    const unexpected = (rows as Array<{ dependent_table: string }>).filter((r) => !known.has(r.dependent_table));
    expect(unexpected).toHaveLength(0);
    expect((rows as Array<{ dependent_table: string }>).some((r) => r.dependent_table === "business_open_loops")).toBe(true);
  });
  it("operations_runbooks/operations_tasks er de eneste tabellene med en FK inn mot operations_vendors", async () => {
    const { rows } = await adminPool.query(`
      SELECT tc.table_name AS dependent_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'operations_vendors'
    `);
    const known = new Set(["operations_runbooks", "operations_tasks"]);
    const unexpected = (rows as Array<{ dependent_table: string }>).filter((r) => !known.has(r.dependent_table));
    expect(unexpected).toHaveLength(0);
  });
});

describe("B/C/D: erasure av en driftsoppgave med LINKET open-loop + leverandør/runbook lykkes, ingen FK-brudd", () => {
  it("executeErasure fjerner oppgave + events + vendor + runbook + den oppgave-linkede open-loopen", async () => {
    const sentinel = `SentinelOpsErase${randomUUID().replace(/-/g, "")}`;
    const vendor = await operations.createVendor(TENANT_A, "business", { name: `${sentinel}-vendor` });
    const runbook = await operations.createRunbook(TENANT_A, "business", { title: `${sentinel}-runbook`, content: "...", vendor_id: vendor.vendor_id });
    const task = await operations.createTask(TENANT_A, "business", { title: sentinel, vendor_id: vendor.vendor_id, runbook_id: runbook.runbook_id });
    // RLS krever jarvis.tenant_id/jarvis.memory_spaces session-kontekst -
    // en rå appPool.query() UTENFOR withMemoryTransaction ser INGEN rader
    // (samme presedens som open-loop-operations.test.ts sin insertOperationsTask-hjelper).
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE operations_tasks SET due_at = now() - interval '5 days' WHERE tenant_id = $1 AND task_id = $2", [TENANT_A, task.task_id])
    );
    await openLoops.runSweep(TENANT_A, "business");

    const linkedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.operations_task_id === task.task_id
    );
    expect(linkedBefore).toBeDefined();
    const linkedOpenLoopId = linkedBefore!.open_loop_id;

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-ops-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed"); // Ville rapportert "failed" ved en FK-regresjon.

    // §D: den linkede open-loop-raden er FAKTISK BORTE.
    const linkedGone = await adminPool.query("SELECT 1 FROM business_open_loops WHERE open_loop_id = $1", [linkedOpenLoopId]);
    expect(linkedGone.rowCount).toBe(0);
    const anyLinkedGone = await adminPool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE operations_task_id = $1", [task.task_id]);
    expect((anyLinkedGone.rows[0] as { n: number }).n).toBe(0);

    // §B: selve oppgaven, leverandøren og runbooken er borte.
    const taskGone = await operations.getTask(TENANT_A, "business", task.task_id);
    expect(taskGone).toBeNull();
    const vendorGone = await operations.getVendor(TENANT_A, "business", vendor.vendor_id);
    expect(vendorGone).toBeNull();
    const runbookGone = await operations.getRunbook(TENANT_A, "business", runbook.runbook_id);
    expect(runbookGone).toBeNull();

    // §C: events er borte.
    const eventsGone = await adminPool.query("SELECT 1 FROM operations_task_events WHERE task_id = $1", [task.task_id]);
    expect(eventsGone.rowCount).toBe(0);
  });
});

describe("D (utvidet): ingen dinglende FK-referanse noe sted i tenanten etter erasure", () => {
  it("ingen business_open_loops-rad i tenanten peker til en operations_tasks-rad som ikke finnes", async () => {
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM business_open_loops bol
       WHERE bol.tenant_id = $1 AND bol.operations_task_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM operations_tasks t WHERE t.task_id = bol.operations_task_id)`,
      [TENANT_A]
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("E: en erasert driftsoppgave kan ikke gjenoppstaa - en ny oppgave faar en HELT NY task_id", () => {
  it("en ny oppgave opprettet etter erasure faar en ny id, aldri en gjenbruk av den slettede", async () => {
    const sentinel = `SentinelNoResurrectOps${randomUUID().replace(/-/g, "")}`;
    const task = await operations.createTask(TENANT_A, "business", { title: sentinel });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const erased = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-ops-erase-resurrect-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(erased.status).toBe("completed");

    const gone = await operations.getTask(TENANT_A, "business", task.task_id);
    expect(gone).toBeNull();

    const fresh = await operations.createTask(TENANT_A, "business", { title: sentinel });
    expect(fresh.task_id).not.toBe(task.task_id);
    const freshEvents = await operations.listTaskEvents(TENANT_A, "business", fresh.task_id);
    expect(freshEvents).toHaveLength(1); // KUN "task_created" - ingen historikk overlevde fra den slettede oppgaven.
  });
});

describe("F/G: urelaterte open-loops og urelatert business-data er UPAAVIRKET av en operations-scoped erasure", () => {
  it("en urelatert (ikke-operations-tilknyttet) open-loop og en urelatert followup forblir uendret", async () => {
    const sentinel = `SentinelUnrelatedOps${randomUUID().replace(/-/g, "")}`;
    const followup = await business.createFollowup(TENANT_A, "business", {
      title: sentinel, due_at: new Date(Date.now() - 3_600_000).toISOString()
    });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const unrelatedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.followup_id === followup.followup_id
    );
    expect(unrelatedBefore).toBeDefined();
    expect(unrelatedBefore!.operations_task_id).toBeNull();

    const task = await operations.createTask(TENANT_A, "business", { title: `${sentinel}-task` });
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE operations_tasks SET due_at = now() - interval '5 days' WHERE tenant_id = $1 AND task_id = $2", [TENANT_A, task.task_id])
    );
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-ops-erase-unrelated-${randomUUID()}`,
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

describe("H: idempotens - samme request_id kjørt to ganger paa et operations-scoped erasure gir samme resultat", () => {
  it("andre kjøring er en idempotent replay, ingen dobbel sletting, ingen feil", async () => {
    const task = await operations.createTask(TENANT_A, "business", { title: "Idempotent ops erasure" });
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE operations_tasks SET due_at = now() - interval '5 days' WHERE tenant_id = $1 AND task_id = $2", [TENANT_A, task.task_id])
    );
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-ops-erase-idem-${randomUUID()}`;
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
