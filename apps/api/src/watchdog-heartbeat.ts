// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { envInt } from "@jarvis/contracts";
import type { Watchdog } from "@jarvis/watchdog";
import { HeartbeatConfigError, HeartbeatSender, validateHeartbeatUrl, type HeartbeatLog, type PingFn } from "./heartbeat-sender.ts";
import { WATCHDOG_MIN_FRESH_MS, watchdogFreshLimitMs } from "./watchdog-status.ts";

/**
 * WP-OPS2a K3: EKSTERN dead man's switch for VAKTHUNDEN (`JARVIS_WATCHDOG_HEARTBEAT_URL`). AV som standard: uten URL sendes ingenting og ingen timer startes.
 *
 * Problemet: vakthunden kjører i worker-prosessen og kan ikke varsle om at worker selv er død, hengt eller har mistet databasen - en død vakthund er stille. Løsningen er den samme som for backup og for API-et
 * (`heartbeat-sender.ts`): stillhet = alarm hos eierens EGEN eksterne monitor. Workeren pinger monitoren KUN mens
 *  1. vakthundens siste FULLFØRTE tikk er yngre enn max(3 x vakthund-intervallet, 2 min) (`Watchdog.lastCompletedTickAgeMs()`, målt med en MONOTON klokke så et hopp i veggklokken aldri gjør en hengt vakthund fersk; et hengt tikk, en hengt sjekk
 *     eller en hengt varslingssink flytter det aldri), OG
 *  2. databasen svarer på `SELECT 1` innen 3 s (en ping-spørring som fortsatt henger fra forrige runde stables ikke på).
 * Ellers sendes INGENTING - og aldri et «feiler»-ping: en død eller hengt worker skal se ut som det den er, nemlig fravær av ping. Monitoren (eierens valg, ingen leverandør bygget inn) varsler når pinget uteblir.
 *
 * Sikkerhet: kun status (aldri innhold, tenant-data eller hemmeligheter i URL/kropp/headere). URL-en er selv en kapabilitet (nøkkelen står ofte i stien) og logges ALDRI - kun opprinnelsen (`https://vert`). Feilmeldingene
 * nevner variabelnavnet, aldri URL-en eller verdien. Utgående kall går via `guardedFetch` (se `heartbeat-sender.ts`). Alt her kan aldri velte workeren: timere er `unref`, og alle feil fanges.
 */
export const WATCHDOG_HEARTBEAT_URL_ENV = "JARVIS_WATCHDOG_HEARTBEAT_URL";
export const WATCHDOG_HEARTBEAT_INTERVAL_ENV = "JARVIS_WATCHDOG_HEARTBEAT_INTERVAL_SEC";
/** Gulvet for hvor gammelt siste fullførte tikk kan være: en vakthund med kort intervall får likevel minst 2 min før stillheten starter. */
export const WATCHDOG_HEARTBEAT_MIN_FRESH_MS = WATCHDOG_MIN_FRESH_MS;
export const WATCHDOG_HEARTBEAT_DB_TIMEOUT_MS = 3_000;
/** En `SELECT 1` som har hengt lenger enn dette (x databasefristen) regnes som tapt, og en ny kan startes - ellers kunne én aldri-avsluttet spørring gjøre heartbeaten stum for alltid, også etter at databasen er frisk. */
const HUNG_QUERY_RETRY_FACTOR = 10;
const USER_AGENT = "jarvis-watchdog-heartbeat/1";

export interface WatchdogHeartbeatConfig {
  url: string;
  intervalSec: number;
  /** Opprinnelsen (`https://vert`) - det eneste som noensinne logges. */
  origin: string;
}

/** `null` = AV (standard). Ugyldig URL/intervall kaster `HeartbeatConfigError` (meldingen nevner variabelen, aldri verdien). */
export function watchdogHeartbeatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WatchdogHeartbeatConfig | null {
  const raw = env[WATCHDOG_HEARTBEAT_URL_ENV]?.trim();
  if (raw === undefined || raw === "") return null;
  const url = validateHeartbeatUrl(raw, WATCHDOG_HEARTBEAT_URL_ENV);
  let intervalSec: number;
  try {
    intervalSec = envInt(WATCHDOG_HEARTBEAT_INTERVAL_ENV, 60, { min: 10, max: 3600 }, env);
  } catch {
    // `envInt` siterer den ubehandlede verdien; her kan en feilplassert URL havnet i intervall-variabelen, så meldingen er fast.
    throw new HeartbeatConfigError(`${WATCHDOG_HEARTBEAT_INTERVAL_ENV}: ugyldig verdi (heltall mellom 10 og 3600 sekunder)`);
  }
  return { url: url.toString(), intervalSec, origin: url.origin };
}

/**
 * `SELECT 1` mot runtime-poolen med klientside spørrefrist (`query_timeout` er en pg-opsjon per spørring, men mangler i @types/pg sin `QueryConfig`): en hengt tilkobling avbrytes og kastes av poolen i stedet for å stå.
 * Ingen tenant-kontekst trengs - spørringen leser ingen tabell.
 */
export function poolPing(pool: Pick<pg.Pool, "query">, timeoutMs: number = WATCHDOG_HEARTBEAT_DB_TIMEOUT_MS): () => Promise<unknown> {
  return () => pool.query({ text: "SELECT 1", query_timeout: timeoutMs } as pg.QueryConfig);
}

/** Hvor gammelt siste fullførte vakthund-tikk kan være før heartbeaten tier: max(3 x vakthund-intervallet, 2 min). SAMME formel som selvdiagnosens vakthund-leser (K1, `watchdogFreshLimitMs` i `watchdog-status.ts`): ÉN definisjon. */
export function watchdogTickMaxAgeMs(watchdogIntervalMs: number): number {
  return watchdogFreshLimitMs(watchdogIntervalMs);
}

export interface WatchdogHeartbeatSelfCheckDeps {
  /** Alderen på siste fullførte tikk kommer fra vakthundens MONOTONE klokke (`lastCompletedTickAgeMs`), aldri fra `Date.now()` (fiks-runde 1, A-L2). */
  watchdog: Pick<Watchdog, "lastCompletedTickAgeMs">;
  /** Vakthundens tikk-intervall (ms) - terskelen regnes av det. */
  intervalMs: number;
  /** `SELECT 1` mot runtime-poolen. */
  dbPing: () => Promise<unknown>;
  /** Klokke (ms) KUN for å tidfeste en hengt `SELECT 1` (relative differanser). Standard `performance.now()` (monoton); injiseres i tester. */
  now?: () => number;
  dbTimeoutMs?: number;
}

/**
 * Selvsjekken heartbeaten pinger på: ferskt FULLFØRT tikk OG databasen svarer innen fristen. Kaster aldri. Alder under 0, ikke-endelig alder og «aldri tikket» er IKKE ferskt - alderen kan ikke bevises. Strengt «yngre enn»: nøyaktig terskelen er stille.
 * Alderen er vakthundens MONOTONE alder (`lastCompletedTickAgeMs`): veggklokken kan hoppe (NTP, manuell endring), og et hopp bakover under en hengt vakthund ga ellers falske pings, et hopp frem falsk stillhet (fiks-runde 1, A-L2).
 */
export function watchdogHeartbeatSelfCheck(deps: WatchdogHeartbeatSelfCheckDeps): () => Promise<boolean> {
  const now = deps.now ?? (() => performance.now());
  const maxAgeMs = watchdogTickMaxAgeMs(deps.intervalMs);
  const dbTimeoutMs = deps.dbTimeoutMs ?? WATCHDOG_HEARTBEAT_DB_TIMEOUT_MS;
  // Én spørring av gangen: henger en `SELECT 1` fortsatt fra forrige runde, legges det ikke en ny oppå (ville tømt poolen for tilkoblinger mens databasen er nede) - men en som har hengt veldig lenge regnes som tapt.
  let inFlight: { since: number } | null = null;
  return async () => {
    try {
      const age = deps.watchdog.lastCompletedTickAgeMs();
      if (age === null) return false;
      if (!(age >= 0 && age < maxAgeMs)) return false;
      if (inFlight !== null && now() - inFlight.since < HUNG_QUERY_RETRY_FACTOR * dbTimeoutMs) return false;
      const query = Promise.resolve().then(() => deps.dbPing());
      const mine = { since: now() };
      inFlight = mine;
      const clear = (): void => { if (inFlight === mine) inFlight = null; };
      query.then(clear, clear);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([query, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("db_timeout")), dbTimeoutMs); })]);
        return true;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      return false;
    }
  };
}

export interface StartWatchdogHeartbeatOptions {
  env?: NodeJS.ProcessEnv;
  watchdog: Pick<Watchdog, "lastCompletedTickAgeMs">;
  /** Vakthundens tikk-intervall (ms). */
  watchdogIntervalMs: number;
  dbPing: () => Promise<unknown>;
  send?: PingFn;
  log?: HeartbeatLog;
  now?: () => number;
  dbTimeoutMs?: number;
}

/**
 * Starter heartbeaten hvis den er konfigurert (`null` uten URL = AV). Ugyldig konfig logges høyt (`watchdog_heartbeat_config_invalid`, uten URL) og starter IKKE - workeren lever videre; fravær av ping er alarmen.
 * Kaster aldri.
 */
export function startWatchdogHeartbeat(opts: StartWatchdogHeartbeatOptions): HeartbeatSender | null {
  const log: HeartbeatLog = opts.log ?? ((event) => console.log(JSON.stringify(event)));
  try {
    let config: WatchdogHeartbeatConfig | null;
    try {
      config = watchdogHeartbeatConfigFromEnv(opts.env ?? process.env);
    } catch (err) {
      log({ msg: "watchdog_heartbeat_config_invalid", error: err instanceof HeartbeatConfigError ? err.message.slice(0, 200) : `${WATCHDOG_HEARTBEAT_URL_ENV}: ugyldig konfig` });
      return null;
    }
    if (config === null) return null;
    const selfCheck = watchdogHeartbeatSelfCheck({
      watchdog: opts.watchdog, intervalMs: opts.watchdogIntervalMs, dbPing: opts.dbPing, ...(opts.now ? { now: opts.now } : {}), ...(opts.dbTimeoutMs !== undefined ? { dbTimeoutMs: opts.dbTimeoutMs } : {})
    });
    const sender = new HeartbeatSender({
      url: config.url, origin: config.origin, intervalMs: config.intervalSec * 1000, selfCheck, log, name: "watchdog_heartbeat", userAgent: USER_AGENT,
      ...(opts.send ? { send: opts.send } : {})
    });
    sender.start();
    return sender;
  } catch {
    try {
      log({ msg: "watchdog_heartbeat_start_failed", note: "heartbeaten er ikke startet (uventet feil); fravær av ping er alarmen" });
    } catch {
      // selv loggingen feilet - workeren skal uansett aldri velte av heartbeaten
    }
    return null;
  }
}
