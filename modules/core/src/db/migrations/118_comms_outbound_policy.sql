-- WP-G1 (D-463, UA-7 Communications Hub - resterende deler): utgående kommunikasjonspolicy, mottakeres opt-out, utgående journal og verifiserte innkommende hendelser.
-- Forward-safe (expand-only): fire NYE tabeller + én trigger-funksjon. Ingen eksisterende tabell/kolonne endres.
--
-- D-64 Core-vs-Adapter: «hvem Jarvis får snakke gjennom (konto-allowlist), hvem som har sagt stopp (opt-out), hva som faktisk ble sendt (journal) og hva som kom inn (verifiserte hendelser)» er Jarvis' egen
-- domene-/policytilstand (JARVIS_CANONICAL). Leverandørene (Slack, Discord, Meta, Twilio, Telnyx, Microsoft) er transporter/kilder/utførelsesleverandører og eier ingen av disse tabellene.
--
-- Personvern (se docs/UA7_COMMUNICATIONS_DPIA.md og docs/security/PROCESSING_INVENTORY.md):
--  - mottakere lagres som PSEUDONYM (`recipient_hash`, SHA-256 med tenant+kanal i saltet) og en maskert visning - aldri som klartekst i opt-out/journal. Pseudonymisering er ikke anonymisering.
--  - journalen lagrer HASH og lengde av innholdet, aldri selve meldingsteksten.
--  - innkommende hendelser er UBETRODDE data (`trust_level` er låst til 'untrusted' av CHECK); kun signaturverifiserte hendelser lagres (CHECK `signature_verified`), og tekstutdraget er begrenset og har
--    en tidsfrist (`retention_until`, standard 30 dager, aldri over 365).
--  - alle rader bærer tenant, memory space, kilde og sporings-id (`task_id`/`session_id`/`ingest_id`, CLAUDE.md regel 4). RLS: FORCE, tenant + RESTRICTIVE memory space (som 046/108).
--
-- Tilstandsmaskinen i journalen (`comms_outbound_log`): requested -> sent | failed | outcome_unknown; outcome_unknown -> sent | failed (avklart); sent/failed/denied er TERMINALE. Kjernekolonnene er uforanderlige
-- (trigger). `jarvis_app` har UPDATE (overgangene) og DELETE (kun retensjonssveip og Q-20-sletting) - de kan ikke tilbakekalles uten å bryte funksjonen (samme grense som growth_write_journal, D-459).

CREATE TABLE comms_authorized_accounts (
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  account_id           text NOT NULL CHECK (char_length(account_id) BETWEEN 8 AND 80),
  memory_space_id      text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  channel              text NOT NULL CHECK (channel IN ('slack','discord','whatsapp','sms','teams','messenger','instagram','phone')),
  -- Ikke-hemmelig referanse til eierens konto hos leverandøren (Slack team-id, WhatsApp phone_number_id, avsendernummer E.164, Discord guild-id, side-/IG-konto-id, Teams tenant). ALDRI en credential.
  account_ref          text NOT NULL CHECK (char_length(account_ref) BETWEEN 1 AND 200),
  -- Leverandøren som skal brukes for kontoen (SMS kan gå via Twilio ELLER Telnyx; telefon via Twilio ELLER Telnyx).
  provider             text NOT NULL CHECK (provider IN ('slack','discord','meta_whatsapp','twilio','telnyx','ms_graph','meta_messenger','meta_instagram')),
  display_name         text CHECK (display_name IS NULL OR char_length(display_name) <= 120),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by_person_id text REFERENCES people (person_id),
  source               text NOT NULL CHECK (source IN ('owner_route','tool')),
  session_id           text CHECK (session_id IS NULL OR char_length(session_id) <= 200),
  task_id              text CHECK (task_id IS NULL OR char_length(task_id) <= 200),
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  PRIMARY KEY (tenant_id, account_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX comms_authorized_accounts_active_uq ON comms_authorized_accounts (tenant_id, channel, account_ref) WHERE status = 'active';

CREATE TABLE comms_recipient_opt_outs (
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  opt_out_id           text NOT NULL CHECK (char_length(opt_out_id) BETWEEN 8 AND 80),
  memory_space_id      text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  channel              text NOT NULL CHECK (channel IN ('slack','discord','whatsapp','sms','teams','messenger','instagram','phone')),
  -- Avsenderen avmeldingen gjelder (STOP er per avsender-nummer hos Twilio/Telnyx); '*' = alle våre avsendere på kanalen.
  account_ref          text NOT NULL DEFAULT '*' CHECK (char_length(account_ref) BETWEEN 1 AND 200),
  recipient_hash       text NOT NULL CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
  recipient_hint       text CHECK (recipient_hint IS NULL OR char_length(recipient_hint) <= 32),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  source               text NOT NULL CHECK (source IN ('inbound_stop_keyword','provider_error','owner_recorded','recipient_request')),
  -- Peker til hendelsen som beviser avmeldingen (innkommende hendelsesnøkkel/leverandørfeilkode) - aldri meldingsinnholdet.
  evidence_ref         text CHECK (evidence_ref IS NULL OR char_length(evidence_ref) <= 200),
  recorded_by          text NOT NULL DEFAULT 'system' CHECK (char_length(recorded_by) BETWEEN 1 AND 200),
  session_id           text CHECK (session_id IS NULL OR char_length(session_id) <= 200),
  task_id              text CHECK (task_id IS NULL OR char_length(task_id) <= 200),
  created_at           timestamptz NOT NULL DEFAULT now(),
  lifted_at            timestamptz,
  -- KUN mottakeren selv kan oppheve sin avmelding (START på samme kanal/avsender). Eieren kan REGISTRERE en avmelding, aldri oppheve en (bevisst: mottakerens rett går foran).
  lifted_by            text CHECK (lifted_by IS NULL OR lifted_by = 'inbound_start_keyword'),
  PRIMARY KEY (tenant_id, opt_out_id),
  CHECK ((status = 'lifted') = (lifted_at IS NOT NULL AND lifted_by IS NOT NULL))
);
CREATE UNIQUE INDEX comms_recipient_opt_outs_active_uq ON comms_recipient_opt_outs (tenant_id, channel, account_ref, recipient_hash) WHERE status = 'active';
CREATE INDEX comms_recipient_opt_outs_lookup_idx ON comms_recipient_opt_outs (tenant_id, channel, recipient_hash) WHERE status = 'active';

CREATE TABLE comms_outbound_log (
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  log_id               text NOT NULL CHECK (char_length(log_id) BETWEEN 8 AND 80),
  memory_space_id      text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Kallerens forespørsels-id (= ToolGateway-idempotensnøkkelen satt av ruten). Én forsøksrad per forespørsel (unntatt `denied`, som er ren bevisføring og ikke «brenner» id-en).
  request_id           text NOT NULL CHECK (char_length(request_id) BETWEEN 8 AND 200),
  kind                 text NOT NULL CHECK (kind IN ('message','edit','delete','reaction','call')),
  channel              text NOT NULL CHECK (channel IN ('slack','discord','whatsapp','sms','teams','messenger','instagram','phone')),
  account_ref          text NOT NULL CHECK (char_length(account_ref) BETWEEN 1 AND 200),
  provider             text NOT NULL CHECK (provider IN ('slack','discord','meta_whatsapp','twilio','telnyx','ms_graph','meta_messenger','meta_instagram')),
  recipient_hash       text NOT NULL CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
  recipient_hint       text CHECK (recipient_hint IS NULL OR char_length(recipient_hint) <= 32),
  purpose              text NOT NULL CHECK (purpose IN ('transactional','agreed','marketing')),
  status               text NOT NULL CHECK (status IN ('denied','requested','sent','outcome_unknown','failed')),
  -- Regelevaluering (regelnavn, utfall, kode) - aldri innhold. `denial_codes` er de avslående kodene.
  rule_evaluation      jsonb NOT NULL,
  denial_codes         jsonb NOT NULL DEFAULT '[]'::jsonb,
  recipient_proof      jsonb NOT NULL,
  content_sha256       text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  content_length       integer NOT NULL DEFAULT 0 CHECK (content_length >= 0),
  ai_disclosure_applied boolean NOT NULL DEFAULT false,
  -- For edit/delete/reaksjon: journalraden for den opprinnelige, sendte meldingen.
  target_log_id        text,
  provider_message_id  text CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 300),
  thread_ref           text CHECK (thread_ref IS NULL OR char_length(thread_ref) <= 300),
  before_state         jsonb,
  after_state          jsonb,
  person_id            text NOT NULL CHECK (char_length(person_id) BETWEEN 1 AND 200),
  session_id           text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 200),
  task_id              text CHECK (task_id IS NULL OR char_length(task_id) <= 200),
  source               text NOT NULL CHECK (source IN ('owner_route','tool','sweep','legacy_notify_guard')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  retention_until      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, log_id)
);
-- Én forsøksrad per forespørsel (den som kan ha nådd leverandøren); `denied`-rader er bevis og teller ikke.
CREATE UNIQUE INDEX comms_outbound_log_request_uq ON comms_outbound_log (tenant_id, request_id) WHERE status <> 'denied';
CREATE INDEX comms_outbound_log_recipient_idx ON comms_outbound_log (tenant_id, channel, recipient_hash, created_at DESC);
CREATE INDEX comms_outbound_log_account_idx ON comms_outbound_log (tenant_id, channel, account_ref, created_at DESC);
CREATE INDEX comms_outbound_log_provider_msg_idx ON comms_outbound_log (tenant_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX comms_outbound_log_retention_idx ON comms_outbound_log (retention_until);

CREATE FUNCTION comms_outbound_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.log_id <> OLD.log_id OR NEW.request_id <> OLD.request_id OR NEW.kind <> OLD.kind OR NEW.channel <> OLD.channel
     OR NEW.account_ref <> OLD.account_ref OR NEW.provider <> OLD.provider OR NEW.recipient_hash <> OLD.recipient_hash OR NEW.purpose <> OLD.purpose
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR NEW.created_at <> OLD.created_at OR NEW.person_id <> OLD.person_id
     OR NEW.session_id <> OLD.session_id OR NEW.memory_space_id <> OLD.memory_space_id OR NEW.source <> OLD.source OR NEW.rule_evaluation <> OLD.rule_evaluation THEN
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
CREATE TRIGGER comms_outbound_log_guard BEFORE UPDATE ON comms_outbound_log FOR EACH ROW EXECUTE FUNCTION comms_outbound_log_guard();

CREATE FUNCTION comms_recipient_opt_outs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.opt_out_id <> OLD.opt_out_id OR NEW.channel <> OLD.channel OR NEW.account_ref <> OLD.account_ref
     OR NEW.recipient_hash <> OLD.recipient_hash OR NEW.source <> OLD.source OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'comms_recipient_opt_outs: kjernekolonnene er uforanderlige';
  END IF;
  IF OLD.status = 'lifted' THEN
    RAISE EXCEPTION 'comms_recipient_opt_outs: en opphevet avmelding kan ikke endres (ny avmelding = ny rad)';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER comms_recipient_opt_outs_guard BEFORE UPDATE ON comms_recipient_opt_outs FOR EACH ROW EXECUTE FUNCTION comms_recipient_opt_outs_guard();

CREATE TABLE comms_inbound_events (
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  event_id             text NOT NULL CHECK (char_length(event_id) BETWEEN 8 AND 80),
  memory_space_id      text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  provider             text NOT NULL CHECK (provider IN ('slack','meta','twilio','telnyx')),
  channel              text NOT NULL CHECK (channel IN ('slack','discord','whatsapp','sms','teams','messenger','instagram','phone')),
  -- Kontoen hendelsen kom inn på (vår side). '*' når leverandøren ikke oppgir den.
  account_ref          text NOT NULL DEFAULT '*' CHECK (char_length(account_ref) BETWEEN 1 AND 200),
  -- Leverandørens egen hendelses-id (+ type) - gjenspillingsvernet: samme hendelse en gang til treffer UNIQUE og endrer ingenting.
  event_key            text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 300),
  kind                 text NOT NULL CHECK (kind IN ('message','status','opt_out','opt_in','other')),
  sender_hash          text CHECK (sender_hash IS NULL OR sender_hash ~ '^[0-9a-f]{64}$'),
  sender_hint          text CHECK (sender_hint IS NULL OR char_length(sender_hint) <= 32),
  -- Løst identitet (kun EKSAKT treff i Conversation Graph; ukjent forblir NULL, Q-26). Komposittnøkkel (tenant_id, identity_id) legges på under.
  identity_id          text REFERENCES conversation_identities (identity_id),
  thread_ref           text CHECK (thread_ref IS NULL OR char_length(thread_ref) <= 300),
  -- UBETRODD innhold: begrenset, kontrolltegn-renset og hemmelighetsskannet tekstutdrag. Aldri en instruksjon, aldri direkte til minne (CLAUDE.md regel 7).
  content_excerpt      text CHECK (content_excerpt IS NULL OR char_length(content_excerpt) <= 2000),
  content_sha256       text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  trust_level          text NOT NULL DEFAULT 'untrusted' CHECK (trust_level = 'untrusted'),
  signature_verified   boolean NOT NULL CHECK (signature_verified),
  provider_ts          timestamptz,
  received_at          timestamptz NOT NULL DEFAULT now(),
  retention_until      timestamptz NOT NULL,
  -- Kilde og sporing (regel 4): webhooks har ingen person/sesjon - `ingest_id` er per-forespørsel-id'en som spor, `source` er alltid 'webhook:<leverandør>'.
  source               text NOT NULL CHECK (source ~ '^webhook:[a-z]{3,20}$'),
  ingest_id            text NOT NULL CHECK (char_length(ingest_id) BETWEEN 8 AND 80),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, provider, event_key)
);
SELECT jarvis_scope_fk('comms_inbound_events'::regclass, 'identity_id', 'conversation_identities'::regclass, 'identity_id');
CREATE INDEX comms_inbound_events_sender_idx ON comms_inbound_events (tenant_id, channel, sender_hash, received_at DESC) WHERE sender_hash IS NOT NULL;
CREATE INDEX comms_inbound_events_retention_idx ON comms_inbound_events (retention_until);

GRANT SELECT, INSERT, UPDATE, DELETE ON comms_authorized_accounts, comms_recipient_opt_outs, comms_outbound_log TO jarvis_app;
-- Innkommende hendelser er uforanderlige etter innsetting (ingen UPDATE): kun SELECT/INSERT og DELETE (retensjonssveip og Q-20-sletting).
GRANT SELECT, INSERT, DELETE ON comms_inbound_events TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comms_authorized_accounts', 'comms_recipient_opt_outs', 'comms_outbound_log', 'comms_inbound_events'] LOOP
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
