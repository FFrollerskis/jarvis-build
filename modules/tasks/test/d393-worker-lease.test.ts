import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContract } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InProcessWorker, PgTaskQueue } from "@jarvis/tasks";

/** D-393 (JARVIS-040): lease fornyes mens jobben kjører, og samme worker kan ikke overlappe egne drain-løkker. */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let queue: PgTaskQueue;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d393-lease-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d393 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_d393");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-lease','Lease','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-lease');
  `);
  appPool = createPool({ ...base, user: "jarvis_d393", password: "pw2" });
  queue = new PgTaskQueue(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const contract = (): JobContract => ({
  task_id: `task-${randomUUID()}`, owner_person_id: "person-tobias", tenant_id: "tenant-lease", goal: "lang jobb",
  acceptance_criteria: ["fullfører"], input: { data: {}, trust_level: "internal", provenance: "test" },
  allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [], agent_profile: "executive",
  model_budget_ore: 1000, retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3
});

describe("JARVIS-040: lease-fornyelse", () => {
  it("en jobb som kjører lenger enn leasen forblir eid (en annen worker kan ikke claime den), og fullføres", async () => {
    const worker = new InProcessWorker(queue, 3); // heartbeat hvert sekund
    const job = contract();
    await queue.enqueue("tenant-lease", job);
    worker.register("executive", async () => {
      await new Promise((resolve) => setTimeout(resolve, 4500)); // > lease (3 s)
      return { ok: true };
    });
    const running = worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 3600));
    const intruder = new InProcessWorker(queue, 3);
    intruder.register("executive", async () => ({}));
    const stolen = await queue.claimNext(intruder.workerId, 3, ["executive"]);
    expect(stolen).toBeNull();
    expect(await running).toBe(job.task_id);
    const view = await queue.get("tenant-lease", job.task_id);
    expect(view?.status).toBe("completed");
  }, 20_000);

  it("drain() overlapper ikke: et nytt kall mens en drain pågår returnerer umiddelbart 0", async () => {
    const worker = new InProcessWorker(queue, 60);
    await queue.enqueue("tenant-lease", contract());
    let started = false;
    worker.register("executive", async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 600));
      return {};
    });
    const first = worker.drain();
    while (!started) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await worker.drain()).toBe(0);
    expect(await first).toBe(1);
  }, 20_000);
});
