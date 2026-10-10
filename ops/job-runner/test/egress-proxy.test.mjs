import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EgressProxy, isPublicAddress, parseConnectTarget } from "../egress-proxy.mjs";

/**
 * WP-C1 (D-32 port 9): egress-proxyen er CONNECT-only med eksakt vert:port-allowlist og SSRF-/DNS-rebinding-vern. Testes mot
 * lokale servere og injiserte resolve/connect (proxyen NEKTER loopback, så en suksess-tunnel må omdirigeres til en lokal ekkoserver).
 */

const LOOPBACK_CLIENTS = [{ network: "127.0.0.0", prefix: 8 }];
const ALLOW = ["github.com:443", "api.github.com:443", "api.anthropic.com:443"];

let echo; let echoPort; let proxy; let proxyPort; let events; let dials; let resolveCalls;
const cleanup = [];

beforeEach(async () => {
  echo = net.createServer((socket) => { socket.on("data", (d) => socket.write(d)); socket.on("error", () => undefined); });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = echo.address().port;
  events = []; dials = []; resolveCalls = [];
});
afterEach(async () => {
  for (const s of cleanup.splice(0)) s.destroy();
  await proxy?.stop();
  await new Promise((r) => echo.close(r));
});

async function startProxy(options = {}) {
  proxy = new EgressProxy({
    allow: ALLOW, allowedClientCidrs: LOOPBACK_CLIENTS,
    resolve: async (host) => { resolveCalls.push(host); return ["140.82.112.3"]; },
    connect: (ip, port) => { dials.push({ ip, port }); return net.connect(echoPort, "127.0.0.1"); }, // «internett» = lokal ekkoserver
    onEvent: (e) => events.push(e),
    ...options
  });
  proxyPort = (await proxy.start(0, "127.0.0.1")).port;
  return proxy;
}

/** Sender en rå forespørsel til proxyen; returnerer statuslinje + resten. */
function rawRequest(text, { keepOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    cleanup.push(socket);
    let buf = "";
    const done = () => { if (!keepOpen) resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), text: buf, socket }); };
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      if (keepOpen && buf.includes("\r\n\r\n")) resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), text: buf, socket });
    });
    socket.on("end", done);
    socket.on("close", done);
    socket.on("error", reject);
    socket.write(text);
  });
}
const connectReq = (authority, extra = "") => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${extra}\r\n`;

describe("A: gyldig tunnel", () => {
  it("CONNECT til allowlistet vert:port -> 200, data flyter begge veier, og proxyen kobler til den VALIDERTE IP-en", async () => {
    await startProxy();
    const r = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    expect(r.status).toBe(200);
    const got = await new Promise((resolve) => { r.socket.once("data", (d) => resolve(d.toString())); r.socket.write("hei-fra-klient"); });
    expect(got).toBe("hei-fra-klient");
    expect(dials).toEqual([{ ip: "140.82.112.3", port: 443 }]);
    expect(resolveCalls).toEqual(["github.com"]);
    expect(events.find((e) => e.event === "connect_allowed")).toMatchObject({ host: "github.com", port: 443 });
  });

  it("bytes sendt rett etter CONNECT-headerne (TLS ClientHello i samme pakke) videresendes", async () => {
    await startProxy();
    const r = await rawRequest(`${connectReq("api.anthropic.com:443")}HELLO`, { keepOpen: true });
    expect(r.status).toBe(200);
    const echoed = r.text.endsWith("HELLO") ? "HELLO" : await new Promise((resolve) => r.socket.once("data", (d) => resolve(d.toString())));
    expect(echoed).toContain("HELLO");
  });

  it("normaliserer store bokstaver og avsluttende punktum i verten (samme vert)", async () => {
    await startProxy();
    expect((await rawRequest(connectReq("GitHub.COM:443"), { keepOpen: true })).status).toBe(200);
    expect((await rawRequest(connectReq("github.com.:443"), { keepOpen: true })).status).toBe(200);
  });
});

describe("B: allowlisten er eksakt vert:port", () => {
  it("annen vert, annen port, subdomene, domene-suffiks-triks nektes (403) uten oppslag eller tilkobling", async () => {
    await startProxy();
    for (const target of ["example.com:443", "github.com:80", "github.com:22", "github.com:8443", "evil.github.com:443", "github.com.evil.com:443", "xgithub.com:443", "api.github.com:80", "anthropic.com:443", "statsig.anthropic.com:443", "localhost:443", "metadata.google.internal:80", "github.com:4430"]) {
      const r = await rawRequest(connectReq(target));
      expect(r.status, target).toBe(403);
    }
    expect(dials).toEqual([]);
    expect(resolveCalls).toEqual([]);
    expect(events.filter((e) => e.reason === "not_allowlisted")).toHaveLength(13);
  });

  it("IP-literaler og IPv6-former er aldri gyldige mål (400), uansett om de er private eller offentlige", async () => {
    await startProxy();
    for (const target of ["127.0.0.1:443", "10.0.0.5:443", "169.254.169.254:80", "192.168.1.1:443", "140.82.112.3:443", "1.1.1.1:443", "[::1]:443", "[2606:4700::1111]:443", "::1:443", "0x7f.1:443", "2130706433:443", "0177.0.0.1:443"]) {
      const r = await rawRequest(connectReq(target));
      expect([400, 403], target).toContain(r.status);
      expect(r.status === 200).toBe(false);
    }
    expect(dials).toEqual([]);
  });

  it("feilformede mål: brukerinfo, sti, uten port, port 0/65536, tomt, for langt, mellomrom, kontrolltegn", async () => {
    await startProxy();
    for (const target of ["user@github.com:443", "github.com:443/path", "github.com", "github.com:0", "github.com:65536", ":443", `${"a".repeat(300)}.com:443`, "git hub.com:443", "github.com:443\u0000", "-github.com:443", "github..com:443", "github.com:44 3"]) {
      const r = await rawRequest(`CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`).catch(() => ({ status: 0 }));
      // 400/403 fra proxyen, eller 0 = forbindelsen ble lukket uten svar (feilformet forespørselslinje avvist av HTTP-parseren)
      expect([0, 400, 403], JSON.stringify(target)).toContain(r.status);
    }
    expect(dials).toEqual([]);
  });
});

describe("C: SSRF og DNS-rebinding - proxyen slår opp selv og kobler til den validerte IP-en", () => {
  const privateAnswers = [
    ["loopback", ["127.0.0.1"]], ["rfc1918-10", ["10.0.0.5"]], ["rfc1918-172", ["172.16.5.5"]], ["rfc1918-192", ["192.168.1.10"]],
    ["link-local/metadata", ["169.254.169.254"]], ["cgnat/tailscale", ["100.64.1.1"]], ["unspecified", ["0.0.0.0"]], ["multicast", ["224.0.0.1"]],
    ["ipv6-loopback", ["::1"]], ["ipv6-ula", ["fc00::1"]], ["ipv6-linklocal", ["fe80::1"]], ["ipv4-mapped", ["::ffff:127.0.0.1"]],
    ["ipv4-mapped-hex", ["::ffff:7f00:1"]], ["6to4", ["2002:7f00:1::"]], ["nat64", ["64:ff9b::127.0.0.1"]], ["blandet svar (offentlig + privat)", ["140.82.112.3", "10.0.0.1"]],
    ["blandet svar omvendt", ["10.0.0.1", "140.82.112.3"]], ["ugyldig adresse", ["ikke-en-ip"]], ["docs-prefiks", ["192.0.2.1"]]
  ];
  for (const [name, answers] of privateAnswers) {
    it(`allowlistet vert som løses til ${name} nektes (403) og det kobles aldri til`, async () => {
      await startProxy({ resolve: async () => answers });
      const r = await rawRequest(connectReq("github.com:443"));
      expect(r.status).toBe(403);
      expect(dials).toEqual([]);
      expect(events.at(-1)).toMatchObject({ event: "connect_denied", reason: "resolves_to_private_address", host: "github.com", port: 443 });
    });
  }

  it("rebinding: første svar offentlig, påfølgende private - tilkoblingen går til den FØRSTE, validerte IP-en (ett oppslag per CONNECT)", async () => {
    let n = 0;
    await startProxy({ resolve: async () => { n += 1; return n === 1 ? ["140.82.112.3"] : ["127.0.0.1"]; } });
    const first = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    expect(first.status).toBe(200);
    expect(dials).toEqual([{ ip: "140.82.112.3", port: 443 }]);
    expect(n).toBe(1); // aldri et nytt oppslag mellom sjekk og tilkobling
    const second = await rawRequest(connectReq("github.com:443"));
    expect(second.status).toBe(403); // nå svarer DNS privat -> nektet
    expect(dials).toHaveLength(1);
  });

  it("offentlige IPv4 og IPv6-adresser slippes gjennom", async () => {
    await startProxy({ resolve: async () => ["2606:4700::1111", "140.82.112.3"] });
    const r = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    expect(r.status).toBe(200);
    expect(dials[0].ip).toBe("2606:4700::1111");
  });

  it("DNS-feil/tomt svar nektes (403), og en oppstrøms som ikke svarer gir 502", async () => {
    await startProxy({ resolve: async () => { throw new Error("SERVFAIL"); } });
    expect((await rawRequest(connectReq("github.com:443"))).status).toBe(403);
    await proxy.stop();
    await startProxy({ resolve: async () => [] });
    expect((await rawRequest(connectReq("github.com:443"))).status).toBe(403);
    await proxy.stop();
    await startProxy({ connect: () => net.connect(1, "127.0.0.1") }); // port 1 avviser
    expect((await rawRequest(connectReq("github.com:443"))).status).toBe(502);
  });

  it("isPublicAddress: tabell", () => {
    for (const ip of ["140.82.112.3", "8.8.8.8", "1.1.1.1", "2606:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ["127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "255.255.255.255", "224.0.0.1", "240.0.0.1", "198.18.0.1", "::", "::1", "fc00::", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2002:0a00:0001::", "64:ff9b::10.0.0.1", "not-an-ip", "", "999.1.1.1", "1.2.3",
      // utfasede/lokale IPv6-områder som ellers kunne nådd interne mål: IPv4-kompatible (::a.b.c.d), site-local, lokal NAT64
      "::7f00:1", "::a00:1", "::a9fe:a9fe", "fec0::1", "feff::1", "64:ff9b:1::1", "64:ff9b:1:ffff::1", "::ffff:0:0", "::ffff:a9fe:a9fe"]) expect(isPublicAddress(ip), ip).toBe(false);
    // og en ekte offentlig IPv6-adresse blir ikke fanget av de nye områdene
    for (const ip of ["2606:50c0:8000::154", "2a01:4f8:c17:1::1", "2001:4860:4860::8888"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("innebygd IPv4 i ALLE skrivemåter (byte-basert): NAT64/SIIT/mappet/6to4 i hex, full form, store bokstaver, ledende nuller og punktdesimal gir samme svar som IPv4-adressen", () => {
    // Node og de fleste resolvere skriver slike adresser i HEX (64:ff9b::7f00:1), ikke punktdesimal - en tekst-regex for punktdesimal slapp hex-formen gjennom
    const embedded = {
      "7f00:1": "127.0.0.1", "a00:1": "10.0.0.1", "c0a8:101": "192.168.1.1", "a9fe:a9fe": "169.254.169.254", "ac10:1": "172.16.0.1", "6440:1": "100.64.0.1", "0:0": "0.0.0.0", "8c52:7003": "140.82.112.3", "808:808": "8.8.8.8"
    };
    for (const [hex, dotted] of Object.entries(embedded)) {
      const expected = isPublicAddress(dotted);
      const forms = [
        `64:ff9b::${hex}`, `0064:ff9b:0000:0000:0000:0000:${hex.replace(/^([0-9a-f]+):([0-9a-f]+)$/, (_, a, b) => `${a.padStart(4, "0")}:${b.padStart(4, "0")}`)}`, `64:FF9B::${hex.toUpperCase()}`, `64:ff9b::${dotted}`, `64:ff9b:0:0:0:0:${dotted}`,
        `::ffff:${hex}`, `::FFFF:${hex}`, `0:0:0:0:0:ffff:${hex}`, `0000:0000:0000:0000:0000:ffff:${hex.replace(/^([0-9a-f]+):([0-9a-f]+)$/, (_, a, b) => `${a.padStart(4, "0")}:${b.padStart(4, "0")}`)}`, `::ffff:${dotted}`,
        `::ffff:0:${hex}`, `::ffff:0:${dotted}`, `0:0:0:0:ffff:0:${hex}`
      ];
      for (const ip of forms) expect(isPublicAddress(ip), `${ip} (${dotted})`).toBe(expected);
    }
    // 6to4 (2002:AABB:CCDD::) bærer IPv4-adressen i biter 16-47
    expect(isPublicAddress("2002:7f00:1::")).toBe(false);
    expect(isPublicAddress("2002:a9fe:a9fe::1")).toBe(false);
    expect(isPublicAddress("2002:8c52:7003::1")).toBe(true);
    // ikke-offentlige områder som ellers ligner offentlige: IETF-protokolltildelingen, dokumentasjon, SRv6
    for (const ip of ["2001::1", "2001:1::1", "2001:2::1", "2001:3::1", "2001:10::1", "2001:20::1", "2001:1ff::1", "3fff::1", "3fff:fff::1", "5f00::1", "5f00:1::1", "::ffff:0:0", "2001:db8:1::1"]) expect(isPublicAddress(ip), ip).toBe(false);
    // og områdene rett utenfor er fortsatt offentlige (GitHub, Cloudflare, Google ligger her)
    for (const ip of ["2001:200::1", "2001:4860:4860::8888", "2606:50c0:8000::154", "2606:4700::6810:84e5", "2600::1", "2a00:1450:4001:80b::200e", "4000::1"]) expect(isPublicAddress(ip), ip).toBe(true);
    // uparsbart er aldri offentlig, uansett hva isIP mener om sone-id
    for (const ip of ["fe80::1%eth0", "::1%lo", "1:2:3:4:5:6:7:8:9", ":::", "1::2::3", "g::1", 1, null, undefined, {}]) expect(isPublicAddress(ip), String(ip)).toBe(false);
  });
});

describe("D: ingen vanlig HTTP-videresending - alt som ikke er CONNECT avvises", () => {
  it("GET/POST/PUT/DELETE/TRACE/OPTIONS (absolutt URI og origin-form) gir 405 med Allow: CONNECT; ingen oppslag eller tilkobling", async () => {
    await startProxy();
    for (const method of ["GET", "POST", "PUT", "DELETE", "TRACE", "OPTIONS", "HEAD", "PATCH"]) {
      for (const target of ["http://github.com/", "http://127.0.0.1:80/", "/", "http://169.254.169.254/latest/meta-data/"]) {
        const r = await rawRequest(`${method} ${target} HTTP/1.1\r\nHost: github.com\r\nContent-Length: 0\r\n\r\n`);
        expect(r.status, `${method} ${target}`).toBe(405);
        expect(r.text.toLowerCase()).toContain("allow: connect");
      }
    }
    expect(dials).toEqual([]);
    expect(resolveCalls).toEqual([]);
  });
});

describe("E: klient-CIDR og grenser", () => {
  it("klient utenfor jobbnettets CIDR nektes (403) før noe annet skjer", async () => {
    await startProxy({ allowedClientCidrs: [{ network: "172.30.77.0", prefix: 24 }] });
    const r = await rawRequest(connectReq("github.com:443"));
    expect(r.status).toBe(403);
    expect(events.at(-1)).toMatchObject({ reason: "client_not_allowed" });
    expect(resolveCalls).toEqual([]);
  });

  it("maks samtidige tilkoblinger (global og per klient) gir 503; plass frigjøres når en tunnel lukkes", async () => {
    await startProxy({ maxConnections: 2, maxConnectionsPerClient: 5 });
    const a = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    const b = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await rawRequest(connectReq("github.com:443"))).status).toBe(503);
    a.socket.destroy();
    await new Promise((r) => setTimeout(r, 150));
    expect((await rawRequest(connectReq("github.com:443"), { keepOpen: true })).status).toBe(200);
    await proxy.stop();
    await startProxy({ maxConnections: 10, maxConnectionsPerClient: 1 });
    expect((await rawRequest(connectReq("github.com:443"), { keepOpen: true })).status).toBe(200);
    expect((await rawRequest(connectReq("github.com:443"))).status).toBe(503);
  });

  it("idle-tidsavbrudd og maks tunnel-levetid river tunnelen", async () => {
    await startProxy({ idleTimeoutMs: 250 });
    const idle = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    const closedIdle = await new Promise((resolve) => { idle.socket.on("close", () => resolve(true)); setTimeout(() => resolve(false), 3_000); });
    expect(closedIdle).toBe(true);
    await proxy.stop();
    await startProxy({ idleTimeoutMs: 60_000, maxTunnelMs: 300 });
    const live = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    const keepAlive = setInterval(() => live.socket.write("x"), 50);
    const closedLife = await new Promise((resolve) => { live.socket.on("close", () => resolve(true)); setTimeout(() => resolve(false), 3_000); });
    clearInterval(keepAlive);
    expect(closedLife).toBe(true);
  });

  it("tilkobling som aldri etableres gir 502 etter connect-tidsavbruddet", async () => {
    await startProxy({ connectTimeoutMs: 300, connect: () => new net.Socket() }); // aldri connect()
    const t0 = Date.now();
    const r = await rawRequest(connectReq("github.com:443"));
    expect(r.status).toBe(502);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("start() nekter jokertegn-adresse og vertsnavn", async () => {
    const p = new EgressProxy({ allow: ALLOW, allowedClientCidrs: LOOPBACK_CLIENTS });
    for (const host of ["0.0.0.0", "::", "localhost", "", "::1"]) await expect(p.start(0, host), host).rejects.toThrow("egress_proxy_requires_specific_ipv4_listen_address");
  });
});

describe("H: klient som forsvinner midt i oppslag/oppkobling lekker ingen upstream-sockets (B-M1)", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Hver upstream-socket proxyen noen gang åpner, så testen kan telle hvilke som fortsatt lever. */
  let upstreams;
  beforeEach(() => { upstreams = []; });
  const openUpstreams = () => upstreams.filter((u) => !u.destroyed).length;
  const tracked = () => { const u = net.connect(echoPort, "127.0.0.1"); upstreams.push(u); return u; };

  /** Rå forbindelse som sender CONNECT og deretter RST etter `rstAfterMs` (en jobb som dør/avbryter midt i oppslaget). */
  const connectThenReset = (rstAfterMs) => new Promise((resolve) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    cleanup.push(socket);
    socket.on("error", () => undefined);
    socket.on("close", resolve);
    socket.on("connect", () => { socket.write(connectReq("github.com:443")); setTimeout(() => socket.resetAndDestroy(), rstAfterMs); });
  });

  it("RST mens proxyen slår opp DNS (reviewerens repro: 40 forsøk) -> ingen åpne upstream-sockets, og slot-regnskapet er tomt", async () => {
    await startProxy({ resolve: async () => { await sleep(150); return ["140.82.112.3"]; }, connect: tracked, maxConnections: 8, maxConnectionsPerClient: 4, idleTimeoutMs: 60_000 });
    for (let i = 0; i < 40; i += 1) await connectThenReset(30);
    await sleep(600);
    expect(openUpstreams()).toBe(0); // før: 40 åpne sockets (idle-timeout 120 s) mens active=0 - maxConnections omgått
    expect(proxy.active).toBe(0);
    expect(proxy.perClient.size).toBe(0);
    expect(events.some((e) => e.event === "connect_allowed")).toBe(false);
  }, 30_000);

  it("RST mens proxyen kobler til upstream (oppkoblingen tar 150 ms) -> den halvåpne oppkoblingen rives med en gang; ingenting henger igjen", async () => {
    // Oppkoblingen starter først etter 150 ms (som en treg handshake); er klienten borte da, skal den aldri bli en tunnel.
    const slow = () => {
      const u = new net.Socket();
      upstreams.push(u);
      setTimeout(() => { if (!u.destroyed) u.connect(echoPort, "127.0.0.1"); }, 150);
      return u;
    };
    await startProxy({ connect: slow, maxConnections: 8, maxConnectionsPerClient: 4, idleTimeoutMs: 60_000 });
    await connectThenReset(40); // klienten er borte etter ca. 40 ms; oppkoblingen ville først startet etter 150 ms
    await sleep(30);
    expect(upstreams.at(-1)?.destroyed).toBe(true); // revet MED EN GANG (avbrutt), ikke først når oppkoblingen er ferdig og vi oppdager at klienten er borte
    for (let i = 0; i < 20; i += 1) await connectThenReset(40);
    await sleep(600);
    expect(upstreams.length).toBeGreaterThan(0);
    expect(openUpstreams()).toBe(0);
    expect(proxy.active).toBe(0);
    expect(proxy.perClient.size).toBe(0);
  }, 30_000);

  it("klienten forsvinner i SAMME øyeblikk som oppkoblingen lykkes (close er ikke levert ennå): upstream rives og plassen frigis", async () => {
    let dial;
    await startProxy({ connect: () => { dial = new net.Socket(); upstreams.push(dial); return dial; }, connectTimeoutMs: 5_000, idleTimeoutMs: 60_000 });
    const client = net.connect(proxyPort, "127.0.0.1");
    cleanup.push(client);
    client.on("error", () => undefined);
    client.on("connect", () => client.write(connectReq("github.com:443")));
    for (let i = 0; i < 100 && dial === undefined; i += 1) await sleep(10);
    expect(dial).toBeDefined();
    // synkront i ett tikk: serversiden av klienten ødelegges (destroyed=true; close kommer først i neste tikk) og oppkoblingen «lykkes»
    for (const server of proxy.sockets) server.destroy();
    dial.emit("connect");
    await sleep(300);
    expect(dial.destroyed).toBe(true);
    expect(proxy.active).toBe(0);
    expect(events.some((e) => e.event === "connect_aborted" && e.reason === "client_gone")).toBe(true);
    expect(events.some((e) => e.event === "connect_allowed")).toBe(false); // aldri en tunnel, aldri et 200-svar til en klient som er borte
  });

  it("klienten forsvinner ETTER at tunnelen er etablert: upstream rives umiddelbart (ikke ved idle-tidsavbruddet)", async () => {
    await startProxy({ connect: tracked, idleTimeoutMs: 60_000 });
    const r = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    expect(r.status).toBe(200);
    expect(openUpstreams()).toBe(1);
    r.socket.resetAndDestroy();
    await sleep(300);
    expect(openUpstreams()).toBe(0);
    expect(proxy.active).toBe(0);
  });

  it("klientsiden har egen idle-timer, uavhengig av upstream: en tunnel hvis upstream aldri tidsavbryter rives likevel", async () => {
    await startProxy({ connect: () => { const u = tracked(); u.setTimeout = () => u; return u; }, idleTimeoutMs: 250 });
    const idle = await rawRequest(connectReq("github.com:443"), { keepOpen: true });
    const closed = await new Promise((resolve) => { idle.socket.on("close", () => resolve(true)); setTimeout(() => resolve(false), 3_000); });
    expect(closed).toBe(true);
  });
});

describe("I: rå tilkoblinger før CONNECT er lest - per-IP-tak, global grense og kort header-timeout (B-L1)", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Rå forbindelse fra en bestemt kilde-IP (127.0.0.0/8: hver adresse er en egen «jobb-container»). */
  const from = (localAddress, onConnect) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort, localAddress });
    cleanup.push(socket);
    socket.on("error", () => undefined);
    socket.on("connect", () => onConnect?.(socket));
    return socket;
  };
  const halfSent = (socket) => socket.write("CONNECT github.com:443 HTTP/1.1\r\nHost: x\r\n"); // aldri ferdig header-blokk
  const answerTo = (localAddress) => new Promise((resolve) => {
    let out = "";
    const s = from(localAddress, (sock) => sock.write(connectReq("github.com:443")));
    s.on("data", (d) => { out += d; if (out.includes("\r\n\r\n")) resolve(out.split("\r\n")[0]); });
    s.on("close", () => resolve(out ? out.split("\r\n")[0] : "closed-without-answer"));
    setTimeout(() => resolve("timeout"), 3_000);
  });

  it("én klient-IP kan ikke fylle alle rå plasser med halvsendte header-blokker: taket per IP holdes, og en annen jobb får svar (før: closed-without-answer)", async () => {
    await startProxy({ maxConnections: 4, maxConnectionsPerClient: 2 }); // server.maxConnections = 8, rå tilkoblinger per IP = 2 x 2 = 4
    const held = Array.from({ length: 12 }, () => from("127.0.0.2", halfSent));
    await sleep(400);
    expect(held.filter((s) => !s.destroyed).length).toBe(4);
    expect(events.some((e) => e.event === "connect_denied" && e.reason === "too_many_raw_connections" && e.client === "127.0.0.2")).toBe(true);
    expect(await answerTo("127.0.0.3")).toBe("HTTP/1.1 200 Connection Established");
    // plassen frigjøres når en av de holdte lukkes
    held.find((s) => !s.destroyed).destroy();
    await sleep(200);
    expect(proxy.rawPerClient.get("127.0.0.2")).toBe(3);
  });

  it("tallet på rå tilkoblinger går tilbake til null når alle er lukket (ingen lekkasje i telleren)", async () => {
    await startProxy({ maxConnections: 4, maxConnectionsPerClient: 2 });
    const sockets = Array.from({ length: 6 }, () => from("127.0.0.2", halfSent));
    await sleep(300);
    for (const s of sockets) s.destroy();
    await sleep(300);
    expect(proxy.rawPerClient.size).toBe(0);
  });

  it("den globale grensen (server.maxConnections = 2 x maxConnections) holder også når hver klient er under sitt eget tak", async () => {
    await startProxy({ maxConnections: 2, maxConnectionsPerClient: 10, maxRawConnectionsPerClient: 50 }); // server.maxConnections = 4
    const first = ["127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5"].map((ip) => from(ip, halfSent));
    await sleep(300);
    expect(first.every((s) => !s.destroyed)).toBe(true);
    const fifth = from("127.0.0.6", halfSent);
    const closed = await new Promise((resolve) => { fifth.on("close", () => resolve(true)); setTimeout(() => resolve(false), 1_500); });
    expect(closed).toBe(true); // avvist av serveren uten svar
  });

  it("header-blokken må være ferdig på sekunder: en halvsendt forespørsel rives etter headersTimeout (ikke etter Nodes standard 60 s)", async () => {
    await startProxy({ headersTimeoutMs: 300, requestTimeoutMs: 600, timeoutCheckIntervalMs: 50 });
    const slow = from("127.0.0.2", halfSent);
    const closed = await new Promise((resolve) => { slow.on("close", () => resolve(true)); setTimeout(() => resolve(false), 2_500); });
    expect(closed).toBe(true);
    await sleep(100);
    expect(proxy.rawPerClient.size).toBe(0);
  });

  it("standardverdiene: header-timeout 5 s, request-timeout 10 s, sjekkintervall 1 s, rå tak per IP = 2 x tunneltaket per klient", () => {
    const p = new EgressProxy({ allow: ALLOW, allowedClientCidrs: LOOPBACK_CLIENTS });
    expect([p.headersTimeoutMs, p.requestTimeoutMs, p.timeoutCheckIntervalMs, p.maxRawPerClient, p.maxPerClient]).toEqual([5_000, 10_000, 1_000, 32, 16]);
    expect(new EgressProxy({ allow: ALLOW, allowedClientCidrs: LOOPBACK_CLIENTS, headersTimeoutMs: 20_000, requestTimeoutMs: 1_000 }).requestTimeoutMs).toBe(20_000); // Node krever header <= request
  });
});

describe("F: logging - kun vert:port og årsak, aldri innhold", () => {
  it("hendelser inneholder ikke tunnel-data, stier eller header-innhold", async () => {
    await startProxy();
    const r = await rawRequest(connectReq("github.com:443", "Authorization: Bearer TOPP-HEMMELIG\r\nX-Secret: HEMMELIG-HEADER\r\n"), { keepOpen: true });
    r.socket.write("TUNNEL-HEMMELIG-DATA");
    await rawRequest("GET http://github.com/hemmelig/sti?token=QUERY-HEMMELIG HTTP/1.1\r\nHost: github.com\r\n\r\n");
    await new Promise((res) => setTimeout(res, 100));
    const logged = JSON.stringify(events);
    for (const secret of ["TOPP-HEMMELIG", "HEMMELIG-HEADER", "TUNNEL-HEMMELIG-DATA", "QUERY-HEMMELIG", "/hemmelig/sti"]) expect(logged, secret).not.toContain(secret);
    for (const e of events) expect(Object.keys(e).every((k) => ["event", "host", "port", "reason", "client"].includes(k))).toBe(true);
  });
});

describe("G: parseConnectTarget", () => {
  it("godtar kun dns.navn:port", () => {
    expect(parseConnectTarget("GitHub.com:443")).toEqual({ host: "github.com", port: 443 });
    expect(parseConnectTarget("api.anthropic.com.:443")).toEqual({ host: "api.anthropic.com", port: 443 });
    for (const bad of ["", "github.com", "1.2.3.4:80", "[::1]:80", "a@b.com:1", "x.com:99999", "x.com:0", "x.com:abc", "x .com:1", "x.com:1/", undefined, null, 5]) {
      expect(() => parseConnectTarget(bad), String(bad)).toThrow();
    }
  });
});
