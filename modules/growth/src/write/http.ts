import { OUTCOME_UNKNOWN_PREFIX, abortableSleep, afterAcceptedMutation, guardedFetch, isProvenPreSendTransportError, redactVendorText, throwIfAborted, transportErrorKind } from "@jarvis/tool-gateway";

/**
 * WP-D3 (UA-4 Growth, D-459): ÉN felles HTTP-klient for alle skrivetransportene (Google Ads, Meta, GA4, Search Console, Business Profile, YouTube, LinkedIn, TikTok). Rå REST via
 * `guardedFetch` (ingen leverandør-SDK, CLAUDE.md regel 3): kun http(s) mot en ren vert, ingen `.`/`..`-segmenter, ingen redirects (`redirect: "reject"` - en 3xx på en mutasjon er et
 * ukjent utfall, aldri noe som følges med Authorization/kropp), kallsignalet fra gatewayen avbryter forespørselen (WP-K).
 *
 * RETRY (JARVIS-018): lesing gjentas på 429/5xx (maks 3 forsøk, eksponentiell backoff, `Retry-After` respekteres opp til 10 s); en MUTASJON gjentas KUN på 429 (avslag FØR behandling).
 *
 * UTFALL UKJENT (review H1, D-459): for en MUTASJON er ALT som ikke er BEVIST «aldri sendt» eller et entydig leverandøravslag (4xx) et UKJENT utfall - aldri en vanlig feil som inviterer til en ny, dobbel
 * skriving og som låser journalraden som terminal `failed`. Konkret: (a) en transportfeil ETTER at forespørselen kan ha nådd leverandøren (nullstilt socket, tidsavbrudd, `fetch failed`, avbrutt lesing av svaret,
 * ukjent feilform) kastes som `outcome_unknown:<etikett>_transport_<art>` via den delte `afterAcceptedMutation` (WP-K) - unntatt feil som BEVISER at ingenting ble sendt (ugyldig URL/konfig, DNS, tilkobling nektet,
 * TLS-oppsett: `isProvenPreSendTransportError`), som forblir vanlige feil; (b) en 5xx eller 3xx (også en uventet redirect: `redirect: "reject"`) er `outcome_unknown:<etikett>_http_<status>`; (c) et 2xx-svar som ikke
 * kan tolkes er `outcome_unknown:<etikett>_response_unreadable`. Feil mens forespørselen BYGGES (JSON-serialisering) kastes før noe sendes og er vanlige feil. Gatewayen merker raden `unverified` (aldri retry-bar med
 * samme nøkkel), journalen står som `outcome_unknown` (kan senere avklares), og klasse D-eieren varsles («UTFALL UKJENT»).
 *
 * HEMMELIGHETER: credential og access token havner aldri i URL-en (Meta bruker body/header der det er verifisert), aldri i feilmeldinger (kjente verdier vaskes, deretter den sentrale
 * skanneren via `redactVendorText`), aldri i utdata. Feilmeldingene har en fast form: `<etikett>_error_<status>:<kode>:<redigert melding>` (≤ 200 tegn).
 */
export class GrowthVendorError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly retryable: boolean, readonly vendorCode?: string) {
    super(message);
    this.name = "GrowthVendorError";
  }
}

export interface VendorRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Starter med «/». Segmenter skal være validert/kodet av kalleren (`encodePathSegment`/streng id-sjekk). */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** JSON-kropp (serialiseres her). */
  body?: unknown;
  /** `true` = en tilstandsendrende forespørsel (styrer retry og ukjent-utfall-klassifiseringen). */
  mutation?: boolean;
  /** 404 gir `null` i stedet for en feil (preflight/readback for «finnes ikke»). */
  allowNotFound?: boolean;
  /** Verdier som skal vaskes bort fra feiltekst (credential, access token ...). */
  secrets?: readonly string[];
}

export interface VendorHttpOptions {
  /** Kort etikett i feilkoder (`google_ads`, `meta_ads` ...). */
  label: string;
  baseUrl: string;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_BODY_CHARS = 1_000_000;

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[REDACTED]");
  return out;
}

/** Trekker en kort kode og melding ut av de vanlige feilkonvoluttene (Google `{error:{status,message}}`, Meta `{error:{type,code,message}}`, `{errors:[{message}]}`, `{message,code}`). */
export function classifyVendorError(raw: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const err = (parsed["error"] ?? (Array.isArray(parsed["errors"]) ? (parsed["errors"] as unknown[])[0] : undefined) ?? parsed) as Record<string, unknown>;
    const code = String(err["status"] ?? err["type"] ?? err["code"] ?? parsed["code"] ?? "UNKNOWN").slice(0, 40);
    const message = typeof err["message"] === "string" ? err["message"] : typeof parsed["message"] === "string" ? parsed["message"] : "";
    return { code, message };
  } catch {
    return { code: "UNCLASSIFIED", message: "" };
  }
}

/**
 * Review H1: en feil fra selve sendingen/lesingen av svaret på en MUTASJON. `afterAcceptedMutation` (WP-K) lar en feil som ALLEREDE er ukjent utfall (`tool_timeout`, `outcome_unknown:...`) gå uendret videre og
 * gjør alt annet om til `outcome_unknown:<kode>` - unntatt feil som BEVISER at ingenting ble sendt (`keep`). Kasterer alltid.
 */
function afterSendFailure(label: string, err: unknown): Promise<never> {
  return afterAcceptedMutation<never>(`${label}_transport_${transportErrorKind(err)}`, () => { throw err; }, { keep: isProvenPreSendTransportError });
}

export class VendorHttp {
  constructor(private readonly options: VendorHttpOptions) {}

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : abortableSleep(ms);
  }

  async request(r: VendorRequest): Promise<{ status: number; json: unknown } | null> {
    const label = this.options.label;
    const mutation = r.mutation === true;
    const query = new URLSearchParams(Object.entries(r.query ?? {}).sort(([a], [b]) => a.localeCompare(b))).toString();
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}${r.path}${query.length > 0 ? `?${query}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json", ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...(r.headers ?? {}) };
    // Review H1: kroppen serialiseres FØR noe sendes - en feil her (sirkulær struktur, BigInt) er en bevist «aldri sendt»-feil og forblir en vanlig feil.
    const body = r.body !== undefined ? JSON.stringify(r.body) : undefined;
    let last: GrowthVendorError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // WP-K: et avbrutt kall sender aldri et nytt forsøk (en mutasjon kan allerede ha nådd leverandøren; gatewayen har merket utfallet ukjent).
      throwIfAborted();
      let response: Response;
      try {
        response = await guardedFetch(url, { method: r.method, redirect: "reject", headers, ...(body !== undefined ? { body } : {}) });
      } catch (err) {
        throw mutation ? await afterSendFailure(label, err) : err;
      }
      if (response.status === 404 && r.allowNotFound === true) return null;
      let text = "";
      try {
        text = (await response.text()).slice(0, MAX_BODY_CHARS);
      } catch (err) {
        // Svaret kunne ikke leses ferdig (nullstilt/avbrutt midt i kroppen). Et 2xx-svar vi ikke kan lese betyr at leverandøren KAN ha behandlet mutasjonen (ukjent utfall); for lesing er det en feil. En 4xx/5xx
        // er allerede et svar (statusen avgjør under), så kroppen mangler bare for feilmeldingen.
        if (response.ok) {
          if (mutation) await afterSendFailure(label, err);
          throw new GrowthVendorError(`${label}_invalid_response:body_unreadable`, response.status, false);
        }
      }
      if (response.ok) {
        if (text.trim().length === 0) return { status: response.status, json: {} };
        try {
          return { status: response.status, json: JSON.parse(text) as unknown };
        } catch {
          // 2xx men uforståelig kropp: leverandøren sa ja. For en mutasjon er utfallet UKJENT; for lesing en vanlig feil.
          if (mutation) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:${label}_response_unreadable`);
          throw new GrowthVendorError(`${label}_invalid_response:non_json`, response.status, false);
        }
      }
      const c = classifyVendorError(text);
      const message = redactVendorText(scrub(c.message, r.secrets ?? []), 160);
      const retryable = response.status === 429 || (!mutation && response.status >= 500 && response.status <= 504);
      // Review H1: kun et entydig leverandøravslag (4xx) beviser at mutasjonen IKKE ble behandlet. 5xx og alle andre ikke-2xx-svar (3xx) er et ukjent utfall.
      if (mutation && !(response.status >= 400 && response.status < 500)) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:${label}_http_${response.status}`);
      last = new GrowthVendorError(`${label}_error_${response.status}:${c.code.replace(/[^A-Za-z0-9_.:-]/g, "_")}${message ? `:${message}` : ""}`.slice(0, 200), response.status, retryable, c.code);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw last!;
  }
}
