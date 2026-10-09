import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  HeartbeatConfigError, HeartbeatSender, loopbackSelfCheck, sendPing, startUptimeHeartbeat, uptimeHeartbeatConfigFromEnv, validateHeartbeatUrl, type PingFn
} from "../src/heartbeat-sender.ts";

/**
 * WP-C2: API-ets ekstern oppetids-heartbeat. Stillhet = alarm: det pinges KUN mens selvsjekken består, og aldri med innhold. Hele utsendingsbanen
 * (`guardedFetch`) kjøres mot en lokal server på 127.0.0.1 - ingen nettverk ut av maskinen.
 */
const KEY = "not-real-not-real-not-real"; // lavt entropi-plassholder (ikke en ekte nøkkel)
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); })));
});

interface Hit { method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"]; bodyLength: number }
async function serve(handler: (req: IncomingMessage, res: import("node:http").ServerResponse, n: number) => void = (_r, res) => { res.statusCode = 200; res.end("OK"); }) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; });
    req.on("end", () => { hits.push({ method: req.method, url: req.url, headers: req.headers, bodyLength: n }); handler(req, res, hits.length); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { hits, port, url: (path = "/") => `http://127.0.0.1:${port}${path}` };
}

function sender(over: Partial<ConstructorParameters<typeof HeartbeatSender>[0]> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const sent: string[] = [];
  const s = new HeartbeatSender({
    url: `https://hc-ping.example/${KEY}`, origin: "https://hc-ping.example", intervalMs: 60_000, selfCheck: async () => true,
    send: async (url) => { sent.push(url); return { ok: true, status: 200, reason: null }; }, log: (e) => events.push(e), now: () => new Date("2026-10-09T03:00:00.000Z"), ...over
  });
  return { s, events, sent };
}

describe("WP-C2 oppetids-heartbeat: konfig (AV som standard, fail-safe)", () => {
  it("uten JARVIS_UPTIME_HEARTBEAT_URL er den AV: null, ingen timer, ingen utgående kall", () => {
    expect(uptimeHeartbeatConfigFromEnv({})).toBeNull();
    expect(uptimeHeartbeatConfigFromEnv({ JARVIS_UPTIME_HEARTBEAT_URL: "   " })).toBeNull();
    expect(startUptimeHeartbeat({ port: 3010, env: {} })).toBeNull();
  });

  it("gyldig https-URL med standardintervall 60 s; opprinnelsen er det eneste som eksponeres", () => {
    const c = uptimeHeartbeatConfigFromEnv({ JARVIS_UPTIME_HEARTBEAT_URL: `https://hc-ping.example/${KEY}?x=1` });
    expect(c).toEqual({ url: `https://hc-ping.example/${KEY}?x=1`, intervalSec: 60, origin: "https://hc-ping.example" });
    expect(uptimeHeartbeatConfigFromEnv({ JARVIS_UPTIME_HEARTBEAT_URL: `https://hc.example/${KEY}`, JARVIS_UPTIME_HEARTBEAT_INTERVAL_SEC: "300" })?.intervalSec).toBe(300);
  });

  it("utrygge URL-er avvises uten å sitere dem: http mot ikke-loopback, brukerinfo, fragment, mellomrom, kontrolltegn, backslash, andre skjema, for lang", () => {
    for (const bad of [`http://hc.example/${KEY}`, `https://u:p@hc.example/${KEY}`, `https://hc.example/${KEY}#f`, "https://hc.example/a b", "https://hc.example/a\nb", "https://hc.example\\x", "ftp://hc.example/x", "javascript:alert(1)", "https://", "ikke en url", `https://hc.example/${"a".repeat(3000)}`]) {
      expect(() => validateHeartbeatUrl(bad), bad.slice(0, 30)).toThrow(HeartbeatConfigError);
      try { validateHeartbeatUrl(bad); } catch (err) { expect((err as Error).message).not.toContain(KEY); }
    }
    expect(() => validateHeartbeatUrl("http://127.0.0.1:8080/x")).not.toThrow();
    expect(() => validateHeartbeatUrl("http://localhost/x")).not.toThrow();
  });

  it("ugyldig konfig starter IKKE heartbeaten og velter ikke API-et - den logges høyt (fravær av ping er selve alarmen)", () => {
    const events: Array<Record<string, unknown>> = [];
    expect(startUptimeHeartbeat({ port: 3010, env: { JARVIS_UPTIME_HEARTBEAT_URL: "http://evil.example/x" }, log: (e) => events.push(e) })).toBeNull();
    expect(startUptimeHeartbeat({ port: 3010, env: { JARVIS_UPTIME_HEARTBEAT_URL: `https://hc.example/${KEY}`, JARVIS_UPTIME_HEARTBEAT_INTERVAL_SEC: "1" }, log: (e) => events.push(e) })).toBeNull();
    expect(events.map((e) => e["msg"])).toEqual(["uptime_heartbeat_config_invalid", "uptime_heartbeat_config_invalid"]);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });
});

describe("WP-C2 oppetids-heartbeat: stillhet = alarm (kun ping mens selvsjekken består)", () => {
  it("frisk selvsjekk → ETT ping til nøyaktig den konfigurerte URL-en", async () => {
    const { s, sent } = sender();
    expect(await s.tick()).toBe("sent");
    expect(sent).toEqual([`https://hc-ping.example/${KEY}`]);
    expect(s.status()).toMatchObject({ last_ok_at: "2026-10-09T03:00:00.000Z", consecutive_send_failures: 0, silent_ticks: 0 });
  });

  it("ødelagt selvsjekk (false / kaster / henger) → INGEN ping, ingen /fail-ping: stillheten er signalet", async () => {
    for (const selfCheck of [async () => false, async () => { throw new Error("db nede"); }, () => new Promise<boolean>(() => undefined)]) {
      const { s, sent, events } = sender({ selfCheck, selfCheckTimeoutMs: 50 });
      expect(await s.tick()).toBe("silent");
      expect(sent).toEqual([]);
      expect(s.status().silent_ticks).toBe(1);
      expect(events[0]).toMatchObject({ msg: "uptime_heartbeat_selfcheck_failed", silent_ticks: 1 });
    }
  });

  it("gjenoppretting: første friske tikk etter stillhet pinger igjen og logger det; loggingen er rate-begrenset (første + hvert 10.)", async () => {
    let healthy = false;
    const { s, sent, events } = sender({ selfCheck: async () => healthy });
    for (let i = 0; i < 12; i++) await s.tick();
    expect(events.filter((e) => e["msg"] === "uptime_heartbeat_selfcheck_failed").map((e) => e["silent_ticks"])).toEqual([1, 10]);
    healthy = true;
    expect(await s.tick()).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ msg: "uptime_heartbeat_selfcheck_recovered", silent_ticks: 12 });
    expect(s.status().silent_ticks).toBe(0);
  });

  it("en utsending som feiler kaster aldri: telles, logges rate-begrenset uten URL, og gjenoppretting logges", async () => {
    let ok = false;
    const send: PingFn = async () => (ok ? { ok: true, status: 200, reason: null } : { ok: false, status: 503, reason: "http_503" });
    const { s, events } = sender({ send });
    expect(await s.tick()).toBe("send_failed");
    expect(await s.tick()).toBe("send_failed");
    expect(s.status().consecutive_send_failures).toBe(2);
    expect(events.filter((e) => e["msg"] === "uptime_heartbeat_ping_failed")).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "http_503", target: "https://hc-ping.example", consecutive_failures: 1 });
    ok = true;
    expect(await s.tick()).toBe("sent");
    expect(events.at(-1)).toMatchObject({ msg: "uptime_heartbeat_ping_recovered", failures: 2 });
    expect(JSON.stringify(events)).not.toContain(KEY);
    // selv en send-funksjon som KASTER velter ikke tikket
    const thrower = sender({ send: async () => { throw new Error(`boom ${KEY}`); } });
    expect(await thrower.s.tick()).toBe("send_failed");
    expect(JSON.stringify(thrower.events)).not.toContain(KEY);
  });

  it("overlappende tikk stables ikke: et tikk som henger gjør at neste hoppes over", async () => {
    let release: (v: boolean) => void = () => undefined;
    const { s } = sender({ selfCheck: () => new Promise<boolean>((resolve) => { release = resolve; }), selfCheckTimeoutMs: 10_000 });
    const first = s.tick();
    expect(await s.tick()).toBe("skipped_busy");
    release(true);
    expect(await first).toBe("sent");
  });

  it("start() logger kun opprinnelsen, holder ikke prosessen i live (unref), og stop() stopper alt; dobbel start gjør ingenting ekstra", () => {
    const { s, events } = sender();
    s.start();
    s.start();
    expect(events.filter((e) => e["msg"] === "uptime_heartbeat_started")).toEqual([{ msg: "uptime_heartbeat_started", target: "https://hc-ping.example", interval_sec: 60 }]);
    const priv = s as unknown as { timer: NodeJS.Timeout; firstTimer: NodeJS.Timeout };
    expect(priv.timer.hasRef()).toBe(false);
    expect(priv.firstTimer.hasRef()).toBe(false);
    expect(s.status().running).toBe(true);
    s.stop();
    expect(s.status().running).toBe(false);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });
});

describe("WP-C2 oppetids-heartbeat: ekte utsending via guardedFetch mot lokal server", () => {
  it("GET uten kropp til riktig sti+query; ingen hemmeligheter i headere; 2xx = ok", async () => {
    const srv = await serve();
    const r = await sendPing(srv.url(`/ping/${KEY}?a=b`), 2000);
    expect(r).toEqual({ ok: true, status: 200, reason: null });
    expect(srv.hits).toHaveLength(1);
    expect(srv.hits[0]).toMatchObject({ method: "GET", url: `/ping/${KEY}?a=b`, bodyLength: 0 });
    expect(JSON.stringify(srv.hits[0]!.headers)).not.toMatch(/authorization|cookie|password|secret|token|JARVIS_/i);
  });

  it("non-2xx = feil, en redirect FØLGES ALDRI, tidsavbrudd gir `timeout`, lukket port gir `network` - og ingenting kaster", async () => {
    const target = await serve();
    const srv = await serve((req, res) => {
      if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("location", target.url("/hit")); res.end(); return; }
      if (req.url === "/slow") return; // svarer aldri
      res.statusCode = 500; res.end("feil");
    });
    expect(await sendPing(srv.url("/x"), 2000)).toMatchObject({ ok: false, status: 500, reason: "http_500" });
    expect(await sendPing(srv.url("/redirect"), 2000)).toMatchObject({ ok: false, status: 302, reason: "http_302" });
    expect(target.hits).toHaveLength(0);
    expect(await sendPing(srv.url("/slow"), 200)).toMatchObject({ ok: false, reason: "timeout" });
    const closed = await serve();
    const url = closed.url("/gone");
    await new Promise<void>((resolve) => { servers.pop()!.close(() => resolve()); });
    expect(await sendPing(url, 500)).toMatchObject({ ok: false, reason: "network" });
  });

  it("guardedFetch-vernet gjelder: en URL med utrygg form (backslash/dot-segment/brukerinfo) sendes aldri", async () => {
    for (const bad of ["http://127.0.0.1:1/a/../b", "http://u:p@127.0.0.1:1/x", "http://127.0.0.1:1\\evil"]) {
      expect(await sendPing(bad, 300), bad).toMatchObject({ ok: false });
    }
  });

  it("hele kjeden: HeartbeatSender → guardedFetch → lokal server, og selvsjekken mot en lokal /health (200 = frisk, 503/lukket/treg = stille)", async () => {
    const monitor = await serve();
    const api = await serve((req, res) => { res.statusCode = req.url === "/health" ? 200 : 404; res.end("{}"); });
    const healthy = new HeartbeatSender({ url: monitor.url(`/hc/${KEY}`), origin: "http://127.0.0.1", intervalMs: 60_000, selfCheck: loopbackSelfCheck(api.port), log: () => undefined });
    expect(await healthy.tick()).toBe("sent");
    expect(monitor.hits.map((h) => `${h.method} ${h.url}`)).toEqual([`GET /hc/${KEY}`]);

    const down = await serve((_req, res) => { res.statusCode = 503; res.end("{}"); });
    const sick = new HeartbeatSender({ url: monitor.url(`/hc/${KEY}`), origin: "http://127.0.0.1", intervalMs: 60_000, selfCheck: loopbackSelfCheck(down.port), log: () => undefined });
    expect(await sick.tick()).toBe("silent");
    const hung = await serve(() => undefined);
    expect(await loopbackSelfCheck(hung.port, fetch, 200)()).toBe(false);
    const gone = await serve();
    const gonePort = gone.port;
    await new Promise<void>((resolve) => { servers.pop()!.close(() => resolve()); });
    expect(await loopbackSelfCheck(gonePort, fetch, 300)()).toBe(false);
    expect(monitor.hits).toHaveLength(1); // den syke instansen sendte INGEN ping
  });

  it("startUptimeHeartbeat med fullstendig konfig: første ping kommer etter selvsjekken, og stop() hindrer flere", async () => {
    const monitor = await serve();
    const events: Array<Record<string, unknown>> = [];
    const s = startUptimeHeartbeat({
      port: 1, env: { JARVIS_UPTIME_HEARTBEAT_URL: monitor.url(`/hc/${KEY}`), JARVIS_UPTIME_HEARTBEAT_INTERVAL_SEC: "10" }, selfCheck: async () => true, log: (e) => events.push(e)
    });
    expect(s).not.toBeNull();
    expect(events[0]).toMatchObject({ msg: "uptime_heartbeat_started", interval_sec: 10 });
    expect(await s!.tick()).toBe("sent");
    s!.stop();
    expect(monitor.hits).toHaveLength(1);
  });
});
