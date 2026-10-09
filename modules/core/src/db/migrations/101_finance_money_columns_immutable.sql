-- WP-F1 (D-453, Q-47 a): pengekolonnene på en betalingsintensjon / refusjon / capture er UFORANDERLIGE etter opprettelse.
--
-- Eierens step-up-godkjenning er bundet til intensjonens ID (og, i tillegg, til beløp + valuta + mottaker-digest slik eieren så dem). Den bindingen er bare meningsfull hvis raden
-- ikke kan endres mellom forespørsel og godkjenning. Applikasjonen endrer aldri disse kolonnene (kun tilstand, leverandørfelt og avviksflagg), så uforanderligheten håndheves her,
-- på databasenivå, for ALLE roller (også appens egen og superbrukere): en feilkorreksjon gjøres ved å kansellere og opprette en NY intensjon, aldri ved å endre beløp eller mottaker
-- på en eksisterende. (Bare tabelleieren kan slå triggeren av - en bevisst DDL-handling, ikke noe appen kan gjøre; testfixturer bruker `ALTER TABLE ... DISABLE TRIGGER`.)
--
-- Beskyttet på `payment_intents`: id, tenant, idempotensnøkkel, provider, beløp, valuta, formål, leverandørnavn, canonical vendor-id, leverandørreferanse, kontokode og motkonto.
-- Beskyttet på `stripe_refunds`/`vipps_captures`/`vipps_refunds`: id, tenant, foreldrebetaling, idempotensnøkkel, beløp og valuta (og `reason` på Stripe-refusjoner).
-- ET FORSØK på å endre en beskyttet kolonne gir `check_violation` (23514) med `finance_money_column_immutable:<tabell>.<kolonne>`; en UPDATE som setter samme verdi igjen er tillatt.

CREATE FUNCTION finance_money_columns_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb := to_jsonb(OLD);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (new_row -> col) IS DISTINCT FROM (old_row -> col) THEN
      RAISE EXCEPTION 'finance_money_column_immutable:%.%', TG_TABLE_NAME, col USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION finance_money_columns_immutable() FROM PUBLIC;

CREATE TRIGGER payment_intents_money_immutable BEFORE UPDATE ON payment_intents FOR EACH ROW
  EXECUTE FUNCTION finance_money_columns_immutable(
    'payment_intent_id', 'tenant_id', 'idempotency_key', 'provider', 'amount_ore', 'currency', 'purpose', 'vendor_name', 'vendor_id', 'vendor_provider_ref', 'account_code', 'counter_account_code'
  );

CREATE TRIGGER stripe_refunds_money_immutable BEFORE UPDATE ON stripe_refunds FOR EACH ROW
  EXECUTE FUNCTION finance_money_columns_immutable('refund_id', 'tenant_id', 'payment_intent_id', 'idempotency_key', 'amount_ore', 'currency', 'reason');

CREATE TRIGGER vipps_captures_money_immutable BEFORE UPDATE ON vipps_captures FOR EACH ROW
  EXECUTE FUNCTION finance_money_columns_immutable('capture_id', 'tenant_id', 'payment_intent_id', 'idempotency_key', 'amount_ore', 'currency');

CREATE TRIGGER vipps_refunds_money_immutable BEFORE UPDATE ON vipps_refunds FOR EACH ROW
  EXECUTE FUNCTION finance_money_columns_immutable('refund_id', 'tenant_id', 'payment_intent_id', 'idempotency_key', 'amount_ore', 'currency');
