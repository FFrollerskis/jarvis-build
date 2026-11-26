// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { envInt } from "@jarvis/contracts";
import { guardedFetch } from "@jarvis/tool-gateway";

/**
 * WP-C2 (OPS-RUNTIME): ekstern oppetids-heartbeat («dead man's switch») for API-et. AV som standard: uten `JARVIS_UPTIME_HEARTBEAT_URL` sendes ingenting.
 *
 * Prinsippet er at STILLHET = ALARM hos eierens eksterne overvåker (healthchecks.io-konvensjonen, men leverandøruavhengig: ren GET uten kropp). Derfor pinger
 * vi KUN mens en lokal selvsjekk består - databasen svarer OG api-prosessen faktisk svarer på sin egen HTTP-port (`/health`, som kjører beredskapssjekken) -
 * og vi sender aldri et «jeg feiler»-ping: en hengt event-loop, en nede database eller en død prosess skal se ut som det den er, nemlig fravær av ping.
 *
 * Sikkerhet: kun status (aldri innhold, tenant-data eller hemmeligheter i URL/kropp/headere). URL-en er selv en kapabilitet (nøkkelen står ofte i stien) og
 * logges derfor aldri - kun opprinnelsen (`https://vert`). Utgående kall går via `guardedFetch` (rå URL sjekkes: kun http(s) mot ren vert, ingen brukerinfo,
 * ingen `..`), uten redirect-følging, med kort tidsavbrudd. En feil her kan aldri velte API-et: alt fanges, telles og logges (rate-begrenset).
 */
export class HeartbeatConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeartbeatConfigError";
  }
}

// guardedFetch (assertSafeVendorUrl) godtar ikke IPv6-literaler i vertsdelen - holdes utenfor her så validering og utsending er enige.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000- \u007f\\]/;
const MAX_URL_LENGTH = 2048;
const FIRST_TICK_DELAY_MS = 15_000;
const LOG_EVERY_N = 10;

/** Variabelen API-heartbeaten leses fra - standard i feilmeldingene. WP-OPS2a K3: andre kallere (vakthundens heartbeat) gir sitt EGET variabelnavn, så meldingen peker på riktig innstilling. */
const UPTIME_URL_ENV = "JARVIS_UPTIME_HEARTBEAT_URL";

/** https:// (http:// kun mot loopback, for test/lokal proxy); ingen brukerinfo/fragment/mellomrom. Feilmeldingen siterer ALDRI URL-en (nøkkelen står i den). */
export function validateHeartbeatUrl(raw: string, envName: string = UPTIME_URL_ENV): URL {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH || UNSAFE.test(raw)) throw new HeartbeatConfigError(`${envName}: ugyldig URL (tom, for lang, mellomrom/kontrolltegn eller backslash)`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HeartbeatConfigError(`${envName}: ikke en gyldig URL`);
  }
  if (url.username !== "" || url.password !== "") throw new HeartbeatConfigError(`${envName}: brukerinfo i URL er ikke tillatt`);
  if (url.hash !== "") throw new HeartbeatConfigError(`${envName}: fragment (#) er ikke tillatt`);
  if (url.hostname === "") throw new HeartbeatConfigError(`${envName}: mangler vert`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new HeartbeatConfigError(`${envName}: kun https:// er tillatt (http:// bare mot loopback, for test)`);
  }
  return url;
}

export interface UptimeHeartbeatConfig {
  url: string;
  intervalSec: number;
  /** Opprinnelsen (`https://vert`) - det eneste som noensinne logges. */
  origin: string;
}

/** `null` = AV (standard). Ugyldig URL/intervall kaster (kalleren logger høyt og lar API-et starte - fravær av ping er selve alarmen). */
export function uptimeHeartbeatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UptimeHeartbeatConfig | null {
  const raw = env["JARVIS_UPTIME_HEARTBEAT_URL"]?.trim();
  if (raw === undefined || raw === "") return null;
  const url = validateHeartbeatUrl(raw);
  const intervalSec = envInt("JARVIS_UPTIME_HEARTBEAT_INTERVAL_SEC", 60, { min: 10, max: 3600 }, env);
  return { url: url.toString(), intervalSec, origin: url.origin };
}

export interface PingResult {
  ok: boolean;
  status: number | null;
  /** Kort kode (`http_503`, `timeout`, `network`) - aldri URL eller svartekst. */
  reason: string | null;
}
export type PingFn = (url: string, timeoutMs: number) => Promise<PingResult>;

/** Utsending: GET via `guardedFetch`, ingen redirect, svarkroppen leses aldri. WP-OPS2a K3: user-agent er valgfri (vakthundens heartbeat bruker sin egen), `sendPing` under er uendret. */
export function makeSendPing(userAgent: string): PingFn {
  return async (url, timeoutMs) => {
    try {
      const res = await guardedFetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": userAgent } });
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, reason: null };
      return { ok: false, status: res.status, reason: `http_${res.status}` };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      return { ok: false, status: null, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
  };
}

/** Standard utsending for API-heartbeaten (uendret user-agent). */
export const sendPing: PingFn = makeSendPing("jarvis-api-uptime/1");

/** Selvsjekken: API-et svarer på sin egen port og `/health` (som kjører beredskapssjekken inkl. databasen) gir 200. Kaster aldri. */
export function loopbackSelfCheck(port: number, fetchImpl: typeof fetch = fetch, timeoutMs = 3000): () => Promise<boolean> {
  return async () => {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => undefined);
      return res.status === 200;
    } catch {
      return false;
    }
  };
}

export type HeartbeatLog = (event: Record<string, unknown>) => void;
export interface HeartbeatSenderOptions {
  url: string;
  origin: string;
  intervalMs: number;
  selfCheck: () => Promise<boolean>;
  send?: PingFn;
  selfCheckTimeoutMs?: number;
  sendTimeoutMs?: number;
  now?: () => Date;
  log?: HeartbeatLog;
  /** WP-OPS2a K3: prefiks på loggeventene (`<name>_started`, `<name>_selfcheck_failed` ...). Standard `uptime_heartbeat` (uendret for API-et). */
  name?: string;
  /** WP-OPS2a K3: user-agent for standard utsending når `send` ikke er gitt. Standard `jarvis-api-uptime/1` (uendret for API-et). */
  userAgent?: string;
}
export type TickOutcome = "sent" | "send_failed" | "silent" | "skipped_busy";

export class HeartbeatSender {
  private timer: NodeJS.Timeout | undefined;
  private firstTimer: NodeJS.Timeout | undefined;
  private busy = false;
  private silentTicks = 0;
  private sendFailures = 0;
  private lastAttemptAt: string | null = null;
  private lastOkAt: string | null = null;
  private readonly send: PingFn;
  private readonly selfCheckTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly now: () => Date;
  private readonly log: HeartbeatLog;
  private readonly name: string;

  constructor(private readonly options: HeartbeatSenderOptions) {
    this.name = options.name ?? "uptime_heartbeat";
    this.send = options.send ?? (options.userAgent !== undefined ? makeSendPing(options.userAgent) : sendPing);
    this.selfCheckTimeoutMs = options.selfCheckTimeoutMs ?? 5_000;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  }

  /** Ett tikk: selvsjekk → (kun hvis den består) ett ping. Kaster aldri. */
  async tick(): Promise<TickOutcome> {
    if (this.busy) return "skipped_busy"; // forrige tikk henger: ikke stable opp
    this.busy = true;
    try {
      this.lastAttemptAt = this.now().toISOString();
      let healthy = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        healthy = await Promise.race([
          this.options.selfCheck(),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.selfCheckTimeoutMs); })
        ]);
      } catch {
        healthy = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!healthy) {
        this.silentTicks += 1;
        if (this.silentTicks === 1 || this.silentTicks % LOG_EVERY_N === 0) {
          this.log({ msg: `${this.name}_selfcheck_failed`, silent_ticks: this.silentTicks, note: "sender IKKE ping (stillhet = alarm hos monitoren)" });
        }
        return "silent";
      }
      if (this.silentTicks > 0) this.log({ msg: `${this.name}_selfcheck_recovered`, silent_ticks: this.silentTicks });
      this.silentTicks = 0;
      let result: PingResult;
      try {
        result = await this.send(this.options.url, this.sendTimeoutMs);
      } catch {
        result = { ok: false, status: null, reason: "network" };
      }
      if (result.ok) {
        if (this.sendFailures > 0) this.log({ msg: `${this.name}_ping_recovered`, failures: this.sendFailures, target: this.options.origin });
        this.sendFailures = 0;
        this.lastOkAt = this.now().toISOString();
        return "sent";
      }
      this.sendFailures += 1;
      if (this.sendFailures === 1 || this.sendFailures % LOG_EVERY_N === 0) {
        this.log({ msg: `${this.name}_ping_failed`, reason: result.reason, target: this.options.origin, consecutive_failures: this.sendFailures });
      }
      return "send_failed";
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.log({ msg: `${this.name}_started`, target: this.options.origin, interval_sec: Math.round(this.options.intervalMs / 1000) });
    const run = () => void this.tick().catch(() => undefined);
    // Første ping kort etter oppstart (serveren må rekke å lytte), deretter fast intervall. Ingen timer holder prosessen i live.
    this.firstTimer = setTimeout(run, Math.min(this.options.intervalMs, FIRST_TICK_DELAY_MS));
    this.firstTimer.unref();
    this.timer = setInterval(run, this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.firstTimer !== undefined) clearTimeout(this.firstTimer);
    this.timer = undefined;
    this.firstTimer = undefined;
  }

  status(): { running: boolean; target: string; interval_sec: number; last_attempt_at: string | null; last_ok_at: string | null; consecutive_send_failures: number; silent_ticks: number } {
    return {
      running: this.timer !== undefined, target: this.options.origin, interval_sec: Math.round(this.options.intervalMs / 1000), last_attempt_at: this.lastAttemptAt,
      last_ok_at: this.lastOkAt, consecutive_send_failures: this.sendFailures, silent_ticks: this.silentTicks
    };
  }
}

export interface StartUptimeHeartbeatOptions {
  port: number;
  env?: NodeJS.ProcessEnv;
  selfCheck?: () => Promise<boolean>;
  send?: PingFn;
  log?: HeartbeatLog;
}

/** Starter heartbeaten hvis den er konfigurert. Ugyldig konfig logges høyt og starter IKKE (API-et lever videre; fravær av ping er alarmen). */
export function startUptimeHeartbeat(opts: StartUptimeHeartbeatOptions): HeartbeatSender | null {
  const log = opts.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
  let config: UptimeHeartbeatConfig | null;
  try {
    config = uptimeHeartbeatConfigFromEnv(opts.env ?? process.env);
  } catch (err) {
    log({ msg: "uptime_heartbeat_config_invalid", error: err instanceof Error ? err.message.slice(0, 200) : "ugyldig konfig" });
    return null;
  }
  if (config === null) return null;
  const sender = new HeartbeatSender({
    url: config.url, origin: config.origin, intervalMs: config.intervalSec * 1000, selfCheck: opts.selfCheck ?? loopbackSelfCheck(opts.port), log,
    ...(opts.send ? { send: opts.send } : {})
  });
  sender.start();
  return sender;
}
