import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { failOnSweepFailures } from "@jarvis/contracts";
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

describe("D-442 (JARVIS-027): en tenant som feiler i et sveip gjør jobben feilet (retry), aldri fullført", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let timer: NodeJS.Timeout | undefined;
  beforeEach(() => { errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => { if (timer) clearInterval(timer); errorSpy.mockRestore(); });

  const row = async (job: string) =>
    (await pool.query<{ attempts: number; completed_at: Date | null; retry_after: Date | null; last_error: string | null }>(
      "SELECT attempts, completed_at, retry_after, last_error FROM scheduler_state WHERE job_name = $1", [job]
    )).rows[0];

  it("registrert tenant-feil: retry_after + last_error (jobb, tenant, delmengde) settes og dagen er ikke fullført; neste forsøk uten feil fullfører", async () => {
    const job = "sched-sweep-tenant-failure";
    const scheduler = new DailyScheduler(pool, job, 0);
    const processed: string[] = [];
    let run = 0;
    timer = scheduler.start(() => failOnSweepFailures(job, async (failures) => {
      run += 1;
      for (const tenant of ["tenant-ok", "tenant-x"]) {
        if (tenant === "tenant-x" && run === 1) failures.record(tenant, new Error("Gmail nede"), "gmail");
        else processed.push(`${run}:${tenant}`);
      }
    }), 20);

    await waitFor(async () => (await row(job))?.retry_after != null);
    const failed = await row(job);
    expect(failed?.completed_at).toBeNull();
    expect(failed?.last_error).toContain(`${job}: 1 tenant-feil (tenant-x/gmail: Gmail nede)`);
    expect(processed).toEqual(["1:tenant-ok"]); // isolasjonen er uendret: den friske tenanten ble kjørt før jobben ble markert feilet
    expect(run).toBe(1); // ingen retry før backoff

    await pool.query("UPDATE scheduler_state SET retry_after = now() - interval '1 second' WHERE job_name = $1", [job]);
    await waitFor(async () => (await row(job))?.completed_at != null);
    expect(run).toBe(2);
    expect((await row(job))?.attempts).toBe(2);
    expect(processed).toEqual(["1:tenant-ok", "2:tenant-ok", "2:tenant-x"]);
  });

  it("sveip uten tenant-feil bokføres som fullført ved første forsøk (ingen falsk alarm)", async () => {
    const job = "sched-sweep-clean";
    const scheduler = new DailyScheduler(pool, job, 0);
    timer = scheduler.start(() => failOnSweepFailures(job, async () => undefined), 20);
    await waitFor(async () => (await row(job))?.completed_at != null);
    const done = await row(job);
    expect(done?.attempts).toBe(1);
    expect(done?.last_error).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("D-442: heartbeat holder claimet ferskt mens en lang jobb kjører", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let timer: NodeJS.Timeout | undefined;
  beforeEach(() => { errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => { if (timer) clearInterval(timer); errorSpy.mockRestore(); });

  const claimedAgeMinutes = async (job: string): Promise<number> =>
    Number((await pool.query<{ age: number }>(
      "SELECT extract(epoch FROM (now() - claimed_at)) / 60 AS age FROM scheduler_state WHERE job_name = $1", [job]
    )).rows[0]?.age);

  it("heartbeat() fornyer KUN claimet til den eide instansen og kun for en ikke-fullført rad", async () => {
    const job = "sched-heartbeat-direct";
    const owner = new DailyScheduler(pool, job, 0);
    expect(await owner.claimToday()).toBe(true);
    await pool.query("UPDATE scheduler_state SET claimed_at = now() - interval '20 minutes' WHERE job_name = $1", [job]);
    await new DailyScheduler(pool, job, 0).heartbeat(); // en annen instans
    expect(await claimedAgeMinutes(job)).toBeGreaterThan(19);
    await owner.heartbeat();
    expect(await claimedAgeMinutes(job)).toBeLessThan(1);
    await owner.markCompleted();
    await pool.query("UPDATE scheduler_state SET claimed_at = now() - interval '20 minutes' WHERE job_name = $1", [job]);
    await owner.heartbeat(); // fullført rad røres ikke
    expect(await claimedAgeMinutes(job)).toBeGreaterThan(19);
  });

  it("en jobb som kjører lenge får claimet fornyet av heartbeat, og ingen annen tick/instans starter en samtidig kjøring", async () => {
    const job = "sched-heartbeat-long-run";
    const scheduler = new DailyScheduler(pool, job, 0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    timer = scheduler.start(async () => { runs += 1; await gate; }, 20, 20);
    await waitFor(async () => (await pool.query("SELECT 1 FROM scheduler_state WHERE job_name = $1", [job])).rows.length > 0);
    // Simuler at jobben har kjørt «lenge» uten å bli overtakbar ennå (14 min < lease på 15 min), slik at testen ikke kappløper med tick-intervallet:
    // heartbeat skal friske claimet opp igjen mens jobben fortsatt kjører.
    await pool.query("UPDATE scheduler_state SET claimed_at = now() - interval '14 minutes' WHERE job_name = $1", [job]);
    await waitFor(async () => (await claimedAgeMinutes(job)) < 1);
    expect(await new DailyScheduler(pool, job, 0).claimToday()).toBe(false); // ingen samtidig kjøring
    expect(runs).toBe(1);
    release();
    await waitFor(async () => (await pool.query("SELECT completed_at FROM scheduler_state WHERE job_name = $1", [job])).rows[0]?.completed_at != null);
    expect(runs).toBe(1);
  });
});
