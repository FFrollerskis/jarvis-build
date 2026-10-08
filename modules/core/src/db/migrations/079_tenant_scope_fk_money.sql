-- Q-44 / D-435 domene 2: penger (betalingsintensjoner, bank, kort, finans, leverandørhendelser). En feilkoblet betalingsreferanse på tvers
-- av tenants er den dyreste feilen i systemet; se 078 for mekanismen (`jarvis_scope_fk_named` slår opp FK-en på navn og er idempotent).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('bank_account_balances', 'bank_account_balances_bank_account_id_fkey'),
    ('bank_accounts', 'bank_accounts_consent_id_fkey'),
    ('bank_transactions', 'bank_transactions_bank_account_id_fkey'),
    ('bank_transactions', 'bank_transactions_matched_payment_intent_id_fkey'),
    ('card_authorizations', 'card_authorizations_card_id_fkey'),
    ('card_events', 'card_events_card_id_fkey'),
    ('card_spend_policies', 'card_spend_policies_card_id_fkey'),
    ('card_transactions', 'card_transactions_authorization_id_fkey'),
    ('card_transactions', 'card_transactions_card_id_fkey'),
    ('card_transactions', 'card_transactions_matched_commitment_id_fkey'),
    ('finance_procurement_items', 'finance_procurement_items_payment_intent_id_fkey'),
    ('finance_recurring_commitments', 'finance_recurring_commitments_payment_intent_id_fkey'),
    ('finance_spend_records', 'finance_spend_records_campaign_id_fkey'),
    ('finance_spend_records', 'finance_spend_records_payment_intent_id_fkey'),
    ('finance_spend_records', 'finance_spend_records_procurement_item_id_fkey'),
    ('finance_spend_records', 'finance_spend_records_recurring_commitment_id_fkey'),
    ('finance_vendor_provider_bindings', 'finance_vendor_provider_bindings_vendor_id_fkey'),
    ('neonomics_webhook_events', 'neonomics_webhook_events_payment_intent_id_fkey'),
    ('payment_intent_events', 'payment_intent_events_payment_intent_id_fkey'),
    ('payment_intents', 'payment_intents_vendor_id_fkey'),
    ('provider_cards', 'provider_cards_campaign_id_fkey'),
    ('provider_cards', 'provider_cards_commitment_id_fkey'),
    ('stripe_refunds', 'stripe_refunds_payment_intent_id_fkey'),
    ('stripe_webhook_events', 'stripe_webhook_events_payment_intent_id_fkey'),
    ('vipps_captures', 'vipps_captures_payment_intent_id_fkey'),
    ('vipps_refunds', 'vipps_refunds_payment_intent_id_fkey'),
    ('vipps_webhook_events', 'vipps_webhook_events_payment_intent_id_fkey'),
    ('wallester_webhook_events', 'wallester_webhook_events_card_id_fkey')
  ) AS t(tbl, conname) LOOP
    PERFORM jarvis_scope_fk_named(r.tbl::regclass, r.conname::name);
  END LOOP;
END;
$$;
