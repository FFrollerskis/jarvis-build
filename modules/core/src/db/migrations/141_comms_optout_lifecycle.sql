-- WP-G1c (D-481, JARVIS-112 b, c, f): avmeldingens livssyklus håndhevet i DATABASEN. Forward-safe (expand-only): én ny tabell, én ny sekvens, nye kolonner (alle NULL-bare) og to nye trigger-funksjoner;
-- trigger-funksjonen `comms_recipient_opt_outs_guard` (118) erstattes med en kilde-bevisst versjon. Ingen eksisterende rad endres og ingen eksisterende kolonne fjernes. Migrasjonen er append-only: 118 er urørt.
--
-- 1) KILDE-REGLER VED OPPHEVELSE (JARVIS-112 b, Q-72 pkt 9/10/13). FØR: triggeren sjekket ikke `source` - kun app-SQL begrenset hvem som kunne løfte hva, så en app-rolle (eller en kodefeil) kunne løfte en
--    `owner_recorded`-avmelding. NÅ er tabellen for hvem-kan-løfte-hva en tilstandsmaskin i selve triggeren:
--      lifted_by = 'inbound_start_keyword' (mottakerens egen START): KUN `inbound_stop_keyword` og `provider_error`. ALDRI `owner_recorded` og ALDRI `recipient_request`.
--      lifted_by = 'owner_undo' (eierens angre av en feilregistrert STOP, K5): KUN `owner_recorded`, med obligatorisk begrunnelse, person og sesjon. ALDRI `recipient_request` og aldri en avmelding som kom fra mottakeren selv.
--    Alt annet feiler med `check_violation` (23514) `comms_opt_out_lift_forbidden:<årsak>`. (`recipient_request` kan i dag ikke løftes av noen - samme regel som app-koden hadde; en senere beslutning kan åpne den ved å endre EN linje her.)
--
-- 2) STOP/START-REKKEFØLGE (JARVIS-112 c, Q-72/N-C). Twilio har ingen signert tidsstempel, så rekkefølgen avgjøres av PLATTFORMENS egen mottakssekvens (en monoton databasesekvens), ikke av leverandørens tid:
--      `comms_event_seq`            - EN sekvens (CACHE 1: strengt monoton på tvers av tilkoblinger) som gir både mottakssekvensen til en START og registreringssekvensen til en STOP.
--      `comms_recipient_opt_outs.stop_seq` - registreringssekvensen til den SISTE STOP som er lagt inn i raden (økes når en senere STOP absorberes; kan aldri minke - trigger). NULL = rad fra før denne migrasjonen (regnes som 0).
--      `comms_inbound_receipts`     - første mottak av en opt-in-/opt-out-hendelse, persistert FØR behandlingen (egen, committet transaksjon): en leverandør-retry av en START som feilet midtveis beholder sin OPPRINNELIGE sekvens
--                                     og kan dermed aldri løfte en STOP som ble registrert etter at START-en først ble mottatt.
--    Regelen (i app-SQL, under advisory-lås per mottaker): en START løfter KUN rader med `stop_seq` < START-ens mottakssekvens («STOP vinner» når registreringen skjedde etter at START-en ble mottatt, eller samtidig).
--
-- 3) DELETE-VERN (JARVIS-112 b). `jarvis_app` beholder DELETE-granten (retensjonssveipet og Q-20-slettingen er LOVLIGE bruk), men en BEFORE DELETE-trigger gjør sletting umulig utenom dem:
--      comms_recipient_opt_outs: KUN i en erasure-transaksjon (`jarvis.erasure_in_progress = 'true'`, satt av ErasureService etter policy-autorisering; samme mønster som 062/101).
--      comms_inbound_receipts:   erasure ELLER en rad hvis `retention_until` har passert (databasens klokke).
--    ÆRLIG AVGRENSNING (som 101): triggeren stopper utilsiktet/feilaktig sletting og kodefeil, IKKE en app-rolle med FRI SQL (den kan selv sette erasure-GUC-en i en transaksjon) og ikke tabelleieren/superbrukeren
--    (kan `DISABLE TRIGGER`). Valget er bevisst smalest mulig: en SECURITY DEFINER-funksjon ville krevd DELETE-rettigheter og en ny definer-rolle for et vern som uansett ikke er kryptografisk, og ville endret
--    erasure-planen (delt kode). Journalen (`comms_outbound_log`) får samme vern i 142.

CREATE SEQUENCE comms_event_seq AS bigint START WITH 1 INCREMENT BY 1 CACHE 1;
GRANT USAGE, SELECT ON SEQUENCE comms_event_seq TO jarvis_app;

ALTER TABLE comms_recipient_opt_outs
  ADD COLUMN stop_seq bigint CHECK (stop_seq IS NULL OR stop_seq > 0),
  -- Eierens angre (K5): obligatorisk begrunnelse (kort, én linje, uten hemmeligheter - valideres i koden), hvem (person), og sesjon/oppgave for sporbarhet (CLAUDE.md regel 4).
  ADD COLUMN lift_reason text CHECK (lift_reason IS NULL OR char_length(lift_reason) BETWEEN 3 AND 200),
  ADD COLUMN lifted_by_person_id text REFERENCES people (person_id),
  ADD COLUMN lift_session_id text CHECK (lift_session_id IS NULL OR char_length(lift_session_id) <= 200),
  ADD COLUMN lift_task_id text CHECK (lift_task_id IS NULL OR char_length(lift_task_id) <= 200);

ALTER TABLE comms_recipient_opt_outs DROP CONSTRAINT comms_recipient_opt_outs_lifted_by_check;
ALTER TABLE comms_recipient_opt_outs ADD CONSTRAINT comms_recipient_opt_outs_lifted_by_check CHECK (lifted_by IS NULL OR lifted_by IN ('inbound_start_keyword', 'owner_undo'));
ALTER TABLE comms_recipient_opt_outs ADD CONSTRAINT comms_recipient_opt_outs_owner_undo_complete CHECK (
  lifted_by IS DISTINCT FROM 'owner_undo' OR (lift_reason IS NOT NULL AND lifted_by_person_id IS NOT NULL AND lift_session_id IS NOT NULL)
);
ALTER TABLE comms_recipient_opt_outs ADD CONSTRAINT comms_recipient_opt_outs_lift_detail_only_owner_undo CHECK (
  lifted_by IS NOT DISTINCT FROM 'owner_undo' OR (lift_reason IS NULL AND lifted_by_person_id IS NULL AND lift_session_id IS NULL AND lift_task_id IS NULL)
);

CREATE OR REPLACE FUNCTION comms_recipient_opt_outs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.opt_out_id <> OLD.opt_out_id OR NEW.channel <> OLD.channel OR NEW.account_ref <> OLD.account_ref
     OR NEW.recipient_hash <> OLD.recipient_hash OR NEW.source <> OLD.source OR NEW.created_at <> OLD.created_at OR NEW.memory_space_id <> OLD.memory_space_id THEN
    RAISE EXCEPTION 'comms_recipient_opt_outs: kjernekolonnene er uforanderlige';
  END IF;
  IF OLD.status = 'lifted' THEN
    RAISE EXCEPTION 'comms_recipient_opt_outs: en opphevet avmelding kan ikke endres (ny avmelding = ny rad)';
  END IF;
  IF NEW.status = 'lifted' THEN
    IF NEW.lifted_by = 'inbound_start_keyword' THEN
      -- Mottakerens egen START: kun avmeldinger som kom fra et stopp-ord eller en leverandørfeil. En eierregistrert (eller mottakerbedt, utenfor kanalen) avmelding løftes aldri av et tekstsvar.
      IF OLD.source NOT IN ('inbound_stop_keyword', 'provider_error') THEN
        RAISE EXCEPTION 'comms_opt_out_lift_forbidden:start_cannot_lift_%', OLD.source USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.lifted_by = 'owner_undo' THEN
      -- Eierens angre: kun en avmelding EIEREN selv registrerte. Mottakerens egen avmelding (stopp-ord, leverandørfeil, mottakerens bønn) kan eieren aldri oppheve.
      IF OLD.source <> 'owner_recorded' THEN
        RAISE EXCEPTION 'comms_opt_out_lift_forbidden:owner_cannot_lift_%', OLD.source USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'comms_opt_out_lift_forbidden:unknown_lifter' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.stop_seq IS DISTINCT FROM OLD.stop_seq AND (NEW.stop_seq IS NULL OR (OLD.stop_seq IS NOT NULL AND NEW.stop_seq < OLD.stop_seq)) THEN
    -- Registreringssekvensen kan bare økes (en senere STOP): å senke den ville latt en eldre START løfte en nyere STOP.
    RAISE EXCEPTION 'comms_recipient_opt_outs: stop_seq kan kun øke' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Første mottak av en opt-in-/opt-out-hendelse (persistert FØR behandlingen, egen transaksjon). Ingen personopplysninger: leverandørens hendelsesnøkkel (som dedupe-raden), sekvens og tidspunkt.
CREATE TABLE comms_inbound_receipts (
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','shared')),
  provider             text NOT NULL CHECK (provider IN ('slack','meta','twilio','telnyx')),
  event_key            text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 300),
  kind                 text NOT NULL CHECK (kind IN ('opt_in','opt_out')),
  recv_seq             bigint NOT NULL CHECK (recv_seq > 0),
  received_at          timestamptz NOT NULL DEFAULT now(),
  retention_until      timestamptz NOT NULL,
  -- Kilde og sporing (regel 4): webhooks har ingen person/sesjon - `ingest_id` er per-forespørsel-id'en, `source` er alltid 'webhook:<leverandør>'.
  source               text NOT NULL CHECK (source ~ '^webhook:[a-z]{3,20}$'),
  ingest_id            text NOT NULL CHECK (char_length(ingest_id) BETWEEN 8 AND 80),
  PRIMARY KEY (tenant_id, provider, event_key)
);
CREATE INDEX comms_inbound_receipts_retention_idx ON comms_inbound_receipts (retention_until);

CREATE FUNCTION comms_optout_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('jarvis.erasure_in_progress', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'comms_row_delete_forbidden:%', TG_TABLE_NAME USING ERRCODE = '23514';
END
$$;
REVOKE ALL ON FUNCTION comms_optout_no_delete() FROM PUBLIC;

CREATE FUNCTION comms_retention_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('jarvis.erasure_in_progress', true) = 'true' THEN
    RETURN OLD;
  END IF;
  -- Retensjonssveipet: kun rader hvis oppbevaringstid HAR gått ut (databasens klokke, aldri appens).
  IF OLD.retention_until < now() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'comms_row_delete_forbidden:%', TG_TABLE_NAME USING ERRCODE = '23514';
END
$$;
REVOKE ALL ON FUNCTION comms_retention_no_delete() FROM PUBLIC;

CREATE TRIGGER comms_recipient_opt_outs_no_delete BEFORE DELETE ON comms_recipient_opt_outs FOR EACH ROW EXECUTE FUNCTION comms_optout_no_delete();
CREATE TRIGGER comms_inbound_receipts_no_delete BEFORE DELETE ON comms_inbound_receipts FOR EACH ROW EXECUTE FUNCTION comms_retention_no_delete();

-- Innkommende første-mottak er uforanderlige etter innsetting (ingen UPDATE): kun SELECT/INSERT og DELETE (retensjonssveip og Q-20-sletting, begge bak triggeren over).
GRANT SELECT, INSERT, DELETE ON comms_inbound_receipts TO jarvis_app;

ALTER TABLE comms_inbound_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_inbound_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY comms_inbound_receipts_tenant ON comms_inbound_receipts
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY comms_inbound_receipts_space ON comms_inbound_receipts AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
