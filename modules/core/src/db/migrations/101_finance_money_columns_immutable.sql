-- WP-F1 (D-462, Q-47 a): pengekolonnene på en betalingsintensjon / refusjon / capture er UFORANDERLIGE etter opprettelse (BEFORE UPDATE), og en rad som har vært hos
-- leverandøren kan ikke SLETTES og gjenopprettes med andre verdier (BEFORE DELETE) - unntatt i en erasure-transaksjon.
--
-- Eierens step-up-godkjenning er bundet til intensjonens ID (og, i tillegg, til beløp + valuta + mottaker-digest slik eieren så dem). Den bindingen er bare meningsfull hvis raden
-- ikke kan endres mellom forespørsel og godkjenning. Applikasjonen endrer aldri disse kolonnene (kun tilstand, leverandørfelt og avviksflagg), så uforanderligheten håndheves her,
-- på databasenivå: en feilkorreksjon gjøres ved å kansellere og opprette en NY intensjon, aldri ved å endre beløp eller mottaker på en eksisterende.
--
-- 1) UPDATE (`*_money_immutable`): et forsøk på å endre en beskyttet kolonne gir `check_violation` (23514) med `finance_money_column_immutable:<tabell>.<kolonne>`, uansett rolle
--    (appens egen rolle og superbrukere) så lenge triggeren er aktiv; en UPDATE som setter samme verdi igjen er tillatt. Beskyttet på `payment_intents`: id, tenant, idempotensnøkkel,
--    provider, beløp, valuta, formål, leverandørnavn, canonical vendor-id, leverandørreferanse, kontokode og motkonto. På `stripe_refunds`/`vipps_captures`/`vipps_refunds`: id, tenant,
--    foreldrebetaling, idempotensnøkkel, beløp og valuta (og `reason` på Stripe-refusjoner).
-- 2) DELETE (`*_money_no_delete`, review M-F3): uten dette kunne appens rolle (som har DELETE-grant for erasure, 038/039/040/041) SLETTE en rad og INSERT-e samme id på nytt med et annet
--    beløp og dermed omgå 1). En rad som har eller har hatt kontakt med leverandøren - tilstand utenom draft/cancelled, eller `submitted_at`/`first_submit_attempt_at` satt - avvises
--    med `check_violation` (23514) `finance_money_row_delete_forbidden:<tabell>`. Utkast (og kansellerte utkast som aldri nådde leverandøren) kan slettes. Erasure virker: den setter den
--    transaksjonslokale GUC-en `jarvis.erasure_in_progress = 'true'` (`setErasureInProgress`, samme mønster som `forbid_mutation()` for memory_versions i 062) rett før slettingen.
--
-- ÆRLIG AVGRENSNING - hva triggerne beskytter mot og ikke: de stopper utilsiktet/feilaktig endring og sletting, applikasjonsfeil og feilbruk fra modell/HTTP-lagene (ingen vei dit er
-- nåbar fra modell eller HTTP; dette er et andre, uavhengig lag bak bindingen). De er IKKE en barriere mot en app-rolle med FRI SQL (den kan selv sette erasure-GUC-en i en
-- transaksjon, eller først skrive `state`/`submitted_at`/`first_submit_attempt_at` tilbake til et «aldri sendt» utkast og så slette det - tilstandsmaskinen håndheves av applikasjonen, ikke av databasen) og heller ikke mot tabelleieren/superbrukeren (kan `ALTER TABLE ... DISABLE TRIGGER`, `session_replication_role = replica`) - det er bevisste DDL-/administratorhandlinger,
-- ikke noe appen kan gjøre; testfixturer og operatør-opprydding bruker dem. TRUNCATE nås ikke av appen (ingen TRUNCATE-grant).

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

-- BEFORE DELETE (review M-F3): se punkt 2 i toppkommentaren. Samme funksjon for alle fire tabeller (alle har `state`, `submitted_at` og `first_submit_attempt_at`, jf. 099).
CREATE FUNCTION finance_money_rows_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Aldri hos leverandøren: et utkast (eller et kansellert utkast) kan slettes fritt.
  IF OLD.state IN ('draft', 'cancelled') AND OLD.submitted_at IS NULL AND OLD.first_submit_attempt_at IS NULL THEN
    RETURN OLD;
  END IF;
  -- Erasure-stien (transaksjonslokal GUC, forsvinner ved COMMIT/ROLLBACK).
  IF current_setting('jarvis.erasure_in_progress', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'finance_money_row_delete_forbidden:%', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION finance_money_rows_no_delete() FROM PUBLIC;

CREATE TRIGGER payment_intents_money_no_delete BEFORE DELETE ON payment_intents FOR EACH ROW EXECUTE FUNCTION finance_money_rows_no_delete();
CREATE TRIGGER stripe_refunds_money_no_delete BEFORE DELETE ON stripe_refunds FOR EACH ROW EXECUTE FUNCTION finance_money_rows_no_delete();
CREATE TRIGGER vipps_captures_money_no_delete BEFORE DELETE ON vipps_captures FOR EACH ROW EXECUTE FUNCTION finance_money_rows_no_delete();
CREATE TRIGGER vipps_refunds_money_no_delete BEFORE DELETE ON vipps_refunds FOR EACH ROW EXECUTE FUNCTION finance_money_rows_no_delete();
