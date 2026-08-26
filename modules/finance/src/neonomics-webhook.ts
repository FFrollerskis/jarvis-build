import { timingSafeEqual } from "node:crypto";

/**
 * D-111 (UA-6 Slice 5): Neonomics webhook-autentisering + envelope-parsing.
 * Neonomics sin OFFISIELLE webhook-kontrakt for betalingsstatus-
 * oppdateringer (VERIFIED_SEARCH_SNIPPET - docs.neonomics.io var
 * EGRESS_BLOCKED, se D-111 for kildeliste):
 *
 *   - Webhooken registreres i Neonomics sin Merchant-portal med URL + en
 *     KUNDE-VALGT API-NØKKEL (obligatorisk) som Neonomics autentiserer
 *     sine forespørsler med.
 *   - Dette er IKKE en HMAC-signaturkontrakt (Stripe) og IKKE Azure-stil
 *     forespørselssignering (Vipps) - implementert som SIN EGEN kontrakt
 *     (byggeordrens §23 «do not force Stripe/Vipps event patterns»):
 *     konstant-tid sammenligning av API-nøkkelen, fail-closed.
 *   - Vellykket mottak = HTTP 200; ALT annet trigges Neonomics-retry
 *     (eksponentiell backoff, min 10s, maks 7 dager) - `failed_retryable`
 *     returneres derfor som ikke-200 (samme ærlighetsprinsipp som
 *     Stripe-/Vipps-mottakene).
 *   - Nyttelasten bærer betalings-ID + ISO 20022-status. INGEN dokumentert
 *     global hendelses-ID i det uavhengige søket - dedupe-nøkkelen er
 *     Jarvis-utledet `paymentId:status` (deterministisk; konservativ -
 *     i verste fall under-dedupliserer den, og ordens-vokteren i
 *     FinanceService gjør en duplisert levering uskadelig uansett).
 */

export interface NeonomicsWebhookAuthResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/** Konstant-tid API-nøkkel-sjekk - ALDRI `===` på hemmelighetsavledet materiale (samme prinsipp som alle øvrige webhook-mottak). */
export function verifyNeonomicsWebhookApiKey(providedKey: string | undefined | null, configuredKey: string): NeonomicsWebhookAuthResult {
  if (!providedKey) return { valid: false, reason: "missing_api_key_header" };
  const providedBuf = Buffer.from(providedKey, "utf8");
  const configuredBuf = Buffer.from(configuredKey, "utf8");
  if (providedBuf.length !== configuredBuf.length) return { valid: false, reason: "api_key_mismatch" };
  if (!timingSafeEqual(providedBuf, configuredBuf)) return { valid: false, reason: "api_key_mismatch" };
  return { valid: true };
}

export interface ParsedNeonomicsEventEnvelope {
  readonly dedupeKey: string;
  readonly paymentId: string;
  readonly status: string;
}

/** Minimal, TRYGG utdrag - ALDRI hele nyttelasten persistert (samme §25-prinsipp som Stripe/Vipps-parserne). Kaster deterministisk på malformert form. */
export function parseNeonomicsEventEnvelope(rawBody: Buffer): ParsedNeonomicsEventEnvelope {
  const json = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  const paymentId = typeof json["paymentId"] === "string" ? json["paymentId"] : typeof json["id"] === "string" ? (json["id"] as string) : null;
  const status = typeof json["status"] === "string" ? (json["status"] as string) : null;
  if (!paymentId || !status) throw new Error("neonomics_event_envelope_malformed");
  return { dedupeKey: `${paymentId}:${status}`, paymentId, status };
}
