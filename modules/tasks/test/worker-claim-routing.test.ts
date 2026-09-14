import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobContract } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InProcessWorker, PgTaskQueue } from "@jarvis/tasks";

/**
 * D-103 (UA-5 Production Coding Reachability Repair v1) - Blokker A: beviser
 * at `claim_next_task()` (035_worker_claim_profile_filter.sql) ATOMISK
 * begrenser claim til jobbtyper anropende worker faktisk har en registrert
 * handler for. FØR denne migrasjonen kunne EN HVILKEN SOM HELST worker-
 * prosess claime EN HVILKEN SOM HELST agent_profile - en prosess uten en
 * matchende handler ville da terminalt feilet jobben med "ingen handler for
 * agentprofil ...". Dette er EKSAKT scenarioet fra produksjonen: apps/api/
 * src/main.ts sin egen "executive"-only InProcessWorker og apps/api/src/
 * worker-main.ts sin "coding"-worker poller SAMME kø samtidig.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let queue: PgTaskQueue;
let resetWorker: InProcessWorker;

function contract(overrides: Partial<JobContract> = {}): JobContract {
  return {
    task_id: `task-${randomUUID()}`,
    owner_person_id: "person-tobias",
    tenant_id: "tenant-a",
    goal: "testjobb",
    acceptance_criteria: ["fullfører"],
    input: { data: {}, trust_level: "internal", provenance: "test" },
    allowed_tools: [],
    allowed_memory_spaces: ["personal"],
    allowed_network_targets: [],
    agent_profile: "executive",
    model_budget_ore: 1000,
    retry_policy: { max_attempts: 2, backoff_seconds: 0 },
    max_steps: 3,
    ...overrides
  };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-claimroute-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person'), ('tenant-b','Annen','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a'), ('person-tobias','tenant-b');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
  queue = new PgTaskQueue(appPool);
  resetWorker = new InProcessWorker(queue, 60);
  for (const profile of ["executive", "coding", "verifier"]) {
    resetWorker.register(profile, async () => ({ drained: true }));
  }
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("D-103: claim_next_task() atomisk profil-filtrert claim (Blokker A)", () => {
  // Hver test enqueuer sine egne, unike task_id-er - men uten opprydding ville
  // en jobb som en tests worker BEVISST IKKE claimer (nettopp poenget som
  // testes) ligge igjen og forstyrre en SENERE tests claim-antakelser (samme
  // "tøm køen for tidligere testers jobber"-presedens som fase6-worker.test.ts).
  // Reset-workeren (registrert i beforeAll etter queue finnes) støtter ALLE
  // agent_profile-verdier denne filen bruker.
  beforeEach(async () => {
    await resetWorker.drain(100);
  });

  it("A: en executive-only worker kan ALDRI claime en coding-jobb (forblir 'created', ALDRI terminalt feilet)", async () => {
    const executiveOnly = new InProcessWorker(queue, 60);
    executiveOnly.register("executive", async () => ({ ok: true }));
    const c = contract({ agent_profile: "coding" });
    await queue.enqueue("tenant-a", c);
    const claimed = await executiveOnly.tick();
    expect(claimed).toBeNull(); // ingenting å claime for DENNE workeren
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("created"); // ALDRI 'failed'
  });

  it("B: en coding-only worker kan ALDRI claime en executive-jobb", async () => {
    const codingOnly = new InProcessWorker(queue, 60);
    codingOnly.register("coding", async () => ({ ok: true }));
    const c = contract({ agent_profile: "executive" });
    await queue.enqueue("tenant-a", c);
    const claimed = await codingOnly.tick();
    expect(claimed).toBeNull();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("created");
  });

  it("C: en coding-worker claimer en coding-jobb korrekt og fullfører den", async () => {
    const codingWorker = new InProcessWorker(queue, 60);
    codingWorker.register("coding", async () => ({ done: true }));
    const c = contract({ agent_profile: "coding" });
    await queue.enqueue("tenant-a", c);
    const taskId = await codingWorker.tick();
    expect(taskId).toBe(c.task_id);
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
  });

  it("D: en executive-worker claimer en executive-jobb korrekt og fullfører den", async () => {
    const executiveWorker = new InProcessWorker(queue, 60);
    executiveWorker.register("executive", async () => ({ done: true }));
    const c = contract({ agent_profile: "executive" });
    await queue.enqueue("tenant-a", c);
    const taskId = await executiveWorker.tick();
    expect(taskId).toBe(c.task_id);
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
  });

  it("E: en worker med flere registrerte handlere claimer BEGGE støttede typer", async () => {
    const multi = new InProcessWorker(queue, 60);
    multi.register("executive", async () => ({ kind: "executive" }));
    multi.register("coding", async () => ({ kind: "coding" }));
    const c1 = contract({ agent_profile: "executive" });
    const c2 = contract({ agent_profile: "coding" });
    await queue.enqueue("tenant-a", c1);
    await queue.enqueue("tenant-a", c2);
    const claimed = await multi.drain();
    expect(claimed).toBe(2);
    expect((await queue.get("tenant-a", c1.task_id))?.status).toBe("completed");
    expect((await queue.get("tenant-a", c2.task_id))?.status).toBe("completed");
  });

  it("F: en eldre, ustøttet jobb blokkerer ALDRI en nyere, støttet jobb (ingen starvation)", async () => {
    const codingOnly = new InProcessWorker(queue, 60);
    codingOnly.register("coding", async () => ({ ok: true }));
    const unsupported = contract({ agent_profile: "verifier" }); // eldst, men ingen handler her
    await queue.enqueue("tenant-a", unsupported);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const supported = contract({ agent_profile: "coding" }); // nyere, MEN støttet
    await queue.enqueue("tenant-a", supported);
    const taskId = await codingOnly.tick();
    expect(taskId).toBe(supported.task_id); // hopper over den ustøttede, eldre jobben
    expect((await queue.get("tenant-a", unsupported.task_id))?.status).toBe("created"); // uendret, IKKE feilet
  });

  it("G: lease-oppførsel uendret - claimNext() med agentProfiles setter fortsatt lease_expires_at", async () => {
    const c = contract({ agent_profile: "coding" });
    await queue.enqueue("tenant-a", c);
    const claimed = await queue.claimNext("worker-lease-g", 60, ["coding"]);
    expect(claimed?.task_id).toBe(c.task_id);
    // D-92-klasse RLS-fallgruve: `tasks` har FORCE RLS (005_rls.sql) - en rå
    // spørring via `jarvis_test`-rollen uten `jarvis.tenant_id` satt ser INGEN
    // rader. `adminPool` (postgres-superbruker) omgår RLS naturlig for denne
    // diagnostiske lesingen (samme mønster som resten av testfilene).
    const raw = await adminPool.query("SELECT lease_expires_at, status FROM tasks WHERE task_id = $1", [c.task_id]);
    expect(raw.rows[0].status).toBe("running");
    expect(raw.rows[0].lease_expires_at).not.toBeNull();
  });

  it("H: reclaim-oppførsel uendret - utløpt lease kan reclaimes av en ANNEN kompatibel worker", async () => {
    const c = contract({ agent_profile: "coding" });
    await queue.enqueue("tenant-a", c);
    const first = await queue.claimNext("worker-h1", 1, ["coding"]);
    expect(first?.task_id).toBe(c.task_id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = await queue.claimNext("worker-h2", 60, ["coding"]);
    expect(second?.task_id).toBe(c.task_id);
    expect(await queue.complete("tenant-a", c.task_id, "worker-h1", { stale: true })).toBe(false);
    expect(await queue.complete("tenant-a", c.task_id, "worker-h2", { ok: true })).toBe(true);
  });

  it("I: retry-oppførsel uendret - en feilet jobb med attempts < max_attempts requeues til 'created', fortsatt kun claimbar for kompatible profiler", async () => {
    const worker = new InProcessWorker(queue, 60);
    let attempt = 0;
    worker.register("coding", async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("simulert feil");
      return { ok: true };
    });
    const c = contract({ agent_profile: "coding", retry_policy: { max_attempts: 2, backoff_seconds: 0 } });
    await queue.enqueue("tenant-a", c);
    await worker.tick();
    expect((await queue.get("tenant-a", c.task_id))?.status).toBe("created");
    await worker.tick();
    expect((await queue.get("tenant-a", c.task_id))?.status).toBe("completed");
  });

  it("J: tenant-isolasjon uendret - claim på tvers av tenants forblir korrekt separert", async () => {
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", async () => ({ ok: true }));
    const cA = contract({ agent_profile: "coding", tenant_id: "tenant-a" });
    const cB = contract({ agent_profile: "coding", tenant_id: "tenant-b" });
    await queue.enqueue("tenant-a", cA);
    await queue.enqueue("tenant-b", cB);
    const claimed = await worker.drain();
    expect(claimed).toBe(2);
    expect((await queue.get("tenant-a", cA.task_id))?.status).toBe("completed");
    expect((await queue.get("tenant-b", cB.task_id))?.status).toBe("completed");
  });

  it("K: to samtidige, kompatible workere kan ALDRI dobbelt-claime samme jobb (FOR UPDATE SKIP LOCKED bevart)", async () => {
    const c = contract({ agent_profile: "coding" });
    await queue.enqueue("tenant-a", c);
    const [a, b] = await Promise.all([
      queue.claimNext("worker-k1", 60, ["coding"]),
      queue.claimNext("worker-k2", 60, ["coding"])
    ]);
    const claimedBy = [a, b].filter((x) => x?.task_id === c.task_id);
    expect(claimedBy).toHaveLength(1); // EN og kun én av de to fikk den
  });

  it("L: normal produksjons-claim-flyt gir ALDRI 'ingen handler for agentprofil'-feil ved profil-mismatch (kun for en worker som selv har en genuin registreringsfeil)", async () => {
    const executiveOnly = new InProcessWorker(queue, 60);
    executiveOnly.register("executive", async () => ({ ok: true }));
    const c = contract({ agent_profile: "coding" });
    await queue.enqueue("tenant-a", c);
    await executiveOnly.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("created"); // ALDRI 'failed', ALDRI last_error om "ingen handler"
    expect(view?.last_error).toBeNull();
  });
});
