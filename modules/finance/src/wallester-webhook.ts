import { timingSafeEqual } from "node:crypto";

/**
 * UA-6 Slice 6 (D-112): Wallester webhook-autentisering og envelope-
 * parsing - ren, avhengighetsfri modul (samme arkitekturrolle som
 * stripe-webhook.ts/vipps-webhook.ts/neonomics-webhook.ts).
 *
 * Kontrakt (VERIFIED_SEARCH_SNIPPET + byggeordrens §15): Wallester
 * leverer hendelser (autorisasjon approve/decline i beslutnings-
 * øyeblikket, oppgjør, korthendelser) som HTTP POST til et forhånds-
 * konfigurert endepunkt, autentisert med HTTP BASIC (kunde-konfigurert
 * brukernavn/passord) - IKKE HMAC (Stripe), IKKE forespørselssignering
 * (Vipps), IKKE ren API-nøkkel (Neonomics). Implementert som SIN EGEN
 * kontrakt: konstant-tid-sammenligning av det dekodede
 * `brukernavn:passord`-paret. INGEN bekreftet global hendelses-ID i det
 * uavhengige søket - dedupe-nøkkelen er Jarvis-utledet (hendelses-id når
 * til stede, ellers deterministisk `type:objekt-id:status`), samme
 * konservative prinsipp som Vipps/Neonomics: under-deduplisering i verste
 * fall, aldri feilaktig dropp - idempotens-invariantene i CardService
 * gjør en duplisert levering uskadelig uansett.
 */

export interface WallesterWebhookAuthResult {
  valid: boolean;
  reason?: "missing_authorization_header" | "not_basic_scheme" | "credential_mismatch";
}

/**
 * Verifiserer `Authorization: Basic <base64(user:pass)>` konstant-tid.
 * Lengdeforskjell håndteres uten å kaste (og uten timing-lekkasje av
 * innholdet - sammenligningen skjer alltid over like lange buffere).
 */
export function verifyWallesterWebhookBasicAuth(
  authorizationHeader: string | undefined,
  expectedUsername: string,
  expectedPassword: string
): WallesterWebhookAuthResult {
  if (!authorizationHeader) return { valid: false, reason: "missing_authorization_header" };
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(authorizationHeader.trim());
  if (!match) return { valid: false, reason: "not_basic_scheme" };
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return { valid: false, reason: "credential_mismatch" };
  }
  const expected = `${expectedUsername}:${expectedPassword}`;
  const a = Buffer.from(decoded, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Konstant-tid også ved lengdeavvik: sammenlign b mot seg selv for å
    // holde arbeidsmengden uavhengig av hvor input avviker.
    timingSafeEqual(b, b);
    return { valid: false, reason: "credential_mismatch" };
  }
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: "credential_mismatch" };
}

export type WallesterEventKind = "authorization" | "transaction" | "card" | "unknown";

export interface WallesterEventEnvelope {
  /** Provider-hendelses-id når til stede - ellers null (dedupeKey dekker identiteten uansett). */
  eventId: string | null;
  eventType: string;
  kind: WallesterEventKind;
  /** Provider-objektet hendelsen gjelder (autorisasjons-, transaksjons- eller kort-ID). */
  providerObjectId: string;
  /** Provider-kort-ID-en hendelsen ruter til (tenant-oppslag skjer mot KJENT provider_cards-mapping - ALDRI payload-tenant-metadata, §15). */
  providerCardId: string | null;
  status: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

export class WallesterEventEnvelopeError extends Error {
  constructor(detail: string) {
    super(`wallester_event_envelope_malformed:${detail}`);
    this.name = "WallesterEventEnvelopeError";
  }
}

function classifyKind(eventType: string): WallesterEventKind {
  const t = eventType.toLowerCase();
  if (t.includes("authorization")) return "authorization";
  if (t.includes("transaction")) return "transaction";
  if (t.includes("card")) return "card";
  return "unknown";
}

export function parseWallesterEventEnvelope(rawBody: Buffer): WallesterEventEnvelope {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new WallesterEventEnvelopeError("invalid_json");
  }
  const eventType = typeof parsed["type"] === "string" ? (parsed["type"] as string) : null;
  if (!eventType) throw new WallesterEventEnvelopeError("missing_type");
  const data = (parsed["data"] as Record<string, unknown> | undefined) ?? parsed;
  const providerObjectId = typeof data["id"] === "string" ? (data["id"] as string) : null;
  if (!providerObjectId) throw new WallesterEventEnvelopeError("missing_object_id");
  const status = typeof data["status"] === "string" ? (data["status"] as string) : "unknown";
  const eventId = typeof parsed["event_id"] === "string" ? (parsed["event_id"] as string) : null;
  const providerCardId =
    typeof data["card_id"] === "string" ? (data["card_id"] as string) : typeof parsed["card_id"] === "string" ? (parsed["card_id"] as string) : null;
  return {
    eventId,
    eventType,
    kind: classifyKind(eventType),
    providerObjectId,
    providerCardId,
    status,
    payload: data,
    dedupeKey: eventId ?? `${eventType}:${providerObjectId}:${status}`
  };
}
