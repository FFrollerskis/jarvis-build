/**
 * UA-6 Finance & Spend Integrity Gateway - FJERDE slice (Slice 4, D-110):
 * Vipps MobilePay (P1, masterplan-navngitt sammen med Stripe/bank -
 * `CORE_DEPENDENCY_DECISION_REQUIRED=false`). `payment_intents`/idempotens/
 * avviksdeteksjon/kill-switch/avstemming forblir `JARVIS_CANONICAL`
 * (service.ts, uendret av denne filen); selve betalings-/capture-/refund-
 * tilstanden og webhook-hendelses-identiteten er Vipps sitt
 * `EXTERNAL_CANONICAL` ansvar.
 *
 * D-41-verifiseringsstatus (SAMME disiplin som `stripe-transport.ts`
 * D-109/`fiken-transport.ts` D-107): direkte `WebFetch` mot
 * `developer.vippsmobilepay.com` var EGRESS-BLOKKERT i denne runden (SAMME
 * strukturelle proxy-begrensning som rammet `api.fiken.no`/`api.stripe.com`
 * tidligere). Kontrakten under er derfor `VERIFIED_SEARCH_SNIPPET`
 * (uavhengig websøk denne økten mot flere offisielle
 * developer.vippsmobilepay.com-sideindekserte titler/utdrag - IKKE
 * `VERIFIED_PRIMARY_SOURCE`, full kildeliste i D-110,
 * DECISIONS_AND_ASSUMPTIONS.md):
 *
 *   - **API-produkt**: ePayment API (`/epayment/v1/*`) - Vipps sitt
 *     offisielt anbefalte API for NYE integrasjoner (eldre eCom-/PSP-API-er
 *     eksplisitt IKKE brukt her).
 *   - **Miljøer**: test `https://apitest.vipps.no`, produksjon
 *     `https://api.vipps.no` - HELT separate credential-sett, ALDRI delt.
 *   - **Auth (to steg)**: (1) `POST /accesstoken/get` med headerne
 *     `client_id`/`client_secret`/`Ocp-Apim-Subscription-Key`/
 *     `Merchant-Serial-Number` -> `{ access_token, expires_in }`
 *     (gyldig 1t test / 24t produksjon - IKKE en OAuth-utveksling, egne
 *     eier-utstedte API-nøkler, samme "single-owner"-mønster som Stripe sin
 *     hemmelige nøkkel). (2) ALLE påfølgende ePayment-kall bruker
 *     `Authorization: Bearer <access_token>` PLUSS DE SAMME
 *     `Ocp-Apim-Subscription-Key`/`Merchant-Serial-Number`-headerne.
 *   - **Idempotens**: `Idempotency-Key`-header PÅKREVD på alle
 *     POST/PUT/PATCH/DELETE. Gjenbruk av SAMME nøkkel med ANDRE parametre
 *     -> `409 CONFLICT`. Gjenbruk med SAMME parametre er trygt å gjenta
 *     (samme "første svar vinner"-kontrakt som Stripe).
 *   - **Opprett betaling**: `POST /epayment/v1/payments`, kropp
 *     `{ amount: { currency, value }, paymentMethod: { type: "WALLET" },
 *     reference, returnUrl, userFlow, paymentDescription }` -> `{ reference,
 *     redirectUrl }`. `reference` er UNIK PER MSN (selger-serienummer), IKKE
 *     globalt unik.
 *   - **Beløp**: `value` i minste myntenhet (øre for NOK/DKK, cent for
 *     EUR) - SAMME konvensjon som `payment_intents.amount_ore`, INGEN
 *     konvertering nødvendig (Vipps bruker STORE bokstaver for valutakode,
 *     f.eks. `"NOK"` - i MOTSETNING til Stripe sin små-bokstav-konvensjon,
 *     så INGEN casing-konvertering trengs her heller).
 *   - **Betalingstilstander** (`state`-feltet): `CREATED` (opprettet,
 *     VENTER på brukerbekreftelse i Vipps-appen - et EKTE
 *     brukerinteraksjons-steg, i MOTSETNING til Stripe sin server-only-flyt
 *     denne sliceen) -> `AUTHORIZED` (bruker bekreftet, beløp reservert,
 *     IKKE fanget/oppgjort ennå) -> (selger fanger, delvis eller helt)
 *     `CAPTURED` (fanget beløp faktisk oppgjort). `TERMINATED` (avbrutt
 *     FØR autorisering - av bruker eller timeout) og selgerinitiert
 *     `CANCEL` (avbrutt ETTER autorisering, FØR capture - frigjør
 *     reservasjonen) er BEGGE terminale, IKKE-økonomiske utfall. Delvis
 *     capture etterlater resten av reservasjonen fangbar/avbrytbar til den
 *     enten fanges eller avbrytes eksplisitt.
 *   - **Capture**: `POST /epayment/v1/payments/{reference}/capture`, kropp
 *     `{ modificationAmount: { currency, value } }` - helt eller delvis av
 *     det reserverte beløpet.
 *   - **Cancel**: `POST /epayment/v1/payments/{reference}/cancel` - avbryter
 *     FØR/ETTER autorisering (frigjør gjenværende ikke-fanget reservasjon
 *     ved delvis capture). Kan IKKE fanges etter kansellering.
 *   - **Refund**: `POST /epayment/v1/payments/{reference}/refund`, kropp
 *     `{ modificationAmount: { currency, value } }` - helt eller delvis av
 *     det FANGEDE beløpet (kun etter capture).
 *   - **Webhook-autentisering**: SE `vipps-webhook.ts` (egen fil) - HMAC-
 *     SHA256 over `METHOD\npathOgQuery\ndato;host;innholds-hash`, HELT
 *     ANNERLEDES kontrakt enn Stripe sin `Stripe-Signature`-header (ALDRI
 *     tvunget inn i Stripe sitt mønster - byggeordrens §9 "Do not force a
 *     Stripe pattern").
 */

const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const TOKEN_REFRESH_SKEW_MS = 60_000;

import { toOreInteger } from "./ore.ts";

import { financeBackoff, financeFetch, isRetrySafe } from "./http.ts";
import { expectAccessToken, expectCurrency, expectId, expectMinorUnits, expectRecord, expectStatus, readJsonBody, type ResponseContext } from "./provider-response.ts";

export type VippsEnvironment = "test" | "production";

export function vippsApiBaseUrl(environment: VippsEnvironment): string {
  return environment === "production" ? "https://api.vipps.no" : "https://apitest.vipps.no";
}

export class VippsApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "VippsApiError";
  }
}

/** Tolerant, avkortet (200 tegn) sanering av Vipps sin feilrespons - ALDRI rå kropp/headere logget (samme presedens som Stripe/Fiken sine `classify*ErrorBody`). */
function classifyVippsErrorBody(rawBody: string): string {
  const trimmed = rawBody.slice(0, 200).trim();
  try {
    const parsed = JSON.parse(rawBody) as { title?: string; detail?: string };
    const message = typeof parsed.detail === "string" ? parsed.detail.slice(0, 200) : typeof parsed.title === "string" ? parsed.title.slice(0, 200) : trimmed;
    return message.length > 0 ? message : "no_body";
  } catch {
    return trimmed.length > 0 ? trimmed : "no_body";
  }
}

export interface VippsAmount {
  currency: string;
  value: number;
}

export interface VippsPaymentObject {
  reference: string;
  state: string;
  amount: VippsAmount;
}

export interface CreateVippsPaymentInput {
  amountOre: number;
  /** Store bokstaver (`"NOK"`) - Vipps forventer SAMME casing, ingen konvertering (i motsetning til Stripe). */
  currency: string;
  /** Selger-unik (per MSN) referanse - Jarvis sin egen `payment_intent_id` gjenbrukt direkte (aldri en separat generert streng). */
  reference: string;
  paymentDescription: string;
  returnUrl: string;
  idempotencyKey: string;
}

export interface VippsModificationInput {
  reference: string;
  amountOre: number;
  currency: string;
  idempotencyKey: string;
}

/**
 * Minimalt grensesnitt FinanceService faktisk trenger - SAMME "narrow
 * injectable writer"-prinsipp som `StripePaymentWriter`/
 * `FikenGeneralJournalEntryWriter`. Token-henting/caching er en
 * IMPLEMENTASJONSDETALJ innkapslet i `VippsTransport` selv, ALDRI
 * eksponert opp til FinanceService (som aldri skal måtte vite om
 * access-token-livssyklusen).
 */
export interface VippsPaymentWriter {
  createPayment(input: CreateVippsPaymentInput): Promise<VippsPaymentObject>;
  getPayment(reference: string): Promise<VippsPaymentObject>;
  capturePayment(input: VippsModificationInput): Promise<VippsPaymentObject>;
  cancelPayment(reference: string, idempotencyKey: string): Promise<VippsPaymentObject>;
  refundPayment(input: VippsModificationInput): Promise<VippsPaymentObject>;
  /** D-242: connector-helsesjekk-probe, se `VippsTransport.checkCredentials()` sin doc-kommentar. */
  checkCredentials(): Promise<void>;
}

/**
 * `fetch()`-basert (SAMME "ingen ny SDK uten begrunnelse"-prinsipp som
 * CLAUDE.md regel 3 og `StripeTransport`/`FikenTransport`) - INGEN
 * `@vippsmobilepay/sdk`-npm-pakke.
 */
export class VippsTransport implements VippsPaymentWriter {
  private readonly baseUrl: string;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly subscriptionKey: string,
    private readonly merchantSerialNumber: string,
    environment: VippsEnvironment
  ) {
    this.baseUrl = vippsApiBaseUrl(environment);
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return this.cachedToken.token;
    }
    const response = await financeFetch(`${this.baseUrl}/accesstoken/get`, {
      method: "POST",
      headers: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        "Ocp-Apim-Subscription-Key": this.subscriptionKey,
        "Merchant-Serial-Number": this.merchantSerialNumber
      }
    });
    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      throw new VippsApiError(`vipps_access_token_failed_${response.status}:${classifyVippsErrorBody(rawBody)}`, response.status, RETRYABLE_HTTP_STATUS.has(response.status));
    }
    // WP-FIN2 (K7): token-utvekslingen er ingen pengemutasjon - et ugyldig svar er en typet feil (aldri `Bearer undefined`, aldri en cachet «undefined»).
    const ctx: ResponseContext = { operation: "vipps.access_token", mutation: false };
    const body = expectRecord(await readJsonBody(response, ctx), ctx);
    const accessToken = expectAccessToken(body, "access_token", ctx);
    const expiresInMs = Number(body["expires_in"]) * 1000;
    this.cachedToken = { token: accessToken, expiresAtMs: now + (Number.isFinite(expiresInMs) && expiresInMs > 0 ? expiresInMs : 3_600_000) };
    return accessToken;
  }

  /**
   * D-242: billig helsesjekk-/reachability-probe (SAMME rolle som
   * `FikenTransport.listCompanies()`/`StripeTransport.getBalance()`) - Vipps
   * har INGEN parameterløs "whoami"-lesing i ePayment-API-et (i motsetning
   * til Fiken/Stripe), men `POST /accesstoken/get` (SAMME kall `request()`
   * allerede gjør FØR ethvert ekte API-kall) er selv INGEN mutasjon og
   * feiler umiddelbart med `vipps_access_token_failed_401`/`_403` på en
   * ugyldig `client_id`/`client_secret`/`Ocp-Apim-Subscription-Key` - egnet
   * som `live_test` uten å måtte opprette en reell betaling.
   */
  async checkCredentials(): Promise<void> {
    await this.getAccessToken();
  }

  private async request(ctx: ResponseContext, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    let lastError: VippsApiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const accessToken = await this.getAccessToken();
      const response = await financeFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
          "Merchant-Serial-Number": this.merchantSerialNumber,
          "content-type": "application/json",
          accept: "application/json",
          ...(idempotencyKey !== undefined ? { "Idempotency-Key": idempotencyKey } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      if (response.ok) {
        return readJsonBody(response, ctx); // WP-FIN2 (K7): valideres strengt av den aktuelle metoden
      }
      const rawBody = await response.text().catch(() => "");
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status) && isRetrySafe(method, response.status, idempotencyKey !== undefined);
      lastError = new VippsApiError(`vipps_api_failed_${response.status}:${classifyVippsErrorBody(rawBody)}`, response.status, retryable);
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
      await financeBackoff(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw lastError ?? new VippsApiError("vipps_api_failed_unknown", 0, false);
  }

  /**
   * WP-FIN2 (K7): et Vipps-betalingssvar er gyldig KUN med `reference` (trygg id), `state` (status) og `amount` {`value` (heltall i minste enhet), `currency` (tre bokstaver)} - feltene Jarvis
   * lagrer og avstemmer mot. Mangler/ugyldig: mutasjon = `outcome_unknown:provider_response_invalid:<kode>`, lesing = typet feil. MERK (`unverified`, D-41): Vipps' dokumentasjon (søkeutdrag) sier
   * at opprett-svaret bærer `reference` og `redirectUrl`; at `state`/`amount` også følger med er IKKE verifisert. Avviker en ekte leverandør, feiler dette LUKKET (ukjent utfall) - aldri en
   * gjettet tilstand eller et beløp lagret som leverandørens. Må avklares mot sandkasse ved aktivering (`BLOCKED_EXTERNAL`).
   */
  private paymentFrom(body: unknown, ctx: ResponseContext): VippsPaymentObject {
    const raw = expectRecord(body, ctx);
    const amount = expectRecord(raw["amount"], ctx, "amount");
    return {
      reference: expectId(raw, "reference", ctx),
      state: expectStatus(raw, "state", ctx),
      amount: { currency: expectCurrency(amount, "currency", ctx), value: expectMinorUnits(amount, "value", ctx) }
    };
  }

  async createPayment(input: CreateVippsPaymentInput): Promise<VippsPaymentObject> {
    const ctx: ResponseContext = { operation: "vipps.create_payment", mutation: true };
    return this.paymentFrom(
      await this.request(
        ctx,
        "POST",
        "/epayment/v1/payments",
        {
          amount: { currency: input.currency, value: toOreInteger(input.amountOre) },
          paymentMethod: { type: "WALLET" },
          reference: input.reference,
          paymentDescription: input.paymentDescription,
          returnUrl: input.returnUrl,
          userFlow: "WEB_REDIRECT"
        },
        input.idempotencyKey
      ),
      ctx
    );
  }

  async getPayment(reference: string): Promise<VippsPaymentObject> {
    const ctx: ResponseContext = { operation: "vipps.get_payment", mutation: false };
    return this.paymentFrom(await this.request(ctx, "GET", `/epayment/v1/payments/${encodeURIComponent(reference)}`), ctx);
  }

  async capturePayment(input: VippsModificationInput): Promise<VippsPaymentObject> {
    const ctx: ResponseContext = { operation: "vipps.capture_payment", mutation: true };
    return this.paymentFrom(
      await this.request(
        ctx,
        "POST",
        `/epayment/v1/payments/${encodeURIComponent(input.reference)}/capture`,
        { modificationAmount: { currency: input.currency, value: toOreInteger(input.amountOre) } },
        input.idempotencyKey
      ),
      ctx
    );
  }

  async cancelPayment(reference: string, idempotencyKey: string): Promise<VippsPaymentObject> {
    const ctx: ResponseContext = { operation: "vipps.cancel_payment", mutation: true };
    return this.paymentFrom(await this.request(ctx, "POST", `/epayment/v1/payments/${encodeURIComponent(reference)}/cancel`, undefined, idempotencyKey), ctx);
  }

  async refundPayment(input: VippsModificationInput): Promise<VippsPaymentObject> {
    const ctx: ResponseContext = { operation: "vipps.refund_payment", mutation: true };
    return this.paymentFrom(
      await this.request(
        ctx,
        "POST",
        `/epayment/v1/payments/${encodeURIComponent(input.reference)}/refund`,
        { modificationAmount: { currency: input.currency, value: toOreInteger(input.amountOre) } },
        input.idempotencyKey
      ),
      ctx
    );
  }
}
