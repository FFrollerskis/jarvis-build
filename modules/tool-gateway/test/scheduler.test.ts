import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DailyScheduler } from "../src/scheduler.ts";

/**
 * D-218: `DailyScheduler.start()` sin `.catch(() => undefined)` svelget FØR
 * denne fiksen ALLE feil (deliver()-unntak, claimToday()/markCompleted()-DB-
 * feil) helt sporløst - INGEN av de 17 schedulerte jobbene i
 * `apps/api/src/main.ts` hadde noen logglinje for et slikt tilfelle (kun 3 av
 * dem logger sitt EGET, snevrere "resultatet var strukturelt ufullstendig"-
 * tilfelle, aldri et uventet unntak). Denne testfilen fantes ikke tidligere -
 * `start()` var utestet.
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let pool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pgsched-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  pool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  pool.on("error", () => undefined);
  await runMigrations(pool);
}, 120_000);

afterAll(async () => { await pool?.end(); await stopEmbeddedPostgres?.(); }, 120_000);

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("D-218: DailyScheduler.start() sitt siste sikkerhetsnett", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let timer: NodeJS.Timeout | undefined;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (timer) clearInterval(timer);
    errorSpy.mockRestore();
  });

  it("deliver() som kaster logges strukturert (job_name+instance_id+error), rad IKKE markert fullført, prosessen krasjer ikke", async () => {
    const scheduler = new DailyScheduler(pool, "sched-test-throws", 0);
    timer = scheduler.start(async () => {
      throw new Error("boom-deliver");
    }, 20);
    await waitFor(() => errorSpy.mock.calls.length > 0);
    const [line] = errorSpy.mock.calls[0] as [string];
    const parsed = JSON.parse(line) as { msg: string; job_name: string; instance_id: string; error: string };
    expect(parsed.msg).toBe("daily_scheduler_tick_failed");
    expect(parsed.job_name).toBe("sched-test-throws");
    expect(parsed.instance_id).toBe(scheduler.instanceId);
    expect(parsed.error).toContain("boom-deliver");
    const state = await pool.query<{ completed_at: Date | null }>(
      "SELECT completed_at FROM scheduler_state WHERE job_name = $1", ["sched-test-throws"]
    );
    expect(state.rows).toHaveLength(1); // claimToday() rakk aa committe FOER deliver() kastet
    expect(state.rows[0]?.completed_at).toBeNull();
  });

  it("claimToday() sitt eget DB-feil (ikke bare et deliver()-unntak) fanges av SAMME sikkerhetsnett", async () => {
    const brokenPool = { query: () => Promise.reject(new Error("boom-db")) } as unknown as pg.Pool;
    const scheduler = new DailyScheduler(brokenPool, "sched-test-db-fail", 0);
    timer = scheduler.start(async () => undefined, 20);
    await waitFor(() => errorSpy.mock.calls.length > 0);
    const [line] = errorSpy.mock.calls[0] as [string];
    const parsed = JSON.parse(line) as { msg: string; job_name: string; error: string };
    expect(parsed.msg).toBe("daily_scheduler_tick_failed");
    expect(parsed.job_name).toBe("sched-test-db-fail");
    expect(parsed.error).toContain("boom-db");
  });

  it("vellykket levering: INGEN feil logges OG markCompleted() faktisk kjørt (regresjonsvakt - fiksen legger ikke til støy på den lykkelige stien)", async () => {
    const scheduler = new DailyScheduler(pool, "sched-test-ok", 0);
    let delivered = false;
    timer = scheduler.start(async () => {
      delivered = true;
    }, 20);
    await waitFor(() => delivered);
    await waitFor(async () => {
      const state = await pool.query<{ completed_at: Date | null }>(
        "SELECT completed_at FROM scheduler_state WHERE job_name = $1", ["sched-test-ok"]
      );
      return state.rows[0]?.completed_at != null;
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("D-393 (JARVIS-027): retry i stedet for tapt dag", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let timer: NodeJS.Timeout | undefined;
  beforeEach(() => { errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => { if (timer) clearInterval(timer); errorSpy.mockRestore(); });

  const row = async (job: string) =>
    (await pool.query<{ attempts: number; completed_at: Date | null; retry_after: Date | null; last_error: string | null }>(
      "SELECT attempts, completed_at, retry_after, last_error FROM scheduler_state WHERE job_name = $1", [job]
    )).rows[0];

  it("feilet kjøring får retry_after + last_error; ved retry_after passert overtas dagen og fullføres", async () => {
    const job = "sched-retry-ok";
    const scheduler = new DailyScheduler(pool, job, 0);
    let calls = 0;
    const deliver = async (): Promise<void> => { calls += 1; if (calls === 1) throw new Error("transient-net"); };
    timer = scheduler.start(deliver, 20);
    await waitFor(async () => (await row(job))?.retry_after != null);
    const failed = await row(job);
    expect(failed?.last_error).toContain("transient-net");
    expect(failed?.completed_at).toBeNull();
    expect(calls).toBe(1); // ingen retry før backoff
    await pool.query("UPDATE scheduler_state SET retry_after = now() - interval '1 second' WHERE job_name = $1", [job]);
    await waitFor(async () => (await row(job))?.completed_at != null);
    expect(calls).toBe(2);
    expect((await row(job))?.attempts).toBe(2);
  });

  it("en hengt claim (krasj uten fullføring) overtas først etter 15 min lease", async () => {
    const job = "sched-stale-claim";
    const crashed = new DailyScheduler(pool, job, 0);
    expect(await crashed.claimToday()).toBe(true);
    const other = new DailyScheduler(pool, job, 0);
    expect(await other.claimToday()).toBe(false); // claim er fersk
    await pool.query("UPDATE scheduler_state SET claimed_at = now() - interval '16 minutes' WHERE job_name = $1", [job]);
    expect(await other.claimToday()).toBe(true);
    expect((await row(job))?.attempts).toBe(2);
  });

  it("gir opp etter 4 forsøk (synlig i loggen) og fullført jobb claimes aldri igjen", async () => {
    const job = "sched-give-up";
    const scheduler = new DailyScheduler(pool, job, 0);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await scheduler.claimToday()).toBe(true);
      await scheduler.markFailed(`fail-${attempt}`);
      await pool.query("UPDATE scheduler_state SET retry_after = now() - interval '1 second' WHERE job_name = $1", [job]);
    }
    expect(await scheduler.claimToday()).toBe(false);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("daily_scheduler_gave_up"))).toBe(true);

    const doneJob = new DailyScheduler(pool, "sched-done-never-again", 0);
    expect(await doneJob.claimToday()).toBe(true);
    await doneJob.markCompleted();
    await pool.query("UPDATE scheduler_state SET claimed_at = now() - interval '1 hour' WHERE job_name = $1", ["sched-done-never-again"]);
    expect(await doneJob.claimToday()).toBe(false);
  });
});
