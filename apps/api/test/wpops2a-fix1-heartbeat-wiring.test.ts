import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WATCHDOG_HEARTBEAT_INTERVAL_ENV, WATCHDOG_HEARTBEAT_URL_ENV, startWatchdogHeartbeat, watchdogHeartbeatSelfCheck } from "../src/watchdog-heartbeat.ts";

/**
 * WP-OPS2a fiks-runde 1 (review A-L8): testhull som reviewer A fant med mutanter, nå dekket på wiring-nivå (`startWatchdogHeartbeat` uten injisert `send` mot en ekte lokal server):
 *  - H21: standard utsending bruker vakthundens EGEN user-agent (`jarvis-watchdog-heartbeat/1`), ikke API-ets,
 *  - H25: det er den NORMALISERTE URL-en som sendes (en `HTTP://`-URL med store bokstaver ville ellers blitt avvist av `guardedFetch` ved sending),
 *  - H29: en URL feilplassert i INTERVALL-variabelen siteres aldri i loggen,
 *  - H01: `null` (aldri tikket) er stillhet også når en feil kunne gjort det til alder 0 (null regnes som 0 i en sammenligning),
 *  - H11/H12: en hengt `SELECT 1` regnes som tapt etter NØYAKTIG 10 x databasefristen (ikke 1 x, ikke 5 x).
 * Ingen ekte nøkler: URL-ene er lokale (127.0.0.1) eller `.example`, markørene er lagde.
 */
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
  vi.restoreAllMocks();
});

async function serve(): Promise<{ seen: Array<{ ua: string | undefined; url: string | undefined; method: string | undefined }>; port: number }> {
  const seen: Array<{ ua: string | undefined; url: string | undefined; method: string | undefined }> = [];
  const server = createServer((req, res) => { seen.push({ ua: req.headers["user-agent"], url: req.url, method: req.method }); res.statusCode = 200; res.end("ok"); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, port: (server.address() as AddressInfo).port };
}
const fresh = { lastCompletedTickAgeMs: () => 0 };

describe("wiring-nivå: standard utsending (uten injisert send) går til den normaliserte URL-en med vakthundens egen user-agent", () => {
  it("H21: user-agent er `jarvis-watchdog-heartbeat/1`, metoden er GET og stien bevares", async () => {
    const { seen, port } = await serve();
    const hb = startWatchdogHeartbeat({ env: { [WATCHDOG_HEARTBEAT_URL_ENV]: `http://127.0.0.1:${port}/p/abc` }, watchdog: fresh, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log: () => undefined });
    try { expect(await hb!.tick()).toBe("sent"); } finally { hb!.stop(); }
    expect(seen).toEqual([{ ua: "jarvis-watchdog-heartbeat/1", url: "/p/abc", method: "GET" }]);
  });

  it("H25: `HTTP://127.0.0.1:port/...` (store bokstaver) normaliseres og KAN sendes - den rå strengen ville blitt avvist av guardedFetch", async () => {
    const { seen, port } = await serve();
    const hb = startWatchdogHeartbeat({ env: { [WATCHDOG_HEARTBEAT_URL_ENV]: `HTTP://127.0.0.1:${port}/p/abc` }, watchdog: fresh, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log: () => undefined });
    try { expect(await hb!.tick()).toBe("sent"); } finally { hb!.stop(); }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/p/abc");
  });

  it("en URL med standardport og store bokstaver i verten (`https://HC.EXAMPLE:443/x`) sendes normalisert (config.url er det som sendes)", async () => {
    const sent: string[] = [];
    const hb = startWatchdogHeartbeat({
      env: { [WATCHDOG_HEARTBEAT_URL_ENV]: "https://HC.EXAMPLE:443/p/abc" }, watchdog: fresh, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log: () => undefined,
      send: async (u) => { sent.push(u); return { ok: true, status: 200, reason: null }; }
    });
    try { expect(await hb!.tick()).toBe("sent"); } finally { hb!.stop(); }
    expect(sent).toEqual(["https://hc.example/p/abc"]);
  });
});

describe("H29: en URL feilplassert i intervall-variabelen siteres aldri", () => {
  it("INTERVAL = en URL med lagd markør: konfig ugyldig, fast melding, ingen markør og ingen vert i loggen, og heartbeaten starter ikke", () => {
    const marker = ["zq", "interval", "marker"].join("-");
    const events: Array<Record<string, unknown>> = [];
    const hb = startWatchdogHeartbeat({
      env: { [WATCHDOG_HEARTBEAT_URL_ENV]: "https://hc.example/ok", [WATCHDOG_HEARTBEAT_INTERVAL_ENV]: `https://hc.example/${marker}` },
      watchdog: fresh, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log: (e) => events.push(e)
    });
    expect(hb).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ msg: "watchdog_heartbeat_config_invalid" });
    expect(String(events[0]?.["error"])).toContain(WATCHDOG_HEARTBEAT_INTERVAL_ENV);
    expect(JSON.stringify(events)).not.toContain(marker);
    expect(JSON.stringify(events)).not.toContain("hc.example");
    expect(String(events[0]?.["error"])).toBe(`${WATCHDOG_HEARTBEAT_INTERVAL_ENV}: ugyldig verdi (heltall mellom 10 og 3600 sekunder)`);
  });

  it("også en vanlig ugyldig tallverdi siteres ikke (meldingen er fast)", () => {
    for (const bad of ["9", "3601", "abc", "1.5", "-5", "0"]) {
      const events: Array<Record<string, unknown>> = [];
      expect(startWatchdogHeartbeat({ env: { [WATCHDOG_HEARTBEAT_URL_ENV]: "https://hc.example/ok", [WATCHDOG_HEARTBEAT_INTERVAL_ENV]: bad }, watchdog: fresh, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log: (e) => events.push(e) })).toBeNull();
      expect(String(events[0]?.["error"]), bad).toBe(`${WATCHDOG_HEARTBEAT_INTERVAL_ENV}: ugyldig verdi (heltall mellom 10 og 3600 sekunder)`);
    }
  });

  it("compose gir tom streng for intervallet når URL-en er satt: standard 60 s (ikke en feil)", () => {
    const events: Array<Record<string, unknown>> = [];
    const hb = startWatchdogHeartbeat({ env: { [WATCHDOG_HEARTBEAT_URL_ENV]: "https://hc.example/ok", [WATCHDOG_HEARTBEAT_INTERVAL_ENV]: "" }, watchdog: fresh, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log: (e) => events.push(e), send: async () => ({ ok: true, status: 200, reason: null }) });
    try {
      expect(hb).not.toBeNull();
      expect(events).toEqual([{ msg: "watchdog_heartbeat_started", target: "https://hc.example", interval_sec: 60 }]);
    } finally { hb?.stop(); }
  });
});

describe("H01: aldri tikket (null) er stillhet - null skal aldri regnes som alder 0", () => {
  it("lastCompletedTickAgeMs = null gir false uansett klokke (også en klokke som står på 0 eller nær epoke)", async () => {
    for (const now of [0, 1, 50_000, 1_800_000_000_000]) {
      const check = watchdogHeartbeatSelfCheck({ watchdog: { lastCompletedTickAgeMs: () => null }, intervalMs: 60_000, dbPing: async () => undefined, now: () => now });
      expect(await check(), `klokke ${now}`).toBe(false);
    }
  });
});

describe("H11/H12: en hengt SELECT 1 regnes som tapt etter NØYAKTIG 10 x databasefristen", () => {
  it("40 ms-frist: ingen ny spørring ved 1 x, 5 x eller 9,98 x fristen (399 ms); den starter ved 10 x (400 ms) og pinget gjenopptas", async () => {
    const clock = { t: 1_000_000 };
    let mode: "hang" | "ok" = "hang";
    let calls = 0;
    const sent: string[] = [];
    const hb = startWatchdogHeartbeat({
      env: { [WATCHDOG_HEARTBEAT_URL_ENV]: "https://hc.example/ok" }, watchdog: fresh, watchdogIntervalMs: 60_000, dbTimeoutMs: 40, log: () => undefined, now: () => clock.t,
      dbPing: () => { calls += 1; return mode === "hang" ? new Promise<void>(() => undefined) : Promise.resolve(); },
      send: async (u) => { sent.push(u); return { ok: true, status: 200, reason: null }; }
    });
    try {
      expect(await hb!.tick()).toBe("silent"); // spørringen henger: fristen (40 ms reell tid) går ut
      expect(calls).toBe(1);
      mode = "ok";
      for (const offset of [40, 199, 200, 201, 399]) {
        clock.t = 1_000_000 + offset;
        expect(await hb!.tick(), `${offset} ms etter oppstart av den hengte spørringen`).toBe("silent");
        expect(calls, `${offset} ms: ingen ny spørring skal legges oppå`).toBe(1);
      }
      clock.t = 1_000_000 + 400;
      expect(await hb!.tick()).toBe("sent"); // regnes som tapt: en ny spørring startes og svarer
      expect(calls).toBe(2);
      expect(sent).toEqual(["https://hc.example/ok"]);
    } finally { hb!.stop(); }
  });
});
