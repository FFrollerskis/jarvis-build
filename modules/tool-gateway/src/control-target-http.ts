import { guardedFetch, isRetrySafeStatus } from "./url-safety.ts";

/**
 * WP-E1 (UA-5): felles, smal HTTP-klient for de SELVHOSTEDE kontrollerte skymålene (Langfuse, Infisical) - samme garantier som `cloudflare-transport.ts`, men uten
 * leverandørspesifikk logikk: alle kall går via `guardedFetch` (ren http(s)-URL, ingen sti-triks), credential KUN i headere, vaskes ut av alle feilmeldinger,
 * lesing gjentas på 429/5xx (begrenset), en mutasjon gjentas ALDRI på 5xx (bivirkningen kan ha skjedd - JARVIS-018; kun 429 = avslag før behandling), og
 * svarkroppen er begrenset (1 MB) slik at et ondsinnet/feilkonfigurert mål ikke kan fylle minnet.
 */
export class ControlTargetHttpError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly retryable: boolean) {
    super(message);
    this.name = "ControlTargetHttpError";
  }
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;
const RETRYABLE: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Vasker hver oppgitte hemmelighet (≥ 6 tegn) ut av en tekst. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join("[REDACTED]");
  return out;
}

/** Normaliserer en konfigurert basis-URL til opprinnelsen (`http(s)://vert[:port]`); alt annet (sti, query, brukerinfo) avvises. */
export function normalizeBaseUrl(raw: string | null | undefined, label: string): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(value)) throw new Error(`${label}_base_url_invalid`);
  return value;
}

export interface JsonRequest {
  service: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Hemmeligheter som aldri må stå i en feilmelding. */
  secrets: readonly string[];
  /** Statuskoder som returneres som svar (ikke feil), f.eks. 404 for «finnes ikke». */
  acceptStatus?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  json: unknown;
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text().then((t) => t.slice(0, MAX_BODY_BYTES)).catch(() => "");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ControlTargetHttpError("response_too_large", response.status, false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorText(raw: string, secrets: readonly string[]): string {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown; errors?: Array<{ message?: unknown }> };
    const candidate = typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : typeof parsed.errors?.[0]?.message === "string" ? parsed.errors[0].message : "";
    return scrubSecrets(candidate, secrets).replace(/\s+/g, " ").slice(0, 160) || "UNCLASSIFIED";
  } catch {
    return "UNCLASSIFIED_ERROR_BODY";
  }
}

export async function jsonRequest(req: JsonRequest): Promise<JsonResponse> {
  const sleep = req.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: ControlTargetHttpError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await guardedFetch(req.url, {
      method: req.method,
      headers: { accept: "application/json", ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {})
    });
    const raw = await readCapped(response);
    if (response.ok || req.acceptStatus?.includes(response.status)) {
      let parsed: unknown = null;
      if (raw.length > 0) {
        try { parsed = JSON.parse(raw); } catch { if (response.ok) throw new ControlTargetHttpError(`${req.service}_invalid_response:non_json`, response.status, false); }
      }
      return { status: response.status, ok: response.ok, json: parsed };
    }
    const retryable = RETRYABLE.has(response.status) && isRetrySafeStatus(req.method, response.status);
    last = new ControlTargetHttpError(`${req.service}_error_${response.status}:${errorText(raw, req.secrets)}`, response.status, retryable);
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }
  throw last!;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const strOrNull = (v: unknown, max = 200): string | null => (typeof v === "string" ? v.slice(0, max) : null);
export const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
