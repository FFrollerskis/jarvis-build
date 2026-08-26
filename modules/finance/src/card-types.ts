import type { MemorySpace } from "@jarvis/contracts";

/**
 * UA-6 Slice 6 (D-112): kanoniske typer for det programmerbare
 * kortdomenet (provider-nøytral modell; i dag kun provider 'wallester').
 * Jarvis eier kortformål/policy/avstemming/avvik (JARVIS_CANONICAL);
 * provider eier utstedt kortidentitet/nettverkstilstand/oppgjør
 * (EXTERNAL_CANONICAL). PCI-grensen (byggeordrens §23): INGEN typer her
 * bærer PAN/CVV/PIN - kun maskert referanse og provider-ID-er.
 */

export type CardProvider = "wallester";
export type CardType = "virtual" | "physical" | "disposable";

/**
 * Kanonisk kortlivssyklus: draft -> pending_provider -> active <-> frozen
 * -> closed. Deterministisk tilstandsmaskin (§6) - en provider-feil endrer
 * ALDRI kanonisk tilstand; passiv synk reparerer stale tilstand.
 */
export type CardState = "draft" | "pending_provider" | "active" | "frozen" | "closed";

const CARD_TRANSITIONS: Readonly<Record<CardState, readonly CardState[]>> = {
  draft: ["pending_provider", "active", "closed"],
  pending_provider: ["active", "frozen", "closed"],
  active: ["frozen", "closed"],
  frozen: ["active", "closed"],
  closed: []
};

export function isValidCardTransition(from: CardState, to: CardState): boolean {
  return CARD_TRANSITIONS[from].includes(to);
}

export interface ProviderCard {
  card_id: string;
  tenant_id: string;
  memory_space_id: MemorySpace;
  provider: CardProvider;
  provider_card_id: string | null;
  provider_account_id: string | null;
  idempotency_key: string;
  name: string;
  purpose: string;
  card_type: CardType;
  state: CardState;
  currency: string;
  cardholder_person_id: string | null;
  masked_card_number: string | null;
  commitment_id: string | null;
  campaign_id: string | null;
  vendor_name: string | null;
  wallet_compatible: boolean;
  wallet_tokenization_status: string | null;
  provider_state: string | null;
  anomaly_flags: string[];
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  activated_at: string | null;
  frozen_at: string | null;
  closed_at: string | null;
  last_synced_at: string | null;
}

export type CardPolicySyncState = "pending" | "applied" | "rejected";

export interface CardSpendPolicy {
  policy_id: string;
  tenant_id: string;
  memory_space_id: MemorySpace;
  card_id: string;
  requested_transaction_limit_ore: number | null;
  requested_daily_limit_ore: number | null;
  requested_weekly_limit_ore: number | null;
  requested_monthly_limit_ore: number | null;
  requested_atm_enabled: boolean;
  requested_online_enabled: boolean;
  requested_contactless_enabled: boolean;
  applied_transaction_limit_ore: number | null;
  applied_daily_limit_ore: number | null;
  applied_weekly_limit_ore: number | null;
  applied_monthly_limit_ore: number | null;
  applied_atm_enabled: boolean | null;
  applied_online_enabled: boolean | null;
  applied_contactless_enabled: boolean | null;
  sync_state: CardPolicySyncState;
  requested_at: string;
  applied_at: string | null;
}

export type CardAuthorizationStatus = "approved" | "declined" | "reversed" | "settled" | "expired";
export type CardChannel = "pos" | "online" | "atm" | "contactless" | "unknown";

export interface CardAuthorization {
  authorization_id: string;
  tenant_id: string;
  memory_space_id: MemorySpace;
  card_id: string;
  provider: CardProvider;
  provider_authorization_id: string;
  status: CardAuthorizationStatus;
  amount_ore: number;
  currency: string;
  merchant_name: string | null;
  merchant_category_code: string | null;
  channel: CardChannel;
  decline_reason: string | null;
  authorized_at: string | null;
  anomaly_flags: string[];
}

export type CardTransactionType = "purchase" | "refund" | "reversal" | "fee";
export type CardReconciliationState = "unmatched" | "matched" | "ambiguous";

export interface CardTransaction {
  card_transaction_id: string;
  tenant_id: string;
  memory_space_id: MemorySpace;
  card_id: string;
  provider: CardProvider;
  provider_transaction_id: string;
  authorization_id: string | null;
  transaction_type: CardTransactionType;
  amount_ore: number;
  currency: string;
  merchant_name: string | null;
  merchant_category_code: string | null;
  channel: CardChannel;
  transaction_at: string | null;
  settled_at: string | null;
  reconciliation_state: CardReconciliationState;
  matched_commitment_id: string | null;
  match_rule: string | null;
  match_evidence: Record<string, unknown>;
  anomaly_flags: string[];
}

/**
 * Deterministiske kortavvikstyper (byggeordrens §14) - ren SQL/kode-
 * beregning, ALDRI AI-inferert (Q-26). Typer flagges der beviset bor:
 * korttransaksjon, autorisasjon eller kortet selv.
 */
export type CardAnomalyType =
  | "UNEXPECTED_CARD_SPEND"
  | "CARD_AMOUNT_LIMIT_BREACH"
  | "CARD_PURPOSE_MISMATCH"
  | "CARD_CURRENCY_MISMATCH"
  | "CARD_DUPLICATE_TRANSACTION"
  | "CARD_AUTH_SETTLEMENT_CONFLICT"
  | "CARD_TRANSACTION_CORRECTION_CONFLICT"
  | "CARD_SPEND_AFTER_FREEZE"
  | "CARD_SPEND_AFTER_CLOSE"
  | "CARD_PROVIDER_STATE_CONFLICT"
  | "CARD_PROVIDER_OBJECT_TENANT_CONFLICT"
  | "UNEXPECTED_CASH_WITHDRAWAL"
  | "UNEXPECTED_ONLINE_PURCHASE"
  | "DUPLICATE_ECONOMIC_EFFECT";

export class CardNotFoundError extends Error {
  constructor(readonly cardId: string) {
    super(`card_not_found:${cardId}`);
    this.name = "CardNotFoundError";
  }
}

export class CardInvalidStateError extends Error {
  constructor(readonly cardId: string, readonly from: CardState, readonly to: CardState) {
    super(`card_invalid_state_transition:${cardId}:${from}->${to}`);
    this.name = "CardInvalidStateError";
  }
}

export class CardNotSubmittedError extends Error {
  constructor(readonly cardId: string) {
    super(`card_not_submitted_to_provider:${cardId}`);
    this.name = "CardNotSubmittedError";
  }
}

export class WallesterCredentialsUnavailableError extends Error {
  constructor(readonly tenantId: string) {
    super(`wallester_credentials_unavailable:${tenantId}`);
    this.name = "WallesterCredentialsUnavailableError";
  }
}

export class WallesterTenantNotConfiguredError extends Error {
  constructor() {
    super("wallester_tenant_not_configured");
    this.name = "WallesterTenantNotConfiguredError";
  }
}

/**
 * Deterministisk mapping fra Wallester sin rå provider-korttilstand til
 * kanonisk CardState (VERIFIED_SEARCH_SNIPPET-klassen tilstander:
 * aktiv/blokkert/lukket + venter-personalisering for fysiske kort).
 * `null` = ukjent provider-tilstand -> INGEN kanonisk overgang (bevares
 * observasjonelt i provider_state, konflikt flagges av synken).
 */
export function mapWallesterCardState(providerState: string): CardState | null {
  switch (providerState.toLowerCase()) {
    case "active":
      return "active";
    case "blocked":
    case "frozen":
      return "frozen";
    case "closed":
    case "expired":
      return "closed";
    case "ordered":
    case "personalized":
    case "awaitingactivation":
    case "created":
      return "pending_provider";
    default:
      return null;
  }
}
