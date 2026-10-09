import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SweepFailedError, assertNoSweepFailures } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DailyScheduler } from "@jarvis/tool-gateway";
import { createRadarState, radarSweepFailures, type RadarSweepResult } from "../src/evolution-radar.ts";
import type { LookupImpl } from "../src/radar-url-guard.ts";

/**
 * L6 (gjennomgang av PR #313): radar-sveipet kjørte i tillegg til den planlagte jobben ETT UBETINGET sveip 60 s etter HVER oppstart - ved en crash-loop ga det tung trafikk mot kildene. Nå kjører sveipet KUN via den
 * persisterte `DailyScheduler` (høyst én gang per døgn, også ved omstart), og det feiler høyt via `assertNoSweepFailures` når alle kilder feilet. Her: (1) kildenivå-vakt mot `main.ts`, (2) ren enhetstest av
 * `radarSweepFailures`, (3) atferd mot ekte Postgres: omstart gir ikke nytt sveip, total svikt gir retry/last_error uten innhold, delvis svikt gir ingen retry.
 */
const NOW = new Date("2026-10-15T06:00:00.000Z");
const PUBLIC: LookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];
const TENANT = "tenant-radar";
const sources = JSON.stringify([
  { kind: "security", name: "Varsler", url: "https://security.example.com/feed" },
  { kind: "model", name: "Modellnytt", url: "https://models.example.com/changelog" }
]);
const okPage = async (): Promise<Response> => new Response("Alt vel.", { status: 200, headers: { "content-type": "text/plain" } });

const result = (over: Partial<RadarSweepResult>): RadarSweepResult => ({ at: NOW.toISOString(), configured: 2, ok: 0, quarantined: 0, failed: 0, security_events: 0, per_source: [], ...over });
const failedSource = (name: string, finding: string): RadarSweepResult["per_source"][number] => ({ name, kind: "security", status: "fetch_failed", findings: [finding], bytes: 0 });

describe("L6: radarSweepFailures - feil høyt kun når ALLE kilder feilet", () => {
  it("alle kilder feilet → én feil per kilde (kun kildenavn og feilkode), ellers ingen", () => {
    const all = result({ failed: 2, per_source: [failedSource("Varsler", "network_error"), failedSource("Modellnytt", "http_503")] });
    expect(radarSweepFailures(all, TENANT)).toEqual([
      { tenant_id: TENANT, scope: "Varsler", error: "network_error" },
      { tenant_id: TENANT, scope: "Modellnytt", error: "http_503" }
    ]);
    // delvis svikt: noen kilder ble hentet - et nytt forsøk ville hentet de friske på nytt
    expect(radarSweepFailures(result({ ok: 1, failed: 1, per_source: [failedSource("Modellnytt", "timeout")] }), TENANT)).toEqual([]);
    // en kilde i karantene er en vellykket henting med mistenkelig innhold (sikkerhetsfunn), ikke en svikt
    expect(radarSweepFailures(result({ quarantined: 1, failed: 1, per_source: [failedSource("Modellnytt", "timeout")] }), TENANT)).toEqual([]);
    // ingen feilet / ingen kilder (inert)
    expect(radarSweepFailures(result({ ok: 2 }), TENANT)).toEqual([]);
    expect(radarSweepFailures(result({ configured: 0 }), TENANT)).toEqual([]);
    // en feilet kilde uten funnkode får likevel en feiltekst
    expect(radarSweepFailures(result({ configured: 1, failed: 1, per_source: [{ name: "X", kind: "api", status: "fetch_failed", findings: [], bytes: 0 }] }), TENANT)[0]!.error).toBe("fetch_failed");
  });

  it("assertNoSweepFailures kaster SweepFailedError med jobbnavn, kilde og kode - aldri URL eller innhold", () => {
    const failures = radarSweepFailures(result({ failed: 2, per_source: [failedSource("Varsler", "blocked_address"), failedSource("Modellnytt", "dns_failure")] }), TENANT);
    expect(() => assertNoSweepFailures("evolution-radar-sweep", failures)).toThrow(SweepFailedError);
    try {
      assertNoSweepFailures("evolution-radar-sweep", failures);
    } catch (err) {
      expect((err as Error).message).toBe("evolution-radar-sweep: 2 tenant-feil (tenant-radar/Varsler: blocked_address; tenant-radar/Modellnytt: dns_failure)");
      expect((err as Error).message).not.toMatch(/https?:|example\.com/);
    }
  });
});

describe("L6: main.ts kjører radar-sveipet kun via DailyScheduler og feiler høyt (kildenivå-vakt - main.ts kan ikke importeres)", () => {
  const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
  const start = main.indexOf('new DailyScheduler(pool, "evolution-radar-sweep"');
  const statement = main.slice(start, main.indexOf(";\n", start));

  it("jobben finnes og eskalerer i SAMME setning som kjøringen (D-442-mønsteret): assertNoSweepFailures over radarSweepFailures", () => {
    expect(start).toBeGreaterThan(0);
    expect(statement).toContain("evolutionRadar.run()");
    expect(statement).toContain('assertNoSweepFailures("evolution-radar-sweep", radarSweepFailures(summary, owner.tenant_id))');
    expect(statement).toMatch(/\.start\(\(\) => evolutionRadar\.run\(\)/);
  });

  it("ingen ubetinget oppstartssveip: radaren kjøres fra nøyaktig ÉN plass (scheduleren), uten setTimeout og uten den gamle oppstartsloggen", () => {
    expect(main.match(/evolutionRadar\.run\(/g)).toHaveLength(1);
    expect(main).not.toContain("evolution_radar_boot_sweep_failed");
    const block = main.slice(main.indexOf("if (evolutionRadar.configured > 0) {"), start + statement.length + 20);
    expect(block).not.toMatch(/setTimeout|setInterval/);
    // radaren er fortsatt inert uten kilder
    expect(main).toContain("if (evolutionRadar.configured > 0) {");
  });

  it("jobben går på det planlagte klokkeslettet (JARVIS_RADAR_SWEEP_HOUR, standard 06) og er en kritisk jobb (ikke best-effort)", () => {
    expect(statement).toContain('envHour("JARVIS_RADAR_SWEEP_HOUR", 6)');
  });
});

describe("L6: atferd mot ekte Postgres - høyst én kjøring per døgn også ved omstart, feil høyt ved total svikt", () => {
  let stop: (() => Promise<void>) | undefined;
  let pool: pg.Pool;
  const timers: NodeJS.Timeout[] = [];
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-radar-sched-"));
    const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
    stop = leased.stop;
    await leased.postgres.createDatabase("jarvis_test");
    pool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
    pool.on("error", () => undefined);
    await runMigrations(pool);
  }, 240_000);
  afterAll(async () => { await pool?.end(); await stop?.(); }, 120_000);
  beforeEach(() => { errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => { for (const t of timers.splice(0)) clearInterval(t); errorSpy.mockRestore(); });

  const row = async (job: string) =>
    (await pool.query<{ attempts: number; completed_at: Date | null; retry_after: Date | null; last_error: string | null }>("SELECT attempts, completed_at, retry_after, last_error FROM scheduler_state WHERE job_name = $1", [job])).rows[0];
  const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> => {
    const t0 = Date.now();
    while (!(await predicate())) {
      if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: timeout");
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  /** Samme sammensetning som i main.ts: kjør sveipet og eskaler total svikt. */
  const deliverFor = (radar: ReturnType<typeof createRadarState>) => () => radar.run().then((summary) => summary).then((summary) => assertNoSweepFailures("evolution-radar-sweep", radarSweepFailures(summary, TENANT)));

  it("en omstart (ny scheduler-instans) gir ikke et nytt sveip samme døgn: kildene hentes én gang", async () => {
    const job = "radar-restart-once";
    let fetches = 0;
    const radar = createRadarState({ JARVIS_RADAR_SOURCES: sources }, { lookupImpl: PUBLIC, now: () => NOW, fetchImpl: async () => { fetches += 1; return okPage(); } });
    timers.push(new DailyScheduler(pool, job, 0).start(deliverFor(radar), 20));
    await waitFor(async () => (await row(job))?.completed_at != null);
    expect(fetches).toBe(2); // to kilder, ett sveip
    // «Omstart» ×3: nye instanser (og en ny radar-tilstand, som ved en ny prosess) - dagens jobb er fullført, så ingenting kjører.
    for (let i = 0; i < 3; i += 1) {
      const restarted = createRadarState({ JARVIS_RADAR_SOURCES: sources }, { lookupImpl: PUBLIC, now: () => NOW, fetchImpl: async () => { fetches += 1; return okPage(); } });
      timers.push(new DailyScheduler(pool, job, 0).start(deliverFor(restarted), 20));
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(fetches).toBe(2);
    expect((await row(job))?.attempts).toBe(1);
  });

  it("total svikt (alle kilder feiler): jobben feiler høyt - retry_after + last_error med kildenavn og kode (ingen URL/innhold), dagen er ikke fullført; neste forsøk som lykkes fullfører", async () => {
    const job = "radar-all-failed";
    let healthy = false;
    const radar = createRadarState({ JARVIS_RADAR_SOURCES: sources }, {
      lookupImpl: PUBLIC, now: () => NOW,
      fetchImpl: async () => { if (healthy) return okPage(); throw new TypeError("fetch failed: ECONNREFUSED 10.0.0.9:443 https://security.example.com/feed"); }
    });
    timers.push(new DailyScheduler(pool, job, 0).start(deliverFor(radar), 20));
    await waitFor(async () => (await row(job))?.retry_after != null);
    const failed = await row(job);
    expect(failed?.completed_at).toBeNull();
    expect(failed?.last_error).toContain("evolution-radar-sweep: 2 tenant-feil");
    expect(failed?.last_error).toContain("Varsler: network_error");
    expect(failed?.last_error).not.toMatch(/ECONNREFUSED|10\.0\.0\.9|https?:|example\.com/);
    healthy = true;
    await pool.query("UPDATE scheduler_state SET retry_after = now() - interval '1 second' WHERE job_name = $1", [job]);
    await waitFor(async () => (await row(job))?.completed_at != null);
    expect((await row(job))?.attempts).toBe(2);
  });

  it("delvis svikt (én kilde nede, én frisk): jobben fullføres uten retry - friske kilder hentes ikke på nytt", async () => {
    const job = "radar-partial";
    const calls: string[] = [];
    const radar = createRadarState({ JARVIS_RADAR_SOURCES: sources }, {
      lookupImpl: PUBLIC, now: () => NOW,
      fetchImpl: async (url: string) => { calls.push(url); if (url.includes("models.example.com")) throw new TypeError("fetch failed"); return okPage(); }
    });
    timers.push(new DailyScheduler(pool, job, 0).start(deliverFor(radar), 20));
    await waitFor(async () => (await row(job))?.completed_at != null);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.sort()).toEqual(["https://models.example.com/changelog", "https://security.example.com/feed"]);
    const done = await row(job);
    expect(done).toMatchObject({ attempts: 1, retry_after: null, last_error: null });
    expect(radar.last()).toMatchObject({ ok: 1, failed: 1 });
  });
});
