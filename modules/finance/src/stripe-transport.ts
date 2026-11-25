/**
 * UA-6 Finance & Spend Integrity Gateway - TREDJE slice (Slice 3, D-109):
 * Stripe (P1, masterplan-navngitt sammen med Vipps/bank, IKKE et
 * Claude-valgt leverandørvalg - `CORE_DEPENDENCY_DECISION_REQUIRED=false`).
 * `payment_intents`/idempotens/avviksdeteksjon/kill-switch/avstemming
 * forblir `JARVIS_CANONICAL` (service.ts, uendret av denne filen); selve
 * PaymentIntent-/Charge-/Refund-tilstanden og webhook-hendelses-
 * identiteten er Stripe sitt `EXTERNAL_CANONICAL` ansvar.
 *
 * D-41-verifiseringsstatus (samme ærlighetsdisiplin som `fiken-transport.ts`
 * D-107/`google-ads-transport.ts` D-83): direkte `WebFetch` mot
 * `docs.stripe.com` var EGRESS-BLOKKERT i denne runden (SAMME strukturelle
 * proxy-begrensning som rammet `api.fiken.no`/`developers.google.com`
 * tidligere). Kontrakten under er derfor `VERIFIED_SEARCH_SNIPPET`
 * (uavhengig websøk denne økten mot flere kilder - offisielle Stripe-
 * dokumentasjonstitler indeksert i søkeresultater, tredjeparts
 * utviklerartikler som siterer den offisielle API-referansen ordrett, og
 * Stripe sin egen offentlige blogg-post om idempotens-design), IKKE
 * `VERIFIED_PRIMARY_SOURCE` - full kildeliste i D-109,
 * DECISIONS_AND_ASSUMPTIONS.md:
 *   - Auth: `Authorization: Bearer sk_...` (hemmelig API-nøkkel, ALDRI en
 *     OAuth-utveksling for et direkte, ikke-Connect Stripe-konto-oppsett -
 *     samme "single-owner, ikke multi-kunde-SaaS"-mønster som Fiken/
 *     GitHub/Google Ads, men UTEN et refresh-token-steg siden Stripe sin
 *     hemmelige nøkkel SELV er det langlivede credentialet).
 *   - Base-URL: `https://api.stripe.com/v1`.
 *   - **Request-body er `application/x-www-form-urlencoded`, IKKE JSON**
 *     (Stripe sin REST-API sitt kjente, dokumenterte avvik fra de fleste
 *     moderne API-er - nøstede objekter kodes med felt-i-brakett-notasjon,
 *     f.eks. `automatic_payment_methods[enabled]=true`). Responser ER JSON.
 *   - Idempotens: `Idempotency-Key`-header (opptil 255 tegn, anbefalt
 *     UUID) på alle POST-kall - Stripe lagrer FØRSTE svar (status+kropp)
 *     for nøkkelen og returnerer DET SAMME svaret ved gjentakelse, ALDRI
 *     en ny mutasjon. Et 400-svar ved gjenbruk av samme nøkkel med
 *     ANDRE parametre ("Keys for idempotent requests can only be used
 *     with the same parameters they were first used with").
 *   - PaymentIntent-status-enum (rekkefølge i egen livssyklus, ALDRI en
 *     egen "failed"-status - se `types.ts` sin `STRIPE_STATUS_TO_JARVIS_STATE`-
 *     kommentar): `requires_payment_method`, `requires_confirmation`,
 *     `requires_action`, `processing`, `requires_capture`, `succeeded`,
 *     `canceled`.
 *   - Refund-status-enum: `pending`, `requires_action`, `succeeded`,
 *     `failed`, `canceled`. Refund-reason-enum (eier-oppgitt del):
 *     `duplicate`, `fraudulent`, `requested_by_customer` (+
 *     Stripe-INTERN-generert `expired_uncaptured_charge`, ALDRI satt av
 *     Jarvis ved opprettelse).
 *   - Beløp: heltall i minste myntenhet (øre/cent), SAMME konvensjon som
 *     `payment_intents.amount_ore` - INGEN konvertering nødvendig utover
 *     valuta-casing (Stripe forventer små bokstaver, f.eks. `"nok"`,
 *     Jarvis lagrer store bokstaver `"NOK"`).
 *   - Webhook-signatur: se `stripe-webhook.ts` (egen fil, delt av server-
 *     ruten og eventuelle tester - IKKE duplisert her).
 */

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

import { toOreInteger } from "./ore.ts";

import { financeSignal, isRetrySafe } from "./http.ts";
import { ProviderResponseInvalidError, expectArray, expectCurrency, expectId, expectMinorUnits, expectRecord, expectStatus, optionalText, readJsonBody, type ResponseContext } from "./provider-response.ts";

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    /** Stripe sin egen dokumenterte `error.type` (f.eks. "card_error"/"idempotency_error"/"api_error") - ALDRI gjettet, KUN videreformidlet uendret. */
    readonly stripeErrorType: string | null
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tolerant, avkortet (200 tegn) sanering av Stripe sin feilrespons - ALDRI rå kropp/headere logget (samme presedens som `classifyFikenErrorBody`). */
function classifyStripeErrorBody(rawBody: string): { summary: string; errorType: string | null } {
  const trimmed = rawBody.slice(0, 200).trim();
  try {
    const parsed = JSON.parse(rawBody) as { error?: { type?: string; message?: string } };
    const errorType = typeof parsed.error?.type === "string" ? parsed.error.type : null;
    const message = typeof parsed.error?.message === "string" ? parsed.error.message.slice(0, 200) : trimmed;
    return { summary: message.length > 0 ? message : "no_body", errorType };
  } catch {
    return { summary: trimmed.length > 0 ? trimmed : "no_body", errorType: null };
  }
}

/**
 * Koder ett flatt/ett-nivå-nøstet objekt til Stripe sin form-urlencoded
 * brakett-notasjon (`parent[child]=value`). BEVISST begrenset til det
 * denne transporten faktisk sender (ingen generell rekursiv encoder som
 * kunne produsert et uverifisert felt-navn for en dypere struktur - D-41).
 */
function encodeStripeForm(params: Record<string, string | number | boolean | Record<string, string | boolean> | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === "object") {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        parts.push(`${encodeURIComponent(key)}[${encodeURIComponent(nestedKey)}]=${encodeURIComponent(String(nestedValue))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join("&");
}

export interface StripePaymentIntentObject {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: string;
  metadata: Record<string, string>;
  last_payment_error?: { message?: string } | null;
}

/** D-242: minimalt utdrag av Stripe sin `GET /v1/balance` (offisiell, verifisert-via-websøk endepunkt - "returns a balance object for the account that was authenticated in the request", INGEN parametre) - kun de to feltene brukt av `checkStripeBalance()` sin "virker credentialen?"-probe. */
export interface StripeBalanceObject {
  object: "balance";
  available: Array<{ amount: number; currency: string }>;
  pending: Array<{ amount: number; currency: string }>;
}

export interface StripeRefundObject {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: string;
  payment_intent: string;
  reason: string | null;
}

export interface CreateStripePaymentIntentInput {
  amountOre: number;
  /** Store bokstaver (`"NOK"`) - konverteres til Stripe sin forventede små-bokstav-form internt. */
  currency: string;
  /** KUN trygge, ikke-sensitive interne id-er - ALDRI PII/betalingsmetode-data (byggeordrens §13). */
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateStripeRefundApiInput {
  stripePaymentIntentId: string;
  amountOre: number;
  reason?: string;
  idempotencyKey: string;
}

/**
 * `fetch()`-basert (samme "ingen ny SDK uten begrunnelse"-prinsipp som
 * CLAUDE.md regel 3 og `FikenTransport`) - INGEN `stripe`-npm-pakke.
 */
export class StripeTransport {
  constructor(private readonly secretKey: string) {}

  private async request(ctx: ResponseContext, method: string, path: string, form?: Record<string, string | number | boolean | Record<string, string | boolean> | undefined>, idempotencyKey?: string): Promise<unknown> {
    let lastError: StripeApiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(`${STRIPE_API_BASE}${path}`, {
        signal: financeSignal(),
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          ...(idempotencyKey !== undefined ? { "idempotency-key": idempotencyKey } : {})
        },
        ...(form !== undefined ? { body: encodeStripeForm(form) } : {})
      });
      if (response.ok) {
        // WP-FIN2 (K7): kroppen valideres strengt av den aktuelle metoden (aldri `as T` uten feltsjekk).
        return readJsonBody(response, ctx);
      }
      const rawBody = await response.text().catch(() => "");
      const { summary, errorType } = classifyStripeErrorBody(rawBody);
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status) && isRetrySafe(method, response.status, idempotencyKey !== undefined);
      lastError = new StripeApiError(`stripe_api_failed_${response.status}:${summary}`, response.status, retryable, errorType);
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw lastError ?? new StripeApiError("stripe_api_failed_unknown", 0, false, null);
  }

  /**
   * WP-FIN2 (K7): et PaymentIntent-svar er gyldig KUN med id, `object: "payment_intent"`, status, beløp (heltall i minste enhet) og valuta (tre bokstaver). Mangler/ugyldig ->
   * `ProviderResponseInvalidError` (mutasjon: `outcome_unknown:provider_response_invalid:<kode>`, lesing: typet feil). Aldri en lagret «undefined» eller en stille standardverdi.
   */
  private paymentIntentFrom(body: unknown, ctx: ResponseContext): StripePaymentIntentObject {
    const raw = expectRecord(body, ctx);
    if (raw["object"] !== "payment_intent") throw new ProviderResponseInvalidError(ctx.operation, raw["object"] === undefined ? "object_missing" : "object_mismatch", ctx.mutation);
    const lastError = raw["last_payment_error"];
    const lastErrorRecord = lastError === undefined || lastError === null ? null : expectRecord(lastError, ctx, "last_payment_error");
    return {
      id: expectId(raw, "id", ctx),
      object: "payment_intent",
      amount: expectMinorUnits(raw, "amount", ctx),
      currency: expectCurrency(raw, "currency", ctx),
      status: expectStatus(raw, "status", ctx),
      metadata: typeof raw["metadata"] === "object" && raw["metadata"] !== null && !Array.isArray(raw["metadata"]) ? (raw["metadata"] as Record<string, string>) : {},
      ...(lastErrorRecord !== null ? { last_payment_error: (() => { const message = optionalText(lastErrorRecord, "message", ctx, 500); return message !== null ? { message } : {}; })() } : {})
    };
  }

  /** WP-FIN2 (K7): samme for refusjoner (id, `object: "refund"`, status, beløp, valuta, intensjons-id, valgfri `reason`). */
  private refundFrom(body: unknown, ctx: ResponseContext): StripeRefundObject {
    const raw = expectRecord(body, ctx);
    if (raw["object"] !== "refund") throw new ProviderResponseInvalidError(ctx.operation, raw["object"] === undefined ? "object_missing" : "object_mismatch", ctx.mutation);
    return {
      id: expectId(raw, "id", ctx),
      object: "refund",
      amount: expectMinorUnits(raw, "amount", ctx),
      currency: expectCurrency(raw, "currency", ctx),
      status: expectStatus(raw, "status", ctx),
      payment_intent: expectId(raw, "payment_intent", ctx),
      reason: optionalText(raw, "reason", ctx, 64)
    };
  }

  /**
   * Oppretter en PaymentIntent UTEN en tilknyttet betalingsmetode
   * (server-initiert, ingen kunde til stede for interaktiv betalingsmetode-
   * innsamling denne sliceen - se `service.ts` sin `submitPaymentIntent()`-
   * kommentar for full begrunnelse). Stripe returnerer deterministisk
   * `status: "requires_payment_method"` for et slikt kall - ALDRI antatt
   * `succeeded` her.
   */
  async createPaymentIntent(input: CreateStripePaymentIntentInput): Promise<StripePaymentIntentObject> {
    const ctx: ResponseContext = { operation: "stripe.create_payment_intent", mutation: true };
    return this.paymentIntentFrom(
      await this.request(
        ctx,
        "POST",
        "/payment_intents",
        {
          amount: toOreInteger(input.amountOre),
          currency: input.currency.toLowerCase(),
          "automatic_payment_methods[enabled]": true,
          "automatic_payment_methods[allow_redirects]": "never",
          ...Object.fromEntries(Object.entries(input.metadata).map(([k, v]) => [`metadata[${k}]`, v]))
        },
        input.idempotencyKey
      ),
      ctx
    );
  }

  async getPaymentIntent(stripePaymentIntentId: string): Promise<StripePaymentIntentObject> {
    const ctx: ResponseContext = { operation: "stripe.get_payment_intent", mutation: false };
    return this.paymentIntentFrom(await this.request(ctx, "GET", `/payment_intents/${encodeURIComponent(stripePaymentIntentId)}`), ctx);
  }

  async createRefund(input: CreateStripeRefundApiInput): Promise<StripeRefundObject> {
    const ctx: ResponseContext = { operation: "stripe.create_refund", mutation: true };
    return this.refundFrom(
      await this.request(
        ctx,
        "POST",
        "/refunds",
        {
          payment_intent: input.stripePaymentIntentId,
          amount: toOreInteger(input.amountOre),
          ...(input.reason !== undefined ? { reason: input.reason } : {})
        },
        input.idempotencyKey
      ),
      ctx
    );
  }

  async getRefund(stripeRefundId: string): Promise<StripeRefundObject> {
    const ctx: ResponseContext = { operation: "stripe.get_refund", mutation: false };
    return this.refundFrom(await this.request(ctx, "GET", `/refunds/${encodeURIComponent(stripeRefundId)}`), ctx);
  }

  /**
   * D-242: billig helsesjekk-/reachability-probe (SAMME rolle som
   * `FikenTransport.listCompanies()`) - `GET /v1/balance` krever INGEN
   * parametre, gjør INGEN mutasjon, og feiler umiddelbart med 401 på en
   * ugyldig/tilbakekalt `secretKey` - egnet som `live_test` for `stripe`-
   * connectoren uten å måtte opprette en reell PaymentIntent/Refund.
   */
  async getBalance(): Promise<StripeBalanceObject> {
    const ctx: ResponseContext = { operation: "stripe.get_balance", mutation: false };
    const raw = expectRecord(await this.request(ctx, "GET", "/balance"), ctx);
    if (raw["object"] !== "balance") throw new ProviderResponseInvalidError(ctx.operation, raw["object"] === undefined ? "object_missing" : "object_mismatch", false);
    // Saldobeløp er fortegnsbærende (negativ saldo er gyldig) - kun heltall i minste enhet og tre-bokstavs valuta kreves.
    const entries = (field: "available" | "pending"): Array<{ amount: number; currency: string }> =>
      expectArray(raw[field], ctx, field).map((item) => {
        const entry = expectRecord(item, ctx, `${field}_entry`);
        const amount = entry["amount"];
        if (typeof amount !== "number" || !Number.isSafeInteger(amount)) throw new ProviderResponseInvalidError(ctx.operation, `${field}_amount_invalid`, false);
        return { amount, currency: expectCurrency(entry, "currency", ctx) };
      });
    return { object: "balance", available: entries("available"), pending: entries("pending") };
  }
}
