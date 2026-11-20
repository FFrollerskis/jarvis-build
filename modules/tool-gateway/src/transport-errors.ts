import { UnsafeVendorUrlError } from "./url-safety.ts";

/**
 * WP-K (D-471, JARVIS-018, review M1): hva en feil fra en transport SIER om hvorvidt forespørselen kan ha nådd leverandøren.
 *
 * `ToolGateway` skiller «kastet leverandørfeil» (`failed`: ingen bekreftet bivirkning, samme nøkkel kan prøves på nytt) fra «utfall ukjent» (`unverified`: aldri retry-bar med samme nøkkel).
 * Til nå ble bare gatewayens EGET tidsavbrudd (`tool_timeout`) og transporter som selv kastet `outcome_unknown:...` regnet som ukjent. En transport-feil (`TimeoutError`/`AbortError` fra `fetch`s
 * eget tak, en socket som ble nullstilt etter sending, `fetch failed`) på en IKKE-IDEMPOTENT mutasjon (klasse C/D, `idempotent_external: false`) er nøyaktig samme situasjon: POST-en KAN ha blitt utført, og et
 * samme-nøkkel-replay sendte den en gang til. Funksjonene her er rene og deterministiske (ingen I/O) og klassifiserer KUN feilformen - hvilke verktøy det gjelder avgjør gatewayen.
 *
 * Feil som BEVISER at ingenting ble sendt (DNS, tilkobling nektet, TLS-oppsett, utrygg URL FØR sending) er IKKE ukjent utfall: de forblir `failed` (retry tillatt).
 *
 * Re-review (LOW 1): TRE former der leverandøren faktisk SVARTE, men transporten likevel kastet, er også ukjent utfall - svaret kan bety at mutasjonen ble utført:
 *  - `unsafe_vendor_url:unexpected_redirect_http_<status>` fra `guardedFetch` kastes ETTER at forespørselen er sendt og besvart 3xx (`303 See Other` er selve «POST utført, resultatet ligger her»-mønsteret).
 *    Alle ANDRE `UnsafeVendorUrlError` (ugyldig/utrygg URL) kastes FØR sending og er fortsatt «aldri sendt».
 *  - en feil som BÆRER en 2xx-`httpStatus` (`ControlTargetHttpError`/`CloudflareApiError`: «200, men kroppen var ikke JSON / ikke `success`»): leverandøren sa ja, transporten godtok ikke svaret.
 *  - en `SyntaxError` fra JSON-parsing (`await response.json()` på et 2xx-svar med uparserbar kropp).
 * Ikke dekket (se runbook §3): en transport som selv omskriver en nettverksfeil til en ny `Error` UTEN `cause`/`code` (feilformen er da usynlig her), HTTP 5xx-svar, og en `SyntaxError` som
 * kastes av en transport som JSON-parser modellstyrt inndata FØR sending (gir `unverified` i stedet for `failed` - konservativ retning, krever avstemming/ny nøkkel).
 */
const PRE_SEND_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "ERR_INVALID_URL", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE"
]);
/** TLS-/sertifikatfeil oppstår i håndtrykket, FØR forespørselen sendes. */
const PRE_SEND_CODE_PREFIXES: readonly string[] = ["CERT_", "ERR_TLS_", "ERR_SSL_", "DEPTH_ZERO_", "UNABLE_TO_", "SELF_SIGNED_", "HOSTNAME_MISMATCH"];
/** Feilkoder som oppstår ETTER at forbindelsen er oppe (nullstilt/avbrutt/tidsavbrutt underveis): leverandøren kan ha mottatt og utført forespørselen. */
const INDETERMINATE_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED", "UND_ERR_RESPONSE_EXCEEDED_MAX_SIZE", "ERR_STREAM_PREMATURE_CLOSE"
]);
const INDETERMINATE_MESSAGE = /^(?:fetch failed|terminated|network error|socket hang up|other side closed|The operation was aborted|This operation was aborted)\b/i;
/** `UnsafeVendorUrlError.message` = `unsafe_vendor_url:<reason>`; kun redirect-årsaken (`unexpected_redirect_http_<status>`) kastes ETTER sending. */
const UNEXPECTED_REDIRECT_MESSAGE = /^unsafe_vendor_url:unexpected_redirect_/;
/** V8/undici sine JSON-parsefeil nevner alltid «JSON» («Unexpected token ... is not valid JSON», «Unexpected end of JSON input», «... in JSON at position N»). */
const JSON_SYNTAX_MESSAGE = /JSON/i;
const MAX_DEPTH = 5;

interface ErrorNode { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; errors?: unknown; httpStatus?: unknown }

/** Feilen og dens `cause`-kjede (og `AggregateError.errors`), begrenset i dybde. Kaster aldri (en getter som kaster gir en tom node). */
function nodesOf(err: unknown): ErrorNode[] {
  const out: ErrorNode[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return;
    const node: ErrorNode = {};
    try {
      const raw = value as ErrorNode;
      node.name = raw.name; node.code = raw.code; node.message = raw.message; node.httpStatus = raw.httpStatus;
    } catch { /* en kastende getter gir en tom node */ }
    out.push(node);
    try {
      const raw = value as ErrorNode;
      visit(raw.cause, depth + 1);
      if (Array.isArray(raw.errors)) for (const inner of raw.errors.slice(0, 4)) visit(inner, depth + 1);
    } catch { /* ignorer */ }
  };
  visit(err, 0);
  return out;
}

const codeOf = (node: ErrorNode): string | undefined => (typeof node.code === "string" ? node.code : undefined);
const nameOf = (node: ErrorNode): string | undefined => (typeof node.name === "string" ? node.name : undefined);
const messageOf = (node: ErrorNode): string | undefined => (typeof node.message === "string" ? node.message : undefined);

/** `guardedFetch` sendte forespørselen og leverandøren svarte 3xx (kastet først ETTER svaret - aldri «ikke sendt»). */
const isUnexpectedRedirect = (node: ErrorNode): boolean => nameOf(node) === "UnsafeVendorUrlError" && UNEXPECTED_REDIRECT_MESSAGE.test(messageOf(node) ?? "");
/** Leverandøren svarte 2xx, men transporten kastet likevel (kroppen ikke JSON, ikke `success`, for stor ...): svaret kan bety «utført». */
const isAnsweredSuccessStatus = (node: ErrorNode): boolean => typeof node.httpStatus === "number" && node.httpStatus >= 200 && node.httpStatus <= 299;
/** `Response.json()`/`JSON.parse` på et svar (2xx) som ikke kunne tolkes. */
const isJsonSyntaxError = (node: ErrorNode): boolean => nameOf(node) === "SyntaxError" && JSON_SYNTAX_MESSAGE.test(messageOf(node) ?? "");

/** `true` når feilen er en transport-/nettverksfeil der forespørselen KAN ha nådd leverandøren (utfallet er ukjent). */
export function isIndeterminateTransportError(err: unknown): boolean {
  const nodes = nodesOf(err);
  // Leverandøren SVARTE 3xx etter at forespørselen var sendt: ukjent utfall (en feil-tolket redirect er IKKE «aldri sendt»). Må sjekkes FØR «utrygg URL = aldri sendt» under.
  if (nodes.some(isUnexpectedRedirect)) return true;
  if (err instanceof UnsafeVendorUrlError) return false; // aldri sendt (ugyldig/utrygg URL avvist FØR fetch)
  if (nodes.length === 0) return false;
  for (const node of nodes) {
    const code = codeOf(node);
    if (code !== undefined && (PRE_SEND_CODES.has(code) || PRE_SEND_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)))) return false;
  }
  for (const node of nodes) {
    const name = nameOf(node);
    if (name === "TimeoutError" || name === "AbortError") return true;
    const code = codeOf(node);
    if (code !== undefined && INDETERMINATE_CODES.has(code)) return true;
    if (isAnsweredSuccessStatus(node) || isJsonSyntaxError(node)) return true;
  }
  const rootMessage = nodes[0]!.message;
  return typeof rootMessage === "string" && INDETERMINATE_MESSAGE.test(rootMessage);
}

/**
 * WP-D3 review H1 (D-459): det MOTSATTE standardvalget av `isIndeterminateTransportError`. Den er bevisst smal (kun KJENTE former = ukjent utfall) og passer for gatewayens generelle regel. En transport som VET at
 * forespørselen er en mutasjon (growth-skriving) må derimot regne ENHVER feil som ikke er BEVIST «aldri sendt» som ukjent utfall: en feilform vi ikke kjenner kan like godt ha oppstått ETTER at leverandøren behandlet
 * forespørselen (en nullstilt socket, en avbrutt lesing, et svar vi ikke tolker). `true` KUN når feilen beviser at INGEN byte av forespørselen nådde leverandøren: utrygg/ugyldig URL avvist før fetch, DNS, tilkobling
 * nektet/nådde ikke frem, TLS-oppsett (samme kodelister som over). En 3xx fra leverandøren er motsatt (svaret kom) og er aldri «før sending», og en feil som OGSÅ bærer en etter-sending-kode er aldri «bevist».
 */
export function isProvenPreSendTransportError(err: unknown): boolean {
  const nodes = nodesOf(err);
  if (nodes.some(isUnexpectedRedirect)) return false;
  if (err instanceof UnsafeVendorUrlError) return true; // ugyldig/utrygg URL avvist FØR fetch
  if (nodes.length === 0) return false;
  for (const node of nodes) {
    const name = nameOf(node);
    const code = codeOf(node);
    if (name === "TimeoutError" || name === "AbortError" || (code !== undefined && INDETERMINATE_CODES.has(code)) || isAnsweredSuccessStatus(node) || isJsonSyntaxError(node)) return false;
  }
  return nodes.some((node) => {
    const code = codeOf(node);
    return code !== undefined && (PRE_SEND_CODES.has(code) || PRE_SEND_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)));
  });
}

/** Kort, fast etikett for hvilken type transportfeil det var (aldri feilteksten): brukes i årsakskoden `outcome_unknown:transport_<kind>`. `redirect`/`response` = leverandøren SVARTE (3xx / uforståelig 2xx). */
export function transportErrorKind(err: unknown): "timeout" | "aborted" | "reset" | "redirect" | "response" | "network" {
  const nodes = nodesOf(err);
  if (nodes.some((n) => nameOf(n) === "TimeoutError" || codeOf(n) === "UND_ERR_HEADERS_TIMEOUT" || codeOf(n) === "UND_ERR_BODY_TIMEOUT" || codeOf(n) === "ETIMEDOUT")) return "timeout";
  if (nodes.some((n) => nameOf(n) === "AbortError" || codeOf(n) === "UND_ERR_ABORTED")) return "aborted";
  if (nodes.some((n) => ["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"].includes(codeOf(n) ?? ""))) return "reset";
  if (nodes.some(isUnexpectedRedirect)) return "redirect";
  if (nodes.some((n) => isAnsweredSuccessStatus(n) || isJsonSyntaxError(n))) return "response";
  return "network";
}
