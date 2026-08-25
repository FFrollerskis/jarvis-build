import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * D-109 (UA-6 Slice 3): rene, avhengighetsfrie Stripe-webhook-signatur-
 * hjelpefunksjoner (INGEN `stripe`-SDK - samme "raw fetch/crypto, ingen
 * vendor-SDK uten begrunnelse"-prinsipp som `fiken-transport.ts`).
 *
 * Kontrakt verifisert via uavhengig websøk denne økten (docs.stripe.com
 * selv var EGRESS_BLOCKED fra dette miljøet - samme klasse begrensning som
 * D-107 sin Fiken-audit dokumenterte for `api.fiken.no`, se D-109 i
 * DECISIONS_AND_ASSUMPTIONS.md for full kildeliste):
 *
 * - `Stripe-Signature`-headeren er kommaseparerte `key=value`-par:
 *   `t=<unix-timestamp>,v1=<hex-hmac-signatur>` (kan inneholde flere
 *   `v1=`-verdier ved nøkkel-rotasjon - MINST ÉN må matche).
 * - Den signerte nyttelasten er ALDRI kroppen alene: det er
 *   `${timestamp}.${raw_body}` (bokstavelig punktum mellom), HMAC-SHA256
 *   med webhook-signeringshemmeligheten, hex-kodet.
 * - Sammenligning MÅ være konstant-tid (`timingSafeEqual`) - ALDRI `===`
 *   på hemmelighetsavledet materiale.
 * - Standard toleransevindu er 5 minutter (300s) - eldre/fremtidige
 *   tidsstempler avvises (reproduksjons-/replay-forsvar).
 * - Rå, ubearbeidet request-body kreves (IKKE en JSON.parse->stringify-
 *   rundtur - serialisering kan endre whitespace/nøkkelrekkefølge og
 *   ugyldiggjøre signaturen).
 */

export interface StripeSignatureVerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly timestamp?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

function parseSignatureHeader(header: string): { timestamp: string | undefined; signatures: string[] } {
  const signatures: string[] = [];
  let timestamp: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  return { timestamp, signatures };
}

/**
 * Verifiserer en Stripe-webhook-signatur mot RÅ (ubearbeidet) kropp.
 * `nowSeconds` er injiserbar for deterministiske tester (ALDRI
 * `Date.now()` direkte i produksjonskode uten et eksplisitt kall-punkt -
 * her er kall-stedet `server.ts` sin egen `Math.floor(Date.now() / 1000)`,
 * videreført inn som parameter, samme "ingen skjult global tid"-prinsipp
 * som resten av workspacet).
 */
export function verifyStripeWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  webhookSigningSecret: string,
  nowSeconds: number,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS
): StripeSignatureVerificationResult {
  if (!signatureHeader) {
    return { valid: false, reason: "missing_signature_header" };
  }
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
  if (!timestamp || signatures.length === 0) {
    return { valid: false, reason: "malformed_signature_header" };
  }
  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum)) {
    return { valid: false, reason: "malformed_timestamp" };
  }
  if (Math.abs(nowSeconds - timestampNum) > toleranceSeconds) {
    return { valid: false, reason: "timestamp_outside_tolerance", timestamp: timestampNum };
  }

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", webhookSigningSecret).update(signedPayload, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");

  const matched = signatures.some((candidate) => {
    let candidateBuf: Buffer;
    try {
      candidateBuf = Buffer.from(candidate, "hex");
    } catch {
      return false;
    }
    if (candidateBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(candidateBuf, expectedBuf);
  });

  if (!matched) {
    return { valid: false, reason: "signature_mismatch", timestamp: timestampNum };
  }
  return { valid: true, timestamp: timestampNum };
}

/**
 * Minimal, TRYGG utdrag fra en rå Stripe-webhook-JSON-nyttelast - ALDRI
 * hele objektet lagret (kan inneholde betalingsmetode-/kunde-detaljer
 * Jarvis aldri skal persistere, byggeordrens §4/§13). Kaster
 * `TypeError`-lignende ved uventet form - kalleren (FinanceService)
 * fanger og markerer hendelsen `failed_retryable` i stedet for å anta en
 * form som ikke faktisk ble bevist.
 */
export interface ParsedStripeEventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly api_version: string | null;
  readonly created: number;
  readonly object_id: string | null;
  readonly object_type: string | null;
  readonly amount_ore: number | null;
  readonly currency: string | null;
  readonly status: string | null;
  readonly payment_intent_ref: string | null;
  readonly last_payment_error_message: string | null;
}

export function parseStripeEventEnvelope(rawBody: Buffer): ParsedStripeEventEnvelope {
  const json = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  if (typeof json["id"] !== "string" || typeof json["type"] !== "string" || typeof json["created"] !== "number") {
    throw new Error("stripe_event_envelope_malformed");
  }
  const data = json["data"] as Record<string, unknown> | undefined;
  const object = (data?.["object"] as Record<string, unknown> | undefined) ?? undefined;
  const objectId = typeof object?.["id"] === "string" ? (object["id"] as string) : null;
  const objectType = typeof object?.["object"] === "string" ? (object["object"] as string) : null;
  const amount = typeof object?.["amount"] === "number" ? (object["amount"] as number) : null;
  const currency = typeof object?.["currency"] === "string" ? (object["currency"] as string) : null;
  const status = typeof object?.["status"] === "string" ? (object["status"] as string) : null;
  // For et charge/refund-objekt peker "payment_intent" til den overordnede PaymentIntent - for selve PaymentIntent-objektet ER objectId denne pekeren.
  const paymentIntentRef =
    typeof object?.["payment_intent"] === "string" ? (object["payment_intent"] as string) : objectType === "payment_intent" ? objectId : null;
  const lastError = object?.["last_payment_error"] as Record<string, unknown> | undefined;
  const lastErrorMessage = typeof lastError?.["message"] === "string" ? (lastError["message"] as string).slice(0, 500) : null;

  return {
    id: json["id"],
    type: json["type"],
    api_version: typeof json["api_version"] === "string" ? (json["api_version"] as string) : null,
    created: json["created"],
    object_id: objectId,
    object_type: objectType,
    amount_ore: amount,
    currency: currency ? currency.toUpperCase() : null,
    status,
    payment_intent_ref: paymentIntentRef,
    last_payment_error_message: lastErrorMessage
  };
}
