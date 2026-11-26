import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HeartbeatConfigError, HeartbeatSender, makeSendPing, sendPing, uptimeHeartbeatConfigFromEnv, validateHeartbeatUrl, type HeartbeatSenderOptions } from "../src/heartbeat-sender.ts";

/**
 * WP-OPS2a K3: `HeartbeatSender` er generalisert (valgfri `name`/`envName`/`userAgent`) UTEN å endre API-ets oppførsel: standardene gir BYTE-LIK logg og feilmeldinger. `wpc2-heartbeat-sender.test.ts` er urørt;
 * denne filen låser identiteten eksplisitt (de gamle meldingene ordrett) og at de nye valgene virker.
 */
const KEY = "not-real-not-real-not-real"; // lavt entropi-plassholder (ikke en ekte nøkkel)
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); })));
});

describe("standardene er uendret (API-heartbeaten): ordrette meldinger og loggnavn", () => {
  const BAD: Array<[string, string]> = [
    ["", "JARVIS_UPTIME_HEARTBEAT_URL: ugyldig URL (tom, for lang, mellomrom/kontrolltegn eller backslash)"],
    ["https://hc.example/a b", "JARVIS_UPTIME_HEARTBEAT_URL: ugyldig URL (tom, for lang, mellomrom/kontrolltegn eller backslash)"],
    ["not a url", "JARVIS_UPTIME_HEARTBEAT_URL: ugyldig URL (tom, for lang, mellomrom/kontrolltegn eller backslash)"],
    ["nourlatall", "JARVIS_UPTIME_HEARTBEAT_URL: ikke en gyldig URL"],
    [`https://u:p@hc.example/${KEY}`, "JARVIS_UPTIME_HEARTBEAT_URL: brukerinfo i URL er ikke tillatt"],
    [`https://hc.example/${KEY}#f`, "JARVIS_UPTIME_HEARTBEAT_URL: fragment (#) er ikke tillatt"],
    [`http://hc.example/${KEY}`, "JARVIS_UPTIME_HEARTBEAT_URL: kun https:// er tillatt (http:// bare mot loopback, for test)"],
    ["file:///etc/passwd", "JARVIS_UPTIME_HEARTBEAT_URL: mangler vert"]
  ];
  it("validateHeartbeatUrl uten envName: nøyaktig de gamle feilmeldingene", () => {
    for (const [raw, expected] of BAD) {
      let message = "";
      try { validateHeartbeatUrl(raw); } catch (err) { expect(err).toBeInstanceOf(HeartbeatConfigError); message = (err as Error).message; }
      expect(message, raw).toBe(expected);
      expect(message).not.toContain(KEY);
    }
  });

  it("med envName: samme feil, men navnet i meldingen er variabelen det gjelder - og URL-en siteres aldri", () => {
    for (const [raw, expected] of BAD) {
      const name = "JARVIS_WATCHDOG_HEARTBEAT_URL";
      let message = "";
      try { validateHeartbeatUrl(raw, name); } catch (err) { message = (err as Error).message; }
      expect(message, raw).toBe(expected.replace("JARVIS_UPTIME_HEARTBEAT_URL", name));
      expect(message).not.toContain(KEY);
    }
  });

  it("uptimeHeartbeatConfigFromEnv er uendret (AV uten URL, 60 s standard, opprinnelsen er det eneste som eksponeres)", () => {
    expect(uptimeHeartbeatConfigFromEnv({})).toBeNull();
    expect(uptimeHeartbeatConfigFromEnv({ JARVIS_UPTIME_HEARTBEAT_URL: `https://hc.example/${KEY}` })).toEqual({ url: `https://hc.example/${KEY}`, intervalSec: 60, origin: "https://hc.example" });
  });

  const run = async (over: Partial<HeartbeatSenderOptions>) => {
    const events: Array<Record<string, unknown>> = [];
    let healthy = false;
    let sendOk = false;
    const s = new HeartbeatSender({
      url: `https://hc.example/${KEY}`, origin: "https://hc.example", intervalMs: 60_000, selfCheck: async () => healthy,
      send: async () => (sendOk ? { ok: true, status: 200, reason: null } : { ok: false, status: 503, reason: "http_503" }), log: (e) => events.push(e), ...over
    });
    await s.tick(); // selvsjekk feiler
    healthy = true;
    await s.tick(); // selvsjekk friskner til, utsending feiler
    sendOk = true;
    await s.tick(); // utsending lykkes (gjenoppretting)
    s.start();
    s.stop();
    return events;
  };

  it("loggeventene uten `name` er byte-like med den gamle koden (uptime_heartbeat_*)", async () => {
    expect(await run({})).toEqual([
      { msg: "uptime_heartbeat_selfcheck_failed", silent_ticks: 1, note: "sender IKKE ping (stillhet = alarm hos monitoren)" },
      { msg: "uptime_heartbeat_selfcheck_recovered", silent_ticks: 1 },
      { msg: "uptime_heartbeat_ping_failed", reason: "http_503", target: "https://hc.example", consecutive_failures: 1 },
      { msg: "uptime_heartbeat_ping_recovered", failures: 1, target: "https://hc.example" },
      { msg: "uptime_heartbeat_started", target: "https://hc.example", interval_sec: 60 }
    ]);
  });

  it("med `name` skifter KUN prefikset - øvrige felt er identiske", async () => {
    const events = await run({ name: "watchdog_heartbeat" });
    expect(events.map((e) => e["msg"])).toEqual(["watchdog_heartbeat_selfcheck_failed", "watchdog_heartbeat_selfcheck_recovered", "watchdog_heartbeat_ping_failed", "watchdog_heartbeat_ping_recovered", "watchdog_heartbeat_started"]);
    const rest = (list: Array<Record<string, unknown>>) => list.map(({ msg: _m, ...fields }) => fields);
    expect(rest(events)).toEqual(rest(await run({})));
    expect(JSON.stringify(events)).not.toContain(KEY);
  });
});

describe("user-agent", () => {
  async function serve() {
    const seen: Array<string | undefined> = [];
    const server = createServer((req: IncomingMessage, res) => { seen.push(req.headers["user-agent"]); res.statusCode = 200; res.end("OK"); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping` };
  }

  it("standard `sendPing` bruker uendret `jarvis-api-uptime/1`; `makeSendPing(ua)` bruker den gitte", async () => {
    const { seen, url } = await serve();
    expect(await sendPing(url, 2000)).toEqual({ ok: true, status: 200, reason: null });
    expect(await makeSendPing("jarvis-watchdog-heartbeat/1")(url, 2000)).toEqual({ ok: true, status: 200, reason: null });
    expect(seen).toEqual(["jarvis-api-uptime/1", "jarvis-watchdog-heartbeat/1"]);
  });

  it("HeartbeatSender uten `send`: userAgent styrer standard utsending (og uten userAgent er den uendret)", async () => {
    const { seen, url } = await serve();
    const base = { url, origin: new URL(url).origin, intervalMs: 60_000, selfCheck: async () => true, log: () => undefined };
    expect(await new HeartbeatSender(base).tick()).toBe("sent");
    expect(await new HeartbeatSender({ ...base, userAgent: "jarvis-watchdog-heartbeat/1" }).tick()).toBe("sent");
    expect(seen).toEqual(["jarvis-api-uptime/1", "jarvis-watchdog-heartbeat/1"]);
  });

  it("en eksplisitt `send` går foran userAgent (testene injiserer sin egen)", async () => {
    const sent: string[] = [];
    const s = new HeartbeatSender({ url: "https://hc.example/x", origin: "https://hc.example", intervalMs: 60_000, selfCheck: async () => true, log: () => undefined, userAgent: "ignorert/1", send: async (u) => { sent.push(u); return { ok: true, status: 200, reason: null }; } });
    expect(await s.tick()).toBe("sent");
    expect(sent).toEqual(["https://hc.example/x"]);
  });
});
