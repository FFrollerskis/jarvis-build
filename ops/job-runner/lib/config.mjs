import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { isAbsolute } from "node:path";
import { ConfigError } from "./errors.mjs";
import { JobContainerConfigError, validateJobContainerPolicy } from "./spec.mjs";

/**
 * WP-C1: policy-konfigurasjon for vertstjenestene. Filen (`/etc/jarvis/job-runner.json`) EIES AV VERTSADMIN (root) og leses
 * ved oppstart. Den kan ALDRI overstyres via API-et, og strenge regler gjelder:
 *   - ukjente nøkler avvises på hvert nivå (en skrivefeil blir aldri en stille standardverdi),
 *   - eid av root og ikke skrivbar for gruppe/andre (tjenesten kan ikke endre sin egen policy),
 *   - test-flagg (file://-remote, hopp over uid-sjekk, falsk remote) finnes IKKE i skjemaet: de kan kun settes av testkode
 *     som konstruerer tjenesten direkte, aldri fra denne filen.
 * Alle verdier valideres; feil gir `ConfigError` og tjenesten nekter å starte.
 */

const ABS_PATH = /^\/[A-Za-z0-9._/@+-]{1,198}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;
const GROUP_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const PREFIX = /^[a-z0-9][a-z0-9-]{0,30}\/$/;
const DENY_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
const ALLOW_ENTRY = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+:[0-9]{1,5}$/;
const IDENT = /^[A-Za-z0-9 ._@+-]{1,100}$/;
const DEFAULT_ALLOW = ["github.com:443", "api.github.com:443", "api.anthropic.com:443"];
const DEFAULT_DENY_PATHS = [".github/", ".gitmodules", ".gitattributes"];

/** @param {unknown} value @param {string} path */
function plainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConfigError("config_invalid", `${path}:not_an_object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} obj @param {readonly string[]} allowed @param {string} path */
function onlyKeys(obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ConfigError("config_unknown_key", `${path}.${key}`);
  }
}

/** @param {Record<string, unknown>} obj @param {string} key @param {string} path */
function requireString(obj, key, path) {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) throw new ConfigError("config_invalid", `${path}.${key}:required_string`);
  return value;
}

/** @param {Record<string, unknown>} obj @param {string} key @param {string} path @param {number} min @param {number} max @param {number} def */
function intField(obj, key, path, min, max, def) {
  const value = obj[key];
  if (value === undefined) return def;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError("config_invalid", `${path}.${key}:integer_${min}_${max}`);
  }
  return value;
}

/** @param {Record<string, unknown>} obj @param {string} key @param {string} path @param {string | undefined} def */
function absPathField(obj, key, path, def) {
  const value = obj[key] ?? def;
  if (typeof value !== "string" || !ABS_PATH.test(value) || value.includes("..") || value.includes("//")) {
    throw new ConfigError("config_invalid", `${path}.${key}:absolute_safe_path`);
  }
  return value;
}

/** @param {Record<string, unknown>} obj @param {string} key @param {string} path @param {readonly string[]} def @param {RegExp} pattern @param {number} max */
function stringList(obj, key, path, def, pattern, max) {
  const value = obj[key] ?? def;
  if (!Array.isArray(value) || value.length > max) throw new ConfigError("config_invalid", `${path}.${key}:list`);
  for (const item of value) {
    if (typeof item !== "string" || !pattern.test(item)) throw new ConfigError("config_invalid", `${path}.${key}:entry_invalid`);
  }
  return [...new Set(/** @type {string[]} */ (value))];
}

/** `base_dir` ender som bind-mount-kilde i `docker create --mount`: samme smale tegnsett som den delte builderen (ingen komma/mellomrom). */
function safeMountPath(value) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value)) throw new ConfigError("config_invalid", "runner.base_dir:mount_safe_path");
  return value;
}

/** Validerer og normaliserer runner-seksjonen. */
function parseRunner(raw) {
  const r = plainObject(raw, "runner");
  onlyKeys(r, [
    "socket_path", "socket_group", "token_file", "base_dir", "docker_bin", "docker_host", "git_bin", "image", "network",
    "egress_proxy_url", "user", "memory", "cpus", "pids_limit", "tmpfs_size", "max_concurrent_jobs", "max_job_lifetime_s",
    "default_exec_timeout_ms", "max_exec_timeout_ms", "max_output_bytes", "max_body_bytes", "allowed_repos", "git_credentials",
    "branch_prefix", "clone_depth", "clone_timeout_ms", "publish", "git_identity", "sweep_interval_s"
  ], "runner");

  const socketGroup = r["socket_group"];
  if (socketGroup !== undefined && !(typeof socketGroup === "string" && (GROUP_NAME.test(socketGroup) || /^[0-9]{1,9}$/.test(socketGroup)))) {
    throw new ConfigError("config_invalid", "runner.socket_group");
  }
  const dockerHost = r["docker_host"];
  if (dockerHost !== undefined && !(typeof dockerHost === "string" && /^unix:\/\/\/[A-Za-z0-9._/-]{1,150}$/.test(dockerHost))) {
    throw new ConfigError("config_invalid", "runner.docker_host");
  }

  const allowedRepos = stringList(r, "allowed_repos", "runner", [], SLUG, 50);
  if (allowedRepos.length === 0) throw new ConfigError("config_invalid", "runner.allowed_repos:empty_means_nothing_allowed");

  const credsRaw = plainObject(r["git_credentials"], "runner.git_credentials");
  /**
   * Hvor git-credentialen for et repo kommer fra, bestemt AV VERTSADMIN per repo (aldri av klienten):
   *  - `file` (standard når `token_file` står): PAT i en fil bare runneren kan lese. Et `git_token` i en forespørsel for repoet nektes.
   *  - `request`: worker sender et kortlevd, repo-scopet token (WP-C3) i HVER klone-/publish-forespørsel; mangler det, nektes forespørselen. Ingen fil.
   * Nøyaktig ÉN kilde per repo: `source: request` sammen med `token_file` er en konfigfeil (tvetydig = nektet, aldri en stille fallback).
   * @type {Record<string, Readonly<{ source: "file", tokenFile: string } | { source: "request" }>>}
   */
  const gitCredentials = {};
  for (const [slug, entry] of Object.entries(credsRaw)) {
    if (!SLUG.test(slug)) throw new ConfigError("config_invalid", "runner.git_credentials:slug_invalid");
    if (!allowedRepos.includes(slug)) throw new ConfigError("config_invalid", `runner.git_credentials.${slug}:not_in_allowed_repos`);
    const path = `runner.git_credentials.${slug}`;
    const e = plainObject(entry, path);
    onlyKeys(e, ["token_file", "source"], path);
    const source = e["source"] === undefined ? "file" : e["source"]; // null/tom streng/andre typer er ugyldige, aldri en stille standard
    if (source !== "file" && source !== "request") throw new ConfigError("config_invalid", `${path}.source:file_or_request`);
    if (source === "request") {
      if (e["token_file"] !== undefined) throw new ConfigError("config_invalid", `${path}:token_file_not_allowed_with_source_request`);
      gitCredentials[slug] = Object.freeze({ source: /** @type {const} */ ("request") });
    } else {
      gitCredentials[slug] = Object.freeze({ source: /** @type {const} */ ("file"), tokenFile: absPathField(e, "token_file", path, undefined) });
    }
  }
  for (const slug of allowedRepos) {
    if (!gitCredentials[slug]) throw new ConfigError("config_invalid", `runner.git_credentials.${slug}:missing_credential_for_allowed_repo`);
  }

  const branchPrefix = r["branch_prefix"] ?? "jarvis/";
  if (typeof branchPrefix !== "string" || !PREFIX.test(branchPrefix)) throw new ConfigError("config_invalid", "runner.branch_prefix");

  const publishRaw = r["publish"] === undefined ? {} : plainObject(r["publish"], "runner.publish");
  onlyKeys(publishRaw, ["max_bundle_bytes", "max_commits", "max_files", "deny_paths", "timeout_ms"], "runner.publish");
  const denyPaths = stringList(publishRaw, "deny_paths", "runner.publish", DEFAULT_DENY_PATHS, DENY_PATH, 100);
  for (const entry of denyPaths) {
    if (entry.startsWith("/") || entry.includes("..") || entry.includes("//")) throw new ConfigError("config_invalid", "runner.publish.deny_paths:entry_unsafe");
  }

  const identityRaw = r["git_identity"] === undefined ? {} : plainObject(r["git_identity"], "runner.git_identity");
  onlyKeys(identityRaw, ["name", "email"], "runner.git_identity");
  const identityName = identityRaw["name"] ?? "jarvis-worker";
  const identityEmail = identityRaw["email"] ?? "worker@jarvis.local";
  if (typeof identityName !== "string" || !IDENT.test(identityName) || typeof identityEmail !== "string" || !/^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,100}$/.test(identityEmail)) {
    throw new ConfigError("config_invalid", "runner.git_identity");
  }

  const policy = {
    image: requireString(r, "image", "runner"),
    network: requireString(r, "network", "runner"),
    egressProxyUrl: requireString(r, "egress_proxy_url", "runner"),
    user: typeof r["user"] === "string" ? r["user"] : "10001:10001",
    memory: typeof r["memory"] === "string" ? r["memory"] : "1g",
    cpus: typeof r["cpus"] === "string" ? r["cpus"] : "1.0",
    pidsLimit: intField(r, "pids_limit", "runner", 16, 32768, 256),
    tmpfsSize: typeof r["tmpfs_size"] === "string" ? r["tmpfs_size"] : "256m",
    pull: /** @type {"never"} */ ("never")
  };
  for (const key of ["user", "memory", "cpus", "tmpfs_size"]) {
    if (r[key] !== undefined && typeof r[key] !== "string") throw new ConfigError("config_invalid", `runner.${key}:string`);
  }
  try {
    validateJobContainerPolicy(policy);
  } catch (error) {
    if (error instanceof JobContainerConfigError) throw new ConfigError("config_invalid", `runner.policy:${error.reason}`);
    throw error;
  }
  // Eksempelkonfigen har en nullet plassholder-image-ID: en uendret kopi skal aldri kunne starte tjenesten (feil lukket, med tydelig årsak).
  if (/(?:^|@)sha256:0{64}$/.test(policy.image)) throw new ConfigError("config_invalid", "runner.image:placeholder_not_replaced");
  // Den vertsside runneren kan ikke fungere med en HTTPS-proxy-URL uten vert-literal: containeren har ingen DNS på det interne nettet.
  const proxyUrl = new URL(policy.egressProxyUrl);
  if (isIP(proxyUrl.hostname.replace(/^\[|\]$/g, "")) === 0) {
    throw new ConfigError("config_invalid", "runner.egress_proxy_url:host_must_be_an_ip_literal");
  }

  const maxExec = intField(r, "max_exec_timeout_ms", "runner", 1_000, 3_600_000, 900_000);
  const defaultExec = intField(r, "default_exec_timeout_ms", "runner", 1_000, 3_600_000, 60_000);
  if (defaultExec > maxExec) throw new ConfigError("config_invalid", "runner.default_exec_timeout_ms:above_max");

  return Object.freeze({
    socketPath: absPathField(r, "socket_path", "runner", "/var/lib/jarvis-job-runner/sock/runner.sock"),
    ...(socketGroup !== undefined ? { socketGroup: /** @type {string} */ (socketGroup) } : {}),
    tokenFile: absPathField(r, "token_file", "runner", undefined),
    baseDir: safeMountPath(absPathField(r, "base_dir", "runner", "/var/lib/jarvis-job-runner/jobs")),
    dockerBin: absPathField(r, "docker_bin", "runner", "/usr/bin/docker"),
    ...(dockerHost !== undefined ? { dockerHost: /** @type {string} */ (dockerHost) } : {}),
    gitBin: absPathField(r, "git_bin", "runner", "/usr/bin/git"),
    policy: Object.freeze(policy),
    maxConcurrentJobs: intField(r, "max_concurrent_jobs", "runner", 1, 16, 2),
    maxJobLifetimeS: intField(r, "max_job_lifetime_s", "runner", 60, 86_400, 3_600),
    defaultExecTimeoutMs: defaultExec,
    maxExecTimeoutMs: maxExec,
    maxOutputBytes: intField(r, "max_output_bytes", "runner", 1_024, 16 * 1024 * 1024, 2 * 1024 * 1024),
    maxBodyBytes: intField(r, "max_body_bytes", "runner", 4_096, 4 * 1024 * 1024, 256 * 1024),
    allowedRepos: Object.freeze(allowedRepos),
    gitCredentials: Object.freeze(gitCredentials),
    branchPrefix,
    cloneDepth: intField(r, "clone_depth", "runner", 0, 1_000, 50),
    cloneTimeoutMs: intField(r, "clone_timeout_ms", "runner", 10_000, 1_800_000, 300_000),
    publish: Object.freeze({
      maxBundleBytes: intField(publishRaw, "max_bundle_bytes", "runner.publish", 1_024, 512 * 1024 * 1024, 64 * 1024 * 1024),
      maxCommits: intField(publishRaw, "max_commits", "runner.publish", 1, 500, 20),
      maxFiles: intField(publishRaw, "max_files", "runner.publish", 1, 20_000, 500),
      denyPaths: Object.freeze(denyPaths),
      timeoutMs: intField(publishRaw, "timeout_ms", "runner.publish", 10_000, 1_800_000, 180_000)
    }),
    gitIdentity: Object.freeze({ name: identityName, email: identityEmail }),
    sweepIntervalS: intField(r, "sweep_interval_s", "runner", 1, 600, 15)
  });
}

/** @param {string} entry */
function parseCidr(entry) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(entry);
  if (!m || isIP(m[1]) !== 4) throw new ConfigError("config_invalid", "egress_proxy.allowed_client_cidrs:entry_invalid");
  const prefix = Number(m[2]);
  if (prefix < 8 || prefix > 32) throw new ConfigError("config_invalid", "egress_proxy.allowed_client_cidrs:prefix_8_32");
  return { network: /** @type {string} */ (m[1]), prefix };
}

/** Validerer og normaliserer egress-proxy-seksjonen. */
function parseEgressProxy(raw) {
  const p = plainObject(raw, "egress_proxy");
  onlyKeys(p, [
    "listen_host", "listen_port", "allow", "allowed_client_cidrs", "max_connections", "max_connections_per_client",
    "idle_timeout_ms", "connect_timeout_ms", "max_tunnel_ms"
  ], "egress_proxy");

  const listenHost = requireString(p, "listen_host", "egress_proxy");
  if (isIP(listenHost) !== 4 || listenHost === "0.0.0.0") {
    // Aldri jokertegn: proxyen skal kun høre på jobbnettverkets gateway-adresse (og loopback i utvikling).
    throw new ConfigError("config_invalid", "egress_proxy.listen_host:must_be_a_specific_ipv4_address");
  }
  const allow = stringList(p, "allow", "egress_proxy", DEFAULT_ALLOW, ALLOW_ENTRY, 100);
  for (const entry of allow) {
    const host = entry.slice(0, entry.lastIndexOf(":"));
    const port = Number(entry.slice(entry.lastIndexOf(":") + 1));
    if (port < 1 || port > 65_535) throw new ConfigError("config_invalid", "egress_proxy.allow:port_range");
    // Kun DNS-NAVN: IP-literaler (også «1.2.3.4») og navn uten bokstav i siste etikett (numerisk TLD) er aldri gyldige vertsnavn.
    if (isIP(host) !== 0 || !/[a-z]/.test(host.slice(host.lastIndexOf(".") + 1))) throw new ConfigError("config_invalid", "egress_proxy.allow:dns_name_required");
  }
  const cidrs = stringList(p, "allowed_client_cidrs", "egress_proxy", [], /^[0-9./]{7,18}$/, 16);
  if (cidrs.length === 0) throw new ConfigError("config_invalid", "egress_proxy.allowed_client_cidrs:required");
  const clientCidrs = cidrs.map(parseCidr);
  // Hele nettet (0.0.0.0/8) og «alle» (/8 minimum) er forbudt: klientene er jobbnettverket, ikke «noen».
  const probe = new BlockList();
  for (const c of clientCidrs) probe.addSubnet(c.network, c.prefix, "ipv4");

  return Object.freeze({
    listenHost,
    listenPort: intField(p, "listen_port", "egress_proxy", 1_024, 65_535, 3_128),
    allow: Object.freeze(allow.map((e) => e.toLowerCase())),
    allowedClientCidrs: Object.freeze(clientCidrs),
    maxConnections: intField(p, "max_connections", "egress_proxy", 1, 1_024, 64),
    maxConnectionsPerClient: intField(p, "max_connections_per_client", "egress_proxy", 1, 256, 16),
    idleTimeoutMs: intField(p, "idle_timeout_ms", "egress_proxy", 1_000, 3_600_000, 120_000),
    connectTimeoutMs: intField(p, "connect_timeout_ms", "egress_proxy", 500, 120_000, 10_000),
    maxTunnelMs: intField(p, "max_tunnel_ms", "egress_proxy", 1_000, 86_400_000, 3_600_000)
  });
}

/**
 * Validerer en allerede parset konfig. `sections` angir hvilke seksjoner som er påkrevd (runner-tjenesten krever `runner`,
 * proxy-tjenesten krever `egress_proxy`); den andre seksjonen valideres også hvis den finnes, men mangler den er det ikke en feil.
 *
 * @param {unknown} raw
 * @param {{ require: Array<"runner" | "egress_proxy"> }} options
 */
export function validateConfig(raw, options) {
  const root = plainObject(raw, "config");
  onlyKeys(root, ["version", "runner", "egress_proxy"], "config");
  if (root["version"] !== 1) throw new ConfigError("config_invalid", "version:must_be_1");
  for (const section of options.require) {
    if (root[section] === undefined) throw new ConfigError("config_invalid", `${section}:section_required`);
  }
  return Object.freeze({
    ...(root["runner"] !== undefined ? { runner: parseRunner(root["runner"]) } : {}),
    ...(root["egress_proxy"] !== undefined ? { egressProxy: parseEgressProxy(root["egress_proxy"]) } : {})
  });
}

/**
 * Leser og validerer konfigfilen. Krever (med mindre `allowNonRootOwner`, KUN for tester) at filen er eid av root og ikke
 * skrivbar for gruppe/andre: tjenesten kan ikke endre sin egen policy, og en annen bruker kan ikke gjøre det heller.
 *
 * @param {string} path
 * @param {{ require: Array<"runner" | "egress_proxy">, allowNonRootOwner?: boolean }} options
 */
export async function loadConfigFile(path, options) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new ConfigError("config_path_not_absolute");
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new ConfigError("config_unreadable");
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new ConfigError("config_not_a_regular_file");
    if (st.size > 64 * 1024) throw new ConfigError("config_too_large");
    if ((st.mode & 0o022) !== 0) throw new ConfigError("config_writable_by_group_or_others");
    if (options.allowNonRootOwner !== true && st.uid !== 0) throw new ConfigError("config_must_be_owned_by_root");
    const text = (await handle.readFile({ encoding: "utf8" }));
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ConfigError("config_not_valid_json");
    }
    return validateConfig(parsed, { require: options.require });
  } finally {
    await handle.close();
  }
}
