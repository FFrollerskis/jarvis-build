import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DailyScheduler, type ScheduledRun } from "../src/scheduler.ts";

/**
 * WP-K (D-471, JARVIS-054): `DailyScheduler` gir hver planlagt kjøring en identitet (`ScheduledRun`): stabil `task_id` per jobb og dag, unik `trace_id` per forsøk. Ekte embedded Postgres:
 * forsøkstallet kommer fra `scheduler_state.attempts` (samme claim som før - ingen ny tabell, ingen endret claim-semantikk).
 */
let stop: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpk054-sched-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  pool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  pool.on("error", () => undefined);
  await runMigrations(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stop?.();
}, 120_000);

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const state = async (job: string) =>
  (await pool.query<{ run_date: string; attempts: number; completed_at: Date | null }>(
    "SELECT run_date::text AS run_date, attempts, completed_at FROM scheduler_state WHERE job_name = $1", [job]
  )).rows[0]!;

describe("claimTodayRun: kjøringens identitet", () => {
  it("første forsøk: attempt 1, task_id = sched:<jobb>:<dato> (dagen i scheduler_state), trace_id = ...-a1; claimToday() oppfører seg som før", async () => {
    const job = "wpk054-claim-first";
    const scheduler = new DailyScheduler(pool, job, 0);
    const run = await scheduler.claimTodayRun();
    expect(run).not.toBeNull();
    const row = await state(job);
    expect(run).toEqual({
      job_name: job, run_date: row.run_date, attempt: 1, instance_id: scheduler.instanceId,
      task_id: `sched:${job}:${row.run_date}`, trace_id: `sched-${job}-${row.run_date}-a1`
    });
    // en annen instans vinner ikke samme dag (samme claim-regler som før)
    expect(await new DailyScheduler(pool, job, 0).claimTodayRun()).toBeNull();
    expect(await new DailyScheduler(pool, job, 0).claimToday()).toBe(false);
  });

  it("før planlagt time: null (som claimToday() = false)", async () => {
    const hour = Number(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", hour12: false, hour: "2-digit" }).format(new Date()));
    if (hour >= 23) return; // `hour + 1` finnes ikke - ingenting å bevise den siste timen
    expect(await new DailyScheduler(pool, "wpk054-too-early", hour + 1).claimTodayRun()).toBeNull();
  });

  it("retry etter feil: SAMME task_id, NY trace_id (-a2), og forsøkstallet følger scheduler_state.attempts", async () => {
    const job = "wpk054-claim-retry";
    const scheduler = new DailyScheduler(pool, job, 0);
    const first = (await scheduler.claimTodayRun())!;
    await scheduler.markFailed("transient");
    await pool.query("UPDATE scheduler_state SET retry_after = now() - interval '1 second' WHERE job_name = $1", [job]);
    const second = (await scheduler.claimTodayRun())!;
    expect(second.attempt).toBe(2);
    expect(second.task_id).toBe(first.task_id);
    expect(second.trace_id).not.toBe(first.trace_id);
    expect(second.trace_id).toBe(`${first.trace_id.replace(/-a1$/, "")}-a2`);
    expect((await state(job)).attempts).toBe(2);
  });
});

describe("start(): deliver() får kjøringen", () => {
  let timer: NodeJS.Timeout | undefined;
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => { if (timer) clearInterval(timer); vi.restoreAllMocks(); });

  it("deliver(run) mottar ScheduledRun for denne instansen og dagen; deliver uten parameter virker fortsatt (bakoverkompatibelt)", async () => {
    const job = "wpk054-start-run";
    const scheduler = new DailyScheduler(pool, job, 0);
    const seen: ScheduledRun[] = [];
    timer = scheduler.start(async (run) => { seen.push(run); }, 20);
    await waitFor(async () => (await state(job).catch(() => undefined))?.completed_at != null);
    clearInterval(timer);
    expect(seen).toHaveLength(1);
    const row = await state(job);
    expect(seen[0]).toMatchObject({ job_name: job, run_date: row.run_date, attempt: 1, instance_id: scheduler.instanceId, task_id: `sched:${job}:${row.run_date}` });

    const legacyJob = "wpk054-start-legacy";
    let called = 0;
    const legacy = new DailyScheduler(pool, legacyJob, 0);
    timer = legacy.start(async () => { called += 1; }, 20);
    await waitFor(async () => (await state(legacyJob).catch(() => undefined))?.completed_at != null);
    expect(called).toBe(1);
  });

  it("en feilet kjøring leverer neste forsøk med samme task_id og høyere attempt", async () => {
    const job = "wpk054-start-retry";
    const scheduler = new DailyScheduler(pool, job, 0);
    const seen: ScheduledRun[] = [];
    timer = scheduler.start(async (run) => {
      seen.push(run);
      if (run.attempt === 1) throw new Error("transient-net");
    }, 20);
    await waitFor(async () => seen.length === 1 && ((await pool.query("SELECT retry_after FROM scheduler_state WHERE job_name = $1", [job])).rows[0] as { retry_after: Date | null } | undefined)?.retry_after != null);
    await pool.query("UPDATE scheduler_state SET retry_after = now() - interval '1 second' WHERE job_name = $1", [job]);
    await waitFor(() => seen.length === 2);
    expect(seen.map((r) => r.attempt)).toEqual([1, 2]);
    expect(seen[1]!.task_id).toBe(seen[0]!.task_id);
    expect(seen[1]!.trace_id).not.toBe(seen[0]!.trace_id);
  });
});
