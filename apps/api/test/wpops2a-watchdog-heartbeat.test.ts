import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KillSwitch } from "@jarvis/policy";
import { MemoryAlertSink, Watchdog, type HealthCheck } from "@jarvis/watchdog";
// @ts-expect-error - ren .mjs uten typer (genererer compose-blokkene)
import { NEVER_IN_RUNTIME, SERVICE_ENV } from "../../../infra/local/service-env.mjs";
import type { PingFn } from "../src/heartbeat-sender.ts";
import {
  WATCHDOG_HEARTBEAT_DB_TIMEOUT_MS, WATCHDOG_HEARTBEAT_INTERVAL_ENV, WATCHDOG_HEARTBEAT_MIN_FRESH_MS, WATCHDOG_HEARTBEAT_URL_ENV, poolPing, startWatchdogHeartbeat, watchdogHeartbeatConfigFromEnv,
  watchdogHeartbeatSelfCheck, watchdogTickMaxAgeMs
} from "../src/watchdog-heartbeat.ts";

/**
 * WP-OPS2a K3: EKSTERN dead man's switch for vakthunden (`JARVIS_WATCHDOG_HEARTBEAT_URL`, AV uten URL). En død eller hengt worker er stille: vakthunden kan ikke varsle om seg selv. Derfor pinger workeren eierens EGEN eksterne monitor KUN mens (1) vakthundens
 * siste FULLFØRTE tikk er ferskt og (2) databasen svarer på `SELECT 1` innen 3 s - ellers sender den ingenting (stillhet = alarm), og aldri et «feiler»-ping. Falsk klokke og falsk `send`: ingen ekte nettverkskall, ingen ekte nøkkel (plassholderen under er lagd).
 */
const KEY = "not-real-not-real-not-real"; // lavt entropi-plassholder (ikke en ekte nøkkel)
const URL_OK = `https://hc-ping.example/${KEY}`;
const ENV_OK = { [WATCHDOG_HEARTBEAT_URL_ENV]: URL_OK };
const NOW = 1_800_000_000_000;

interface Rig {
  clock: { t: number };
  last: { at: number | null };
  sent: string[];
  events: Array<Record<string, unknown>>;
  dbCalls: { n: number };
  db: { mode: "ok" | "fail" | "hang" };
}
function rig(env: Record<string, string | undefined> = ENV_OK, over: { watchdogIntervalMs?: number; dbTimeoutMs?: number; send?: PingFn } = {}) {
  const r: Rig = { clock: { t: NOW }, last: { at: NOW }, sent: [], events: [], dbCalls: { n: 0 }, db: { mode: "ok" } };
  const send: PingFn = over.send ?? (async (url) => { r.sent.push(url); return { ok: true, status: 200, reason: null }; });
  const heartbeat = startWatchdogHeartbeat({
    env, watchdog: { lastCompletedTickAgeMs: () => (r.last.at === null ? null : r.clock.t - r.last.at) }, watchdogIntervalMs: over.watchdogIntervalMs ?? 60_000,
    dbPing: () => { r.dbCalls.n += 1; return r.db.mode === "ok" ? Promise.resolve() : r.db.mode === "fail" ? Promise.reject(new Error(`connection refused ${KEY}`)) : new Promise<void>(() => undefined); },
    send, log: (e) => r.events.push(e), now: () => r.clock.t, ...(over.dbTimeoutMs !== undefined ? { dbTimeoutMs: over.dbTimeoutMs } : {})
  });
  return { r, heartbeat };
}
const stopAll: Array<() => void> = [];
afterEach(() => { for (const stop of stopAll.splice(0)) stop(); vi.useRealTimers(); });
function started(env?: Record<string, string | undefined>, over?: Parameters<typeof rig>[1]) {
  const made = rig(env, over);
  if (made.heartbeat) stopAll.push(() => made.heartbeat!.stop());
  return made;
}

describe("konfig: AV uten URL, fail-safe ved ugyldig verdi", () => {
  it("uten URL (usatt, tom, blank) er den AV: null, INGEN timer og INGEN utgående kall", () => {
    vi.useFakeTimers();
    for (const env of [{}, { [WATCHDOG_HEARTBEAT_URL_ENV]: "" }, { [WATCHDOG_HEARTBEAT_URL_ENV]: "   " }]) {
      const { r, heartbeat } = started(env);
      expect(heartbeat).toBeNull();
      expect(r.sent).toEqual([]);
      expect(r.dbCalls.n).toBe(0);
      expect(r.events).toEqual([]); // AV er stille - ingen loggrad
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(watchdogHeartbeatConfigFromEnv({})).toBeNull();
  });

  it("gyldig URL: standardintervall 60 s; intervall-variabelen (10-3600) styrer; opprinnelsen er det eneste som eksponeres", () => {
    expect(watchdogHeartbeatConfigFromEnv(ENV_OK)).toEqual({ url: URL_OK, intervalSec: 60, origin: "https://hc-ping.example" });
    expect(watchdogHeartbeatConfigFromEnv({ ...ENV_OK, [WATCHDOG_HEARTBEAT_INTERVAL_ENV]: "300" })?.intervalSec).toBe(300);
    expect(watchdogHeartbeatConfigFromEnv({ ...ENV_OK, [WATCHDOG_HEARTBEAT_INTERVAL_ENV]: "10" })?.intervalSec).toBe(10);
    expect(watchdogHeartbeatConfigFromEnv({ ...ENV_OK, [WATCHDOG_HEARTBEAT_INTERVAL_ENV]: "3600" })?.intervalSec).toBe(3600);
  });

  it("ugyldig URL starter IKKE, logger `watchdog_heartbeat_config_invalid` med variabelnavnet - og siterer aldri URL-en", () => {
    for (const bad of [`http://hc.example/${KEY}`, `https://user:pw@hc.example/${KEY}`, `https://hc.example/${KEY}#frag`, `https://hc.example/a b/${KEY}`, `ftp://hc.example/${KEY}`, `not a url ${KEY}`, `https://hc.example\\${KEY}`]) {
      vi.useFakeTimers();
      const { r, heartbeat } = started({ [WATCHDOG_HEARTBEAT_URL_ENV]: bad });
      expect(heartbeat, bad.slice(0, 25)).toBeNull();
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toMatchObject({ msg: "watchdog_heartbeat_config_invalid" });
      expect(String(r.events[0]?.["error"])).toContain(WATCHDOG_HEARTBEAT_URL_ENV);
      expect(String(r.events[0]?.["error"])).not.toContain("UPTIME");
      expect(JSON.stringify(r.events)).not.toContain(KEY);
      expect(r.sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("ugyldig intervall (under 10, over 3600, ikke-tall, desimal) starter IKKE og logger variabelen - ikke URL-en", () => {
    for (const bad of ["9", "3601", "abc", "1.5", "-5", "0"]) {
      const { r, heartbeat } = started({ ...ENV_OK, [WATCHDOG_HEARTBEAT_INTERVAL_ENV]: bad });
      expect(heartbeat, bad).toBeNull();
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toMatchObject({ msg: "watchdog_heartbeat_config_invalid" });
      expect(String(r.events[0]?.["error"])).toContain(WATCHDOG_HEARTBEAT_INTERVAL_ENV);
      expect(JSON.stringify(r.events)).not.toContain(KEY);
    }
  });

  it("kaster ALDRI ved oppstart: en uventet feil (her en logger som kaster) gir null og en logglinje - workeren kan ikke velte av heartbeaten", () => {
    vi.useFakeTimers();
    const events: Array<Record<string, unknown>> = [];
    const log = (e: Record<string, unknown>): void => {
      if (e["msg"] === "watchdog_heartbeat_started") throw new Error("logger kaster");
      events.push(e);
    };
    let heartbeat: unknown = "ikke satt";
    expect(() => { heartbeat = startWatchdogHeartbeat({ env: ENV_OK, watchdog: { lastCompletedTickAgeMs: () => 0 }, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log }); }).not.toThrow();
    expect(heartbeat).toBeNull();
    expect(events).toEqual([{ msg: "watchdog_heartbeat_start_failed", note: "heartbeaten er ikke startet (uventet feil); fravær av ping er alarmen" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starter aldri en timer som holder prosessen i live (unref), og stop() fjerner dem; start logger kun opprinnelsen", () => {
    vi.useFakeTimers();
    const { r, heartbeat } = started();
    expect(heartbeat).not.toBeNull();
    expect(vi.getTimerCount()).toBe(2); // første ping + fast intervall
    expect(r.events).toEqual([{ msg: "watchdog_heartbeat_started", target: "https://hc-ping.example", interval_sec: 60 }]);
    heartbeat!.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("terskelen: max(3 x vakthund-intervall, 2 min), strengt «yngre enn»", () => {
  it("konstanter og funksjon", () => {
    expect(WATCHDOG_HEARTBEAT_MIN_FRESH_MS).toBe(120_000);
    expect(WATCHDOG_HEARTBEAT_DB_TIMEOUT_MS).toBe(3_000);
    expect(watchdogTickMaxAgeMs(60_000)).toBe(180_000); // standard vakthund-intervall 60 s -> 3 min
    expect(watchdogTickMaxAgeMs(10_000)).toBe(120_000); // 3 x 10 s = 30 s < 2 min -> gulvet gjelder
    expect(watchdogTickMaxAgeMs(40_000)).toBe(120_000); // 3 x 40 s = 2 min = gulvet
    expect(watchdogTickMaxAgeMs(600_000)).toBe(1_800_000); // 10 min -> 30 min
  });

  it("14:59-lignende grenser: alder 1 ms under grensen pinger, nøyaktig grensen og over er stille", async () => {
    const { r, heartbeat } = started();
    for (const [age, expected] of [[0, "sent"], [179_999, "sent"], [180_000, "silent"], [180_001, "silent"], [3_600_000, "silent"]] as const) {
      r.sent.length = 0;
      r.last.at = r.clock.t - age;
      expect(await heartbeat!.tick(), `alder ${age} ms`).toBe(expected);
      expect(r.sent).toHaveLength(expected === "sent" ? 1 : 0);
    }
  });

  it("intervallet vakthunden faktisk går på styrer grensen (10 min -> 30 min; 10 s -> 2 min-gulvet)", async () => {
    const slow = started(ENV_OK, { watchdogIntervalMs: 600_000 });
    slow.r.last.at = slow.r.clock.t - 1_700_000;
    expect(await slow.heartbeat!.tick()).toBe("sent");
    slow.r.last.at = slow.r.clock.t - 1_800_000;
    expect(await slow.heartbeat!.tick()).toBe("silent");
    const fast = started(ENV_OK, { watchdogIntervalMs: 10_000 });
    fast.r.last.at = fast.r.clock.t - 119_999;
    expect(await fast.heartbeat!.tick()).toBe("sent");
    fast.r.last.at = fast.r.clock.t - 120_000;
    expect(await fast.heartbeat!.tick()).toBe("silent");
  });

  it("aldri tikket (null) og negativ alder (klokkeavvik: tikket er datert frem i tid) gir stillhet - alderen kan ikke bevises", async () => {
    const { r, heartbeat } = started();
    r.last.at = null;
    expect(await heartbeat!.tick()).toBe("silent");
    r.last.at = r.clock.t + 1;
    expect(await heartbeat!.tick()).toBe("silent");
    r.last.at = r.clock.t + 3_600_000;
    expect(await heartbeat!.tick()).toBe("silent");
    expect(r.sent).toEqual([]);
  });
});

describe("stillhet = alarm (aldri et «feiler»-ping)", () => {
  it("pinger nøyaktig den konfigurerte URL-en mens tikket er ferskt og databasen svarer; aldri noe annet endepunkt", async () => {
    const { r, heartbeat } = started();
    expect(await heartbeat!.tick()).toBe("sent");
    expect(await heartbeat!.tick()).toBe("sent");
    expect(r.sent).toEqual([URL_OK, URL_OK]);
    expect(r.sent.some((u) => /fail|start/.test(u))).toBe(false);
  });

  it("databasefeil -> stille; databasen som henger -> stille etter 3 s-fristen (injisert her) og uten å stable opp nye spørringer; gjenopptar når den svarer igjen", async () => {
    const { r, heartbeat } = started(ENV_OK, { dbTimeoutMs: 40 });
    r.db.mode = "fail";
    expect(await heartbeat!.tick()).toBe("silent");
    expect(r.sent).toEqual([]);
    r.db.mode = "hang";
    expect(await heartbeat!.tick()).toBe("silent"); // fristen går ut
    expect(r.dbCalls.n).toBe(2);
    expect(await heartbeat!.tick()).toBe("silent"); // forrige SELECT 1 henger fortsatt: ingen ny spørring legges oppå
    expect(r.dbCalls.n).toBe(2);
    expect(r.sent).toEqual([]);
    // en spørring som har hengt i 10 x fristen regnes som tapt: en ny startes (ellers ville én aldri-avsluttet spørring gjøre heartbeaten stum for alltid)
    r.clock.t += 10 * 40;
    r.last.at = r.clock.t;
    r.db.mode = "ok";
    expect(await heartbeat!.tick()).toBe("sent");
    expect(r.dbCalls.n).toBe(3);
  });

  it("standardfristen for databasen er 3 s: en hengende SELECT 1 gir stillhet nøyaktig når 3 s har gått (ikke før, ikke senere)", async () => {
    vi.useFakeTimers();
    const { r, heartbeat } = started();
    r.db.mode = "hang";
    let outcome: string | undefined;
    const pending = heartbeat!.tick().then((o) => { outcome = o; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(outcome).toBe("silent");
    expect(r.sent).toEqual([]);
  });

  it("gjenopptar etter retting: DB tilbake -> ping; gammelt tikk -> stille; ferskt tikk igjen -> ping", async () => {
    const { r, heartbeat } = started();
    r.db.mode = "fail";
    expect(await heartbeat!.tick()).toBe("silent");
    r.db.mode = "ok";
    expect(await heartbeat!.tick()).toBe("sent");
    r.last.at = r.clock.t - 600_000;
    expect(await heartbeat!.tick()).toBe("silent");
    r.last.at = r.clock.t - 1_000;
    expect(await heartbeat!.tick()).toBe("sent");
    expect(r.sent).toHaveLength(2);
    expect(r.events.map((e) => e["msg"])).toEqual([
      "watchdog_heartbeat_started", "watchdog_heartbeat_selfcheck_failed", "watchdog_heartbeat_selfcheck_recovered", "watchdog_heartbeat_selfcheck_failed", "watchdog_heartbeat_selfcheck_recovered"
    ]);
  });

  it("en leser som KASTER (vakthunden i ukjent tilstand) er stillhet, ikke et ping og ikke en krasj", async () => {
    const events: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const hb = startWatchdogHeartbeat({
      env: ENV_OK, watchdog: { lastCompletedTickAgeMs: () => { throw new Error("boom"); } }, watchdogIntervalMs: 60_000, dbPing: async () => undefined,
      send: async (u) => { sent.push(u); return { ok: true, status: 200, reason: null }; }, log: (e) => events.push(e), now: () => NOW
    });
    stopAll.push(() => hb!.stop());
    expect(await hb!.tick()).toBe("silent");
    expect(sent).toEqual([]);
  });

  it("selve utsendingen feiler (monitoren nede): telles og logges uten URL; kaster aldri", async () => {
    const send: PingFn = async () => ({ ok: false, status: 503, reason: "http_503" });
    const { r, heartbeat } = started(ENV_OK, { send });
    expect(await heartbeat!.tick()).toBe("send_failed");
    expect(r.events.at(-1)).toMatchObject({ msg: "watchdog_heartbeat_ping_failed", reason: "http_503", target: "https://hc-ping.example" });
    expect(JSON.stringify(r.events)).not.toContain(KEY);
  });

  it("ingen URL/nøkkel i NOEN loggrad - heller ikke feilteksten fra en databasefeil som siterer den (skann alle JSON-linjer)", async () => {
    const { r, heartbeat } = started();
    r.db.mode = "fail";
    await heartbeat!.tick();
    r.db.mode = "ok";
    r.last.at = null;
    await heartbeat!.tick();
    r.last.at = r.clock.t;
    await heartbeat!.tick();
    const lines = r.events.map((e) => JSON.stringify(e));
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain("hc-ping.example/");
      expect(line).not.toMatch(/https?:\/\/[^"]*\//); // kun opprinnelsen (uten sti) kan forekomme
    }
  });
});

describe("mot en EKTE Watchdog: en hengt vakthund (også en sjekk som aldri blir ferdig) gir stillhet", () => {
  it("fersk tikk -> ping; deretter henger neste tikk (sjekken avsluttes aldri) og klokken går -> stille ved terskelen", async () => {
    const clock = { t: NOW };
    let hang = false;
    const check: HealthCheck = { name: "maybe", runbook: "r", run: () => (hang ? new Promise(() => undefined) : Promise.resolve({ ok: true, severity: "info" as const, message: "" })) };
    const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch(), 3_600_000, 0, () => clock.t, () => clock.t); // veggklokke og monoton klokke følger den falske klokken (fiks 1, A-L2)
    wd.register(check);
    const sent: string[] = [];
    const hb = startWatchdogHeartbeat({
      env: ENV_OK, watchdog: wd, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log: () => undefined, now: () => clock.t,
      send: async (u) => { sent.push(u); return { ok: true, status: 200, reason: null }; }
    });
    stopAll.push(() => hb!.stop());
    await wd.tick();
    expect(await hb!.tick()).toBe("sent");
    hang = true;
    clock.t += 60_000;
    void wd.tick(); // hengende tikk
    await new Promise((r) => setTimeout(r, 20));
    clock.t += 60_000; // 2 min siden siste FULLFØRTE tikk: fortsatt innenfor 3 min
    expect(await hb!.tick()).toBe("sent");
    clock.t += 60_000; // 3 min: grensen
    expect(await hb!.tick()).toBe("silent");
    clock.t += 600_000;
    expect(await hb!.tick()).toBe("silent");
    expect(sent).toHaveLength(2);
  });
});

describe("selvsjekken er en REN funksjon av (vakthund, klokke, database)", () => {
  it("kaster aldri og svarer boolsk", async () => {
    const check = watchdogHeartbeatSelfCheck({ watchdog: { lastCompletedTickAgeMs: () => 0 }, intervalMs: 60_000, dbPing: async () => undefined, now: () => NOW });
    expect(await check()).toBe(true);
    const broken = watchdogHeartbeatSelfCheck({ watchdog: { lastCompletedTickAgeMs: () => 0 }, intervalMs: 60_000, dbPing: () => { throw new Error("sync boom"); }, now: () => NOW });
    expect(await broken()).toBe(false);
  });
});

describe("poolPing: SELECT 1 med klientside spørrefrist", () => {
  it("sender nøyaktig `SELECT 1` med query_timeout (standard 3 s) og ingen parametre; en annen frist kan gis", async () => {
    const calls: unknown[] = [];
    const pool = { query: async (q: unknown) => { calls.push(q); return { rows: [] }; } };
    await poolPing(pool as never)();
    await poolPing(pool as never, 1234)();
    expect(calls).toEqual([{ text: "SELECT 1", query_timeout: 3000 }, { text: "SELECT 1", query_timeout: 1234 }]);
  });
});

describe("env og wiring (kun worker; AV i eksempelfilen)", () => {
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
  const NAMES = [WATCHDOG_HEARTBEAT_URL_ENV, WATCHDOG_HEARTBEAT_INTERVAL_ENV];

  it("navnene er de eksakte", () => {
    expect(WATCHDOG_HEARTBEAT_URL_ENV).toBe("JARVIS_WATCHDOG_HEARTBEAT_URL");
    expect(WATCHDOG_HEARTBEAT_INTERVAL_ENV).toBe("JARVIS_WATCHDOG_HEARTBEAT_INTERVAL_SEC");
  });

  it("står i SERVICE_ENV.worker (nøyaktig én gang) - og ikke i api, voice, browser eller migrate", () => {
    for (const name of NAMES) {
      expect((SERVICE_ENV.worker as string[]).filter((n) => n === name), name).toHaveLength(1);
      for (const service of ["api", "voice", "browser", "migrate"] as const) expect(SERVICE_ENV[service], `${name} i ${service}`).not.toContain(name);
    }
  });

  it("compose har nøyaktig én videresendingslinje per variabel (tom standard = AV), og linjen ligger i worker-blokken", () => {
    const compose = read("infra/local/docker-compose.yml");
    for (const name of NAMES) {
      const lines = compose.split("\n").filter((l) => l.trim().startsWith(`${name}:`));
      expect(lines, name).toHaveLength(1);
      expect(lines[0]!.trim()).toBe(`${name}: "\${${name}:-}"`);
      const at = compose.indexOf(lines[0]!);
      const blockStart = compose.lastIndexOf("# GENERERT fra infra/local/service-env.mjs (SERVICE_ENV.", at);
      expect(compose.slice(blockStart, blockStart + 120)).toContain("(SERVICE_ENV.worker)");
    }
  });

  it("er ikke hemmeligheter i NEVER_IN_RUNTIME-forstand, og eksempelfilen har dem kommentert (AV) - aldri en aktiv tilordning", () => {
    const example = read(".env.example");
    for (const name of NAMES) {
      expect(NEVER_IN_RUNTIME).not.toContain(name);
      expect(example, name).toMatch(new RegExp(`^# ${name}=`, "m"));
      expect(example.split("\n").filter((l) => new RegExp(`^${name}=.+`).test(l)), name).toEqual([]);
    }
  });

  it("det bokstavelige URL-navnet står kun i watchdog-heartbeat.ts og manifestet i produksjonskoden (ingen annen avlesning)", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", "dist", "test", ".git", "worktrees"].includes(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|mts|mjs|js|cjs|tsx)$/.test(name)) files.push(full);
      }
    };
    for (const d of ["apps", "modules", "packages", "infra", "ops"]) walk(join(ROOT, d));
    const hits = files.filter((f) => readFileSync(f, "utf8").includes("JARVIS_WATCHDOG_HEARTBEAT_URL")).map((f) => f.slice(ROOT.length)).sort();
    expect(hits).toEqual(["apps/api/src/watchdog-heartbeat.ts", "infra/local/service-env.mjs"]);
  });

  it("worker-main.ts starter heartbeaten ETTER at vakthundens intervall er satt opp, med vakthundens egen instans/intervall og en DB-ping; main.ts (API) rører den ikke", () => {
    const worker = read("apps/api/src/worker-main.ts");
    const interval = worker.indexOf("WATCHDOG_INTERVAL_MS\n);");
    const start = worker.indexOf("startWatchdogHeartbeat(");
    expect(interval).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(interval);
    expect(worker.slice(start, start + 220)).toContain("watchdog, watchdogIntervalMs: WATCHDOG_INTERVAL_MS");
    expect(worker.slice(start, start + 220)).toContain("dbPing: poolPing(pool)");
    expect(worker.match(/startWatchdogHeartbeat\(/g)).toHaveLength(1);
    expect(read("apps/api/src/main.ts")).not.toContain("startWatchdogHeartbeat");
  });
});
