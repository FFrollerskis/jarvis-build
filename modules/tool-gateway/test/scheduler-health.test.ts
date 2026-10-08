import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DAILY_SCHEDULER_MAX_ATTEMPTS, DailyScheduler } from "../src/scheduler.ts";
import {
  classifySchedulerRow,
  describeSchedulerProblem,
  readSchedulerHealth,
  schedulerSource
} from "../src/scheduler-health.ts";

/**
 * D-443: eier-synlig status for de daglige bakgrunnsjobbene. SQL-en (Oslo-dato, DISTINCT ON siste rad per jobb, lease-alder) er den risikable delen,
 * så den testes mot ekte Postgres med rader i alle tilstander `DailyScheduler` kan etterlate.
 */

let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let pool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pgschedhealth-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stopEmbeddedPostgres = leasedPostgres.stop;
  await leasedPostgres.postgres.createDatabase("jarvis_test");
  pool = createPool({ host: "127.0.0.1", port: leasedPostgres.port, database: "jarvis_test", user: "postgres", password: "pw" });
  pool.on("error", () => undefined);
  await runMigrations(pool);
}, 120_000);

afterAll(async () => { await pool?.end(); await stopEmbeddedPostgres?.(); }, 120_000);

beforeEach(async () => { await pool.query("DELETE FROM scheduler_state"); });

/** Setter inn en rad. `daysAgo` er relativt til dagens Europe/Oslo-dato; `claimedMinutesAgo` styrer lease-alder. */
async function row(job: string, o: {
  daysAgo?: number; attempts?: number; completed?: boolean; retryInMinutes?: number | null; lastError?: string | null; claimedMinutesAgo?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO scheduler_state (job_name, run_date, claimed_by, claimed_at, completed_at, attempts, retry_after, last_error)
     VALUES ($1, (now() AT TIME ZONE 'Europe/Oslo')::date - $2::int, 'test', now() - make_interval(mins => $3::int),
             CASE WHEN $4::boolean THEN now() ELSE NULL END, $5,
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(mins => $6::int) END, $7)`,
    [job, o.daysAgo ?? 0, o.claimedMinutesAgo ?? 1, o.completed ?? false, o.attempts ?? 1, o.retryInMinutes ?? null, o.lastError ?? null]
  );
}

describe("D-443: readSchedulerHealth klassifiserer alle tilstander scheduleren kan etterlate", () => {
  it("ingen rader: ingen kjente problemer (og ingen påstand om at jobber har kjørt)", async () => {
    expect(await readSchedulerHealth(pool)).toEqual({ jobs_seen: 0, completed: 0, problems: [] });
  });

  it("fullført i dag, og en jobb som kjører nå (nylig claim, ingen feil) er IKKE et problem", async () => {
    await row("done-today", { completed: true });
    await row("running-now", { claimedMinutesAgo: 1 });
    const h = await readSchedulerHealth(pool);
    expect(h).toEqual({ jobs_seen: 2, completed: 1, problems: [] });
  });

  it("en jobb som kjører forsøk 2 etter en tidligere feil (retry_after nullstilt av claim) regnes som kjørende, ikke som feil", async () => {
    await row("retrying-now", { attempts: 2, retryInMinutes: null, lastError: "forrige forsøk feilet", claimedMinutesAgo: 1 });
    expect((await readSchedulerHealth(pool)).problems).toEqual([]);
  });

  it("retry_pending: feilet og nytt forsøk planlagt", async () => {
    await row("sync-a", { attempts: 2, retryInMinutes: 5, lastError: "Gmail nede" });
    const { problems } = await readSchedulerHealth(pool);
    expect(problems).toEqual([{ job_name: "sync-a", run_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), kind: "retry_pending", attempts: 2, max_attempts: DAILY_SCHEDULER_MAX_ATTEMPTS, last_error: "Gmail nede" }]);
  });

  it("gave_up: siste forsøk feilet og forsøkene er brukt opp", async () => {
    await row("sync-b", { attempts: DAILY_SCHEDULER_MAX_ATTEMPTS, retryInMinutes: 15, lastError: "stripe 503" });
    expect((await readSchedulerHealth(pool)).problems.map((p) => [p.job_name, p.kind])).toEqual([["sync-b", "gave_up"]]);
  });

  it("stalled: gammel claim uten fullføring (krasj) - gave_up hvis forsøkene allerede er brukt opp", async () => {
    await row("crashed-early", { attempts: 1, claimedMinutesAgo: 20 });
    await row("crashed-last", { attempts: DAILY_SCHEDULER_MAX_ATTEMPTS, claimedMinutesAgo: 20 });
    const kinds = Object.fromEntries((await readSchedulerHealth(pool)).problems.map((p) => [p.job_name, p.kind]));
    expect(kinds).toEqual({ "crashed-early": "stalled", "crashed-last": "gave_up" });
  });

  it("lost_previous_day: i går ikke fullført og dagens rad finnes ikke ennå; men dagens fullføring overstyrer gårsdagens tap", async () => {
    await row("lost-yesterday", { daysAgo: 1, attempts: 2, retryInMinutes: 5, lastError: "nett nede" });
    await row("recovered", { daysAgo: 1, attempts: 4, retryInMinutes: 15, lastError: "x" });
    await row("recovered", { daysAgo: 0, completed: true });
    await row("fine-yesterday", { daysAgo: 1, completed: true });
    const h = await readSchedulerHealth(pool);
    expect(h.problems.map((p) => [p.job_name, p.kind])).toEqual([["lost-yesterday", "lost_previous_day"]]);
    expect(h.jobs_seen).toBe(3);
    expect(h.completed).toBe(2);
  });

  it("rader eldre enn i går ignoreres", async () => {
    await row("ancient", { daysAgo: 3, attempts: 4, retryInMinutes: 15, lastError: "gammel feil" });
    expect(await readSchedulerHealth(pool)).toEqual({ jobs_seen: 0, completed: 0, problems: [] });
  });

  it("sorterer gave_up foran lost/stalled/retry og avkorter last_error til 120 tegn", async () => {
    await row("z-retry", { attempts: 1, retryInMinutes: 1, lastError: "r" });
    await row("a-gaveup", { attempts: DAILY_SCHEDULER_MAX_ATTEMPTS, retryInMinutes: 15, lastError: "e".repeat(300) });
    const { problems } = await readSchedulerHealth(pool);
    expect(problems.map((p) => p.job_name)).toEqual(["a-gaveup", "z-retry"]);
    expect(problems[0]?.last_error).toHaveLength(120);
  });

  it("fjerner den ledende «<jobb>: »-prefiksen scheduleren selv skriver, så årsaken (tenant, delmengde, feil) ikke kuttes bort av 120-tegnsgrensen", async () => {
    const tenant = "8f3c2b1e-6d4a-4f7b-9c1d-2e5a7b9c0d11";
    await row("support-inbox-sync", {
      attempts: DAILY_SCHEDULER_MAX_ATTEMPTS, retryInMinutes: 15,
      lastError: `support-inbox-sync: 1 tenant-feil (${tenant}/gmail: credential_unavailable)`
    });
    const [problem] = (await readSchedulerHealth(pool)).problems;
    expect(problem?.last_error).toBe(`1 tenant-feil (${tenant}/gmail: credential_unavailable)`);
  });

  it("ende-til-ende med ekte DailyScheduler: fire feilede forsøk gir gave_up, og en vellykket kjøring fjerner problemet", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failing = new DailyScheduler(pool, "e2e-job", 0);
      for (let attempt = 1; attempt <= DAILY_SCHEDULER_MAX_ATTEMPTS; attempt += 1) {
        expect(await failing.claimToday()).toBe(true);
        await failing.markFailed(`feil ${attempt}`);
        await pool.query("UPDATE scheduler_state SET retry_after = now() - interval '1 second' WHERE job_name = 'e2e-job'");
      }
      const afterGiveUp = (await readSchedulerHealth(pool)).problems;
      expect(afterGiveUp).toHaveLength(1);
      expect(afterGiveUp[0]).toMatchObject({ job_name: "e2e-job", kind: "gave_up", attempts: DAILY_SCHEDULER_MAX_ATTEMPTS, last_error: "feil 4" });

      await pool.query("UPDATE scheduler_state SET completed_at = now() WHERE job_name = 'e2e-job'");
      expect((await readSchedulerHealth(pool)).problems).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("D-443: classifySchedulerRow (ren)", () => {
  const base = { job_name: "j", run_date: "2026-10-08", attempts: 1, completed_at: null, retry_after: null, last_error: null, past_day: false, claim_stale: false };
  it("fullført er aldri et problem, selv fra en tidligere dag", () => {
    expect(classifySchedulerRow({ ...base, completed_at: new Date(), past_day: true })).toBeNull();
  });
  it("tidligere dag uten fullføring er alltid tapt", () => {
    expect(classifySchedulerRow({ ...base, past_day: true })).toBe("lost_previous_day");
  });
});

describe("D-443: beskrivelse og morgenbrief-kilde", () => {
  it("describeSchedulerProblem gir en kort norsk setning per type", () => {
    const p = { job_name: "stripe-payment-sync", run_date: "2026-10-08", attempts: 4, max_attempts: 4, last_error: "503" };
    expect(describeSchedulerProblem({ ...p, kind: "gave_up" })).toBe("stripe-payment-sync ga opp etter 4/4 forsøk: 503");
    expect(describeSchedulerProblem({ ...p, kind: "retry_pending", attempts: 2 })).toBe("stripe-payment-sync feilet (forsøk 2/4), nytt forsøk er planlagt: 503");
    expect(describeSchedulerProblem({ ...p, kind: "lost_previous_day", last_error: null })).toBe("stripe-payment-sync ble ikke fullført 2026-10-08 (4 forsøk)");
    expect(describeSchedulerProblem({ ...p, kind: "stalled", last_error: null })).toBe("stripe-payment-sync står fast uten fullføring (forsøk 4/4)");
  });

  it("schedulerSource varsler KUN om tapt arbeid (gave_up / lost_previous_day), ikke om forbigående retry/stalled", async () => {
    await row("gave-up-job", { attempts: DAILY_SCHEDULER_MAX_ATTEMPTS, retryInMinutes: 15, lastError: "boom" });
    await row("lost-job", { daysAgo: 1, attempts: 1, retryInMinutes: 1, lastError: "nett" });
    await row("retry-job", { attempts: 1, retryInMinutes: 1, lastError: "forbigående" });
    await row("stalled-job", { attempts: 1, claimedMinutesAgo: 30 });
    await row("fine-job", { completed: true });
    const owner = { person_id: "owner", tenant_id: "t-owner" } as never;
    const items = await schedulerSource(pool, () => true).collect(owner);
    expect(items.map((i) => i.title).sort()).toEqual([
      "Bakgrunnsjobb uten resultat: gave-up-job",
      "Bakgrunnsjobb uten resultat: lost-job"
    ]);
    const gaveUp = items.find((i) => i.title.endsWith("gave-up-job"))!;
    expect(gaveUp).toMatchObject({ source: "jarvis-scheduler", score: 75, detail: expect.stringContaining("ga opp etter 4/4 forsøk: boom") });
    expect(gaveUp.ref).toMatch(/^gave-up-job:\d{4}-\d{2}-\d{2}$/);
  });

  it("schedulerSource leverer KUN til eieren: en annen tilgangsinnehaver (for eksempel via /brief) får ingenting - driftsstatus kan nevne andre tenants", async () => {
    await row("gave-up-job", { attempts: DAILY_SCHEDULER_MAX_ATTEMPTS, retryInMinutes: 15, lastError: "tenant-x: boom" });
    const isOwner = (id: { person_id: string; tenant_id: string }) => id.person_id === "owner" && id.tenant_id === "t-owner";
    const source = schedulerSource(pool, isOwner as never);
    expect(await source.collect({ person_id: "owner", tenant_id: "t-owner" } as never)).toHaveLength(1);
    expect(await source.collect({ person_id: "gjest", tenant_id: "t-owner" } as never)).toEqual([]);
    expect(await source.collect({ person_id: "owner", tenant_id: "t-annen" } as never)).toEqual([]);
  });
});
