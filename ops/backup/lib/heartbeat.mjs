/* global AbortSignal */
import { envInt, envString } from "./env.mjs";

/**
 * WP-C2 (OPS-RUNTIME): ekstern heartbeat («dead man's switch») for den planlagte backupen. DORMANT: uten `JARVIS_BACKUP_HEARTBEAT_URL` sendes ingenting.
 *
 * Kontrakt (healthchecks.io-konvensjonen, men leverandøruavhengig - ren HTTPS GET uten kropp):
 *   `<URL>/start`  jobben begynner      `<URL>`  jobben lyktes      `<URL>/fail`  jobben feilet
 * Leverandører med en annen konvensjon (f.eks. Uptime Kuma push) setter `..._START_URL` / `..._FAIL_URL` eksplisitt.
 * Det sendes KUN status: aldri innhold, aldri tenant-data, aldri sti/hemmeligheter i kropp eller headere. URL-en er selv en kapabilitet
 * (nøkkelen står i stien) og logges derfor aldri - kun opprinnelsen (`https://vert`). Kort tidsavbrudd, ingen redirect-følging, og en feil her
 * feiler ALDRI selve backupen (den registreres i statusen og synes som manglende ping hos monitoren).
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000- \u007f\\]/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class HeartbeatConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "HeartbeatConfigError";
    this.code = "heartbeat_config_invalid";
  }
}

/** Kaster en `HeartbeatConfigError` UTEN å sitere URL-en (den inneholder nøkkelen). */
export function assertHeartbeatUrl(raw, label) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || UNSAFE.test(raw)) {
    throw new HeartbeatConfigError(`${label}: ugyldig URL (tom, for lang, mellomrom/kontrolltegn eller backslash)`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HeartbeatConfigError(`${label}: ikke en gyldig URL`);
  }
  if (url.username !== "" || url.password !== "") throw new HeartbeatConfigError(`${label}: brukerinfo i URL er ikke tillatt`);
  if (url.hash !== "") throw new HeartbeatConfigError(`${label}: fragment (#) er ikke tillatt`);
  if (url.hostname === "") throw new HeartbeatConfigError(`${label}: mangler vert`);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new HeartbeatConfigError(`${label}: kun https:// er tillatt (http:// bare mot loopback, for test)`);
  }
  return url;
}

/** Legger suffikset på STIEN (foran en evt. query) og unngår dobbel skråstrek. */
export function withPathSuffix(url, suffix) {
  const copy = new URL(url.toString());
  copy.pathname = `${copy.pathname.replace(/\/+$/, "")}${suffix}`;
  return copy;
}

/**
 * @returns {{ configured: false } | { configured: true, invalid: true, reason: string } | { configured: true, invalid: false, urls: { start: string, success: string, fail: string }, timeoutMs: number, label: string }}
 */
export function parseHeartbeatConfig(env = process.env) {
  const base = envString(env, "JARVIS_BACKUP_HEARTBEAT_URL");
  if (base === undefined) return { configured: false };
  try {
    const success = assertHeartbeatUrl(base, "JARVIS_BACKUP_HEARTBEAT_URL");
    const startRaw = envString(env, "JARVIS_BACKUP_HEARTBEAT_START_URL");
    const failRaw = envString(env, "JARVIS_BACKUP_HEARTBEAT_FAIL_URL");
    const start = startRaw === undefined ? withPathSuffix(success, "/start") : assertHeartbeatUrl(startRaw, "JARVIS_BACKUP_HEARTBEAT_START_URL");
    const fail = failRaw === undefined ? withPathSuffix(success, "/fail") : assertHeartbeatUrl(failRaw, "JARVIS_BACKUP_HEARTBEAT_FAIL_URL");
    const timeoutMs = envInt(env, "JARVIS_BACKUP_HEARTBEAT_TIMEOUT_SEC", 10, { min: 1, max: 60 }) * 1000;
    return { configured: true, invalid: false, urls: { start: start.toString(), success: success.toString(), fail: fail.toString() }, timeoutMs, label: success.origin };
  } catch (err) {
    return { configured: true, invalid: true, reason: err instanceof Error ? err.message.slice(0, 160) : "invalid" };
  }
}

/** Ett ping. Kaster aldri. `reason` er en kort kode (aldri URL eller svartekst). */
export async function sendPing(url, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "jarvis-backup-heartbeat/1" }
    });
    try {
      await res.body?.cancel(); // kroppen leses aldri
    } catch {
      // ikke viktig
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, reason: null };
    return { ok: false, status: res.status, reason: `http_${res.status}` };
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, status: null, reason: timeout ? "timeout" : "network" };
  }
}

/** Heartbeat-klient for én kjøring. `last()` gir det som lagres i statusen (kun status, tidspunkt og feilkode). */
export function createHeartbeat(config, { fetchImpl, now = () => new Date(), log = () => undefined } = {}) {
  const last = { last_ping_at: null, last_ping_kind: null, last_ping_ok: null, last_error_code: null };
  async function ping(kind) {
    if (config.configured !== true) return { ok: false, skipped: true, reason: "not_configured" };
    let result;
    if (config.invalid) {
      result = { ok: false, status: null, reason: "config_invalid" };
      log("error", "heartbeat_config_invalid", { reason: config.reason });
    } else {
      result = await sendPing(config.urls[kind], { ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: config.timeoutMs });
      if (!result.ok) log("warn", "heartbeat_ping_failed", { kind, reason: result.reason, target: config.label });
    }
    last.last_ping_at = now().toISOString();
    last.last_ping_kind = kind;
    last.last_ping_ok = result.ok;
    last.last_error_code = result.ok ? null : "heartbeat_failed";
    return result;
  }
  return {
    configured: config.configured === true,
    start: () => ping("start"),
    success: () => ping("success"),
    fail: () => ping("fail"),
    last: () => ({ ...last })
  };
}
