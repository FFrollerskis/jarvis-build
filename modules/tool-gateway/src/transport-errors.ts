import { UnsafeVendorUrlError } from "./url-safety.ts";

/**
 * WP-K (D-471, JARVIS-018, review M1): hva en feil fra en transport SIER om hvorvidt forespørselen kan ha nådd leverandøren.
 *
 * `ToolGateway` skiller «kastet leverandørfeil» (`failed`: ingen bekreftet bivirkning, samme nøkkel kan prøves på nytt) fra «utfall ukjent» (`unverified`: aldri retry-bar med samme nøkkel).
 * Til nå ble bare gatewayens EGET tidsavbrudd (`tool_timeout`) og transporter som selv kastet `outcome_unknown:...` regnet som ukjent. En transport-feil (`TimeoutError`/`AbortError` fra `fetch`s
 * eget tak, en socket som ble nullstilt etter sending, `fetch failed`) på en IKKE-IDEMPOTENT mutasjon (klasse C/D, `idempotent_external: false`) er nøyaktig samme situasjon: POST-en KAN ha blitt utført, og et
 * samme-nøkkel-replay sendte den en gang til. Funksjonene her er rene og deterministiske (ingen I/O) og klassifiserer KUN feilformen - hvilke verktøy det gjelder avgjør gatewayen.
 *
 * Feil som BEVISER at ingenting ble sendt (DNS, tilkobling nektet, TLS-oppsett, utrygg URL) er IKKE ukjent utfall: de forblir `failed` (retry tillatt).
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
const MAX_DEPTH = 5;

interface ErrorNode { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }

/** Feilen og dens `cause`-kjede (og `AggregateError.errors`), begrenset i dybde. Kaster aldri (en getter som kaster gir en tom node). */
function nodesOf(err: unknown): ErrorNode[] {
  const out: ErrorNode[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return;
    const node: ErrorNode = {};
    try {
      const raw = value as ErrorNode;
      node.name = raw.name; node.code = raw.code; node.message = raw.message;
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

/** `true` når feilen er en transport-/nettverksfeil der forespørselen KAN ha nådd leverandøren (utfallet er ukjent). */
export function isIndeterminateTransportError(err: unknown): boolean {
  if (err instanceof UnsafeVendorUrlError) return false; // aldri sendt
  const nodes = nodesOf(err);
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
  }
  const rootMessage = nodes[0]!.message;
  return typeof rootMessage === "string" && INDETERMINATE_MESSAGE.test(rootMessage);
}

/** Kort, fast etikett for hvilken type transportfeil det var (aldri feilteksten): brukes i årsakskoden `outcome_unknown:transport_<kind>`. */
export function transportErrorKind(err: unknown): "timeout" | "aborted" | "reset" | "network" {
  const nodes = nodesOf(err);
  if (nodes.some((n) => nameOf(n) === "TimeoutError" || codeOf(n) === "UND_ERR_HEADERS_TIMEOUT" || codeOf(n) === "UND_ERR_BODY_TIMEOUT" || codeOf(n) === "ETIMEDOUT")) return "timeout";
  if (nodes.some((n) => nameOf(n) === "AbortError" || codeOf(n) === "UND_ERR_ABORTED")) return "aborted";
  if (nodes.some((n) => ["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"].includes(codeOf(n) ?? ""))) return "reset";
  return "network";
}
