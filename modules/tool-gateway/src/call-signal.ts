import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolInvocationContext, ToolTransport } from "./gateway.ts";

/**
 * WP-K (D-471, JARVIS-018): AVBRUDDSSIGNAL for ett verktøykall.
 *
 * FØR: `ToolGateway` sin `withTimeout` avviste bare løftet etter `timeout_ms` - selve leverandørforespørselen (og en evt. retry-løkke bak den) levde videre til `guardedFetch` sin
 * 45 s-grense, og en POST som ble satt i gang FØR tidsavbruddet kunne både fullføre og (via en retry) sendes en gang til ETTER at gatewayen hadde meldt «utfall ukjent».
 *
 * NÅ: gatewayen oppretter en `AbortController` per leverandørkall, avbryter den når tidsavbruddet slår inn, og gir signalet til transporten på TO måter:
 *   1. som EKSPLISITT 5. parameter på `ToolTransport.invoke(action, parameters, credential, context, signal?)` - kontrakten for transporter som ikke går via `guardedFetch`
 *      (prosess-/DB-/egen-`fetch`-transporter må selv koble signalet til sin I/O: Docker, Postgres-drift, nettleser-gatewayen, annonse-transportene);
 *   2. som AMBIENT kontekst (`AsyncLocalStorage`) rundt hele kallet, som `guardedFetch` plukker opp hvis kalleren IKKE har satt et eget signal. Dette er bevisst: `live-transports.ts` har ~70
 *      `guardedFetch`-kallesteder, og dekning «ved konstruksjon» er tryggere enn dekning «ved at hver transport husker å sende signalet videre» (en glemt kallested ville stille falt tilbake til
 *      den gamle oppførselen). Transporter med eget signal (eksplisitt `signal` i `guardedFetch`-init) velger bort det ambiente og må selv sette sammen (`composeSignals`).
 *
 * Retry-/poll-løkker MÅ (a) kalle `throwIfAborted()` FØR hvert nytt forsøk og (b) vente med `abortableSleep()`: etter et tidsavbrudd skal ingen NY forespørsel sendes - særlig ikke en
 * ikke-idempotent POST (gatewayen har da allerede merket utfallet `unverified`, aldri retry-bart med samme nøkkel).
 *
 * DELT TILSTAND: en pågående, delt operasjon (f.eks. OAuth-token-utveksling som flere samtidige kall venter på) skal IKKE dø med første kallers tidsavbrudd. Slike operasjoner starter via
 * `detachFromCallSignal()` (egen 45 s-grense), og hver kaller venter med `raceCallSignal()` slik at DENNES eget tidsavbrudd likevel slipper den fri.
 */
const store = new AsyncLocalStorage<{ signal: AbortSignal | undefined }>();

/** Signalet for kallet som kjører akkurat nå (satt av `invokeWithCallSignal`/`runWithCallSignal`), ellers `undefined`. */
export function currentCallSignal(): AbortSignal | undefined {
  return store.getStore()?.signal;
}

/** Kjør `fn` med `signal` som ambient kallsignal. Nøstede kall (en transport som selv kaller `gateway.execute()`) får sitt EGET signal og skygger dette. */
export function runWithCallSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return store.run({ signal }, fn);
}

/** Kjør `fn` UTEN ambient kallsignal (delt arbeid som ikke skal avbrytes av én kallers frist). */
export function detachFromCallSignal<T>(fn: () => T): T {
  return store.run({ signal: undefined }, fn);
}

/**
 * Setter sammen flere signaler til ett (`undefined` ignoreres). Ingen signaler = `undefined`; ett = selve signalet; flere = `AbortSignal.any`.
 * Brukes av transporter med eget tidsavbrudd: `composeSignals(signal ?? currentCallSignal(), AbortSignal.timeout(ms))`.
 */
export function composeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

/** Avbruddsårsaken som en `Error` (gatewayens tidsavbrudd gir `Error("tool_timeout")`, som `isOutcomeUnknownMessage` kjenner igjen). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("call_aborted");
}

/** Kaster avbruddsårsaken hvis signalet er avbrutt. Uten argument brukes det ambiente kallsignalet. */
export function throwIfAborted(signal: AbortSignal | undefined = currentCallSignal()): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** `setTimeout` som slutter å vente (og rydder timeren) når signalet avbrytes. Avviser med avbruddsårsaken. Uten signal oppfører den seg som en vanlig sleep. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined = currentCallSignal()): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Slutt å VENTE på `promise` når signalet avbrytes (selve operasjonen avbrytes IKKE). For delt arbeid: kalleren slipper fri ved eget tidsavbrudd, mens
 * den delte operasjonen fortsetter for de andre som venter på den.
 */
export function raceCallSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined = currentCallSignal()): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined); // den delte operasjonen kan avvise senere - ingen ubehandlet avvisning
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener("abort", onAbort); reject(err); }
    );
  });
}

/**
 * En transport som tar imot det EKSPLISITTE `signal`-argumentet gjør det til det ambiente kallsignalet for varigheten av `fn` (med mindre det allerede ER det): da dekker samme
 * kodevei både gatewayen (som gir begge deler) og en kaller som bare gir argumentet (tester, skript), uten at hver intern hjelpefunksjon må ta imot signalet som parameter.
 */
export function adoptCallSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  if (signal === undefined || signal === currentCallSignal()) return fn();
  return runWithCallSignal(signal, fn);
}

/**
 * Det ENE stedet som definerer hvordan en transport kalles med en frist: eksplisitt 5. parameter OG ambient kontekst. Gatewayen bruker denne for hovedkallet og readback;
 * tester kan bruke den for å kjøre en transport under et signal uten å gå via gatewayen.
 */
export function invokeWithCallSignal(
  transport: ToolTransport,
  action: string,
  parameters: Record<string, JsonValue>,
  credential: string,
  context: ToolInvocationContext,
  signal: AbortSignal
): Promise<{ external_id?: string; data?: JsonValue }> {
  return runWithCallSignal(signal, () => transport.invoke(action, parameters, credential, context, signal));
}
