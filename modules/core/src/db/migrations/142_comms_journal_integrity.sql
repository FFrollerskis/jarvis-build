-- WP-G1c (D-481, JARVIS-112 b): journalens og romkolonnenes integritet. Forward-safe (expand-only): én ny kolonne (med standardverdi som beskriver eksisterende rader), en erstattet trigger-funksjon og nye triggere/CHECK-er. Ingen
-- eksisterende rad endres og ingen kolonne fjernes. Migrasjonen er append-only: 118 og 119 er urørt.
--
-- 1) SALTET INNHOLDS-HASH (versjonskolonne). Journalen (`comms_outbound_log`) lagrer aldri meldingsteksten, bare en hash - og den var en USALTET SHA-256 (ordbok-gjettbar for korte meldinger). Nye rader får en HMAC-SHA256 med en server-side
--    pepper fra hemmelighetskjeden (se `createContentHasher` i @jarvis/comms). `content_hash_version` sier hvilken: 1 = den gamle usaltede (alle rader som finnes FØR denne migrasjonen, standardverdien), 2 = HMAC med pepper. Gamle rader
--    omskrives aldri (hashen kan ikke «saltes i ettertid» uten innholdet); de beholder versjon 1 og gjenkjennes fortsatt av gjenspillingsvernet (før-bildets `v` = 1 sammenlignes mot det gamle avtrykket). Standardverdien 1 står bevisst igjen: kode
--    som skriver en rad uten å oppgi versjonen (f.eks. en testfiksturer eller et verktøy) får ærlig «usaltet», aldri en falsk påstand om HMAC; all produksjonskode oppgir 2 eksplisitt.
-- 2) UFORANDERLIGE kolonner: `retention_until` og `content_hash_version` kan ikke endres etter innsetting. Uten det kunne en rad i tilstanden `requested`/`outcome_unknown` få oppbevaringsfristen satt til fortiden og så slettes.
-- 3) DELETE-VERN (som 141 for avmeldinger): `jarvis_app` beholder DELETE-granten (retensjonssveipet og Q-20-slettingen er lovlig bruk), men en BEFORE DELETE-trigger avviser sletting av en journalrad med mindre oppbevaringsfristen HAR gått ut på
--    DATABASENS klokke (aldri appens) eller transaksjonen er en erasure-transaksjon (`jarvis.erasure_in_progress = 'true'`). Samme ærlige avgrensning som 101/141: stopper kodefeil, ikke en app-rolle med fri SQL og ikke tabelleieren.
-- 4) ROM-CHECK: alle sju comms-tabeller tillot `health`, `home` og `guest` som memory space (kun konfigurasjon og RLS stoppet det). Kommunikasjon skjer aldri i de rommene (`personal`, `business`, `project`, `shared` er de eneste lovlige).
--    Hver CHECK byttes til den strengere regelen som NOT VALID (håndheves umiddelbart for nye og endrede rader) og VALIDATE forsøkes straks: består alle eksisterende rader, blir den fullt gyldig; ellers forblir den NOT VALID med en NOTICE og
--    eieren validerer etter å ha vurdert de gamle radene (samme mønster som 133).

ALTER TABLE comms_outbound_log ADD COLUMN content_hash_version smallint NOT NULL DEFAULT 1 CHECK (content_hash_version IN (1, 2));

CREATE OR REPLACE FUNCTION comms_outbound_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.log_id <> OLD.log_id OR NEW.request_id <> OLD.request_id OR NEW.kind <> OLD.kind OR NEW.channel <> OLD.channel
     OR NEW.account_ref <> OLD.account_ref OR NEW.provider <> OLD.provider OR NEW.recipient_hash <> OLD.recipient_hash OR NEW.purpose <> OLD.purpose
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR NEW.created_at <> OLD.created_at OR NEW.person_id <> OLD.person_id
     OR NEW.session_id <> OLD.session_id OR NEW.memory_space_id <> OLD.memory_space_id OR NEW.source <> OLD.source OR NEW.rule_evaluation <> OLD.rule_evaluation
     OR NEW.retention_until <> OLD.retention_until OR NEW.content_hash_version <> OLD.content_hash_version THEN
    RAISE EXCEPTION 'comms_outbound_log: kjernekolonnene er uforanderlige';
  END IF;
  IF OLD.status IN ('denied', 'sent', 'failed') THEN
    RAISE EXCEPTION 'comms_outbound_log: terminal status (%) kan ikke endres', OLD.status;
  END IF;
  IF OLD.status = 'requested' AND NEW.status NOT IN ('requested', 'sent', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'comms_outbound_log: ulovlig overgang % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'outcome_unknown' AND NEW.status NOT IN ('outcome_unknown', 'sent', 'failed') THEN
    RAISE EXCEPTION 'comms_outbound_log: ulovlig overgang % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END
$$;

-- `comms_retention_no_delete()` er definert i 141 (erasure ELLER utløpt `retention_until` på databasens klokke).
CREATE TRIGGER comms_outbound_log_no_delete BEFORE DELETE ON comms_outbound_log FOR EACH ROW EXECUTE FUNCTION comms_retention_no_delete();

DO $$
DECLARE
  t text;
  c text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comms_authorized_accounts', 'comms_recipient_opt_outs', 'comms_outbound_log', 'comms_inbound_events', 'comms_meetings', 'comms_meeting_participants', 'comms_meeting_commitments'] LOOP
    c := t || '_memory_space_id_check';
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (memory_space_id IN (''personal'', ''business'', ''project'', ''shared'')) NOT VALID', t, c);
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, c);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE '% forblir NOT VALID: eksisterende rader bryter regelen (nye og endrede rader håndheves)', c;
    END;
  END LOOP;
END
$$;
