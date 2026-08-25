import type { ReconciliationState } from "./types.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): interne
 * utgiftskilder Jarvis ALLEREDE eier (039_finance_spend_integrity.sql). KUN
 * de to kildene som faktisk finnes i kodebasen denne sliceen - se
 * toppkommentaren i migrasjonen for full begrunnelse. ZERO ekstern
 * leverandør (Google Ads/Fiken) rørt her - D-108 forblir uendret.
 */
export type SpendSourceFamily = "marketing" | "model_cost";
export type SpendCategory = "marketing_spend" | "ai_api_cost";
/** §5-krav: bevar estimat-vs-oppgjort-distinksjonen DER en kilde faktisk har den. Begge dagens kilder er alltid 'settled' - se migrasjonskommentaren. */
export type SpendAmountStatus = "settled" | "estimated";
/** §4/§8G-krav: en re-synkronisert kilderad med endret beløp ETTER at posten allerede er avstemt/flagget er en KONFLIKT, aldri en stille overskriving. */
export type SpendCorrectionState = "original" | "corrected" | "correction_conflict";

export interface FinanceSpendRecord {
  spend_record_id: string;
  tenant_id: string;
  memory_space_id: string;
  source_family: SpendSourceFamily;
  source_record_id: string;
  occurred_at: string;
  amount_ore: number;
  currency: string;
  category: SpendCategory;
  source_provider: string | null;
  source_model_or_service: string | null;
  campaign_id: string | null;
  payment_intent_id: string | null;
  recurring_commitment_id: string | null;
  procurement_item_id: string | null;
  reconciliation_state: ReconciliationState;
  anomaly_flags: readonly string[];
  source_amount_status: SpendAmountStatus;
  source_correction_state: SpendCorrectionState;
  provenance: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type CommitmentCadence = "monthly" | "yearly" | "custom_days";
export type CommitmentState = "active" | "paused" | "cancelled";

export interface FinanceRecurringCommitment {
  commitment_id: string;
  tenant_id: string;
  memory_space_id: string;
  vendor_name: string;
  description: string;
  cadence: CommitmentCadence;
  cadence_interval_days: number | null;
  expected_billing_day_of_month: number | null;
  expected_amount_ore: number;
  currency: string;
  amount_tolerance_ore: number;
  source_mapping: Record<string, unknown>;
  state: CommitmentState;
  anomaly_flags: readonly string[];
  payment_intent_id: string | null;
  owner_person_id: string | null;
  start_date: string;
  end_date: string | null;
  next_expected_charge_at: string | null;
  last_expected_charge_at: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
}

export type ProcurementStatus = "expected" | "fulfilled" | "cancelled";

export interface FinanceProcurementItem {
  procurement_item_id: string;
  tenant_id: string;
  memory_space_id: string;
  vendor_name: string;
  description: string;
  expected_amount_ore: number;
  currency: string;
  expected_date: string;
  expected_window_days: number;
  status: ProcurementStatus;
  reconciliation_state: ReconciliationState;
  anomaly_flags: readonly string[];
  payment_intent_id: string | null;
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
  fulfilled_at: string | null;
  cancelled_at: string | null;
}

export interface CreateRecurringCommitmentInput {
  vendor_name: string;
  description: string;
  cadence: CommitmentCadence;
  cadence_interval_days?: number;
  expected_billing_day_of_month?: number;
  expected_amount_ore: number;
  currency?: string;
  amount_tolerance_ore?: number;
  source_mapping?: Record<string, unknown>;
  payment_intent_id?: string;
  owner_person_id?: string;
  start_date: string;
  end_date?: string;
}

export interface CreateProcurementItemInput {
  vendor_name: string;
  description: string;
  expected_amount_ore: number;
  currency?: string;
  expected_date: string;
  expected_window_days?: number;
  payment_intent_id?: string;
  owner_person_id?: string;
}

/**
 * §8: de syv deterministiske avvikstypene byggeordren krever. ALDRI
 * AI-inferert (Q-26-grensen) - rent SQL-baserte, deterministiske regler i
 * `SpendService.runAnomalyDetection()`.
 */
export type SpendAnomalyType =
  | "DUPLICATE_SOURCE_SPEND"
  | "UNEXPECTED_SPEND"
  | "AMOUNT_DEVIATION"
  | "MISSING_EXPECTED_SPEND"
  | "DUPLICATE_RECURRING_CHARGE"
  | "CURRENCY_MISMATCH"
  | "SOURCE_CORRECTION_CONFLICT";

export interface SpendSyncResult {
  scanned: number;
  inserted: number;
  updated: number;
  corrected: number;
  correction_conflicts: number;
}

export interface SpendAnomalyDetectionResult {
  spend_record_flags_added: number;
  commitment_flags_added: number;
  flags_cleared: number;
}

export class CommitmentNotFoundError extends Error {
  constructor(readonly commitmentId: string) {
    super(`finance_recurring_commitment_not_found:${commitmentId}`);
    this.name = "CommitmentNotFoundError";
  }
}

export class ProcurementItemNotFoundError extends Error {
  constructor(readonly procurementItemId: string) {
    super(`finance_procurement_item_not_found:${procurementItemId}`);
    this.name = "ProcurementItemNotFoundError";
  }
}

export class SpendRecordNotFoundError extends Error {
  constructor(readonly spendRecordId: string) {
    super(`finance_spend_record_not_found:${spendRecordId}`);
    this.name = "SpendRecordNotFoundError";
  }
}

/** Speiler `InvalidAccountCodeError`-mønsteret i types.ts: `custom_days`-kadanse UTEN et eksplisitt intervall er en deterministisk fangst FØR databasen (CHECK er andre sikkerhetsnett, se migrasjonen). */
export class MissingCadenceIntervalError extends Error {
  constructor() {
    super("missing_cadence_interval_days_for_custom_days_cadence");
    this.name = "MissingCadenceIntervalError";
  }
}
