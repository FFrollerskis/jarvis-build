import { timingSafeEqual } from "node:crypto";

/**
 * UA-6 Slice 6 (D-112, korrigert D-11x runde 4): Wallester webhook-
 * autentisering og envelope-parsing - ren, avhengighetsfri modul (samme
 * arkitekturrolle som stripe-webhook.ts/vipps-webhook.ts/neonomics-webhook.ts).
 *
 * Autentisering (uendret, fortsatt korrekt per owner-provided Business-
 * kontrakt): HTTP BASIC (kunde-konfigurert brukernavn/passord) -
 * IKKE HMAC (Stripe), IKKE forespørselssignering (Vipps), IKKE ren
 * API-nøkkel (Neonomics). Konstant-tid-sammenligning av det dekodede
 * `brukernavn:passord`-paret.
 *
 * Envelope-kontrakt: PRIMARY_SOURCE_EVIDENCE_MODE=OWNER_PROVIDED_PRIMARY_SOURCE_AUDIT
 * (PR #62, runde 4 - IKKE selv hentet, se wallester-transport.ts filhode for
 * full sourcing-forklaring). Wallester Business skiller `event` (konstant
 * konvolutt-markør, dokumentert verdi "notification") fra `type` (den
 * faktiske klassifikatoren: "authorization" | "authorization_release" |
 * "transaction") - IKKE et enkelt punktum-separert felt som i den
 * tidligere (feilaktig antatte) modellen. `event !== "notification"` er en
 * uventet konvoluttform og avvises (fail-safe - ALDRI gjettet videre).
 * Wallester ekko-er X-Request-ID for korrelasjon (håndtert i
 * apps/api/src/server.ts sin webhook-rute, IKKE her).
 *
 * INGEN bekreftet global hendelses-ID i det owner-provided materialet -
 * dedupe-nøkkelen er fortsatt Jarvis-utledet (hendelses-id når til stede,
 * ellers deterministisk `type:objekt-id:status`), samme konservative
 * prinsipp som Vipps/Neonomics: under-deduplisering i verste fall, aldri
 * feilaktig dropp - idempotens-invariantene i CardService gjør en
 * duplisert levering uskadelig uansett.
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

/** Konstant konvolutt-markør Wallester Business dokumenterer for `event` (owner-provided). */
const WALLESTER_ENVELOPE_EVENT = "notification";

export type WallesterEventKind = "authorization" | "authorization_release" | "transaction" | "card" | "unknown";

export interface WallesterEventEnvelope {
  /** Provider-hendelses-id når til stede - ellers null (dedupeKey dekker identiteten uansett). */
  eventId: string | null;
  /** Rå `type`-feltverdi fra Wallester (klassifikatoren - se filhode). */
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

/**
 * `type` er dokumentert som et LUKKET sett (owner-provided): eksakt
 * matching - ALDRI substreng-heuristikk (den forrige, feilaktig antatte
 * "authorization.approved"-stilen fantes ikke i det owner-provided
 * materialet). En ukjent `type`-verdi klassifiseres "unknown" -
 * fail-safe, aldri gjettet til en av de kjente klassene.
 */
function classifyKind(eventType: string): WallesterEventKind {
  switch (eventType.toLowerCase()) {
    case "authorization":
      return "authorization";
    case "authorization_release":
      return "authorization_release";
    case "transaction":
      return "transaction";
    case "card":
      return "card";
    default:
      return "unknown";
  }
}

export function parseWallesterEventEnvelope(rawBody: Buffer): WallesterEventEnvelope {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new WallesterEventEnvelopeError("invalid_json");
  }
  const envelopeMarker = typeof parsed["event"] === "string" ? (parsed["event"] as string) : null;
  if (envelopeMarker !== WALLESTER_ENVELOPE_EVENT) throw new WallesterEventEnvelopeError("unexpected_envelope_event");
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
