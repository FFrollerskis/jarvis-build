-- WP-D3 (UA-4 Growth, D-459): den FREMTIDIGE utførelses-sliceen som `030_growth_execution_commands.sql` krevde sin EGEN migrasjon for.
--
-- 030 holdt 'executed' UTENFOR status-CHECK-en med vilje: ingen kode kunne noensinne markere en kommando som utført før en utfører (plattform-skrivingen, WP-D3) fantes og var
-- reviewet. Den utføreren finnes nå (googleads/metaads-skrivehandlingene bak klasse D-kjeden, `growth_write_journal` i 113). Denne migrasjonen åpner derfor `executed` - men
-- IKKE uten bevis: databasen selv krever at en kommando bare kan stå som `executed` når
--   (a) den peker på en journalrad (`execution_write_id`) i SAMME tenant, som er `applied` (utført OG verifisert mot leverandørens readback) og gjelder SAMME kampanje, og
--   (b) `executed_at` er satt, og
--   (c) (review L5) journalraden ble utstedt FOR DENNE kommandoen (`growth_write_journal.command_id` = kommandoens id) - og en journalrad kan bevise høyst ÉN kommando (unik indeks).
-- HVA VAKTEN GJØR OG IKKE GJØR (review L5, ærlig): den beskytter mot KODEFEIL og utilsiktede skrivestier (en bar UPDATE, feil journalrad, feil kampanje/kommando, gjenbruk av ett bevis til to kommandoer). Den
-- beskytter IKKE mot en kompromittert applikasjonsrolle: `jarvis_app` har INSERT/UPDATE på journalen og kan i prinsippet skrive en `applied` rad selv; da hjelper ingen databasevakt (samme grense som for
-- resten av revisjonssporet). Journalen er derfor IKKE «append-only»: den er en tilstandsmaskin (INSERT `requested`, UPDATE til terminal status én gang; terminale rader og kjernekolonner er uforanderlige), og
-- DELETE finnes kun for Q-20-erasure.
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
-- Review L5: ÉN journalrad kan bevise høyst ÉN kommando (uten denne kunne to kommandoer peke på samme `applied` skriving).
CREATE UNIQUE INDEX marketing_campaign_execution_commands_write_uniq ON marketing_campaign_execution_commands (tenant_id, execution_write_id) WHERE execution_write_id IS NOT NULL;

CREATE FUNCTION marketing_command_executed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  journal_status   text;
  journal_campaign text;
  journal_command  text;
BEGIN
  -- En utført kommando er et bevis på hva som ble godkjent og utført: status, beløp, kampanje og bevis (journalraden) endres aldri igjen.
  IF TG_OP = 'UPDATE' AND OLD.status = 'executed' AND (
       NEW.status IS DISTINCT FROM 'executed' OR NEW.current_budget_ore IS DISTINCT FROM OLD.current_budget_ore
       OR NEW.proposed_budget_ore IS DISTINCT FROM OLD.proposed_budget_ore OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.recommendation_id IS DISTINCT FROM OLD.recommendation_id OR NEW.execution_write_id IS DISTINCT FROM OLD.execution_write_id
       OR NEW.executed_at IS DISTINCT FROM OLD.executed_at) THEN
    RAISE EXCEPTION 'command_executed_is_terminal' USING ERRCODE = '23514';
  END IF;
  IF NEW.execution_write_id IS NOT NULL THEN
    SELECT status, campaign_id, command_id INTO journal_status, journal_campaign, journal_command
      FROM growth_write_journal WHERE tenant_id = NEW.tenant_id AND write_id = NEW.execution_write_id;
    -- Review L5: journalraden må være utstedt FOR DENNE kommandoen (også for `execution_unknown`): et bevis for en annen kommando er aldri et bevis her.
    IF journal_command IS DISTINCT FROM NEW.command_id THEN
      RAISE EXCEPTION 'command_execution_write_must_be_issued_for_this_command' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'executed' THEN
    IF journal_status IS DISTINCT FROM 'applied' OR journal_campaign IS DISTINCT FROM NEW.campaign_id THEN
      RAISE EXCEPTION 'command_executed_requires_applied_write_for_same_campaign' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER marketing_command_executed_guard BEFORE INSERT OR UPDATE ON marketing_campaign_execution_commands
  FOR EACH ROW EXECUTE FUNCTION marketing_command_executed_guard();
