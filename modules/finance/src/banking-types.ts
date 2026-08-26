import type { PaymentIntentState } from "./types.ts";

/**
 * UA-6 Slice 5 (D-111): kanoniske typer for open-banking-domenet
 * (bank_consents/bank_accounts/bank_account_balances/bank_transactions -
 * 042_neonomics.sql). Provider-parametrisert ('neonomics' i dag) - en
 * fremtidig alternativ open-banking-leverandør gjenbruker NØYAKTIG samme
 * kanoniske modell (D-64: Neonomics-ID-er er pekere, aldri domenekjernen).
 */

export type BankProvider = "neonomics";
export type BankConsentScope = "ais" | "pis" | "ais_pis";
export type BankConsentState = "created" | "authorization_required" | "active" | "expired" | "revoked" | "rejected";
export type BankTransactionStatus = "pending" | "booked";
export type BankTransactionDirection = "debit" | "credit";
export type BankReconciliationState = "unmatched" | "matched" | "ambiguous";

export interface BankConsent {
  consent_id: string;
  tenant_id: string;
  memory_space_id: string;
  provider: BankProvider;
  provider_session_id: string | null;
  bank_id: string;
  bank_name: string | null;
  requested_scope: BankConsentScope;
  state: BankConsentState;
  authorization_url: string | null;
  callback_state: string | null;
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
  authorized_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_verified_at: string | null;
}

export interface BankAccount {
  bank_account_id: string;
  tenant_id: string;
  memory_space_id: string;
  provider: BankProvider;
  provider_account_id: string;
  consent_id: string;
  bank_id: string;
  account_name: string | null;
  account_identifier_masked: string | null;
  currency: string;
  account_type: string | null;
  active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BankAccountBalance {
  balance_id: string;
  tenant_id: string;
  memory_space_id: string;
  bank_account_id: string;
  balance_type: string;
  amount_ore: number;
  currency: string;
  provider_reference_date: string | null;
  observed_at: string;
  created_at: string;
}

export interface BankTransaction {
  bank_transaction_id: string;
  tenant_id: string;
  memory_space_id: string;
  bank_account_id: string;
  provider: BankProvider;
  provider_transaction_id: string;
  status: BankTransactionStatus;
  direction: BankTransactionDirection;
  amount_ore: number;
  currency: string;
  booking_date: string | null;
  value_date: string | null;
  counterparty_name: string | null;
  reference_text: string | null;
  bank_transaction_code: string | null;
  reconciliation_state: BankReconciliationState;
  matched_payment_intent_id: string | null;
  match_rule: string | null;
  match_evidence: Record<string, unknown>;
  anomaly_flags: readonly string[];
  observed_at: string;
  created_at: string;
  updated_at: string;
}

export class BankConsentNotFoundError extends Error {
  constructor(readonly consentId: string) {
    super(`bank_consent_not_found:${consentId}`);
    this.name = "BankConsentNotFoundError";
  }
}

/** AIS-/PIS-kall mot et samtykke som ikke er 'active' - fail-closed flyt-tilstand (utløpt/tilbakekalt samtykke er en OPERASJONELL tilstand, aldri en skjult API-feil - byggeordrens §5). */
export class BankConsentNotActiveError extends Error {
  constructor(readonly consentId: string, readonly state: BankConsentState) {
    super(`bank_consent_not_active:${consentId}:${state}`);
    this.name = "BankConsentNotActiveError";
  }
}

export class BankAccountNotFoundError extends Error {
  constructor(readonly bankAccountId: string) {
    super(`bank_account_not_found:${bankAccountId}`);
    this.name = "BankAccountNotFoundError";
  }
}

/** Callback-state-avvik (byggeordrens §22) - CSRF/replay/feil-samtykke: fail-closed, aldri stille akseptert. */
export class BankCallbackStateMismatchError extends Error {
  constructor(readonly consentId: string) {
    super(`bank_callback_state_mismatch:${consentId}`);
    this.name = "BankCallbackStateMismatchError";
  }
}

export class NeonomicsCredentialsUnavailableError extends Error {
  constructor(readonly tenantId: string) {
    super(`neonomics_credentials_unavailable:${tenantId}`);
    this.name = "NeonomicsCredentialsUnavailableError";
  }
}

export class NeonomicsTenantNotConfiguredError extends Error {
  constructor() {
    super("neonomics_tenant_not_configured");
    this.name = "NeonomicsTenantNotConfiguredError";
  }
}

export class PaymentIntentNotNeonomicsError extends Error {
  constructor(readonly paymentIntentId: string, readonly actualProvider: string) {
    super(`payment_intent_not_neonomics:${paymentIntentId}:${actualProvider}`);
    this.name = "PaymentIntentNotNeonomicsError";
  }
}

/**
 * Deterministiske bank-avvikstyper (byggeordrens §15) - ren SQL i
 * BankingService.runBankAnomalyDetection(), ALDRI AI-inferert (Q-26).
 * Betalings-nivå-avvik gjenbruker de EKSISTERENDE typene på
 * `payment_intents.anomaly_flags` (PROVIDER_AMOUNT_MISMATCH/
 * UNKNOWN_PROVIDER_OUTCOME/DUPLICATE_PROVIDER_EFFECT/
 * PROVIDER_OBJECT_TENANT_CONFLICT - detectPaymentAnomalies() plukker dem
 * opp uendret). Typene UNDER skrives til `bank_transactions.anomaly_flags`
 * / overflates via de to nye OpenLoop-reglene (042_neonomics.sql).
 */
export type BankAnomalyType =
  | "BANK_DUPLICATE_TRANSACTION"
  | "BANK_TRANSACTION_CORRECTION_CONFLICT"
  | "UNMATCHED_BANK_DEBIT"
  | "UNMATCHED_BANK_CREDIT"
  | "PAYMENT_BANK_TRANSACTION_MISMATCH"
  | "UNEXPECTED_LARGE_DEBIT";

export interface BankAnomalyDetectionResult {
  transaction_flags_added: number;
  flags_cleared: number;
}

/**
 * Deterministisk ISO 20022-status -> Jarvis PaymentIntentState
 * (byggeordrens §13: «Never map 'request accepted' to 'money settled'
 * unless provider semantics actually guarantee that» - KUN `ACSC`
 * (AcceptedSettlementCompleted) mapper til `settled`; ACCP/ACTC/PDNG/
 * PATC er alle mellomtilstander (aksept/validering/underveis/delvis SCA),
 * som forblir `provider_acknowledged` med observasjonell status).
 * `null` = ingen tilstandsovergang, kun observasjonell provider_status-
 * oppdatering (samme mønster som STRIPE_/VIPPS_STATUS_TO_JARVIS_STATE).
 */
export const NEONOMICS_STATUS_TO_JARVIS_STATE: Readonly<Record<string, PaymentIntentState | null>> = {
  ACSC: "settled",
  ACCC: "settled", // AcceptedSettlementCompleted-Creditor - sterkeste oppgjørsbekreftelse
  ACCP: null,
  ACTC: null,
  ACSP: null,
  ACWC: null,
  PDNG: null,
  PATC: null, // PartiallyAcceptedTechnicalCorrect - SCA delvis fullført
  RCVD: null,
  RJCT: "failed",
  CANC: "cancelled"
};
