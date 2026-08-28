-- UA-6 Finance & Spend Integrity Gateway - DEDIKERT CLOSEOUT (D-115): lukker
-- et konkret implementasjonsgap avdekket under closeout-auditen.
--
-- `finance_procurement_items.anomaly_flags` (MISSING_EXPECTED_SPEND, satt av
-- SpendService.runAnomalyDetection() siden Slice 2,
-- 039_finance_spend_integrity.sql) ble ALDRI overflatet via OpenLoopService -
-- i motsetning til HVER søsken-avvikskilde i UA-6 (finance_spend_records/
-- finance_recurring_commitments/payment_intents/bank_transactions/
-- provider_cards, ALLE med sin egen business_open_loops-peker-kolonne og
-- surfacing-regel). En uoppfylt anskaffelse var derfor KUN synlig via
-- SpendService.listUnresolvedSpendAnomalies() (manuell les-spørring), ALDRI
-- via den automatiserte daglige open-loop-sveipen/attention-flaten resten av
-- UA-6 bruker. SAMME additive mønster som `finance_recurring_commitment_id`
-- (039_finance_spend_integrity.sql) - kun CHECK-utvidelse + ny nullable
-- peker-kolonne, INGEN eksisterende data røres.
ALTER TABLE business_open_loops ADD COLUMN finance_procurement_item_id text REFERENCES finance_procurement_items (procurement_item_id);
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required',
  'marketing_spend_anomaly',
  'payment_intent_anomaly', 'payment_intent_reconciliation_mismatch',
  'finance_spend_unexpected', 'finance_spend_amount_deviation', 'finance_recurring_charge_missing',
  'finance_recurring_charge_duplicate', 'finance_spend_correction_conflict',
  'bank_transaction_unmatched', 'bank_consent_attention',
  'card_anomaly_attention',
  'finance_procurement_missing'
));
