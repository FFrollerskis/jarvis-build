import { createHmac, timingSafeEqual } from "node:crypto";
import {
  USAGE_LIMITS, UsageImportError,
  type NormalizedUsageEvent, type ParsedUsageBatch, type ProductUsageSource, type RejectedUsageEvent, type UsageEventKind
} from "./product-usage-types.ts";

/**
 * WP-D2: normalisering og kilder for produktbruk (webhook, JSONL, CSV). Ren logikk uten I/O - lagring ligger i `ProductUsageService`.
 * Alt er fail-closed: ukjente felt/kolonner, kontrolltegn, personidentifiserende referanser og tider utenfor vinduet avvises med en kode (aldri verdien).
 */

const ALLOWED_KEYS = new Set(["event_id", "account_ref", "user_ref", "feature", "occurred_at", "quantity", "kind"]);
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$/;
const FEATURE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/**
 * En pseudonym referanse: 6-128 tegn av `A-Za-z0-9_.:-`, ikke e-post (@), ikke mellomrom, og IKKE noe som ligner personidentifiserende tall (gjennomgang av PR #326, F3):
 *  - kun siffer (etter at skilletegnene `-_.:` er fjernet) på 8-19 siffer: telefonnummer, fødselsnummer og kortnummer, også med skilletegn (`010190-12345`, `98-76-54-32`, `4111-1111-1111-1111`, `192-168-1-10`),
 *  - en IPv4-adresse med punktum, og IPv6-lignende verdier (heksadesimale grupper skilt av kolon, `2001:db8::1`).
 * Avsenderen forventes å hashe id-ene (f.eks. HMAC-SHA256 med eget salt, hel hex-streng på minst 32 tegn) - dette er en sikkerhetsmaske mot UTILSIKTET PII, ikke et bevis på hashing: navn-lignende
 * verdier (`ola.nordmann`) kan den ikke oppdage. Kun hashing beskytter mot det.
 */
export function isPseudonymousRef(value: string): boolean {
  if (!REF_RE.test(value)) return false;
  if (/^\d{8,19}$/.test(value.replace(/[-_.:]/g, ""))) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  if (value.includes(":") && /^[0-9a-fA-F:]+$/.test(value)) return false;
  return true;
}

/** Strengt `occurred_at` (PR #326, F4): dato (tolkes som UTC midnatt) eller dato+klokkeslett MED eksplisitt tidssone (`Z`/`±hh:mm`) - aldri serverens tidssone - og en dato som finnes (`2026-02-30` ruller ikke videre til mars). */
const OCCURRED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
export function parseOccurredAt(raw: string): number | null {
  const m = OCCURRED_AT_RE.exec(raw);
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return null;
  if (m[7] !== undefined && m[7] !== "Z" && (Number(m[7].slice(1, 3)) > 14 || Number(m[7].slice(4, 6)) > 59)) return null;
  const ms = new Date(m[4] === undefined ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export type NormalizeResult = { ok: true; event: NormalizedUsageEvent } | { ok: false; reason: string };

/** Normaliserer ÉN rå hendelse. `nowMs` injiseres (deterministiske tester, ingen skjult global tid). */
export function normalizeUsageEvent(raw: unknown, nowMs: number): NormalizeResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "not_an_object" };
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    // Feltnavnet ekkoes bare når det ser ut som et vanlig feltnavn (PR #326, F4): et nøkkelnavn kan være fritekst (en e-postadresse, et navn) og skal ikke lagres/ekkoes.
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: `unknown_field:${/^[a-z][a-z0-9_]{0,31}$/.test(key) ? key : "invalid_name"}` };
  }
  const str = (k: string): string | undefined => {
    const v = obj[k];
    return v === undefined || v === null || v === "" ? undefined : typeof v === "string" ? v : "\u0000invalid";
  };
  const eventId = str("event_id");
  if (eventId === undefined || !EVENT_ID_RE.test(eventId)) return { ok: false, reason: "event_id_invalid" };
  const kindRaw = str("kind") ?? "usage";
  if (kindRaw !== "usage" && kindRaw !== "billing_status") return { ok: false, reason: "kind_invalid" };
  const kind: UsageEventKind = kindRaw;
  const accountRef = str("account_ref");
  if (accountRef === undefined || !isPseudonymousRef(accountRef)) return { ok: false, reason: "account_ref_invalid_or_not_pseudonymous" };
  const userRef = str("user_ref");
  if (userRef !== undefined && !isPseudonymousRef(userRef)) return { ok: false, reason: "user_ref_invalid_or_not_pseudonymous" };
  const feature = str("feature");
  if (kind === "usage") {
    if (feature === undefined || !FEATURE_RE.test(feature)) return { ok: false, reason: "feature_invalid" };
  } else if (feature !== undefined || userRef !== undefined) {
    return { ok: false, reason: "billing_status_takes_no_feature_or_user" };
  }
  const occurredRaw = str("occurred_at");
  const occurredMs = occurredRaw === undefined ? null : parseOccurredAt(occurredRaw);
  if (occurredMs === null) return { ok: false, reason: "occurred_at_invalid" };
  if (occurredMs > nowMs + USAGE_LIMITS.max_future_ms || occurredMs < nowMs - USAGE_LIMITS.max_age_days * 86_400_000) return { ok: false, reason: "occurred_at_out_of_range" };
  let quantity: number;
  const q = obj["quantity"];
  if (q === undefined || q === null || q === "") {
    if (kind === "billing_status") return { ok: false, reason: "quantity_required_for_billing_status" };
    quantity = 1;
  } else {
    const n = typeof q === "number" ? q : typeof q === "string" && /^\d{1,7}$/.test(q) ? Number(q) : Number.NaN;
    if (!Number.isInteger(n)) return { ok: false, reason: "quantity_invalid" };
    quantity = n;
  }
  const [min, max] = kind === "usage" ? [1, USAGE_LIMITS.usage_max_quantity] : [0, USAGE_LIMITS.billing_max_overdue];
  if (quantity < min || quantity > max) return { ok: false, reason: "quantity_out_of_range" };
  return {
    ok: true,
    event: {
      external_event_id: eventId, kind, account_ref: accountRef, user_ref: userRef ?? null, feature: feature ?? null, quantity,
      occurred_at: new Date(occurredMs).toISOString()
    }
  };
}

function normalizeAll(rows: Array<{ position: number; raw: unknown }>, nowMs: number): ParsedUsageBatch {
  const accepted: NormalizedUsageEvent[] = [];
  const rejected: RejectedUsageEvent[] = [];
  const seen = new Set<string>();
  for (const { position, raw } of rows) {
    const r = normalizeUsageEvent(raw, nowMs);
    if (!r.ok) { rejected.push({ position, reason: r.reason }); continue; }
    // Duplikat INNE I SAMME batch (samme avsender-id) telles én gang - resten er duplikater, ikke feil.
    if (seen.has(r.event.external_event_id)) continue;
    seen.add(r.event.external_event_id);
    accepted.push(r.event);
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Webhook: HMAC-signatur + replay-vern (mønster fra finans-webhookene, Stripe-form `t=<unix>,v1=<hex>`)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

export const USAGE_WEBHOOK_SIGNATURE_HEADER = "x-jarvis-signature";
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface UsageSignatureResult { valid: boolean; reason?: string; timestamp?: number }

/** Avsenderen (og testene) signerer slik: `HMAC-SHA256(secret, "<t>.<rå kropp>")`, hex, i headeren `t=<t>,v1=<hex>`. */
export function signUsageWebhook(rawBody: Buffer | string, secret: string, timestampSeconds: number): string {
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * Verifiserer mot RÅ kropp. Konstant-tid-sammenligning, streng hex-lengde, tidsvindu (±300 s) som replay-forsvar; flere `v1` støttes (nøkkelrotasjon).
 * Replay INNENFOR vinduet er harmløst: hver hendelse har en unik `event_id` som lagringen dedupliserer på (samme hendelse teller aldri to ganger).
 */
export function verifyUsageWebhookSignature(
  rawBody: Buffer, header: string | undefined | null, secret: string, nowSeconds: number, toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS
): UsageSignatureResult {
  if (!secret) return { valid: false, reason: "secret_not_configured" };
  if (!header) return { valid: false, reason: "missing_signature_header" };
  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") candidates.push(value);
  }
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp) || candidates.length === 0 || candidates.length > 4) return { valid: false, reason: "malformed_signature_header" };
  const t = Number(timestamp);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { valid: false, reason: "timestamp_outside_tolerance", timestamp: t };
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`, "utf8").digest();
  const matched = candidates.some((c) => {
    if (!/^[0-9a-f]{64}$/i.test(c)) return false;
    const buf = Buffer.from(c, "hex");
    return buf.length === expected.length && timingSafeEqual(buf, expected);
  });
  return matched ? { valid: true, timestamp: t } : { valid: false, reason: "signature_mismatch", timestamp: t };
}

/** Webhook-kropp: `{ "events": [...] }` (maks 500) ELLER én enkelt hendelse. Kaster `UsageImportError` ved ugyldig HELE kropp. */
export function parseWebhookUsagePayload(rawBody: Buffer, nowMs: number): ParsedUsageBatch {
  if (rawBody.length === 0 || rawBody.length > USAGE_LIMITS.webhook_max_bytes) throw new UsageImportError("payload_size_invalid");
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new UsageImportError("payload_not_json");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new UsageImportError("payload_not_an_object");
  const obj = json as Record<string, unknown>;
  let list: unknown[];
  if ("events" in obj) {
    if (Object.keys(obj).some((k) => k !== "events") || !Array.isArray(obj["events"])) throw new UsageImportError("payload_events_invalid");
    list = obj["events"] as unknown[];
  } else {
    list = [obj];
  }
  if (list.length === 0 || list.length > USAGE_LIMITS.webhook_max_events) throw new UsageImportError("payload_event_count_invalid");
  return normalizeAll(list.map((raw, i) => ({ position: i + 1, raw })), nowMs);
}

export const webhookUsageSource: ProductUsageSource<Buffer> = {
  source_id: "webhook",
  parse: (rawBody, nowMs) => parseWebhookUsagePayload(rawBody, nowMs)
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Filimport: JSONL og CSV
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

const MAX_LINE_BYTES = 8 * 1024;

export function parseJsonlUsage(text: string, nowMs: number): ParsedUsageBatch {
  if (Buffer.byteLength(text, "utf8") > USAGE_LIMITS.import_max_bytes) throw new UsageImportError("file_too_large");
  const rows: Array<{ position: number; raw: unknown }> = [];
  const rejected: RejectedUsageEvent[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let nonEmpty = 0;
  lines.forEach((line, idx) => {
    if (line.trim() === "") return;
    nonEmpty += 1;
    if (nonEmpty > USAGE_LIMITS.import_max_events) throw new UsageImportError("too_many_events");
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) { rejected.push({ position: idx + 1, reason: "line_too_long" }); return; }
    try {
      rows.push({ position: idx + 1, raw: JSON.parse(line) });
    } catch {
      rejected.push({ position: idx + 1, reason: "line_not_json" });
    }
  });
  const parsed = normalizeAll(rows, nowMs);
  return { accepted: parsed.accepted, rejected: [...rejected, ...parsed.rejected].sort((a, b) => a.position - b.position) };
}

/** Minimal RFC 4180-parser (anførselstegn, doble anførselstegn, komma og linjeskift i felt). Returnerer rader av felt. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
    if (rows.length > USAGE_LIMITS.import_max_events + 1) throw new UsageImportError("too_many_events");
  }
  if (inQuotes) throw new UsageImportError("csv_unterminated_quote");
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** CSV med header. Ukjente kolonner (f.eks. `email`, `name`, `ip`) avviser HELE filen - personopplysninger skal ikke kunne snike seg inn via en ekstra kolonne. */
export function parseCsvUsage(text: string, nowMs: number): ParsedUsageBatch {
  if (Buffer.byteLength(text, "utf8") > USAGE_LIMITS.import_max_bytes) throw new UsageImportError("file_too_large");
  const all = parseCsvRows(text);
  if (all.length === 0) throw new UsageImportError("csv_empty");
  const header = (all[0] as string[]).map((h) => h.trim().toLowerCase());
  const unknown = header.find((h) => !ALLOWED_KEYS.has(h));
  if (unknown !== undefined) throw new UsageImportError("unknown_column", unknown.slice(0, 40));
  if (new Set(header).size !== header.length) throw new UsageImportError("duplicate_column");
  for (const required of ["event_id", "account_ref", "occurred_at"]) if (!header.includes(required)) throw new UsageImportError("missing_column", required);
  if (all.length - 1 > USAGE_LIMITS.import_max_events) throw new UsageImportError("too_many_events");
  const rows = all.slice(1).map((cells, i) => {
    const raw: Record<string, unknown> = {};
    if (cells.length > header.length) return { position: i + 2, raw: { too_many_cells: true } };
    header.forEach((h, c) => { const v = (cells[c] ?? "").trim(); if (v !== "") raw[h] = v; });
    return { position: i + 2, raw };
  });
  return normalizeAll(rows, nowMs);
}

export type UsageFileFormat = "csv" | "jsonl";

/** Filimport som `ProductUsageSource`: `source_id` er `import:<etikett>` (etiketten er eierens egen, f.eks. dato eller kildenavn). */
export function fileUsageSource(format: UsageFileFormat, label: string): ProductUsageSource<string> {
  if (!/^[a-z0-9][a-z0-9_.-]{0,39}$/.test(label)) throw new UsageImportError("source_label_invalid", "a-z, 0-9, punktum, understrek og bindestrek, maks 40 tegn");
  return { source_id: `import:${label}`, parse: (text, nowMs) => (format === "csv" ? parseCsvUsage(text, nowMs) : parseJsonlUsage(text, nowMs)) };
}
