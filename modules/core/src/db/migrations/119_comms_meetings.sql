-- WP-G1 (D-463, UA-7 P2g): møtetranskripsjon-pipelinen - metadata om behandlede møter, deltakere og FORESLÅTTE forpliktelser. Forward-safe (expand-only): tre NYE tabeller + to trigger-funksjoner.
--
-- D-64 Core-vs-Adapter: «hvilke møter er behandlet, hvem deltok, hvilke forpliktelser ble nevnt og hva eieren bestemte» er Jarvis' egen domenetilstand (JARVIS_CANONICAL). Transkripsjonskilden (eksisterende
-- tekstkilder fra UA-2/Meet/Teams, eller lyd via en tale-adapter) er en leverandør/kilde og eier ingen av disse tabellene.
--
-- DATAMINIMERING (se docs/UA7_COMMUNICATIONS_DPIA.md og docs/security/PROCESSING_INVENTORY.md): selve transkripsjonsteksten lagres ALDRI her - kun innholds-hash (idempotens), antall segmenter, tittel, deltakernavn
-- og korte forpliktelses-utdrag (renset, maks 300 tegn). Rettslig grunnlag avgjøres ALDRI av Jarvis (D-122): eieren attesterer eksplisitt (`legal_basis_attested`, CHECK) og det er et revisjonsspor - ikke en juridisk konklusjon.
-- Deltakere kobles til en identitet KUN ved eksakt treff eller eierens bekreftelse; et rent navnetreff er `candidate` (forslag), aldri en kobling (ukjent forblir ukjent, Q-26).
-- Forpliktelser er FORSLAG (`proposed`) funnet av deterministiske mønstre - de blir en åpen oppfølging (`business_followups`) først når eieren godtar dem.
-- Alle rader bærer tenant, memory space, person, sesjon og kilde (CLAUDE.md regel 4). RLS: FORCE, tenant + RESTRICTIVE memory space. Oppbevaring: `retention_until` (sveip + Q-20-sletting via erasure-planen).

CREATE TABLE comms_meetings (
  tenant_id               text NOT NULL REFERENCES tenants (tenant_id),
  meeting_id              text NOT NULL CHECK (char_length(meeting_id) BETWEEN 8 AND 80),
  memory_space_id         text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  source                  text NOT NULL CHECK (source IN ('text_transcript','audio_file')),
  source_format           text CHECK (source_format IS NULL OR source_format IN ('txt','vtt','srt','json')),
  title                   text CHECK (title IS NULL OR char_length(title) <= 200),
  started_at              timestamptz,
  duration_ms             bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  -- Idempotens: samme innhold i samme tenant OG memory space gir samme møte (ingen dobbeltbehandling, ingen dobbelte forslag). Hvert rom er sitt eget datasett (RLS), så hashen er unik per rom.
  content_sha256          text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  segment_count           integer NOT NULL CHECK (segment_count >= 0),
  -- Eierens eksplisitte attest (D-122: Jarvis avgjør aldri selv et rettslig grunnlag). Uten attest kan raden ikke finnes.
  legal_basis_attested    boolean NOT NULL CHECK (legal_basis_attested),
  legal_basis_note        text CHECK (legal_basis_note IS NULL OR char_length(legal_basis_note) <= 300),
  -- Lyd: hvor talebehandleren kjørte (porten `evaluateSpeechRouting`); tekstkilder har ingen talebehandler.
  speech_processor_locality text CHECK (speech_processor_locality IS NULL OR speech_processor_locality IN ('local','external')),
  person_id               text NOT NULL CHECK (char_length(person_id) BETWEEN 1 AND 200),
  session_id              text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 200),
  task_id                 text CHECK (task_id IS NULL OR char_length(task_id) <= 200),
  created_at              timestamptz NOT NULL DEFAULT now(),
  retention_until         timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, meeting_id),
  UNIQUE (tenant_id, memory_space_id, content_sha256)
);
CREATE INDEX comms_meetings_retention_idx ON comms_meetings (retention_until);

CREATE TABLE comms_meeting_participants (
  tenant_id               text NOT NULL,
  meeting_id              text NOT NULL,
  memory_space_id         text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  participant_ref         text NOT NULL CHECK (char_length(participant_ref) BETWEEN 1 AND 80),
  display_name            text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  identity_id             text REFERENCES conversation_identities (identity_id),
  -- unresolved = ukjent forblir ukjent; exact = eksakt identifikatortreff; candidate = KUN forslag (identity_id forblir NULL); owner_confirmed = eierens bekreftelse.
  resolution              text NOT NULL DEFAULT 'unresolved' CHECK (resolution IN ('unresolved','exact','candidate','owner_confirmed')),
  candidate_identity_id   text REFERENCES conversation_identities (identity_id),
  confirmed_by_person_id  text REFERENCES people (person_id),
  confirmed_at            timestamptz,
  PRIMARY KEY (tenant_id, meeting_id, participant_ref),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES comms_meetings (tenant_id, meeting_id) ON DELETE CASCADE,
  CHECK ((resolution IN ('exact','owner_confirmed')) = (identity_id IS NOT NULL)),
  CHECK ((resolution = 'candidate') = (candidate_identity_id IS NOT NULL)),
  CHECK ((resolution = 'owner_confirmed') = (confirmed_at IS NOT NULL))
);
SELECT jarvis_scope_fk('comms_meeting_participants'::regclass, 'identity_id', 'conversation_identities'::regclass, 'identity_id');
SELECT jarvis_scope_fk('comms_meeting_participants'::regclass, 'candidate_identity_id', 'conversation_identities'::regclass, 'identity_id');

CREATE TABLE comms_meeting_commitments (
  tenant_id               text NOT NULL,
  meeting_id              text NOT NULL,
  memory_space_id         text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  commitment_id           text NOT NULL CHECK (char_length(commitment_id) BETWEEN 8 AND 80),
  -- Taleren (deltaker-referanse) - kan være ukjent.
  participant_ref         text CHECK (participant_ref IS NULL OR char_length(participant_ref) <= 80),
  commitment_text         text NOT NULL CHECK (char_length(commitment_text) BETWEEN 1 AND 300),
  -- Kun en EKSPLISITT dato i teksten (ISO eller «20. november [2026]»); aldri gjettet.
  due_at                  timestamptz,
  -- Proveniens: alltid deterministisk mønster her (aldri modell). `rule` navngir mønsteret; `segment_index` peker til kilden.
  detection               text NOT NULL DEFAULT 'deterministic_pattern' CHECK (detection = 'deterministic_pattern'),
  rule                    text NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 40),
  segment_index           integer NOT NULL CHECK (segment_index >= 0),
  status                  text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','dismissed')),
  followup_id             text CHECK (followup_id IS NULL OR char_length(followup_id) <= 80),
  decided_by_person_id    text REFERENCES people (person_id),
  decided_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, commitment_id),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES comms_meetings (tenant_id, meeting_id) ON DELETE CASCADE,
  CHECK ((status = 'proposed') = (decided_at IS NULL)),
  CHECK (followup_id IS NULL OR status = 'accepted')
);
CREATE INDEX comms_meeting_commitments_meeting_idx ON comms_meeting_commitments (tenant_id, meeting_id, segment_index);
CREATE INDEX comms_meeting_commitments_open_idx ON comms_meeting_commitments (tenant_id, status) WHERE status = 'proposed';

-- Forpliktelser: kjernekolonnene er uforanderlige; `proposed` -> `accepted`|`dismissed` er en ENVEIS overgang (terminal etter det).
CREATE FUNCTION comms_meeting_commitments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.meeting_id <> OLD.meeting_id OR NEW.commitment_id <> OLD.commitment_id OR NEW.commitment_text <> OLD.commitment_text
     OR NEW.participant_ref IS DISTINCT FROM OLD.participant_ref OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.rule <> OLD.rule OR NEW.segment_index <> OLD.segment_index
     OR NEW.detection <> OLD.detection OR NEW.memory_space_id <> OLD.memory_space_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'comms_meeting_commitments: kjernekolonnene er uforanderlige';
  END IF;
  IF OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'comms_meeting_commitments: terminal status (%) kan ikke endres', OLD.status;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER comms_meeting_commitments_guard BEFORE UPDATE ON comms_meeting_commitments FOR EACH ROW EXECUTE FUNCTION comms_meeting_commitments_guard();

-- Deltakere: kjernekolonnene er uforanderlige; en bekreftet/eksakt kobling endres ikke stille.
CREATE FUNCTION comms_meeting_participants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.meeting_id <> OLD.meeting_id OR NEW.participant_ref <> OLD.participant_ref OR NEW.display_name <> OLD.display_name OR NEW.memory_space_id <> OLD.memory_space_id THEN
    RAISE EXCEPTION 'comms_meeting_participants: kjernekolonnene er uforanderlige';
  END IF;
  IF OLD.resolution IN ('exact', 'owner_confirmed') THEN
    RAISE EXCEPTION 'comms_meeting_participants: en etablert kobling (%) kan ikke endres', OLD.resolution;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER comms_meeting_participants_guard BEFORE UPDATE ON comms_meeting_participants FOR EACH ROW EXECUTE FUNCTION comms_meeting_participants_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON comms_meetings, comms_meeting_participants, comms_meeting_commitments TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comms_meetings', 'comms_meeting_participants', 'comms_meeting_commitments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;
