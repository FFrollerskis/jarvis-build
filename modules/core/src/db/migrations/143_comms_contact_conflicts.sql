-- WP-G1c (D-481, JARVIS-112 f1, Q-72 pkt 11): LAGREDE kontaktkonflikt-forslag. Forward-safe (expand-only): én ny tabell med FORCE RLS, én trigger-funksjon og én trigger. Ingen eksisterende rad endres og ingen kolonne fjernes. Append-only: 141 og 142 er urørt.
--
-- BAKGRUNN. `contacts_sync` lenker en Google-kontakts telefon/e-post til EN identitet i Conversation Graph, men hopper over en kontakt hvis identifikatorer enten (a) allerede eies av en ANNEN kontakt (delt sentralbord, delt e-post: `shared_identity`)
-- eller (b) peker på flere ulike identiteter (`split_identities`). En slik konflikt ble kun rapportert i synk-svaret og FUNNET PÅ NYTT ved hver synk - eieren hadde ingen vei til å avgjøre den. Nå lagres hver konflikt som et FORSLAG (samme mønster som møteforpliktelser,
-- 119: `proposed` -> `accepted`/`dismissed`) eieren kan godta eller avvise. `accepted` lenker kontakten eksplisitt til den delte identiteten (eierens bekreftede valg; `match_method` er fortsatt `contact_sync`, så mottakeren regnes fortsatt som KALD:
-- kald-regelen er uendret og venter på eierens bekreftelse, Q-72 pkt 11); `dismissed` huskes, så samme konflikt ikke foreslås igjen. En konflikt der identifikatorene peker på ulike identiteter (`split_identities`) kan ALDRI godtas (det ville vært en sammenslåing av to
-- identiteter, som er en egen, reversibel eier-handling i Conversation Graph): CHECK-en under håndhever det i databasen.
--
-- PERSONOPPLYSNINGER: ingen telefon, ingen e-post, ingen navn. Kun Googles ugjennomsiktige ressursnavn (`people/c<tall>`) for kontakten og for de andre kontaktene som eier identiteten, en art, en stabil fingerprint (SHA-256 over disse, for idempotens),
-- og eierens avgjørelse (person, tidspunkt, sesjon). Ressursnavn er en stedfortreder for en person i eierens Google-konto (pseudonym, ikke anonymt): DPIA §10.5/§10.7 og PROCESSING_INVENTORY er oppdatert. Beholdes til erasure (en avgjørelse er funksjonell tilstand:
-- en godtatt konflikt styrer fremtidige synker, så retensjonssveip ville stille endret atferd); ingen app-sletting utenom erasure er bygget.

CREATE TABLE comms_contact_conflicts (
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  conflict_id           text NOT NULL CHECK (char_length(conflict_id) BETWEEN 8 AND 80),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','shared')),
  -- Kilden til lenkene (samme `source_type` som `contacts_sync` setter i Conversation Graph) og kontakten konflikten gjelder (Googles ressursnavn; formen er den samme som `RESOURCE_NAME` i koden).
  source_type           text NOT NULL DEFAULT 'google_contacts' CHECK (source_type = 'google_contacts'),
  resource_name         text NOT NULL CHECK (resource_name ~ '^people/c[0-9]{1,25}$'),
  kind                  text NOT NULL CHECK (kind IN ('shared_identity','split_identities')),
  -- De ANDRE kontaktene som allerede eier den delte identiteten (sortert, høyst 20; tom for `split_identities`).
  conflicting_resources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conflicting_resources) = 'array' AND jsonb_array_length(conflicting_resources) <= 20),
  -- SHA-256 (hex) over (kontakt, art, sortert konfliktsett): samme konflikt = samme fingerprint, så gjentatte synker ikke gir nye forslag. Endres konfliktsettet, blir det et NYTT forslag.
  fingerprint           text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status                text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','dismissed')),
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  seen_count            integer NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  -- Proveniens for oppdagelsen (CLAUDE.md regel 4): hvem/hvilken sesjon kjørte synken som fant konflikten første gang, og kilden.
  source                text NOT NULL DEFAULT 'contacts_sync' CHECK (source = 'contacts_sync'),
  detected_by_person_id text NOT NULL REFERENCES people (person_id),
  detect_session_id     text NOT NULL CHECK (char_length(detect_session_id) BETWEEN 1 AND 200),
  detect_task_id        text CHECK (detect_task_id IS NULL OR char_length(detect_task_id) <= 200),
  -- Eierens avgjørelse (kun satt når status er `accepted`/`dismissed`).
  decided_at            timestamptz,
  decided_by_person_id  text REFERENCES people (person_id),
  decision_session_id   text CHECK (decision_session_id IS NULL OR char_length(decision_session_id) <= 200),
  decision_task_id      text CHECK (decision_task_id IS NULL OR char_length(decision_task_id) <= 200),
  PRIMARY KEY (tenant_id, conflict_id),
  UNIQUE (tenant_id, memory_space_id, resource_name, fingerprint),
  CHECK ((status = 'proposed') = (decided_at IS NULL)),
  CHECK ((status = 'proposed') = (decided_by_person_id IS NULL)),
  CHECK (decision_session_id IS NULL OR decided_at IS NOT NULL),
  -- En konflikt der identifikatorene peker på ULIKE identiteter kan aldri godtas (ville slått sammen identiteter).
  CHECK (status <> 'accepted' OR kind = 'shared_identity'),
  CHECK (kind = 'shared_identity' OR jsonb_array_length(conflicting_resources) = 0)
);
CREATE INDEX comms_contact_conflicts_open_idx ON comms_contact_conflicts (tenant_id, memory_space_id, last_seen_at DESC) WHERE status = 'proposed';
CREATE INDEX comms_contact_conflicts_accepted_idx ON comms_contact_conflicts (tenant_id, memory_space_id, resource_name) WHERE status = 'accepted';

CREATE FUNCTION comms_contact_conflicts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.conflict_id <> OLD.conflict_id OR NEW.memory_space_id <> OLD.memory_space_id OR NEW.source_type <> OLD.source_type
     OR NEW.resource_name <> OLD.resource_name OR NEW.kind <> OLD.kind OR NEW.conflicting_resources <> OLD.conflicting_resources OR NEW.fingerprint <> OLD.fingerprint
     OR NEW.first_seen_at <> OLD.first_seen_at OR NEW.source <> OLD.source OR NEW.detected_by_person_id <> OLD.detected_by_person_id
     OR NEW.detect_session_id <> OLD.detect_session_id OR NEW.detect_task_id IS DISTINCT FROM OLD.detect_task_id THEN
    RAISE EXCEPTION 'comms_contact_conflicts: kjernekolonnene er uforanderlige';
  END IF;
  -- Teller og sist-sett kan bare øke (en senere synk fant samme konflikt igjen).
  IF NEW.seen_count < OLD.seen_count OR NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'comms_contact_conflicts: seen_count og last_seen_at kan kun øke' USING ERRCODE = '23514';
  END IF;
  -- En avgjørelse kan ombestemmes mellom godtatt og avvist (eieren), men et forslag blir aldri `proposed` igjen.
  IF NEW.status = 'proposed' AND OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'comms_contact_conflicts: en avgjørelse kan ikke gjøres om til et åpent forslag' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER comms_contact_conflicts_guard BEFORE UPDATE ON comms_contact_conflicts FOR EACH ROW EXECUTE FUNCTION comms_contact_conflicts_guard();

-- En avgjørelse er funksjonell tilstand (en godtatt konflikt styrer fremtidige synker): sletting er kun lov i en erasure-transaksjon (samme vakt som for avmeldinger, 141: `jarvis.erasure_in_progress`). DELETE-granten er der for erasure.
CREATE TRIGGER comms_contact_conflicts_no_delete BEFORE DELETE ON comms_contact_conflicts FOR EACH ROW EXECUTE FUNCTION comms_optout_no_delete();

GRANT SELECT, INSERT, UPDATE, DELETE ON comms_contact_conflicts TO jarvis_app;

ALTER TABLE comms_contact_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_contact_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY comms_contact_conflicts_tenant ON comms_contact_conflicts
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY comms_contact_conflicts_space ON comms_contact_conflicts AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
