/**
 * UA-6 Finance & Spend Integrity Gateway. Jarvis EIER selv Payment/Spend
 * Intent-domenet (JARVIS_CANONICAL, D-64 Core-vs-Adapter-porten kjørt
 * FØRST for hver leverandør - se DECISIONS_AND_ASSUMPTIONS.md D-107/D-109):
 * idempotens, deterministisk avviksdeteksjon, avstemming og
 * eier-kontrollert kill switch er ALDRI utsatt til en leverandør.
 * Fiken (P0, D-107), Stripe (P1, D-109, TREDJE slice) og Vipps MobilePay
 * (P1, D-110, FJERDE slice) er ALLE HYBRID_WITH_CLEAR_AUTHORITY: Fiken
 * forblir bokføring-av-post (norsk bokføringslov) EXTERNAL_CANONICAL;
 * Stripe/Vipps forblir selve betalings-/capture-/refund-tilstanden og
 * webhook-hendelses-identiteten EXTERNAL_CANONICAL. Bank (resten av P1) og
 * kort/wallet (P2) er BEVISST IKKE bygget ennå - se `PaymentProvider` under.
 */

export type PaymentIntentState = "draft" | "submitted" | "provider_acknowledged" | "settled" | "failed" | "cancelled";
export type ReconciliationState = "unreconciled" | "matched" | "mismatched";
/** 'fiken' (P0, D-107), 'stripe' (P1, D-109), 'vipps' (P1, D-110) og 'neonomics' (P1 bank/open-banking, D-111) bygget. Programmerbart kort/wallet (P2) er masterplan-navngitt FREMTIDIG provider. */
export type PaymentProvider = "fiken" | "stripe" | "vipps" | "neonomics";

export type PaymentIntentEventType =
  | "intent_created"
  | "submitted"
  | "provider_acknowledged"
  | "settled"
  | "failed"
  | "cancelled"
  | "anomaly_flagged"
  | "reconciled"
  | "kill_switch_blocked"
  /** D-110 (UA-6 Slice 4): Vipps sitt payment.state forblir 'AUTHORIZED' selv ETTER en vellykket capture (VERIFIED_SEARCH_SNIPPET) - en distinkt hendelsestype er derfor nødvendig, ALDRI korrekt uttrykt som 'settled' alene for et delvis capture-steg. */
  | "captured";

export interface PaymentIntent {
  payment_intent_id: string;
  tenant_id: string;
  memory_space_id: string;
  idempotency_key: string;
  state: PaymentIntentState;
  purpose: string;
  amount_ore: number;
  currency: string;
  vendor_name: string;
  vendor_provider_ref: string | null;
  /** D-116: peker til `finance_vendors` - NULLABLE, "ukjent forblir ukjent" for enhver intent som ikke eksplisitt hevder en canonical vendor-identitet. Se `vendor-registry.ts`. */
  vendor_id: string | null;
  account_code: string;
  counter_account_code: string | null;
  provider: PaymentProvider;
  provider_ref: string | null;
  reconciliation_state: ReconciliationState;
  /** Deterministiske avviksflagg (ALDRI AI-inferert - Q-26-grensen). */
  anomaly_flags: readonly string[];
  failure_reason: string | null;
  owner_person_id: string | null;
  /**
   * Siste kjente leverandør-rapporterte tilstand (Stripe `status`-strengen,
   * f.eks. "requires_payment_method"/"processing"/"succeeded") - REN
   * observasjon, ALDRI autoritativ over `state`. `null` for Fiken
   * (synkron postering, ingen egen provider-side-status-maskin).
   */
  provider_status: string | null;
  provider_reported_amount_ore: number | null;
  provider_reported_currency: string | null;
  /** Ordens-vokter: en eldre hendelse skal ALDRI overskrive nyere lagret provider_status - se FinanceService sin applyProviderOutcome(). */
  provider_status_updated_at: string | null;
  /** Pointer til hvilken stripe_webhook_events-rad som sist oppdaterte provider_status - BEVISST ingen FK (unngår sirkulær avhengighet). */
  latest_stripe_event_id: string | null;
  /** D-110: pointer til hvilken vipps_webhook_events-rad (dedupe_key) som sist oppdaterte provider_status - SAMME "pointer, ingen FK"-prinsipp. */
  latest_vipps_event_key: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  /** WP-F1: første reservasjon av en innsending mot leverandøren (se 099) - bærer leverandørens idempotensvindu. */
  first_submit_attempt_at: string | null;
}

export interface PaymentIntentEvent {
  event_id: string;
  tenant_id: string;
  memory_space_id: string;
  payment_intent_id: string;
  event_type: PaymentIntentEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export interface FinanceKillSwitch {
  tenant_id: string;
  enabled: boolean;
  enabled_by_person_id: string | null;
  enabled_at: string | null;
  disabled_at: string | null;
  reason: string | null;
  updated_at: string;
}

export interface CreatePaymentIntentInput {
  idempotency_key: string;
  purpose: string;
  amount_ore: number;
  currency?: string;
  vendor_name: string;
  vendor_provider_ref?: string;
  /** D-116: valgfri eksplisitt canonical vendor-identitet (`finance_vendors.vendor_id`) - `undefined` betyr INGEN vendor-korrekthetskontroll for denne intenten (byte-for-byte uendret oppførsel for enhver kaller fra FØR denne sliceen). */
  vendor_id?: string;
  account_code: string;
  /** Motkonto (bank-/kontantkonto) for balansert postering - se `MissingCounterAccountError`. */
  counter_account_code?: string;
  owner_person_id?: string;
  actor_person_id?: string;
  /**
   * D-109 (UA-6 Slice 3): valgfri - `undefined` -> DB-default `'fiken'`
   * (byte-for-byte UENDRET oppførsel for enhver eksisterende kaller fra
   * FØR denne sliceen). Eksplisitt `'stripe'` oppretter en Stripe-styrt
   * intent i stedet - `account_code` forblir OBLIGATORISK for BEGGE
   * providere (intern bokføringskategori-tag), men det strenge Fiken-
   * kontokodeformatet (`^\d{4}(:\d{5})?$`) håndheves KUN når provider
   * faktisk er `'fiken'` (se `validateCreateInput()` i service.ts og
   * 040_stripe.sql sin betingede CHECK-constraint).
   */
  provider?: PaymentProvider;
}

/** Fiken sin egen kontokode-form (verifisert mot offisiell swagger-spec, D-41): `NNNN` eller `NNNN:NNNNN` (reskontro). */
export const ACCOUNT_CODE_PATTERN = /^\d{4}(:\d{5})?$/;
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class InvalidAccountCodeError extends Error {
  constructor(readonly accountCode: string) {
    super(`invalid_account_code:${accountCode}`);
    this.name = "InvalidAccountCodeError";
  }
}

/** D-392 (JARVIS-072): samme idempotency_key med ANDRE parametre er en feil, aldri en stille retur av en annen betaling. */
export class IdempotencyKeyConflictError extends Error {
  constructor(readonly idempotencyKey: string, readonly mismatchedFields: readonly string[]) {
    super(`idempotency_key_conflict:${idempotencyKey}:${mismatchedFields.join(",")}`);
    this.name = "IdempotencyKeyConflictError";
  }
}

export class InvalidAmountError extends Error {
  constructor(readonly amountOre: number) {
    super(`invalid_amount_ore:${amountOre}`);
    this.name = "InvalidAmountError";
  }
}

export class InvalidCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(`invalid_currency:${currency}`);
    this.name = "InvalidCurrencyError";
  }
}

/** Akseptansekriterium 5 ("Finance kill switch stops new transactions immediately"): deterministisk, ALDRI kun en promptregel (CLAUDE.md regel 2). */
export class FinanceKillSwitchActiveError extends Error {
  constructor(readonly tenantId: string) {
    super(`finance_kill_switch_active:${tenantId}`);
    this.name = "FinanceKillSwitchActiveError";
  }
}

/** Akseptansekriterium 1 ("Retry cannot double-pay"): submitPaymentIntent() på en intent som allerede har forlatt 'draft' er ALDRI en ny provider-mutasjon. */
export class PaymentIntentAlreadySubmittedError extends Error {
  constructor(
    readonly paymentIntentId: string,
    readonly state: PaymentIntentState
  ) {
    super(`payment_intent_already_submitted:${paymentIntentId}:${state}`);
    this.name = "PaymentIntentAlreadySubmittedError";
  }
}

/**
 * WP-F1 (D-462): en innsending mot leverandøren er RESERVERT (`submitted`) og pågår - eller pågikk for kort tid siden til at vi kan vite at den er
 * død. Et parallelt kall (annen gateway-nøkkel, annen prosess) skal ALDRI kalle leverandøren på nytt mens første kall kan være i flukt: to samtidige
 * kall mot samme objekt gir kun ÉN leverandørhandling (dobbeltbetalingsvern lag 3, i tillegg til gateway-ledgeren og leverandørens Idempotency-Key).
 */
export class SubmitInFlightError extends Error {
  constructor(readonly subjectId: string) {
    super(`submit_in_flight:${subjectId}`);
    this.name = "SubmitInFlightError";
  }
}

/**
 * WP-F1 (D-462; review M-F1): duplikatvakten INNE i reservasjonstransaksjonen. En annen intensjon mot samme leverandør (provider + navn), beløp og valuta er allerede sendt
 * (siste døgn) eller står reservert/med ukjent utfall, og eieren har ikke kvittert den (`confirm_possible_duplicate_of`). Kastes FØR `draft -> submitted` og FØR noe leverandørkall.
 * Meldingen er den samme koden som den tidlige validatoren avviser med (`possible_duplicate_of:<id>`).
 */
export class PossibleDuplicatePaymentError extends Error {
  constructor(readonly paymentIntentId: string, readonly duplicateOfId: string) {
    super(`possible_duplicate_of:${duplicateOfId}`);
    this.name = "PossibleDuplicatePaymentError";
  }
}

/**
 * WP-F1: leverandørutfallet er UKJENT (tidsavbrudd/nettverk/5xx/409 etter at kallet kan ha nådd leverandøren). Meldingen begynner med `outcome_unknown`
 * slik at ToolGateway behandler den som et ukjent utfall (ledger `unverified`, aldri retry-bar med samme nøkkel, `reconcile()`, varsel til eieren) -
 * i motsetning til en entydig avvisning (`failed`, retry tillatt). Den opprinnelige feilen beholdes som `cause` (aldri som tekst - kan bære leverandørdetaljer).
 */
export class ProviderOutcomeUnknownError extends Error {
  constructor(readonly subjectId: string, detail: string, cause?: unknown) {
    super(`outcome_unknown:${detail}`.slice(0, 160), cause === undefined ? undefined : { cause });
    this.name = "ProviderOutcomeUnknownError";
  }
}

/**
 * WP-F1: avvik som settes av innsendings-/avstemmingskjeden (ikke av leverandør-sveipene). `SUBMIT_OUTCOME_UNKNOWN` = en innsending endte uten et
 * entydig leverandørsvar (utfallet er ukjent); fjernes først når en senere innsending faktisk får leverandørens svar.
 */
export type FinanceChainAnomalyType = "SUBMIT_OUTCOME_UNKNOWN";

/** Akseptansekriterium 3 ("Wrong account/vendor... deterministically caught"): Jarvis GJETTER ALDRI Tobias sin bankkontokode - se D-41-kommentaren i migrasjonen. */
export class MissingCounterAccountError extends Error {
  constructor(readonly paymentIntentId: string) {
    super(`missing_counter_account_code:${paymentIntentId}`);
    this.name = "MissingCounterAccountError";
  }
}

export class MissingVendorProviderRefError extends Error {
  constructor(readonly paymentIntentId: string) {
    super(`missing_vendor_provider_ref:${paymentIntentId}`);
    this.name = "MissingVendorProviderRefError";
  }
}

export class FikenCredentialsUnavailableError extends Error {
  constructor(readonly tenantId: string) {
    super(`fiken_credentials_unavailable:${tenantId}`);
    this.name = "FikenCredentialsUnavailableError";
  }
}

export class PaymentIntentNotFoundError extends Error {
  constructor(readonly paymentIntentId: string) {
    super(`payment_intent_not_found:${paymentIntentId}`);
    this.name = "PaymentIntentNotFoundError";
  }
}

// === Stripe (P1, D-109, UA-6 Slice 3) ===================================

export class StripeCredentialsUnavailableError extends Error {
  constructor(readonly tenantId: string) {
    super(`stripe_credentials_unavailable:${tenantId}`);
    this.name = "StripeCredentialsUnavailableError";
  }
}

/** Provider-siden svarte, men i en form Jarvis ikke kan tolke deterministisk - ALDRI stille anta suksess (byggeordrens §5/§6). */
export class AmbiguousProviderResponseError extends Error {
  constructor(readonly paymentIntentId: string, readonly detail: string) {
    super(`ambiguous_provider_response:${paymentIntentId}:${detail}`);
    this.name = "AmbiguousProviderResponseError";
  }
}

export class PaymentIntentNotStripeError extends Error {
  constructor(readonly paymentIntentId: string, readonly actualProvider: PaymentProvider) {
    super(`payment_intent_not_stripe:${paymentIntentId}:${actualProvider}`);
    this.name = "PaymentIntentNotStripeError";
  }
}

/** Refusjon kan kun opprettes mot en FAKTISK avsluttet (settled) Stripe-betaling - Stripe krever selv en ekte belastning å refundere mot. */
export class PaymentIntentNotSettledError extends Error {
  constructor(readonly paymentIntentId: string, readonly state: PaymentIntentState) {
    super(`payment_intent_not_settled:${paymentIntentId}:${state}`);
    this.name = "PaymentIntentNotSettledError";
  }
}

/** Akseptansekriterium (byggeordrens §9, "prevent invalid aggregate refund amount"): summen av alle ikke-mislykkede refusjoner kan ALDRI overstige det opprinnelige beløpet. */
export class ExcessiveRefundAmountError extends Error {
  constructor(readonly paymentIntentId: string, readonly requestedOre: number, readonly remainingOre: number) {
    super(`excessive_refund_amount:${paymentIntentId}:requested=${requestedOre}:remaining=${remainingOre}`);
    this.name = "ExcessiveRefundAmountError";
  }
}

export class RefundAlreadySubmittedError extends Error {
  constructor(readonly refundId: string, readonly state: PaymentIntentState) {
    super(`refund_already_submitted:${refundId}:${state}`);
    this.name = "RefundAlreadySubmittedError";
  }
}

export class RefundNotFoundError extends Error {
  constructor(readonly refundId: string) {
    super(`refund_not_found:${refundId}`);
    this.name = "RefundNotFoundError";
  }
}

/** Byggeordrens §12: en webhook-hendelse hvis leverandørobjekt allerede peker til en ANNEN tenant - fail-closed, ALDRI stille rutet/overskrevet. */
export class ProviderObjectTenantConflictError extends Error {
  constructor(readonly providerRef: string, readonly expectedTenantId: string, readonly actualTenantId: string) {
    super(`provider_object_tenant_conflict:${providerRef}:expected=${expectedTenantId}:actual=${actualTenantId}`);
    this.name = "ProviderObjectTenantConflictError";
  }
}

export class InvalidWebhookSignatureError extends Error {
  constructor(readonly detail: string) {
    super(`invalid_webhook_signature:${detail}`);
    this.name = "InvalidWebhookSignatureError";
  }
}

export class StripeTenantNotConfiguredError extends Error {
  constructor() {
    super("stripe_tenant_not_configured");
    this.name = "StripeTenantNotConfiguredError";
  }
}

/**
 * Stripe sin egen dokumenterte reason-enum (owner-oppgitt underdel -
 * 'expired_uncaptured_charge' er Stripe-INTERN-generert, ALDRI noe Jarvis
 * selv setter ved opprettelse - verifisert mot Stripe sin offisielle
 * Refund-objekt-dokumentasjon, D-41).
 */
export type StripeRefundReason = "duplicate" | "fraudulent" | "requested_by_customer";
export const STRIPE_REFUND_REASONS: readonly StripeRefundReason[] = ["duplicate", "fraudulent", "requested_by_customer"];

/** Gjenbruker BEVISST samme 6-tilstands livssyklus-vokabular som PaymentIntentState (byggeordrens §9: "reuse existing state-machine conventions", ikke et nytt vokabular). */
export type StripeRefundState = PaymentIntentState;

export interface StripeRefund {
  refund_id: string;
  tenant_id: string;
  memory_space_id: string;
  payment_intent_id: string;
  idempotency_key: string;
  state: StripeRefundState;
  amount_ore: number;
  currency: string;
  reason: StripeRefundReason | null;
  provider_ref: string | null;
  failure_reason: string | null;
  anomaly_flags: readonly string[];
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  first_submit_attempt_at: string | null;
}

export interface CreateStripeRefundInput {
  idempotency_key: string;
  payment_intent_id: string;
  amount_ore: number;
  reason?: StripeRefundReason;
  owner_person_id?: string;
  actor_person_id?: string;
}

/** WP-F1: `rejected` = autentisert hendelse med permanent ugyldig innhold (dødbrev med årsak, besvart 2xx - ingen evig retry). */
export type StripeWebhookEventStatus = "received" | "verified" | "processed" | "failed_retryable" | "unsupported" | "rejected";

export interface StripeWebhookEventRecord {
  stripe_event_id: string;
  tenant_id: string;
  memory_space_id: string;
  event_type: string;
  api_version: string | null;
  payment_intent_id: string | null;
  status: StripeWebhookEventStatus;
  payload_summary: Record<string, unknown>;
  error_message: string | null;
  stripe_created_at: string;
  received_at: string;
  processed_at: string | null;
  created_at: string;
}

/**
 * Deterministisk avviksdeteksjon spesifikk for Stripe (byggeordrens §11) -
 * ren SQL i FinanceService.runProviderAnomalyDetection(), ALDRI AI-inferert
 * (Q-26-grensen). Skrives til DEN EKSISTERENDE `payment_intents.anomaly_flags`-
 * kolonnen (refusjonsavvik propageres opp til foreldre-intenten) slik at
 * DEN EKSISTERENDE `detectPaymentAnomalies()`-overflatingen fanger det uten
 * noen ny OpenLoop-mekanisme.
 */
export type StripeAnomalyType =
  | "PROVIDER_AMOUNT_MISMATCH"
  | "PROVIDER_CURRENCY_MISMATCH"
  | "PROVIDER_DUPLICATE_OBJECT_CONFLICT"
  | "UNKNOWN_PROVIDER_OUTCOME"
  | "WEBHOOK_STATE_CONFLICT"
  | "REFUND_AMOUNT_CONFLICT"
  | "PROVIDER_OBJECT_TENANT_CONFLICT";

export interface StripeProviderAnomalyDetectionResult {
  payment_intent_flags_added: number;
  refund_flags_added: number;
  flags_cleared: number;
}

/**
 * Deterministisk utfallskartlegging Stripe PaymentIntent.status -> Jarvis
 * PaymentIntentState (byggeordrens §5: "Map Stripe outcomes
 * deterministically... Do not silently infer success"). Verifisert mot
 * Stripe sin dokumenterte status-enum: `requires_payment_method`/
 * `requires_confirmation`/`requires_action`/`processing`/
 * `requires_capture` er ALLE mellomtilstander - Stripe har INGEN egen
 * "failed"-status på selve PaymentIntent-objektet (et mislykket forsøk
 * holder objektet i `requires_payment_method` med `last_payment_error`
 * satt - se `payment_intent.payment_failed`-hendelsestype-håndteringen i
 * FinanceService.ingestStripeWebhookEvent(), IKKE denne statustabellen).
 * `canceled` mappes til Jarvis sin EGEN `cancelled` (ikke `failed`) - en
 * bevisst avbrutt intensjon, ikke en feilet en (PAYMENT_INTENT_TRANSITIONS
 * utvidet til å tillate provider_acknowledged -> cancelled for nettopp
 * dette).
 */
export const STRIPE_STATUS_TO_JARVIS_STATE: Readonly<Record<string, PaymentIntentState | null>> = {
  requires_payment_method: null, // forblir provider_acknowledged - observasjonell status alene, ingen state-overgang
  requires_confirmation: null,
  requires_action: null,
  processing: null,
  requires_capture: null,
  succeeded: "settled",
  canceled: "cancelled"
};

export const STRIPE_REFUND_STATUS_TO_STATE: Readonly<Record<string, StripeRefundState | null>> = {
  pending: null, // forblir provider_acknowledged
  requires_action: null,
  succeeded: "settled",
  failed: "failed",
  canceled: "cancelled"
};

// === Vipps MobilePay (P1, D-110, UA-6 Slice 4) ===========================

export class VippsCredentialsUnavailableError extends Error {
  constructor(readonly tenantId: string) {
    super(`vipps_credentials_unavailable:${tenantId}`);
    this.name = "VippsCredentialsUnavailableError";
  }
}

export class PaymentIntentNotVippsError extends Error {
  constructor(readonly paymentIntentId: string, readonly actualProvider: PaymentProvider) {
    super(`payment_intent_not_vipps:${paymentIntentId}:${actualProvider}`);
    this.name = "PaymentIntentNotVippsError";
  }
}

/**
 * Capture/cancel krever at Vipps FAKTISK har autorisert (reservert) beløpet
 * - IKKE bare "sendt inn" (`CREATED`, fortsatt VENTER på brukerbekreftelse
 * i Vipps-appen - byggeordrens §5 "represent intermediate/waiting states
 * correctly", §7 "no over-capture"/"invalid-state capture"). Refusjon
 * gjenbruker DEN EKSISTERENDE `PaymentIntentNotSettledError` (generisk
 * navngitt, INGEN Stripe-spesifikk streng i selve klassen) - SAMME
 * precondition som Stripe (kun refunder en FAKTISK oppgjort betaling).
 */
export class PaymentIntentNotAuthorizedError extends Error {
  constructor(readonly paymentIntentId: string, readonly providerStatus: string | null) {
    super(`payment_intent_not_authorized:${paymentIntentId}:${providerStatus ?? "unknown"}`);
    this.name = "PaymentIntentNotAuthorizedError";
  }
}

export class VippsTenantNotConfiguredError extends Error {
  constructor() {
    super("vipps_tenant_not_configured");
    this.name = "VippsTenantNotConfiguredError";
  }
}

/** Speiler `ExcessiveRefundAmountError` (byggeordrens §7 "no over-capture") - egen klasse for korrekt feilnavn/melding, ALDRI gjenbruk av refusjons-klassen for en INNGÅENDE handling. */
export class ExcessiveCaptureAmountError extends Error {
  constructor(readonly paymentIntentId: string, readonly requestedOre: number, readonly remainingOre: number) {
    super(`excessive_capture_amount:${paymentIntentId}:requested=${requestedOre}:remaining=${remainingOre}`);
    this.name = "ExcessiveCaptureAmountError";
  }
}

export class CaptureAlreadySubmittedError extends Error {
  constructor(readonly captureId: string, readonly state: PaymentIntentState) {
    super(`capture_already_submitted:${captureId}:${state}`);
    this.name = "CaptureAlreadySubmittedError";
  }
}

export class CaptureNotFoundError extends Error {
  constructor(readonly captureId: string) {
    super(`capture_not_found:${captureId}`);
    this.name = "CaptureNotFoundError";
  }
}

/** Gjenbruker BEVISST samme 6-tilstands livssyklus-vokabular som PaymentIntentState (byggeordrens §14: "reuse existing state-machine conventions"). */
export type VippsCaptureState = PaymentIntentState;
export type VippsRefundState = PaymentIntentState;

export interface VippsCapture {
  capture_id: string;
  tenant_id: string;
  memory_space_id: string;
  payment_intent_id: string;
  idempotency_key: string;
  state: VippsCaptureState;
  amount_ore: number;
  currency: string;
  failure_reason: string | null;
  anomaly_flags: readonly string[];
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  first_submit_attempt_at: string | null;
}

export interface CreateVippsCaptureInput {
  idempotency_key: string;
  payment_intent_id: string;
  amount_ore: number;
  owner_person_id?: string;
  actor_person_id?: string;
}

export interface VippsRefund {
  refund_id: string;
  tenant_id: string;
  memory_space_id: string;
  payment_intent_id: string;
  idempotency_key: string;
  state: VippsRefundState;
  amount_ore: number;
  currency: string;
  provider_ref: string | null;
  failure_reason: string | null;
  anomaly_flags: readonly string[];
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  first_submit_attempt_at: string | null;
}

export interface CreateVippsRefundInput {
  idempotency_key: string;
  payment_intent_id: string;
  amount_ore: number;
  owner_person_id?: string;
  actor_person_id?: string;
}

export type VippsWebhookEventStatus = "received" | "verified" | "processed" | "failed_retryable" | "unsupported" | "rejected";

export interface VippsWebhookEventRecord {
  dedupe_key: string;
  tenant_id: string;
  memory_space_id: string;
  event_name: string;
  payment_intent_id: string | null;
  status: VippsWebhookEventStatus;
  payload_summary: Record<string, unknown>;
  error_message: string | null;
  vipps_event_timestamp: string | null;
  received_at: string;
  processed_at: string | null;
  created_at: string;
}

/**
 * Deterministisk avviksdeteksjon spesifikk for Vipps (byggeordrens §12) -
 * ren SQL i FinanceService.runVippsProviderAnomalyDetection(), ALDRI
 * AI-inferert (Q-26-grensen). Skrives til DEN EKSISTERENDE
 * `payment_intents.anomaly_flags`-kolonnen (SAMME gjenbruk som Stripe) slik
 * at DEN EKSISTERENDE `detectPaymentAnomalies()`-overflatingen fanger det
 * uten noen ny OpenLoop-mekanisme. `CAPTURE_AMOUNT_CONFLICT`/
 * `DUPLICATE_PROVIDER_EFFECT`/`EXPIRED_PAYMENT_WITH_ACTIVE_INTENT` er NYE
 * (Vipps-spesifikke situasjoner uten Stripe-parallell); resten gjenbruker
 * de EKSISTERENDE StripeAnomalyType-navnene der semantikken faktisk
 * overlapper (byggeordrens §12: "Reuse existing canonical anomaly
 * structures... Do not duplicate anomaly types unnecessarily").
 */
export type VippsAnomalyType =
  | "PROVIDER_AMOUNT_MISMATCH"
  | "PROVIDER_CURRENCY_MISMATCH"
  | "PROVIDER_REFERENCE_CONFLICT"
  | "UNKNOWN_PROVIDER_OUTCOME"
  | "PROVIDER_STATE_CONFLICT"
  | "CAPTURE_AMOUNT_CONFLICT"
  | "REFUND_AMOUNT_CONFLICT"
  | "PROVIDER_OBJECT_TENANT_CONFLICT"
  | "DUPLICATE_PROVIDER_EFFECT"
  | "EXPIRED_PAYMENT_WITH_ACTIVE_INTENT";

export interface VippsProviderAnomalyDetectionResult {
  payment_intent_flags_added: number;
  capture_flags_added: number;
  refund_flags_added: number;
  flags_cleared: number;
}

/**
 * Deterministisk utfallskartlegging Vipps `state` -> Jarvis
 * PaymentIntentState (byggeordrens §6: "Map real Vipps states
 * deterministically... Do not collapse materially different economic
 * states"). `null` betyr "bli i `provider_acknowledged`, KUN observasjonell
 * endring av `provider_status`" (SAMME mønster som
 * `STRIPE_STATUS_TO_JARVIS_STATE`). `CAPTURED` er BEVISST IKKE i dette
 * kartet - overgang til `settled` avgjøres av AGGREGAT fanget beløp (kan
 * være delvis, se `vipps_captures`), håndtert i FinanceService sin egen
 * oppgjørs-sjekk (`checkVippsFullSettlement()`), ALDRI av selve
 * hendelsesnavnet alene. `TERMINATED` (avbrutt FØR autorisering) og
 * `CANCELLED` (selgerinitiert avbrudd ETTER autorisering)/`EXPIRED` er
 * BEGGE en bevisst IKKE-fullført intensjon - mappes til Jarvis sin egen
 * `cancelled` (IKKE `failed`), SAMME begrunnelse som Stripe sin
 * `canceled -> cancelled`-mapping. Den EKSAKTE Vipps-tilstanden er ALDRI
 * tapt selv om Jarvis sin `state` kollapser dem - `provider_status`
 * (observasjonelt felt) beholder den nøyaktige, ukollapsede verdien.
 */
export const VIPPS_STATUS_TO_JARVIS_STATE: Readonly<Record<string, PaymentIntentState | null>> = {
  CREATED: null,
  AUTHORIZED: null,
  TERMINATED: "cancelled",
  EXPIRED: "cancelled",
  CANCELLED: "cancelled",
  // D-392 (JARVIS-020): ABORTED er en ekte avsluttet betalingstilstand i Vipps ePayment (brukeren avbrøt) - ikke en modifikasjonshendelse.
  ABORTED: "cancelled"
};

/**
 * D-392 (JARVIS-020): CAPTURED/REFUNDED er MODIFIKASJONSHENDELSER (beløpet gjelder selve capturen/refusjonen), ikke betalingstilstander -
 * Vipps sin `payment.state` forblir AUTHORIZED etter capture. De må ALDRI overskrive `provider_status`/`provider_reported_amount_ore`
 * (da ville en delvis capture gjort at neste capture feilet med «ikke AUTHORIZED», og det rapporterte beløpet bli capture-beløpet).
 */
export const VIPPS_MODIFICATION_EVENTS: ReadonlySet<string> = new Set(["CAPTURED", "REFUNDED"]);
