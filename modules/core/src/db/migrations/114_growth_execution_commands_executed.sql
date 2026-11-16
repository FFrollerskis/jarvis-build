-- WP-D3 (UA-4 Growth, D-459): den FREMTIDIGE utførelses-sliceen som `030_growth_execution_commands.sql` krevde sin EGEN migrasjon for.
--
-- 030 holdt 'executed' UTENFOR status-CHECK-en med vilje: ingen kode kunne noensinne markere en kommando som utført før en utfører (plattform-skrivingen, WP-D3) fantes og var
-- reviewet. Den utføreren finnes nå (googleads/metaads-skrivehandlingene bak klasse D-kjeden, `growth_write_journal` i 113). Denne migrasjonen åpner derfor `executed` - men
-- IKKE uten bevis: databasen selv krever at en kommando bare kan stå som `executed` når
--   (a) den peker på en journalrad (`execution_write_id`) i SAMME tenant, som er `applied` (utført OG verifisert mot leverandørens readback) og gjelder SAMME kampanje, og
--   (b) `executed_at` er satt.
-- `execution_unknown` er den ærlige tilstanden etter en akseptert mutasjon uten bekreftet utfall (avstemming gjenstår): kommandoen er verken «venter» (ville invitert til en ny, dobbel
-- skriving) eller «utført». En `executed` kommando er terminal (kan ikke settes tilbake). Den eksisterende grensen «en bar UPDATE ... SET status = 'executed' feiler» består: uten
-- journalrad og `executed_at` nektes den av CHECK-en og triggeren under (testen i modules/growth/test/service-rls.test.ts er uendret og fortsatt sann).

ALTER TABLE marketing_campaign_execution_commands
  ADD COLUMN executed_at        timestamptz,
  ADD COLUMN execution_write_id text;

ALTER TABLE marketing_campaign_execution_commands DROP CONSTRAINT marketing_campaign_execution_commands_status_check;
ALTER TABLE marketing_campaign_execution_commands ADD CONSTRAINT marketing_campaign_execution_commands_status_check
  CHECK (status IN ('pending_execution', 'cancelled', 'superseded', 'executed', 'execution_unknown'));
ALTER TABLE marketing_campaign_execution_commands ADD CONSTRAINT marketing_campaign_execution_commands_executed_has_proof
  CHECK (status <> 'executed' OR (executed_at IS NOT NULL AND execution_write_id IS NOT NULL));
ALTER TABLE marketing_campaign_execution_commands ADD CONSTRAINT marketing_campaign_execution_commands_unknown_has_write
  CHECK (status <> 'execution_unknown' OR execution_write_id IS NOT NULL);
ALTER TABLE marketing_campaign_execution_commands ADD CONSTRAINT marketing_campaign_execution_commands_execution_write_fkey
  FOREIGN KEY (tenant_id, execution_write_id) REFERENCES growth_write_journal (tenant_id, write_id);

CREATE FUNCTION marketing_command_executed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  journal_status   text;
  journal_campaign text;
BEGIN
  -- En utført kommando er et bevis på hva som ble godkjent og utført: status, beløp, kampanje og bevis (journalraden) endres aldri igjen.
  IF TG_OP = 'UPDATE' AND OLD.status = 'executed' AND (
       NEW.status IS DISTINCT FROM 'executed' OR NEW.current_budget_ore IS DISTINCT FROM OLD.current_budget_ore
       OR NEW.proposed_budget_ore IS DISTINCT FROM OLD.proposed_budget_ore OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.recommendation_id IS DISTINCT FROM OLD.recommendation_id OR NEW.execution_write_id IS DISTINCT FROM OLD.execution_write_id
       OR NEW.executed_at IS DISTINCT FROM OLD.executed_at) THEN
    RAISE EXCEPTION 'command_executed_is_terminal' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'executed' THEN
    SELECT status, campaign_id INTO journal_status, journal_campaign
      FROM growth_write_journal WHERE tenant_id = NEW.tenant_id AND write_id = NEW.execution_write_id;
    IF journal_status IS DISTINCT FROM 'applied' OR journal_campaign IS DISTINCT FROM NEW.campaign_id THEN
      RAISE EXCEPTION 'command_executed_requires_applied_write_for_same_campaign' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER marketing_command_executed_guard BEFORE INSERT OR UPDATE ON marketing_campaign_execution_commands
  FOR EACH ROW EXECUTE FUNCTION marketing_command_executed_guard();
