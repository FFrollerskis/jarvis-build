/**
 * UA-3 next slice (D-53): automatisk open-loop-deteksjon (masterplan-
 * akseptansekriterium 3, "Open loops detected automatically") + Business
 * OS-tidslinje for daglig/ukentlig brief. Additivt pa P0-domenemodellen i
 * types.ts - ingen eksisterende entitet endret.
 */

export type OpenLoopType =
  | "overdue_followup"
  | "stalled_opportunity"
  | "support_ticket_needs_reply"
  | "support_ticket_overdue"
  | "support_ticket_unassigned"
  | "support_ticket_waiting_internal"
  | "contract_renewal_due"
  | "contract_termination_deadline"
  | "contract_obligation_due"
  | "contract_review_required"
  | "marketing_spend_anomaly"
  | "payment_intent_anomaly"
  | "payment_intent_reconciliation_mismatch"
  | "finance_spend_unexpected"
  | "finance_spend_amount_deviation"
  | "finance_recurring_charge_missing"
  | "finance_recurring_charge_duplicate"
  | "finance_spend_correction_conflict";
export type OpenLoopDetectionMethod = "deterministic" | "ai_assisted";
export type OpenLoopPriority = "low" | "normal" | "high";
export type OpenLoopStatus = "open" | "resolved";

export interface BusinessOpenLoop {
  open_loop_id: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  lead_id: string | null;
  followup_id: string | null;
  activity_id: string | null;
  /** UA-3 Native Support Core (D-66): peker til `support_tickets`, null for ikke-support-loops. */
  ticket_id: string | null;
  /** UA-3 Native Contracts Core (D-71): peker til `contracts`, null for ikke-kontrakt-loops. */
  contract_id: string | null;
  /** UA-4 Native Growth Core (D-74): peker til `marketing_campaigns`, null for ikke-vekst-loops. */
  campaign_id: string | null;
  /** UA-6 Finance & Spend Integrity Gateway (D-107): peker til `payment_intents`, null for ikke-finans-loops. */
  payment_intent_id: string | null;
  /** UA-6 Finance & Spend Integrity Gateway Slice 2 (039_finance_spend_integrity.sql): peker til `finance_spend_records`, null for ikke-utgifts-loops. */
  finance_spend_record_id: string | null;
  /** UA-6 Finance & Spend Integrity Gateway Slice 2: peker til `finance_recurring_commitments`, null for ikke-forpliktelses-loops. */
  finance_recurring_commitment_id: string | null;
  loop_type: OpenLoopType;
  detection_key: string;
  detection_method: OpenLoopDetectionMethod;
  confidence: number | null;
  reason: string;
  next_action: string | null;
  canonical_uri: string | null;
  priority: OpenLoopPriority;
  status: OpenLoopStatus;
  owner_person_id: string | null;
  opened_at: string;
  due_at: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** §16 i byggeordren: sporrbar visning over persistert state, ikke en transient LLM-svar. */
export type AttentionBucket = "critical" | "overdue" | "due_soon" | "informational";

export interface AttentionQueueEntry {
  bucket: AttentionBucket;
  loop: BusinessOpenLoop;
}

export interface SweepResult {
  detected: number;
  updated: number;
  auto_resolved: number;
}

/** §15: bedriftshelse-akseptansekriteriet krever sales+product+finance+marketing+operations -
 * `sales` (Business Graph/CRM) og `marketing` (Native Jarvis Growth Core, D-74/D-78) er dekket;
 * `product`/`finance`/`operations` MÅ fortsatt rapporteres som ikke-integrert, aldri fabrikkert -
 * se `BUSINESS_DOMAIN_COVERAGE` i business-brief.ts. */
export type BusinessDomain = "sales" | "product" | "finance" | "marketing" | "operations";
