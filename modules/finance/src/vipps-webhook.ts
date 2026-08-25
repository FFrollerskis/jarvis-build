import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * D-110 (UA-6 Slice 4): rene, avhengighetsfrie Vipps MobilePay webhook-
 * autentiseringshjelpere (INGEN vendor-SDK - samme prinsipp som
 * `stripe-webhook.ts`). Kontrakten er FUNDAMENTALT ANNERLEDES enn Stripe sin
 * `Stripe-Signature`-header - byggeordrens §9 "do not force a Stripe
 * pattern" er tatt bokstavelig: dette er en HELT egen implementasjon, IKKE
 * en omdøpt kopi.
 *
 * Kontrakt verifisert via uavhengig websøk denne økten
 * (developer.vippsmobilepay.com selv var EGRESS_BLOCKED - samme
 * begrensningsklasse som D-107/D-109 sine audits dokumenterte, se D-110 i
 * DECISIONS_AND_ASSUMPTIONS.md for full kildeliste):
 *
 * - Autentiseringen er Azure-stil HMAC-SHA256-forespørselsignering (IKKE en
 *   enkelt signatur-header som Stripe): headerne `Host`, `X-Ms-Date`,
 *   `X-Ms-Content-Sha256` og `Authorization` deltar ALLE.
 * - `X-Ms-Content-Sha256` MÅ være `base64(SHA256(rå_kropp))` - en
 *   INTEGRITETS-sjekk av selve kroppen, uavhengig av signaturen under.
 * - Signert streng: `${METHOD}\n${pathOgQuery}\n${dato};${host};${hash}`
 *   (bokstavelige linjeskift), HMAC-SHA256 med webhook-hemmeligheten
 *   (utstedt ved webhook-registrering), base64-kodet.
 * - `Authorization`-headerens form:
 *   `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=<base64>`.
 * - Sammenligning MÅ være konstant-tid (`timingSafeEqual`) - SAMME prinsipp
 *   som Stripe-webhooken, ALDRI `===` på hemmelighetsavledet materiale.
 * - Vipps sin egen offisielle Webhooks API har INGEN dokumentert
 *   tidsstempel-toleransevindu-mekanisme (i motsetning til Stripe sin
 *   300s-replay-forsvars-kontrakt) i det uavhengige websøket denne økten -
 *   `VERIFIED_SEARCH_SNIPPET` fant INGEN kilde som bekrefter dette, så
 *   INGEN toleransevindu-avvisning er bygget her (D-41: ALDRI oppfunnet
 *   funksjonalitet leverandøren ikke er bekreftet å faktisk kreve/tilby).
 *   Replay-forsvar for selve DOMENE-utfallet er likevel dekket: hendelses-
 *   idempotens (se `parseVippsEventEnvelope()` under) og
 *   `applyVippsPaymentOutcome()` sin ordens-vokter i service.ts gjør en
 *   duplisert/forsinket levering trygg uansett.
 */

export interface VippsSignatureVerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

export interface VippsWebhookRequestHeaders {
  readonly host: string | undefined;
  readonly xMsDate: string | undefined;
  readonly xMsContentSha256: string | undefined;
  readonly authorization: string | undefined;
}

function parseAuthorizationHeader(header: string): { signedHeaders: string; signature: string } | null {
  // Form: "HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=<base64>"
  const match = /^HMAC-SHA256\s+SignedHeaders=([^&]+)&Signature=(.+)$/.exec(header.trim());
  if (!match) return null;
  const [, signedHeaders, signature] = match;
  if (!signedHeaders || !signature) return null;
  return { signedHeaders, signature };
}

/**
 * Verifiserer en Vipps-webhook-forespørsel mot RÅ (ubearbeidet) kropp.
 * `method`/`pathAndQuery` MÅ speile EKSAKT det den mottatte HTTP-
 * forespørselen faktisk var (samme "rå byte-for-byte input, aldri en
 * rekonstruert/normalisert versjon"-prinsipp som Stripe-webhooken sin rå
 * kropp).
 */
export function verifyVippsWebhookSignature(
  rawBody: Buffer,
  method: string,
  pathAndQuery: string,
  headers: VippsWebhookRequestHeaders,
  webhookSecret: string
): VippsSignatureVerificationResult {
  if (!headers.authorization) return { valid: false, reason: "missing_authorization_header" };
  if (!headers.xMsDate) return { valid: false, reason: "missing_date_header" };
  if (!headers.host) return { valid: false, reason: "missing_host_header" };
  if (!headers.xMsContentSha256) return { valid: false, reason: "missing_content_hash_header" };

  const parsedAuth = parseAuthorizationHeader(headers.authorization);
  if (!parsedAuth) return { valid: false, reason: "malformed_authorization_header" };

  // 1) Innholds-integritet: den oppgitte hashen MÅ matche den faktiske rå kroppen.
  const expectedContentHash = createHash("sha256").update(rawBody).digest("base64");
  if (!constantTimeStringEqual(expectedContentHash, headers.xMsContentSha256)) {
    return { valid: false, reason: "content_hash_mismatch" };
  }

  // 2) Signatur-autentisitet: HMAC over den signerte strengen.
  const signedPayload = `${method.toUpperCase()}\n${pathAndQuery}\n${headers.xMsDate};${headers.host};${headers.xMsContentSha256}`;
  const expectedSignature = createHmac("sha256", webhookSecret).update(signedPayload, "utf8").digest("base64");
  if (!constantTimeStringEqual(expectedSignature, parsedAuth.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}

function constantTimeStringEqual(expected: string, actual: string): boolean {
  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "base64");
    actualBuf = Buffer.from(actual, "base64");
  } catch {
    return false;
  }
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Minimal, TRYGG utdrag fra en rå Vipps-webhook-JSON-nyttelast - ALDRI hele
 * objektet lagret (samme byggeordre-§4/§13-prinsipp som Stripe-webhooken).
 * Feltnavn (`reference`/`name`/`amount`/`timestamp`/`idempotencyKey`/`msn`/
 * `success`) er `VERIFIED_SEARCH_SNIPPET`-nivå, IKKE
 * `VERIFIED_PRIMARY_SOURCE` - se toppkommentaren i denne filen.
 *
 * Hendelses-IDENTITET (dedup-nøkkel): Vipps sin Webhooks API-dokumentasjon
 * ga (i det uavhengige websøket denne økten) INGEN bekreftet global
 * hendelses-id-streng parallell til Stripe sin `evt_xxx` - i stedet
 * gjenbrukes betalingens `idempotencyKey`-felt når det er til stede
 * (ekkoet fra den OPPRINNELIGE handlingen som utløste hendelsen - ulike
 * handlinger, f.eks. autoriser vs. capture, har ulike idempotencyKey-
 * verdier, så dette dedupliserer korrekt PER handling). Er feltet FRAVÆRENDE
 * faller parseren tilbake til en deterministisk sammensatt nøkkel
 * (`reference:name:timestamp`) - BEVISST det TRYGGESTE konservative valget
 * (D-41 anti-gjetting): i verste fall under-dedupliserer det (aldri
 * feilaktig dropper en genuint distinkt hendelse), og selv en duplisert
 * levering er uskadelig siden `applyVippsPaymentOutcome()` sin ordens-vokter
 * i service.ts er idempotent uansett.
 */
export interface ParsedVippsEventEnvelope {
  readonly dedupeKey: string;
  readonly reference: string;
  /** Vipps sitt betalings-tilstandsnavn for DENNE hendelsen (f.eks. "CREATED"/"AUTHORIZED"/"CAPTURED"/"CANCELLED"/"TERMINATED"/"REFUNDED"/"EXPIRED") - ALDRI gjettet utover det verifiserte settet i `VIPPS_STATUS_TO_JARVIS_STATE`. */
  readonly name: string;
  readonly amount_ore: number | null;
  readonly currency: string | null;
  readonly msn: string | null;
  readonly success: boolean | null;
  readonly timestamp: string | null;
}

export function parseVippsEventEnvelope(rawBody: Buffer): ParsedVippsEventEnvelope {
  const json = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  if (typeof json["reference"] !== "string" || typeof json["name"] !== "string") {
    throw new Error("vipps_event_envelope_malformed");
  }
  const amountObj = json["amount"] as Record<string, unknown> | undefined;
  const amount = typeof amountObj?.["value"] === "number" ? (amountObj["value"] as number) : null;
  const currency = typeof amountObj?.["currency"] === "string" ? (amountObj["currency"] as string) : null;
  const timestamp = typeof json["timestamp"] === "string" ? (json["timestamp"] as string) : null;
  const idempotencyKey = typeof json["idempotencyKey"] === "string" ? (json["idempotencyKey"] as string) : null;
  const dedupeKey = idempotencyKey ?? `${json["reference"]}:${json["name"]}:${timestamp ?? "no-timestamp"}`;

  return {
    dedupeKey,
    reference: json["reference"],
    name: json["name"],
    amount_ore: amount,
    currency: currency ? currency.toUpperCase() : null,
    msn: typeof json["msn"] === "string" ? (json["msn"] as string) : null,
    success: typeof json["success"] === "boolean" ? (json["success"] as boolean) : null,
    timestamp
  };
}
