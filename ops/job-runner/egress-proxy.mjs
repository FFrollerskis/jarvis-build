#!/usr/bin/env node
import { lookup } from "node:dns/promises";
import http from "node:http";
import net, { BlockList, isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFile } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";

/**
 * WP-C1 (D-32 port 9, Q-46 punkt 4): egress-proxy for jobb-containere. Jobbnettverket er `docker network create --internal`;
 * containerne når KUN denne proxyen (på nettverkets gateway-adresse) og proxyen slipper kun gjennom en eksplisitt allowlist.
 *
 *   - KUN `CONNECT host:port` (HTTPS-tunneler). Vanlig HTTP-videresending finnes ikke: alt annet svarer 405.
 *   - Allowlist på eksakt `vert:port` (standard github.com:443, api.github.com:443, api.anthropic.com:443). Kun DNS-navn - aldri IP-literaler.
 *   - SSRF/DNS-rebinding: proxyen slår opp DNS SELV, krever at ALLE svar er offentlige adresser (loopback/privat/link-local/ULA/CGNAT/
 *     metadata nektes) og kobler til den VALIDERTE IP-en - aldri et nytt oppslag mellom sjekk og tilkobling.
 *   - Kun klienter fra jobbnettverkets CIDR (forsvar i dybden hvis gateway-adressen skulle nås utenfra).
 *   - Grenser: samtidige tilkoblinger (global + per klient), tilkoblings-/idle-tidsavbrudd, maks tunnel-levetid.
 *   - Logger kun vert:port + årsak - aldri innhold (en CONNECT-tunnel er uansett kryptert) og aldri URL-er.
 */

const blocked = new BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) {
  blocked.addSubnet(net4, prefix, "ipv4");
}
for (const [net6, prefix] of [
  // «::/96» = IPv4-kompatible adresser (::a.b.c.d, utfaset men fortsatt parsbare - f.eks. ::7f00:1), «fec0::/10» = site-local (utfaset), «64:ff9b:1::/48» = lokal NAT64 (RFC 8215).
  // IPv4-mappede (::ffff:a.b.c.d), 64:ff9b::/96 og 6to4 (2002::/16) vurderes mot den INNEBYGDE IPv4-adressen i `embeddedIpv4`.
  ["::", 96], ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64], ["2001::", 32], ["64:ff9b:1::", 48]
]) {
  blocked.addSubnet(net6, prefix, "ipv6");
}

/** Trekker ut innebygd IPv4 fra IPv4-mappet/-kompatibel IPv6 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d, 2002:ab:cd::). Speiler apps/browser-gateway/src/egress-policy.ts. */
function embeddedIpv4(ip) {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1] ?? null;
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1] ?? "0", 16);
    const lo = parseInt(hexMapped[2] ?? "0", 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})::?/.exec(lower);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1] ?? "0", 16);
    const lo = parseInt(sixToFour[2] ?? "0", 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** `true` KUN for en offentlig rutbar adresse. Alt ukjent/uparsbart er `false` (fail-closed). */
export function isPublicAddress(ip) {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    const embedded = embeddedIpv4(ip);
    if (embedded !== null) return isPublicAddress(embedded);
    return !blocked.check(ip, "ipv6");
  }
  return !blocked.check(ip, "ipv4");
}

export class EgressDeniedError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = "EgressDeniedError";
    this.reason = reason;
  }
}

/**
 * Parser CONNECT-målet (authority-form). Kun `dns.navn:port` aksepteres: ingen brukerinfo, sti, IP-literaler eller IPv6-klammer.
 * @param {string} authority
 * @returns {{ host: string, port: number }}
 */
export function parseConnectTarget(authority) {
  if (typeof authority !== "string" || authority.length === 0 || authority.length > 300) throw new EgressDeniedError("target_invalid");
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.?):([0-9]{1,5})$/.exec(authority);
  if (!m) throw new EgressDeniedError("target_invalid");
  const host = /** @type {string} */ (m[1]).toLowerCase().replace(/\.$/, "");
  const port = Number(m[2]);
  if (port < 1 || port > 65_535 || host.length === 0 || host.includes("..") || /^\d+(?:\.\d+){3}$/.test(host)) throw new EgressDeniedError("target_invalid");
  return { host, port };
}

/** Klient-IP uten IPv4-mapping-prefiks. */
function clientAddress(socket) {
  const addr = socket.remoteAddress ?? "";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

export class EgressProxy {
  /**
   * @param {{
   *   allow: readonly string[],
   *   allowedClientCidrs: ReadonlyArray<{ network: string, prefix: number }>,
   *   resolve?: (host: string) => Promise<string[]>,
   *   connect?: (ip: string, port: number) => net.Socket,
   *   maxConnections?: number, maxConnectionsPerClient?: number,
   *   idleTimeoutMs?: number, connectTimeoutMs?: number, maxTunnelMs?: number,
   *   onEvent?: (event: { event: string, host?: string, port?: number, reason?: string, client?: string }) => void
   * }} options
   */
  constructor(options) {
    this.allow = new Set(options.allow.map((e) => e.toLowerCase()));
    this.clients = new BlockList();
    for (const c of options.allowedClientCidrs) this.clients.addSubnet(c.network, c.prefix, "ipv4");
    this.resolveHost = options.resolve ?? (async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address));
    this.dial = options.connect ?? ((ip, port) => net.connect({ host: ip, port }));
    this.maxConnections = options.maxConnections ?? 64;
    this.maxPerClient = options.maxConnectionsPerClient ?? 16;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.maxTunnelMs = options.maxTunnelMs ?? 3_600_000;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.active = 0;
    /** @type {Map<string, number>} */
    this.perClient = new Map();
    /** @type {http.Server | undefined} */
    this.server = undefined;
    /** Alle åpne sockets (klientsiden av tunneler): `server.close()` venter ellers på dem for alltid ved avslutning. */
    /** @type {Set<net.Socket>} */
    this.sockets = new Set();
  }

  /**
   * Validerer mål og returnerer de VALIDERTE adressene (alle offentlige). Kaster `EgressDeniedError`.
   * @param {string} host @param {number} port
   */
  async validate(host, port) {
    if (!this.allow.has(`${host}:${port}`)) throw new EgressDeniedError("not_allowlisted");
    /** @type {string[]} */
    let addresses;
    try {
      addresses = await this.resolveHost(host);
    } catch {
      throw new EgressDeniedError("dns_failure");
    }
    if (!Array.isArray(addresses) || addresses.length === 0) throw new EgressDeniedError("dns_empty");
    // Én privat adresse i svaret avviser HELE målet (rebinding/blandede svar).
    if (addresses.some((a) => !isPublicAddress(a))) throw new EgressDeniedError("resolves_to_private_address");
    return addresses;
  }

  /** @param {string[]} addresses @param {number} port @returns {Promise<net.Socket>} */
  async connectValidated(addresses, port) {
    let lastError;
    for (const ip of addresses) {
      try {
        return await new Promise((resolveConn, rejectConn) => {
          const socket = this.dial(ip, port);
          const timer = setTimeout(() => socket.destroy(new Error("connect_timeout")), this.connectTimeoutMs);
          socket.once("connect", () => { clearTimeout(timer); resolveConn(socket); });
          socket.once("error", (error) => { clearTimeout(timer); rejectConn(error); });
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("connect_failed");
  }

  /** @param {http.IncomingMessage} req @param {net.Socket} clientSocket @param {Buffer} head */
  async handleConnect(req, clientSocket, head) {
    const reply = (/** @type {number} */ status, /** @type {string} */ text) => {
      clientSocket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    clientSocket.on("error", () => clientSocket.destroy());
    this.sockets.add(clientSocket);
    clientSocket.once("close", () => this.sockets.delete(clientSocket));
    const client = clientAddress(clientSocket);
    if (isIP(client) !== 4 || !this.clients.check(client, "ipv4")) {
      this.onEvent({ event: "connect_denied", reason: "client_not_allowed", client });
      return reply(403, "Forbidden");
    }
    const used = this.perClient.get(client) ?? 0;
    if (this.active >= this.maxConnections || used >= this.maxPerClient) {
      this.onEvent({ event: "connect_denied", reason: "too_many_connections", client });
      return reply(503, "Busy");
    }
    // Plassen reserveres synkront (før første await).
    this.active += 1;
    this.perClient.set(client, used + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const left = (this.perClient.get(client) ?? 1) - 1;
      if (left <= 0) this.perClient.delete(client);
      else this.perClient.set(client, left);
    };
    clientSocket.once("close", release);

    let target;
    try {
      target = parseConnectTarget(req.url ?? "");
      const addresses = await this.validate(target.host, target.port);
      const upstream = await this.connectValidated(addresses, target.port);
      upstream.on("error", () => upstream.destroy());
      upstream.once("close", () => clientSocket.destroy());
      clientSocket.once("close", () => upstream.destroy());
      upstream.setTimeout(this.idleTimeoutMs, () => upstream.destroy());
      clientSocket.setTimeout(this.idleTimeoutMs, () => clientSocket.destroy());
      const lifetime = setTimeout(() => { clientSocket.destroy(); upstream.destroy(); }, this.maxTunnelMs);
      lifetime.unref();
      clientSocket.once("close", () => clearTimeout(lifetime));
      this.onEvent({ event: "connect_allowed", host: target.host, port: target.port, client });
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    } catch (error) {
      release();
      if (error instanceof EgressDeniedError) {
        this.onEvent({ event: "connect_denied", reason: error.reason, ...(target ? { host: target.host, port: target.port } : {}), client });
        return reply(error.reason === "target_invalid" ? 400 : 403, error.reason === "target_invalid" ? "Bad Request" : "Forbidden");
      }
      this.onEvent({ event: "connect_failed", reason: "upstream_unreachable", ...(target ? { host: target.host, port: target.port } : {}), client });
      return reply(502, "Bad Gateway");
    }
  }

  /**
   * @param {number} port @param {string} host
   * @returns {Promise<{ port: number }>}
   */
  async start(port, host) {
    if (isIP(host) !== 4 || host === "0.0.0.0") throw new Error("egress_proxy_requires_specific_ipv4_listen_address");
    const server = http.createServer(
      { maxHeaderSize: 8 * 1024, requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 1_000 },
      (req, res) => {
        // Ingen vanlig HTTP-videresending: alt som ikke er CONNECT avvises, uten å logge URL/innhold.
        this.onEvent({ event: "connect_denied", reason: "method_not_allowed" });
        res.writeHead(405, { allow: "CONNECT", connection: "close", "content-length": "0" });
        res.end();
        req.resume();
      }
    );
    server.on("connect", (req, clientSocket, head) => void this.handleConnect(req, /** @type {net.Socket} */ (clientSocket), head));
    server.on("clientError", (_error, socket) => socket.destroy());
    server.maxConnections = this.maxConnections * 2;
    this.server = server;
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, () => resolveListen(undefined));
    });
    return { port: /** @type {net.AddressInfo} */ (server.address()).port };
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    for (const socket of [...this.sockets]) socket.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
    }
  }
}

async function main() {
  const configPath = process.env["JARVIS_JOB_RUNNER_CONFIG"] ?? "/etc/jarvis/job-runner.json";
  const loaded = await loadConfigFile(configPath, { require: ["egress_proxy"] });
  const cfg = /** @type {NonNullable<typeof loaded.egressProxy>} */ (loaded.egressProxy);
  const logger = createLogger({ component: "egress-proxy" });
  const proxy = new EgressProxy({
    allow: cfg.allow, allowedClientCidrs: cfg.allowedClientCidrs,
    maxConnections: cfg.maxConnections, maxConnectionsPerClient: cfg.maxConnectionsPerClient,
    idleTimeoutMs: cfg.idleTimeoutMs, connectTimeoutMs: cfg.connectTimeoutMs, maxTunnelMs: cfg.maxTunnelMs,
    onEvent: (e) => (e.event === "connect_allowed" ? logger.info(e.event, { host: e.host, port: e.port }) : logger.warn(e.event, { host: e.host, port: e.port, reason: e.reason }))
  });
  await proxy.start(cfg.listenPort, cfg.listenHost);
  logger.info("egress_proxy_started", { listen: `${cfg.listenHost}:${cfg.listenPort}`, allow_count: cfg.allow.length });
  const stop = () => void proxy.stop().then(() => process.exit(0), () => process.exit(1));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ level: "error", component: "egress-proxy", event: "fatal", code: error?.code ?? "fatal", detail: String(error?.message ?? "").slice(0, 200) }));
    process.exit(1);
  });
}
