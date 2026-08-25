/**
 * UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107). Jarvis
 * EIER selv Payment/Spend Intent-domenet (JARVIS_CANONICAL, D-64
 * Core-vs-Adapter-porten kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md
 * D-107): idempotens, deterministisk avviksdeteksjon, avstemming og
 * eier-kontrollert kill switch er ALDRI utsatt til en leverandør. Fiken
 * (masterplan-navngitt P0-connector, IKKE et Claude-valgt leverandørvalg)
 * forblir bokføring-av-post (norsk bokføringslov) -
 * HYBRID_WITH_CLEAR_AUTHORITY. ZERO Stripe/Vipps/bank-betaling (P1) eller
 * kort/wallet (P2) her - se `PaymentProvider` under, bevisst begrenset til
 * `'fiken'` denne sliceen.
 */

export type PaymentIntentState = "draft" | "submitted" | "provider_acknowledged" | "settled" | "failed" | "cancelled";
export type ReconciliationState = "unreconciled" | "matched" | "mismatched";
/** Kun 'fiken' bygget denne sliceen (P0). Stripe/Vipps/bank (P1) og programmerbart kort/wallet (P2) er masterplan-navngitte FREMTIDIGE providere. */
export type PaymentProvider = "fiken";

export type PaymentIntentEventType =
  | "intent_created"
  | "submitted"
  | "provider_acknowledged"
  | "settled"
  | "failed"
  | "cancelled"
  | "anomaly_flagged"
  | "reconciled"
  | "kill_switch_blocked";

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
  account_code: string;
  counter_account_code: string | null;
  provider: PaymentProvider;
  provider_ref: string | null;
  reconciliation_state: ReconciliationState;
  /** Deterministiske avviksflagg (ALDRI AI-inferert - Q-26-grensen). */
  anomaly_flags: readonly string[];
  failure_reason: string | null;
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
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
  account_code: string;
  /** Motkonto (bank-/kontantkonto) for balansert postering - se `MissingCounterAccountError`. */
  counter_account_code?: string;
  owner_person_id?: string;
  actor_person_id?: string;
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
