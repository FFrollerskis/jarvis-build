/**
 * D-392 (JARVIS-019): felles HTTP-disiplin for alle finansleverandører. Uten tidsavbrudd kunne et hengende leverandørkall holde en
 * DB-forbindelse/radlås (og en `ToolGateway`-slot) åpen for alltid; uten retry-regel ble en 5xx på en NY betaling/journalpost gjentatt
 * selv om leverandøren kan ha utført den første (Fiken/Neonomics/Wallester har ingen Idempotency-Key).
 */
import { abortableSleep, composeSignals, currentCallSignal, throwIfAborted } from "@jarvis/tool-gateway";

export const FINANCE_FETCH_TIMEOUT_MS = 20_000;

/** Kun det egne 20 s-taket. Bruk `financeFetch` for alle leverandørkall: den setter taket SAMMEN med gatewayens kallsignal (WP-FIN2, K2). */
export function financeSignal(): AbortSignal {
  return AbortSignal.timeout(FINANCE_FETCH_TIMEOUT_MS);
}

/**
 * WP-FIN2 (D-486, K2; JARVIS-018-resten): DEN ENE `fetch` for alle finansleverandørene (Stripe, Vipps, Neonomics, Wallester, Fiken). Gatewayens `timeout_ms` (30 s for pengehandlingene) avbrøt tidligere IKKE
 * finansforespørslene: de hadde kun det egne 20 s-taket (`financeSignal`) og en ikke-avbrytbar `sleep` mellom forsøkene, så en retry-løkke kunne sende en ny forespørsel ETTER at gatewayen hadde meldt
 * «utfall ukjent». Nå:
 *   - FØR hvert forsøk: `throwIfAborted()` - er kallet allerede avbrutt (gateway-tidsavbrudd, nøstet kall), sendes ingenting;
 *   - signalet er `composeSignals(<kallsignalet>, AbortSignal.timeout(20 s))`: den som slår inn først avbryter forespørselen (ambient signal fra `invokeWithCallSignal`, eller eksplisitt `signal` fra en kaller);
 *   - med `JARVIS_TOOL_CALL_ABORT=off` finnes det intet kallsignal, og dette er identisk med oppførselen før (kun 20 s-taket).
 * Hva et avbrudd BETYR bestemmes av kalleren, ikke her: en mutasjon (POST/PATCH) som avbrytes har UKJENT utfall (`classifyProviderFailure` -> `unknown` -> `ProviderOutcomeUnknownError`/flagg);
 * en lesing feiler uten flagg. `isRetrySafe` er uendret.
 */
export function financeFetch(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const callSignal = signal ?? currentCallSignal();
  throwIfAborted(callSignal);
  return fetch(url, { ...init, signal: composeSignals(callSignal, AbortSignal.timeout(FINANCE_FETCH_TIMEOUT_MS))! });
}

/** Ventetiden mellom forsøk (backoff): avbrytes av kallsignalet og rydder timeren - aldri en uavbrytbar `sleep` som lar en retry gå ut etter fristen. */
export function financeBackoff(ms: number, signal?: AbortSignal): Promise<void> {
  return abortableSleep(ms, signal ?? currentCallSignal());
}

/**
 * 429 er et avslag FØR behandling og kan alltid gjentas. 5xx gjentas kun for lesing (GET/HEAD) eller når kallet bærer en Idempotency-Key
 * (leverandøren slår da sammen duplikater). En mutasjon uten nøkkel som får 5xx kan allerede være utført - da kastes feilen, aldri en retry.
 */
export function isRetrySafe(method: string, status: number, hasIdempotencyKey: boolean): boolean {
  if (status === 429) return true;
  if (status < 500) return false;
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || hasIdempotencyKey;
}
