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
  | "finance_spend_correction_conflict"
  // UA-6 Slice 5 (D-111) - speiler 042_neonomics.sql sin utvidede CHECK.
  | "bank_transaction_unmatched"
  | "bank_consent_attention"
  // UA-6 Slice 6 (D-112) - speiler 043_wallester.sql sin utvidede CHECK.
  | "card_anomaly_attention"
  // UA-6 closeout (D-115) - speiler 044_finance_procurement_openloop.sql sin utvidede CHECK.
  | "finance_procurement_missing"
  // UA-3 Native Jarvis Product Core (D-128) - speiler 047_product.sql sin utvidede CHECK.
  | "product_item_needs_triage"
  | "product_item_high_priority_stalled"
  // UA-3 Native Jarvis Operations Core (D-129) - speiler 048_operations.sql sin utvidede CHECK.
  | "operations_task_overdue"
  | "operations_task_escalation_needed"
  // WP-D2 (UA-3 «churn/product usage», migrasjon 090) - speiler 090_business_product_usage_churn.sql sin utvidede CHECK.
  | "customer_churn_risk";
export type OpenLoopDetectionMethod = "deterministic" | "ai_assisted";

/**
 * D-396 (JARVIS-045): deterministiske loops hadde `confidence = NULL` - konsumenter (brief/attention) kunne ikke skille «hard fakta» fra
 * heuristikk. Hard-fakta-regler (frist passert, ticket uten svar, forfalt forpliktelse, bankavvik) = 0.9; terskel-/stillstandsheuristikker
 * (dager uten aktivitet, utgiftsavvik mot glidende snitt) = 0.7. Verdiene er KALIBRERINGSFORSLAG - eier kan justere (NEEDS_TOBIAS: kalibrering mot faktiske data).
 */
export const HEURISTIC_LOOP_TYPES: ReadonlySet<OpenLoopType> = new Set<OpenLoopType>([
  "stalled_opportunity", "contract_review_required", "marketing_spend_anomaly", "product_item_needs_triage", "product_item_high_priority_stalled",
  // WP-D2: churn-risiko er en regelbasert PROGNOSE (signaler om atferd), ikke et hardt faktum.
  "customer_churn_risk"
]);
export function deterministicLoopConfidence(loopType: string): number {
  return HEURISTIC_LOOP_TYPES.has(loopType as OpenLoopType) ? 0.7 : 0.9;
}
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
  /** UA-6 closeout (D-115): peker til `finance_procurement_items`, null for ikke-anskaffelses-loops. */
  finance_procurement_item_id: string | null;
  /** UA-3 Native Jarvis Product Core (D-128): peker til `product_items`, null for ikke-produkt-loops. */
  product_item_id: string | null;
  /** UA-3 Native Jarvis Operations Core (D-129): peker til `operations_tasks`, null for ikke-driftsoppgave-loops. */
  operations_task_id: string | null;
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

/**
 * UA-7 slice 2 (D-121): DEN ENE, delte prioriterings-regelen for "hvor mye
 * haster dette?". Trukket UT av `OpenLoopService.attentionQueue()` (der den
 * tidligere var inline) UTEN aa endre semantikken, slik at den
 * kanal-bevisste tverr-kanal-visningen i `@jarvis/conversation-graph` kan
 * gjenbruke NOEYAKTIG samme regel i stedet for aa duplisere en nesten-lik
 * variant (D-64: én kanonisk regel, aldri to parallelle
 * prioriteringsmodeller). Ren funksjon, ingen I/O - `now` injiseres slik at
 * tester er deterministiske.
 */
export function classifyAttentionBucket(
  priority: OpenLoopPriority,
  dueAt: string | null,
  now: number
): AttentionBucket {
  const dueMs = dueAt !== null ? new Date(dueAt).getTime() : null;
  const overdue = dueMs !== null && dueMs < now;
  const dueSoon = dueMs !== null && !overdue && dueMs - now < 48 * 3_600_000;
  if (priority === "high" && overdue) return "critical";
  if (overdue) return "overdue";
  if (dueSoon) return "due_soon";
  return "informational";
}

export interface SweepResult {
  detected: number;
  updated: number;
  auto_resolved: number;
}

/** §15: bedriftshelse-akseptansekriteriet krever sales+product+finance+marketing+operations -
 * `sales` (Business Graph/CRM), `marketing` (Native Jarvis Growth Core, D-74/D-78), `finance`
 * (Native Jarvis Finance & Spend Integrity Gateway, D-127), `product` (Native Jarvis Product
 * Core, D-128) og NÅ `operations` (Native Jarvis Operations Core, D-129) er dekket - se
 * `BUSINESS_DOMAIN_COVERAGE` i business-brief.ts (den faktiske, oppdaterte statusen ligger DER,
 * aldri fabrikkert her). */
export type BusinessDomain = "sales" | "product" | "finance" | "marketing" | "operations";
