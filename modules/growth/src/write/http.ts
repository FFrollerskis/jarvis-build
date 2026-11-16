import { OUTCOME_UNKNOWN_PREFIX, abortableSleep, guardedFetch, redactVendorText, throwIfAborted } from "@jarvis/tool-gateway";

/**
 * WP-D3 (UA-4 Growth, D-459): ÉN felles HTTP-klient for alle skrivetransportene (Google Ads, Meta, GA4, Search Console, Business Profile, YouTube, LinkedIn, TikTok). Rå REST via
 * `guardedFetch` (ingen leverandør-SDK, CLAUDE.md regel 3): kun http(s) mot en ren vert, ingen `.`/`..`-segmenter, ingen redirects (`redirect: "reject"` - en 3xx på en mutasjon er et
 * ukjent utfall, aldri noe som følges med Authorization/kropp), kallsignalet fra gatewayen avbryter forespørselen (WP-K).
 *
 * RETRY (JARVIS-018): lesing gjentas på 429/5xx (maks 3 forsøk, eksponentiell backoff, `Retry-After` respekteres opp til 10 s); en MUTASJON gjentas KUN på 429 (avslag FØR behandling).
 * En 5xx på en mutasjon betyr at bivirkningen KAN ha skjedd: den kastes som `outcome_unknown:<etikett>_http_<status>` (gatewayen merker raden `unverified`, replay blokkeres og
 * klasse D-eieren varsles) - aldri en vanlig feil som inviterer til en ny, dobbel skriving. Et 2xx-svar som ikke kan tolkes etter en mutasjon er også ukjent utfall.
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

export class VendorHttp {
  constructor(private readonly options: VendorHttpOptions) {}

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : abortableSleep(ms);
  }

  async request(r: VendorRequest): Promise<{ status: number; json: unknown } | null> {
    const label = this.options.label;
    const query = new URLSearchParams(Object.entries(r.query ?? {}).sort(([a], [b]) => a.localeCompare(b))).toString();
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}${r.path}${query.length > 0 ? `?${query}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json", ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...(r.headers ?? {}) };
    let last: GrowthVendorError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // WP-K: et avbrutt kall sender aldri et nytt forsøk (en mutasjon kan allerede ha nådd leverandøren; gatewayen har merket utfallet ukjent).
      throwIfAborted();
      const response = await guardedFetch(url, { method: r.method, redirect: "reject", headers, ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}) });
      if (response.status === 404 && r.allowNotFound === true) return null;
      const text = (await response.text().catch(() => "")).slice(0, MAX_BODY_CHARS);
      if (response.ok) {
        if (text.trim().length === 0) return { status: response.status, json: {} };
        try {
          return { status: response.status, json: JSON.parse(text) as unknown };
        } catch {
          // 2xx men uforståelig kropp: leverandøren sa ja. For en mutasjon er utfallet UKJENT; for lesing en vanlig feil.
          if (r.mutation === true) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:${label}_response_unreadable`);
          throw new GrowthVendorError(`${label}_invalid_response:non_json`, response.status, false);
        }
      }
      const c = classifyVendorError(text);
      const message = redactVendorText(scrub(c.message, r.secrets ?? []), 160);
      const retryable = response.status === 429 || (r.mutation !== true && response.status >= 500 && response.status <= 504);
      if (r.mutation === true && response.status >= 500) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:${label}_http_${response.status}`);
      last = new GrowthVendorError(`${label}_error_${response.status}:${c.code.replace(/[^A-Za-z0-9_.:-]/g, "_")}${message ? `:${message}` : ""}`.slice(0, 200), response.status, retryable, c.code);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw last!;
  }
}
