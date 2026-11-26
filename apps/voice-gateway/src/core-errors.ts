/**
 * WP-V2 FIX-5 (F5): skillet mellom en Core-feil der forespørselen BEVISELIG aldri nådde Core, og alt annet (ukjent utfall).
 *
 * Etter at en tur har tatt claimen i utterance-journalen regnes den som UTFØRT i alle utfall (et Core-kall som feilet underveis kan ha
 * utført verktøy, og en replay skal aldri utføre dem på nytt). Unntaket er en feil som BEVISER at ingenting ble sendt: da frigjøres claimen
 * så klienten kan sende samme `utterance_id` på nytt og kommandoen ikke går tapt.
 *
 * BEVISET er Node-feilens `syscall`: `connect` (TCP-tilkoblingen kom aldri i stand) eller `getaddrinfo` (DNS) betyr at ingen byte kan være
 * skrevet til Core. Målt mot Node 22 sin `fetch`: lukket port gir `TypeError: fetch failed` med `cause {code: ECONNREFUSED, syscall: connect}`,
 * DNS-feil `cause {code: ENOTFOUND, syscall: getaddrinfo}`; en socket serveren dreper ETTER mottatt forespørsel gir `UND_ERR_SOCKET` UTEN syscall
 * (ukjent utfall). Alt uten dette beviset - lese-/skrive-/reset-feil, timeout, avbrudd, HTTP-feil, tilkoblings-timeout uten syscall - er UKJENT: claimen
 * beholdes og forespørselen prøves aldri på nytt (dobbel-ACT er verre enn en tapt kommando som klienten ser og kan gjenta med ny id).
 *
 * FIX-3 (runde 2, F12): en REDIRECT fra Core er også UKJENT. `HttpCoreClient` bruker `redirect: "error"` (aldri å følge): fulgte `fetch` en 307/308 til en vert som ga
 * ECONNREFUSED/ENOTFOUND, ville `syscall` pekt på redirect-MÅLET og feilaktig bevist «ikke sendt», selv om det redirectende leddet hadde mottatt hele turen. Nå kaster
 * `fetch` en feil UTEN `syscall` (`unexpected redirect`), som regnes som ukjent utfall.
 */

/** Core nådde aldri forespørselen (ingenting ble skrevet til en socket). Meldingen er en kort kode (aldri innhold). */
export class CoreRequestNotSentError extends Error {
  readonly requestNotSent = true as const;
  constructor(message: string) {
    super(message);
    this.name = "CoreRequestNotSentError";
  }
}

/** `voice_session_required` kastes av `HttpCoreClient` FØR noe HTTP-kall (ubevist sti). */
const SESSION_REQUIRED = "voice_session_required";
/** De to fasene FØR en forespørsel kan være skrevet: TCP-tilkobling og DNS-oppslag. */
const PRE_SEND_SYSCALLS = new Set(["connect", "getaddrinfo"]);
const MAX_CAUSE_DEPTH = 4;

/** Følger `cause`-kjeden (og alle delfeil i en AggregateError). `true` KUN når hver gren ender i en feil fra tilkoblings-/DNS-fasen. */
function provesNotSent(err: unknown, depth: number): boolean {
  if (typeof err !== "object" || err === null || depth > MAX_CAUSE_DEPTH) {
    return false;
  }
  const { syscall, errors, cause } = err as { syscall?: unknown; errors?: unknown; cause?: unknown };
  if (typeof syscall === "string") {
    return PRE_SEND_SYSCALLS.has(syscall);
  }
  if (Array.isArray(errors)) {
    return errors.length > 0 && errors.every((e) => provesNotSent(e, depth + 1));
  }
  return provesNotSent(cause, depth + 1);
}

/** Første feilkode i kjeden (kun `[A-Za-z0-9_]`, aldri tekst) - til loggmeldingen. */
function firstCode(err: unknown, depth = 0): string | undefined {
  if (typeof err !== "object" || err === null || depth > MAX_CAUSE_DEPTH) {
    return undefined;
  }
  const { code, errors, cause } = err as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) {
    return code;
  }
  if (Array.isArray(errors)) {
    for (const e of errors) {
      const found = firstCode(e, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return firstCode(cause, depth + 1);
}

/** `true` bare når feilen BEVISER at forespørselen aldri nådde Core. Ukjent/tvetydig = `false` (claimen beholdes). */
export function isRequestNotSent(err: unknown): boolean {
  if (err instanceof CoreRequestNotSentError) {
    return true;
  }
  if (err instanceof Error && err.message === SESSION_REQUIRED) {
    return true;
  }
  return provesNotSent(err, 0);
}

/** Brukes rundt `fetch` mot Core: en feil fra tilkoblings-/DNS-fasen blir en `CoreRequestNotSentError`; alt annet gis uendret videre. */
export function classifyFetchFailure(err: unknown): unknown {
  return provesNotSent(err, 0) ? new CoreRequestNotSentError(`core_unreachable:${firstCode(err) ?? "connect"}`) : err;
}
