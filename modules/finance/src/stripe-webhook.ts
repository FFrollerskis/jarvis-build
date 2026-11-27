import { createHmac, timingSafeEqual } from "node:crypto";
import { clipRedacted } from "@jarvis/core";
import { safeProviderId, safeToken, strictUnixSeconds, strictWebhookAmount, strictWebhookCurrency } from "./webhook-guard.ts";

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
 * Jarvis aldri skal persistere, byggeordrens §4/§13).
 *
 * WP-F1 (D-462, JARVIS-020/070): STRENG parsing. En hendelse som ikke lar seg identifisere (ikke et JSON-objekt, mangler trygg `id`/`type`) KASTER
 * `stripe_event_envelope_malformed` (kalleren lagrer et dødbrev under en hash-nøkkel). Er hendelsen identifiserbar men et felt er permanent ugyldig
 * (`created` utenfor [2000, 2100), beløp som ikke er et trygt ikke-negativt heltall i minste enhet, ugyldig valuta/objekt-id/referanse), returneres
 * den med `rejection` satt (årsakskode) - kalleren lagrer den som `rejected` og svarer 2xx (ingen evig retry). Beløp/valuta valideres kun for objekttypene
 * Jarvis faktisk anvender (`payment_intent`/`charge`/`refund`); andre objekttyper kan ha negative beløp (saldo-/utbetalingsobjekter) og ignoreres uansett.
 */
export interface ParsedStripeEventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly api_version: string | null;
  /** Unix-sekunder; `0` når `created` er ugyldig (da er `rejection` satt og kalleren bruker mottakstidspunktet). */
  readonly created: number;
  readonly object_id: string | null;
  readonly object_type: string | null;
  readonly amount_ore: number | null;
  readonly currency: string | null;
  readonly status: string | null;
  readonly payment_intent_ref: string | null;
  readonly last_payment_error_message: string | null;
  /** `null` = gyldig. Ellers årsakskoden til permanent ugyldig innhold. */
  readonly rejection: string | null;
}

const MONEY_OBJECT_TYPES: ReadonlySet<string> = new Set(["payment_intent", "charge", "refund"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStripeEventEnvelope(rawBody: Buffer): ParsedStripeEventEnvelope {
  const json: unknown = JSON.parse(rawBody.toString("utf8"));
  if (!isRecord(json)) throw new Error("stripe_event_envelope_malformed");
  const id = safeProviderId(json["id"]);
  const type = typeof json["type"] === "string" && /^[a-z][a-z0-9_.]{0,119}$/.test(json["type"]) ? json["type"] : null;
  if (id === null || type === null) throw new Error("stripe_event_envelope_malformed");

  let rejection: string | null = null;
  const reject = (code: string): void => { rejection ??= code; };

  const created = strictUnixSeconds(json["created"]);
  if (!created.ok) reject(created.rejection);

  const object = isRecord(json["data"]) && isRecord(json["data"]["object"]) ? json["data"]["object"] : undefined;
  let objectId: string | null = null;
  if (object && object["id"] !== undefined && object["id"] !== null) {
    objectId = safeProviderId(object["id"]);
    if (objectId === null) reject("object_id_invalid");
  }
  let objectType: string | null = null;
  if (object && object["object"] !== undefined && object["object"] !== null) {
    objectType = safeToken(object["object"], 64);
    if (objectType === null) reject("object_type_invalid");
  }

  let amount: number | null = null;
  let currency: string | null = null;
  if (object && objectType !== null && MONEY_OBJECT_TYPES.has(objectType)) {
    const a = strictWebhookAmount(object["amount"]);
    if (a.ok) amount = a.value; else reject(a.rejection);
    const c = strictWebhookCurrency(object["currency"]);
    if (c.ok) currency = c.value; else reject(c.rejection);
  }

  // For et charge/refund-objekt peker "payment_intent" til den overordnede PaymentIntent - for selve PaymentIntent-objektet ER objectId denne pekeren.
  let paymentIntentRef: string | null = null;
  if (object && object["payment_intent"] !== undefined && object["payment_intent"] !== null && typeof object["payment_intent"] === "string") {
    paymentIntentRef = safeProviderId(object["payment_intent"]);
    if (paymentIntentRef === null) reject("payment_intent_ref_invalid");
  } else if (objectType === "payment_intent") {
    paymentIntentRef = objectId;
  }

  const lastError = object?.["last_payment_error"];
  const lastErrorMessage = isRecord(lastError) && typeof lastError["message"] === "string" ? clipRedacted(lastError["message"], 500) : null; // skann FØRST, kutt etterpå: lagres i payment_intents.failure_reason (fiks-runde 1, review B L2)

  return {
    id,
    type,
    api_version: safeToken(json["api_version"], 40),
    created: created.ok ? created.value : 0,
    object_id: objectId,
    object_type: objectType,
    amount_ore: amount,
    currency,
    status: object ? safeToken(object["status"], 64) : null,
    payment_intent_ref: paymentIntentRef,
    last_payment_error_message: lastErrorMessage,
    rejection
  };
}
