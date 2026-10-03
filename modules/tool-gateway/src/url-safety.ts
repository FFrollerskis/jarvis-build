/**
 * Remediering del 2 (JARVIS-091): modellstyrte id-er interpoleres i leverandørenes URL-stier.
 * `encodeURIComponent("..")` er FORTSATT `..`, og WHATWG-URL-parseren normaliserer `/files/../admin` til `/admin` FØR
 * forespørselen sendes - endepunktet endres altså under den opprinnelige kapabilitetsklassen/revisjonen (en `read`-handling
 * kan ende på et helt annet endepunkt). Forsvaret er todelt og sentralt:
 *   1. `encodePathSegment` for rene id-segmenter (avviser `.`/`..`/tom/`/`/`\\`/`?`/`#`/kontrolltegn),
 *   2. `guardedFetch`: ALLE utgående leverandørkall sjekkes på den RÅ URL-strengen FØR de sendes - kun http(s) mot en ren vert[:port], ingen
 *      brukerinfo/backslash/kontrolltegn, fast vert, og ingen `.`/`..`-segmenter (heller ikke prosentkodet `%2e`).
 */
export class UnsafeVendorUrlError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe_vendor_url:${reason}`);
    this.name = "UnsafeVendorUrlError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function isDotSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true; // ugyldig prosentkoding i en sti-segment = avvis
  }
  return decoded === "." || decoded === ".." || /^(\.|%2e)+$/i.test(segment);
}

/** Ett sti-segment fra en modell-/klientstyrt verdi. Avviser alt som kan endre stien; ellers `encodeURIComponent`. */
export function encodePathSegment(value: unknown, label = "id"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new UnsafeVendorUrlError(`${label}_invalid`);
  if (CONTROL.test(value) || /[/\\?#]/.test(value) || isDotSegment(value)) throw new UnsafeVendorUrlError(`${label}_unsafe`);
  return encodeURIComponent(value);
}

/** `owner/repo` (GitHub): to segmenter med lukket tegnsett, ingen `.`/`..`. */
export function assertGithubRepoSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value)) throw new UnsafeVendorUrlError("repo_invalid");
  const repo = value.split("/")[1] as string;
  if (repo === "." || repo === ".." || repo.startsWith("-")) throw new UnsafeVendorUrlError("repo_unsafe");
  return value;
}

/** Validerer den RÅ strengen. Kaster `UnsafeVendorUrlError`; returnerer URL-en uendret hvis den er trygg. */
export function assertSafeVendorUrl(raw: string): string {
  if (typeof raw !== "string" || CONTROL.test(raw) || raw.includes("\\")) throw new UnsafeVendorUrlError("url_malformed");
  const m = /^https?:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(raw);
  if (!m) throw new UnsafeVendorUrlError("url_not_plain_http_url");
  const path = m[2] ?? "";
  if (path.split("/").some((segment) => segment !== "" && isDotSegment(segment))) throw new UnsafeVendorUrlError("dot_segment");
  // Parseren må ende på NØYAKTIG samme vert og sti som den rå strengen (ingen stille normalisering).
  const parsed = new URL(raw);
  if (parsed.host.toLowerCase() !== m[1]!.toLowerCase() || parsed.pathname !== (path === "" ? "/" : path)) {
    throw new UnsafeVendorUrlError("normalization_changed_url");
  }
  return raw;
}

/** `fetch` med sentral URL-sikring. Kalles alltid med en streng-URL bygget av vendor-base + (kodede) segmenter. */
export async function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === "string" ? input : input.toString();
  assertSafeVendorUrl(raw);
  return fetch(raw, init);
}

/**
 * Del 3 (JARVIS-048): utgående parametre fra modell/klient valideres deterministisk FØR de når en leverandør.
 * Alle avvik kaster `UnsafeOutboundParameterError` (aldri en stille «rensing» som endrer hva som sendes).
 */
export class UnsafeOutboundParameterError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe_outbound_parameter:${reason}`);
    this.name = "UnsafeOutboundParameterError";
  }
}

/** En RFC 5322-header-verdi: ingen CR/LF/NUL/kontrolltegn (hemmelig Bcc/header-injeksjon), 1..max tegn. */
export function assertHeaderValue(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new UnsafeOutboundParameterError(`${label}_invalid`);
  if (CONTROL.test(value) || /[\u2028\u2029]/.test(value)) throw new UnsafeOutboundParameterError(`${label}_control_characters`);
  return value;
}

const EMAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** NØYAKTIG én ren adresse (`bruker@domene.tld`): ingen visningsnavn, kommaer, flere mottakere, vinkelparenteser eller kontrolltegn. */
export function assertSingleEmailAddress(value: unknown, label = "to"): string {
  const header = assertHeaderValue(value, label, 254);
  if (!EMAIL_ADDRESS.test(header)) throw new UnsafeOutboundParameterError(`${label}_not_a_single_address`);
  return header;
}

/** E.164: `+` og 8..15 sifre. SMS/WhatsApp-mottakere er alltid eksplisitte nummer. */
export function assertE164(value: unknown, label = "to"): string {
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value)) throw new UnsafeOutboundParameterError(`${label}_not_e164`);
  return value;
}

const DANGEROUS_SHEET_FUNCTIONS = /\b(IMPORT(?:DATA|XML|HTML|FEED|RANGE)|HYPERLINK|IMAGE|WEBSERVICE|QUERY|GOOGLEFINANCE|EXECUTE)\s*\(/i;

/** Celleverdier som kan evalueres som formler: ingen utgående/eksfiltrerende funksjoner selv når USER_ENTERED er eksplisitt tillatt. */
export function assertNoDangerousSheetFormulas(cells: unknown): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === "string" && /^\s*[=+\-@]/.test(value) && DANGEROUS_SHEET_FUNCTIONS.test(value)) {
      throw new UnsafeOutboundParameterError("sheet_formula_not_allowed");
    }
  };
  walk(cells);
}
