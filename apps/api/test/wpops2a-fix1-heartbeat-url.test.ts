import { describe, expect, it } from "vitest";
import { assertSafeVendorUrl } from "@jarvis/tool-gateway";
import { HeartbeatConfigError, startUptimeHeartbeat, uptimeHeartbeatConfigFromEnv, validateHeartbeatUrl } from "../src/heartbeat-sender.ts";
import { WATCHDOG_HEARTBEAT_URL_ENV, startWatchdogHeartbeat, watchdogHeartbeatConfigFromEnv } from "../src/watchdog-heartbeat.ts";

/**
 * WP-OPS2a fiks-runde 1 (review A-L6, A-L7 og testhull S13): `validateHeartbeatUrl` (delt av API-ets oppetids-heartbeat og vakthundens dead man's switch) og `guardedFetch` (utsendingen) var uenige for https: en URL kunne godtas ved
 * oppstart, `_started` ble logget, og HVER ping feilet stille som `network` fordi `guardedFetch` avviste den. Nå kaller validatoren `assertSafeVendorUrl(url.toString())` - samme vern som utsendingen - og kaster `HeartbeatConfigError` uten URL i meldingen.
 * A-L7: https mot loopback, privat, link-local eller uspesifisert IP-literal (og `localhost`) avvises; http er fortsatt kun tillatt mot loopback (test/lokal proxy).
 * Alle URL-er bygges sammensatt her (`.example`-verter og lagde markører): ingen ekte-lignende nøkler eller verter.
 */
const SECRET = ["zq", "url", "marker"].join("-"); // lagd markør som står i stien (stien er en kapabilitet og skal aldri siteres)
const reject = (raw: string): HeartbeatConfigError => {
  try { validateHeartbeatUrl(raw); } catch (err) { expect(err, raw).toBeInstanceOf(HeartbeatConfigError); return err as HeartbeatConfigError; }
  throw new Error(`forventet avvisning, men URL-en ble godtatt: ${raw.slice(0, 40)}`);
};

describe("A-L6: validering og utsending er enige for https", () => {
  const MISMATCH = [
    `https://[fd00:ec2::254]/${SECRET}`, `https://[::1]/${SECRET}`, `https://[::ffff:169.254.169.254]/${SECRET}`, `https://hc_ex.example/${SECRET}`, `https://[2001:db8::1]/${SECRET}`
  ];

  it("URL-er som guardedFetch alltid ville avvist (IPv6-literal, understrek i vert) avvises allerede ved konfig - med variabelnavn, uten URL, sti eller vert i meldingen", () => {
    for (const raw of MISMATCH) {
      const err = reject(raw);
      expect(err.message, raw).toContain("JARVIS_UPTIME_HEARTBEAT_URL");
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain("hc_ex");
      expect(err.message).not.toContain("::");
      expect(err.message).not.toContain("https://");
    }
  });

  it("det delte vernet gjelder begge heartbeatene: variabelnavnet i meldingen følger kalleren (vakthund vs API), og konfig-funksjonene gir HeartbeatConfigError", () => {
    for (const raw of MISMATCH) {
      expect(() => uptimeHeartbeatConfigFromEnv({ JARVIS_UPTIME_HEARTBEAT_URL: raw }), raw).toThrow(HeartbeatConfigError);
      expect(() => watchdogHeartbeatConfigFromEnv({ [WATCHDOG_HEARTBEAT_URL_ENV]: raw }), raw).toThrow(HeartbeatConfigError);
      try { watchdogHeartbeatConfigFromEnv({ [WATCHDOG_HEARTBEAT_URL_ENV]: raw }); } catch (err) {
        expect((err as Error).message).toContain(WATCHDOG_HEARTBEAT_URL_ENV);
        expect((err as Error).message).not.toContain("UPTIME");
        expect((err as Error).message).not.toContain(SECRET);
      }
    }
  });

  it("oppstart: en slik URL starter IKKE heartbeaten (ingen `_started`, ingen timer, ingen ping som feiler stille) og logger `config_invalid` uten URL", () => {
    for (const raw of MISMATCH) {
      const events: Array<Record<string, unknown>> = [];
      const watchdog = startWatchdogHeartbeat({ env: { [WATCHDOG_HEARTBEAT_URL_ENV]: raw }, watchdog: { lastCompletedTickAgeMs: () => 0 }, watchdogIntervalMs: 60_000, dbPing: async () => undefined, log: (e) => events.push(e) });
      expect(watchdog, raw).toBeNull();
      expect(events.map((e) => e["msg"])).toEqual(["watchdog_heartbeat_config_invalid"]);
      expect(JSON.stringify(events)).not.toContain(SECRET);
      const apiEvents: Array<Record<string, unknown>> = [];
      expect(startUptimeHeartbeat({ port: 3010, env: { JARVIS_UPTIME_HEARTBEAT_URL: raw }, log: (e) => apiEvents.push(e) })).toBeNull();
      expect(apiEvents.map((e) => e["msg"])).toEqual(["uptime_heartbeat_config_invalid"]);
      expect(JSON.stringify(apiEvents)).not.toContain(SECRET);
    }
  });

  it("egenskap: ALT validatoren godtar er sendbart - assertSafeVendorUrl (guardedFetchs første steg) kaster aldri for den normaliserte URL-en som faktisk sendes", () => {
    const hosts = ["hc.example", "HC.EXAMPLE", "hc.example:443", "hc.example:8443", "a-b.hc.example", "xn--hc-ping.example", "2852039166", "0xa9fea9fe", "[::1]", "[fd00::1]", "[::ffff:a9fe:a9fe]", "hc_ex.example", "hc.example.", "127.0.0.1", "localhost", "127.1", "0177.0.0.1"];
    const paths = ["", "/", `/${SECRET}`, `/${SECRET}?a=b`, `/a/../${SECRET}`, `/a/%2e%2e/${SECRET}`, `/${SECRET}/.`, `/${SECRET}%0d%0aX:1`, `/${SECRET}?q=%0d%0a`, `/${SECRET}?x=${"a".repeat(100)}`, `/a%2fb/${SECRET}`, `/${SECRET}/..%2fx`];
    let accepted = 0;
    for (const scheme of ["https", "http", "HTTPS", "HTTP"]) {
      for (const host of hosts) {
        for (const path of paths) {
          const raw = `${scheme}://${host}${path}`;
          let normalized: string | null = null;
          try { normalized = validateHeartbeatUrl(raw).toString(); } catch { /* avvist: i orden */ }
          if (normalized === null) continue;
          accepted += 1;
          expect(() => assertSafeVendorUrl(normalized!), `${raw} -> ${normalized}`).not.toThrow();
        }
      }
    }
    expect(accepted).toBeGreaterThan(10); // egenskapen er ikke vakuøs
  });

  it("godtatte URL-er gir uendret oppførsel: normalisert streng og opprinnelse som før (wpc2-kontrakten)", () => {
    expect(uptimeHeartbeatConfigFromEnv({ JARVIS_UPTIME_HEARTBEAT_URL: `https://HC.EXAMPLE:443/${SECRET}?x=1` })).toEqual({ url: `https://hc.example/${SECRET}?x=1`, intervalSec: 60, origin: "https://hc.example" });
    expect(watchdogHeartbeatConfigFromEnv({ [WATCHDOG_HEARTBEAT_URL_ENV]: `https://hc.example:8443/${SECRET}` })).toEqual({ url: `https://hc.example:8443/${SECRET}`, intervalSec: 60, origin: "https://hc.example:8443" });
    expect(validateHeartbeatUrl(`http://127.0.0.1:8080/${SECRET}`).toString()).toBe(`http://127.0.0.1:8080/${SECRET}`);
    expect(validateHeartbeatUrl(`http://localhost/${SECRET}`).toString()).toBe(`http://localhost/${SECRET}`);
  });
});

describe("A-L7: https mot loopback, privat, link-local og uspesifisert adresse avvises", () => {
  it("IP-literaler i alle former parseren normaliserer (punktum, desimal, hex, oktal, forkortet) avvises for https - loopback, privat, link-local, 0/8", () => {
    const blocked = [
      "127.0.0.1", "127.1", "127.255.255.254", "2130706433", "0x7f000001", "0177.0.0.1", "10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.168.255.255",
      "169.254.169.254", "169.254.0.1", "2852039166", "0xa9fea9fe", "0251.0376.0251.0376", "0.0.0.0", "0", "0.1.2.3"
    ];
    for (const host of blocked) {
      const err = reject(`https://${host}/${SECRET}`);
      expect(err.message, host).toContain("JARVIS_UPTIME_HEARTBEAT_URL");
      expect(err.message).not.toContain(SECRET);
      if (host.length > 3) expect(err.message).not.toContain(host);
      reject(`HTTPS://${host}:8443/${SECRET}?x=1`);
    }
  });

  it("grensene er nøyaktige: tilgrensende offentlige adresser godtas (172.15/172.32, 192.167/192.169, 169.253/169.255, 126/128, 11, 9)", () => {
    for (const host of ["172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "169.253.255.255", "169.255.0.0", "126.255.255.255", "128.0.0.1", "11.0.0.1", "9.255.255.255", "8.8.8.8", "100.64.0.1"]) {
      expect(() => validateHeartbeatUrl(`https://${host}/${SECRET}`), host).not.toThrow();
    }
  });

  it("localhost-navn avvises for https (localhost, *.localhost, store bokstaver, avsluttende punktum) og metadata.google.internal; vanlige og lignende navn godtas", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "a.b.localhost.", "metadata.google.internal", "METADATA.GOOGLE.INTERNAL"]) {
      const err = reject(`https://${host}/${SECRET}`);
      expect(err.message, host).not.toContain(SECRET);
    }
    for (const host of ["hc.example", "localhost.example", "mylocalhost.example", "notlocalhost", "metadata.google.internal.example", "metadata.example", "monitor.lan"]) {
      expect(() => validateHeartbeatUrl(`https://${host}/${SECRET}`), host).not.toThrow();
    }
  });

  it("http er fortsatt KUN tillatt mot loopback (127.0.0.1 og localhost, også i normalisert form) - ingenting nytt åpnes", () => {
    for (const ok of ["http://127.0.0.1:1/x", "http://localhost:1/x", "http://LOCALHOST:1/x", "http://127.1:1/x", "http://2130706433:1/x", "http://0x7f000001:1/x", "http://0177.0.0.1:1/x", "http://127.0.0.1.:1/x"]) {
      expect(() => validateHeartbeatUrl(ok), ok).not.toThrow();
    }
    for (const bad of ["http://hc.example/x", "http://10.0.0.5/x", "http://192.168.1.1/x", "http://169.254.169.254/x"]) reject(bad);
  });
});

describe("S13 (testhull fra mutant): http mot noe annet enn 127.0.0.1/localhost avvises, også 0.0.0.0 og IPv6-loopback", () => {
  it("0.0.0.0, 0, 127.0.0.2, localhost., [::1], [::ffff:127.0.0.1], nip.io-varianter og @-triks avvises for http", () => {
    for (const bad of [
      `http://0.0.0.0:1/${SECRET}`, `http://0:1/${SECRET}`, `http://127.0.0.2:1/${SECRET}`, `http://localhost.:1/${SECRET}`, `http://[::1]:1/${SECRET}`, `http://[::ffff:127.0.0.1]:1/${SECRET}`,
      `http://[0:0:0:0:0:ffff:7f00:1]:1/${SECRET}`, `http://127.0.0.1.nip.io:1/${SECRET}`, `http://localhost%2f@evil.example/${SECRET}`, `http://hc.example%40evil.example/${SECRET}`
    ]) {
      const err = reject(bad);
      expect(err.message, bad).not.toContain(SECRET);
    }
  });
});
