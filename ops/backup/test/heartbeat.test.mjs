import { afterAll, describe, expect, it } from "vitest";
import { HeartbeatConfigError, assertHeartbeatUrl, createHeartbeat, parseHeartbeatConfig, sendPing, withPathSuffix } from "../lib/heartbeat.mjs";
import { cleanupTempDirs, startServer } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const KEY = "not-real-not-real-not-real";

describe("WP-C2 heartbeat: konfig (dormant, fail-closed, aldri URL i feilmeldinger)", () => {
  it("uten JARVIS_BACKUP_HEARTBEAT_URL er den AV - ingenting konfigurert, ingenting sendt", () => {
    expect(parseHeartbeatConfig({})).toEqual({ configured: false });
    expect(parseHeartbeatConfig({ JARVIS_BACKUP_HEARTBEAT_URL: "   " })).toEqual({ configured: false });
  });

  it("healthchecks.io-konvensjonen: /start og /fail på stien (foran en evt. query), uten dobbel skråstrek", () => {
    const c = parseHeartbeatConfig({ JARVIS_BACKUP_HEARTBEAT_URL: `https://hc-ping.example/${KEY}/` });
    expect(c).toMatchObject({ configured: true, invalid: false, label: "https://hc-ping.example", timeoutMs: 10_000 });
    expect(c.urls).toEqual({ success: `https://hc-ping.example/${KEY}/`, start: `https://hc-ping.example/${KEY}/start`, fail: `https://hc-ping.example/${KEY}/fail` });
    const q = parseHeartbeatConfig({ JARVIS_BACKUP_HEARTBEAT_URL: `https://hc.example/ping/${KEY}?rid=abc` });
    expect(q.urls.start).toBe(`https://hc.example/ping/${KEY}/start?rid=abc`);
    expect(withPathSuffix(new URL("https://x.example/a"), "/fail").toString()).toBe("https://x.example/a/fail");
  });

  it("leverandører med en annen konvensjon setter start-/fail-URL eksplisitt", () => {
    const c = parseHeartbeatConfig({
      JARVIS_BACKUP_HEARTBEAT_URL: "https://kuma.example/api/push/TOKEN123?status=up&msg=OK",
      JARVIS_BACKUP_HEARTBEAT_START_URL: "https://kuma.example/api/push/TOKEN123?status=up&msg=start",
      JARVIS_BACKUP_HEARTBEAT_FAIL_URL: "https://kuma.example/api/push/TOKEN123?status=down&msg=FAIL",
      JARVIS_BACKUP_HEARTBEAT_TIMEOUT_SEC: "3"
    });
    expect(c.urls.fail).toContain("status=down");
    expect(c.urls.start).toContain("msg=start");
    expect(c.timeoutMs).toBe(3000);
  });

  it("utrygge URL-er avvises: http mot ikke-loopback, brukerinfo, fragment, mellomrom/kontrolltegn/backslash, ikke-http-skjema, for lang", () => {
    const bad = [
      `http://hc-ping.example/${KEY}`, `https://user:pw@hc.example/${KEY}`, `https://hc.example/${KEY}#frag`, `https://hc.example/a b`, "https://hc.example/a\nb",
      "https://hc.example\\evil", "ftp://hc.example/x", "javascript:alert(1)", "file:///etc/passwd", "https://", "not a url", `https://hc.example/${"a".repeat(3000)}`
    ];
    for (const raw of bad) {
      const c = parseHeartbeatConfig({ JARVIS_BACKUP_HEARTBEAT_URL: raw });
      expect(c, raw.slice(0, 30)).toMatchObject({ configured: true, invalid: true });
      expect(c.reason).not.toContain(KEY); // feilmeldingen siterer aldri URL-en (nøkkelen står i stien)
    }
    expect(() => assertHeartbeatUrl("http://hc.example/x", "L")).toThrow(HeartbeatConfigError);
    expect(() => assertHeartbeatUrl("http://127.0.0.1:8080/x", "L")).not.toThrow(); // loopback er tillatt (test/lokal proxy)
    expect(() => assertHeartbeatUrl("http://localhost/x", "L")).not.toThrow();
  });

  it("ugyldig tidsavbrudd er en tydelig konfig-feil (siterer ikke verdien)", () => {
    const c = parseHeartbeatConfig({ JARVIS_BACKUP_HEARTBEAT_URL: `https://hc.example/${KEY}`, JARVIS_BACKUP_HEARTBEAT_TIMEOUT_SEC: "0" });
    expect(c).toMatchObject({ configured: true, invalid: true });
  });
});

describe("WP-C2 heartbeat: ping mot lokal server - kun GET, kun status, aldri innhold", () => {
  it("GET uten kropp, riktig sti og query; ingen hemmeligheter i headere; svar 2xx = ok", async () => {
    const srv = await startServer();
    try {
      const r = await sendPing(srv.url(`/ping/${KEY}?rid=abc`), { timeoutMs: 2000 });
      expect(r).toEqual({ ok: true, status: 200, reason: null });
      expect(srv.requests).toHaveLength(1);
      const req = srv.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(`/ping/${KEY}?rid=abc`);
      expect(req.body).toBe("");
      expect(Object.keys(req.headers).sort()).not.toContain("authorization");
      expect(JSON.stringify(req.headers)).not.toMatch(/password|secret|JARVIS_|Bearer/i);
    } finally {
      await srv.close();
    }
  });

  it("non-2xx er feil (reason http_NNN), og en redirect følges ALDRI (ingen pivot til et annet mål)", async () => {
    const target = await startServer();
    const srv = await startServer((req, res) => {
      if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("location", target.url("/hit")); res.end(); } else { res.statusCode = 503; res.end("nede"); }
    });
    try {
      expect(await sendPing(srv.url("/x"), { timeoutMs: 2000 })).toMatchObject({ ok: false, status: 503, reason: "http_503" });
      expect(await sendPing(srv.url("/redirect"), { timeoutMs: 2000 })).toMatchObject({ ok: false, status: 302, reason: "http_302" });
      expect(target.requests).toHaveLength(0);
    } finally {
      await srv.close();
      await target.close();
    }
  });

  it("kort tidsavbrudd: en server som aldri svarer gir `timeout` raskt, og kaster aldri", async () => {
    const srv = await startServer(() => undefined); // svarer aldri
    try {
      const t0 = Date.now();
      const r = await sendPing(srv.url("/slow"), { timeoutMs: 300 });
      expect(r).toMatchObject({ ok: false, reason: "timeout" });
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      await srv.close();
    }
  });

  it("nettverksfeil (lukket port) gir `network`, og kaster aldri", async () => {
    const srv = await startServer();
    const url = srv.url("/gone");
    await srv.close();
    expect(await sendPing(url, { timeoutMs: 1000 })).toMatchObject({ ok: false, reason: "network" });
  });

  it("klient: start → suksess/fail treffer riktige URL-er i riktig rekkefølge, og `last()` har kun status/tidspunkt/feilkode", async () => {
    const srv = await startServer();
    try {
      const config = parseHeartbeatConfig({ JARVIS_BACKUP_HEARTBEAT_URL: srv.url(`/${KEY}`) });
      const logs = [];
      const hb = createHeartbeat(config, { now: () => new Date("2026-10-09T02:00:00.000Z"), log: (l, e, f) => logs.push([l, e, f]) });
      expect(hb.configured).toBe(true);
      await hb.start();
      await hb.success();
      await hb.fail();
      expect(srv.requests.map((r) => r.url)).toEqual([`/${KEY}/start`, `/${KEY}`, `/${KEY}/fail`]);
      expect(hb.last()).toEqual({ last_ping_at: "2026-10-09T02:00:00.000Z", last_ping_kind: "fail", last_ping_ok: true, last_error_code: null });
      expect(logs).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("en feilende heartbeat feiler ALDRI backupen: resultatet er ok:false + kode, og URL-en står ikke i loggen", async () => {
    const srv = await startServer();
    const config = parseHeartbeatConfig({ JARVIS_BACKUP_HEARTBEAT_URL: srv.url(`/${KEY}`), JARVIS_BACKUP_HEARTBEAT_TIMEOUT_SEC: "1" });
    await srv.close(); // ingen lytter
    const logs = [];
    const hb = createHeartbeat(config, { log: (l, e, f) => logs.push({ l, e, f }) });
    await expect(hb.success()).resolves.toMatchObject({ ok: false });
    expect(hb.last()).toMatchObject({ last_ping_kind: "success", last_ping_ok: false, last_error_code: "heartbeat_failed" });
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(logs[0]).toMatchObject({ l: "warn", e: "heartbeat_ping_failed" });
  });

  it("uten konfig: alt er no-op (skipped), ingenting sendes; ugyldig konfig: logges høyt, sender ingenting, feiler ikke", async () => {
    const off = createHeartbeat({ configured: false });
    expect(off.configured).toBe(false);
    expect(await off.success()).toMatchObject({ skipped: true });
    expect(off.last().last_ping_at).toBeNull();

    const logs = [];
    const invalid = createHeartbeat(parseHeartbeatConfig({ JARVIS_BACKUP_HEARTBEAT_URL: "http://hc.example/x" }), { log: (l, e) => logs.push([l, e]) });
    expect(await invalid.start()).toMatchObject({ ok: false, reason: "config_invalid" });
    expect(logs).toEqual([["error", "heartbeat_config_invalid"]]);
    expect(invalid.last()).toMatchObject({ last_ping_ok: false, last_error_code: "heartbeat_failed" });
  });
});
