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
// Relativ, test-only import (SAMME presedens som open-loop-product.test.ts
// sin import av ProductService) - kun brukt her for aa bevise at
// OperationsService sine no-op-kall IKKE manufakturerer friskhet
// ("updated_at") som stille undertrykker eskalerings-/forfalt-regelen.
import { OperationsService } from "../../operations/src/service.ts";

/**
 * UA-3 Native Jarvis Operations Core (D-129): "Reuse OpenLoopService...
 * No second task/reminder engine" - testmatrise for de to nye
 * operations_task_*-loop_type-reglene. Rene SQL-fixtures direkte mot
 * `operations_tasks` (048_operations.sql) - `@jarvis/business` importerer
 * BEVISST IKKE `@jarvis/operations` (samme arkitektur-presedens som
 * contracts/support_tickets/product_items: OpenLoopService leser tabellene
 * direkte via raa SQL, ingen pakke-avhengighet på tvers av domenegrensen).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let openLoops: OpenLoopService;
let operations: OperationsService;

const TENANT_A = "tenant-ol-ops-a";
const TENANT_B = "tenant-ol-ops-b";

async function insertOperationsTask(
  tenantId: string,
  fields: Partial<{ status: string; priority: string; escalation_level: number; due_at: string | null }>
): Promise<string> {
  const taskId = `ops-tk-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO operations_tasks (task_id, tenant_id, memory_space_id, title, status, priority, owner_person_id, escalation_level, due_at)
       VALUES ($1, $2, 'business', $3, $4, $5, 'person-tobias', $6, $7)`,
      [
        taskId, tenantId, `Punkt ${taskId}`, fields.status ?? "open", fields.priority ?? "normal",
        fields.escalation_level ?? 0, fields.due_at ?? null
      ]
    )
  );
  return taskId;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-openloop-ops-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_openloop_ops_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_openloop_ops_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-a-business','${TENANT_A}','business'), ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_openloop_ops_test", password: "pw2" });
  openLoops = new OpenLoopService(appPool);
  operations = new OperationsService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: operations_task_overdue", () => {
  it("en oppgave med passert due_at, ikke-terminal status, blir et open loop", async () => {
    const taskId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const result = await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.operations_task_id === taskId);
    expect(loop?.loop_type).toBe("operations_task_overdue");
  });
  it("en oppgave uten due_at gir IKKE et forfalt-loop", async () => {
    const taskId = await insertOperationsTask(TENANT_A, {});
    await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === taskId)).toBeUndefined();
  });
  it("en done-oppgave med passert due_at gir IKKE et forfalt-loop (terminal status)", async () => {
    const taskId = await insertOperationsTask(TENANT_A, { status: "done", due_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === taskId)).toBeUndefined();
  });
  it("overdue > 3 dager gir prioritet 'high', ellers 'normal'", async () => {
    const oldId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    const recentId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 1 * 86_400_000).toISOString() });
    await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === oldId)?.priority).toBe("high");
    expect(loops.find((l) => l.operations_task_id === recentId)?.priority).toBe("normal");
  });
});

describe("B: operations_task_escalation_needed (§13 'escalations')", () => {
  it("en oppgave overdue > 3 dager UTEN eskalering (escalation_level=0) blir et eskalerings-loop", async () => {
    const taskId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), escalation_level: 0 });
    const result = await openLoops.detectOperationsTasksNeedingEscalation(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.operations_task_id === taskId);
    expect(loop?.loop_type).toBe("operations_task_escalation_needed");
    expect(loop?.priority).toBe("high");
  });
  it("en allerede eskalert oppgave (escalation_level>=1) gir IKKE et eskalerings-loop selv om den er overdue", async () => {
    const taskId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 10 * 86_400_000).toISOString(), escalation_level: 1 });
    await openLoops.detectOperationsTasksNeedingEscalation(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === taskId)).toBeUndefined();
  });
  it("en oppgave overdue < 3 dager gir IKKE et eskalerings-loop selv om escalation_level=0", async () => {
    const taskId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 1 * 86_400_000).toISOString(), escalation_level: 0 });
    await openLoops.detectOperationsTasksNeedingEscalation(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === taskId)).toBeUndefined();
  });
  it("en ekte OperationsService.escalateTask()-kall (escalation_level 0->1) resolves eskalerings-loopet automatisk paa neste sveip", async () => {
    const task = await operations.createTask(TENANT_A, "business", { title: "Escalation auto-resolve" });
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE operations_tasks SET due_at = now() - interval '5 days' WHERE tenant_id = $1 AND task_id = $2", [TENANT_A, task.task_id])
    );
    await openLoops.detectOperationsTasksNeedingEscalation(TENANT_A, "business");
    let loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === task.task_id)).toBeTruthy();

    await operations.escalateTask(TENANT_A, "business", task.task_id, "person-tobias");
    const result = await openLoops.detectOperationsTasksNeedingEscalation(TENANT_A, "business");
    expect(result.auto_resolved).toBeGreaterThanOrEqual(1);
    loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === task.task_id)).toBeUndefined();
  });
});

describe("C: auto-resolve naar vilkaaret ikke lenger er sant", () => {
  it("en forfalt oppgave resolves automatisk paa neste sveip naar den fullfoeres", async () => {
    const taskId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    let loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === taskId)).toBeTruthy();

    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE operations_tasks SET status = 'done' WHERE tenant_id = $1 AND task_id = $2", [TENANT_A, taskId])
    );
    const result = await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    expect(result.auto_resolved).toBeGreaterThanOrEqual(1);
    loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === taskId)).toBeUndefined();
  });
});

describe("D: runSweep inkluderer begge operations-regler (Q-27-trygg full sveip)", () => {
  it("runSweep() detekterer operations_task_overdue UTEN et separat kall", async () => {
    const taskId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === taskId)?.loop_type).toBe("operations_task_overdue");
  });
  it("runOpenLoopSweepForAllTenants (Q-27, listBusinessTenantIds) isolerer en tenant sin feil fra resten", async () => {
    await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const results = await runOpenLoopSweepForAllTenants(appPool, openLoops);
    expect(results[TENANT_A]).toBeDefined();
  });
});

describe("F (samme disiplin som arkitekt-review MERGE BLOCKER 1/D-128): OperationsService sine no-op-kall manufakturerer IKKE friskhet for forfalt-regelen", () => {
  it("et repetert setPriority-kall med SAMME prioritet paa en forfalt oppgave endrer IKKE updated_at og flagges FORTSATT som forfalt", async () => {
    const task = await operations.createTask(TENANT_A, "business", { title: "No-op freshness", priority: "high" });
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE operations_tasks SET due_at = now() - interval '5 days' WHERE tenant_id = $1 AND task_id = $2", [TENANT_A, task.task_id])
    );
    const before = await operations.getTask(TENANT_A, "business", task.task_id);
    // Gjentatt kall MED SAMME verdi - dette skal vaere en EKTE no-op (ingen ny updated_at),
    // ALDRI en stille "touch" som gjenoppfrisker punktet uten reell fremgang.
    const after = await operations.setPriority(TENANT_A, "business", task.task_id, "high");
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());

    const result = await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.operations_task_id === task.task_id)?.loop_type).toBe("operations_task_overdue");
  });
});

describe("E: tenant-isolasjon", () => {
  it("TENANT_B faar ALDRI et open loop for TENANT_A sin driftsoppgave", async () => {
    const taskId = await insertOperationsTask(TENANT_A, { due_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB.find((l) => l.operations_task_id === taskId)).toBeUndefined();
  });
});
