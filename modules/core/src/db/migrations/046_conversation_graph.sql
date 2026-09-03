-- UA-7 Communications Hub - FOERSTE SLICE (D-119): Conversation Graph +
-- confidence-basert, reversibel identitetsoppløsning på tvers av kanaler.
--
-- D-64 Core-vs-Adapter-gate (full begrunnelse: D-119 i
-- DECISIONS_AND_ASSUMPTIONS.md): "hvilken person/motpart er dette, på tvers
-- av Gmail/Telegram/fremtidige kanaler, med hvilken tillit, og reversibelt"
-- er INTRINSIC Jarvis-kjerneintelligens - ingen ekstern leverandør tilbyr
-- dette (Gmail vet ingenting om Telegram-identiteten til samme person).
-- `conversation_identities`/`conversation_channel_links`/
-- `conversation_identity_merges` er derfor JARVIS_CANONICAL. Selve
-- kanalene (Gmail/Telegram/...) forblir EXTERNAL_CANONICAL for
-- meldingsinnhold/threading - denne migrasjonen lagrer ALDRI en kopi av
-- meldingsinnhold, kun peker-metadata (samme `canonical_uri`-prinsipp som
-- `business_activities`, 019_business.sql).
--
-- Reuse-audit FØR denne migrasjonen (se D-119): `business_contacts`
-- (019_business.sql) er en CRM-/salgspipeline-motpartsmodell UTEN
-- confidence-/proveniens-/reversibel-merge-felt noe sted - vurdert og
-- EKSPLISITT gjenbrukt som PEKER (`linked_business_contact_id`), ikke
-- erstattet. `people`/`person_tenants` (001_identity.sql) modellerer
-- INGEN multi-identifikator-per-person noe sted. `memory_sources.
-- trust_level` (008_memory.sql) er den eksisterende proveniens-modellen -
-- gjenbrukt via samme `source_type`/`source_instance_id`/`external_id`-
-- idempotens-mønster som `business_activities`/`business_leads`, IKKE en
-- ny parallell tillitsmodell. Ingen egnet eksisterende struktur dekket
-- confidence-scoret, reversibel kanal-identitet-kobling - en minimal, ny
-- struktur er derfor nødvendig (D-64: NEW_DOMAIN_GENUINELY_REQUIRED=true).
--
-- Tre tabeller, SAMME RLS-/GRANT-/erasure-mønster som 019_business.sql/
-- 045_finance_vendor_registry.sql:
--
-- `conversation_identities`: kanonisk Jarvis-identitetsnode ("denne
-- motparten, uansett kanal"). Kan PEKE til en eksisterende
-- `business_contact`/`person` (aldri en kopi). `status='merged'` +
-- `merged_into_identity_id` TOMBSTONER en sammenslått identitet -
-- ALDRI en DELETE (byggeordrens krav om reversibel merge/split,
-- akseptansekriterium 3).
--
-- `conversation_channel_links`: den confidence-scorte X<->Y-koblingen
-- (kanal-identifikator, f.eks. lowercased e-postadresse eller Telegram
-- chat-id <-> kanonisk identitet). `UNIQUE (tenant_id, channel,
-- channel_identifier) WHERE status = 'active'` håndhever at ÉN
-- kanal-identifikator har HØYST ÉN aktiv eier samtidig (revokerte lenker
-- forblir som historikk, en NY aktiv lenke kan senere peke til en annen
-- identitet - split-korreksjon uten datatap).
--
-- `conversation_identity_merges`: append-only reversibel merge-/split-
-- revisjonslogg (selve kilden til sannhet for "identity merges are
-- reversible and confidence-tracked"). `affected_link_ids` er en JSONB-
-- array av `conversation_channel_links.link_id` som ble omdirigert AV
-- DENNE hendelsen - en `split`-handling bruker DENNE presise listen til å
-- gjenopprette EKSAKT samme lenker til kilde-identiteten (aldri en
-- gjetning om hvilke lenker som "hørte til" kilden). `performed_by`
-- håndhever CLAUDE.md regel 8 ("ingen destruktive handlinger uten
-- eksplisitt bekreftelse") OG byggeordrens "never LLM-alone permanent
-- merge" STRUKTURELT: kun 'owner' eller 'deterministic_rule' kan utføre
-- selve merge/split-handlingen (håndhevet i `ConversationGraphService`,
-- IKKE bare en promptregel) - 'ai_assisted' kan kun FORESLÅ, aldri EIE
-- denne kolonnens verdi for en faktisk utført handling.

CREATE TABLE conversation_identities (
  identity_id              text PRIMARY KEY,
  tenant_id                text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id          text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  display_name             text,
  -- Peker, ALDRI en kopi - samme prinsipp som business_activities.canonical_uri.
  linked_business_contact_id text REFERENCES business_contacts (contact_id),
  linked_person_id          text REFERENCES people (person_id),
  status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
  merged_into_identity_id     text REFERENCES conversation_identities (identity_id),
  created_by_person_id         text REFERENCES people (person_id),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  -- En sammenslått identitet MÅ ha et mål; en aktiv identitet MÅ IKKE.
  CHECK ((status = 'merged') = (merged_into_identity_id IS NOT NULL))
);
CREATE INDEX conversation_identities_lookup_idx ON conversation_identities (tenant_id, memory_space_id, status);
CREATE INDEX conversation_identities_contact_idx ON conversation_identities (tenant_id, linked_business_contact_id);

CREATE TABLE conversation_channel_links (
  link_id                 text PRIMARY KEY,
  tenant_id               text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id         text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  identity_id             text NOT NULL REFERENCES conversation_identities (identity_id),
  -- Kanaler eksplisitt bygget denne sliceen (Gmail via email/lignende
  -- headere, Telegram via chat-id). Fremtidige kanaler (Slack/Teams/
  -- WhatsApp/Discord/SMS/SIP) er BEVISST IKKE inkludert her (D-108/§29 i
  -- byggeordren - "no big-bang all-providers-at-once") - utvides additivt
  -- (ny CHECK-verdi) når en fremtidig UA-7-slice faktisk bygger kanalen.
  channel                 text NOT NULL CHECK (channel IN ('email','telegram')),
  -- Opak, normalisert identifikator (lowercased e-post / rå Telegram
  -- chat-id) - ALDRI parset utover tilstedeværelse+normalisering, samme
  -- prinsipp som finance_vendor_provider_bindings.provider_vendor_ref.
  channel_identifier      text NOT NULL,
  confidence               real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- Deterministisk kilde til confidence-verdien - ALDRI en fri tekst en
  -- modell kan fylle med hva som helst.
  match_method              text NOT NULL CHECK (match_method IN ('exact_email','owner_configured','manual')),
  source_type                 text,
  source_instance_id            text,
  external_id                    text,
  status                          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by_person_id             text REFERENCES people (person_id),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                         timestamptz NOT NULL DEFAULT now(),
  revoked_at                          timestamptz
);
CREATE UNIQUE INDEX conversation_channel_links_active_unique_idx
  ON conversation_channel_links (tenant_id, channel, channel_identifier)
  WHERE status = 'active';
CREATE INDEX conversation_channel_links_identity_idx ON conversation_channel_links (tenant_id, identity_id);

CREATE TABLE conversation_identity_merges (
  merge_id                text PRIMARY KEY,
  tenant_id                text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id          text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  action                    text NOT NULL CHECK (action IN ('merge','split')),
  source_identity_id        text NOT NULL REFERENCES conversation_identities (identity_id),
  target_identity_id        text NOT NULL REFERENCES conversation_identities (identity_id),
  -- KUN satt for action='split' - peker tilbake til den EKSAKTE
  -- merge-hendelsen som reverseres (aldri en generisk "angre siste merge").
  reverses_merge_id           text REFERENCES conversation_identity_merges (merge_id),
  -- Lenkene DENNE hendelsen omdirigerte - kilden til sannhet for en
  -- presis, tapsfri split (se filhode over).
  affected_link_ids            jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence                    real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason                          text NOT NULL,
  -- Strukturell håndhevelse av "aldri en LLM-alene permanent merge" -
  -- 'ai_assisted' kan eksistere som klassifisering av en TIDLIGERE
  -- split-reversering av et feilaktig owner/deterministic-forslag, men
  -- INGEN rad kan noensinne opprettes med performed_by='ai_assisted' for
  -- selve utførelsen (håndhevet i ConversationGraphService, IKKE en
  -- database-CHECK alene - se D-119 for full begrunnelse av hvorfor en
  -- ren DB-CHECK ikke er nok her).
  performed_by                     text NOT NULL CHECK (performed_by IN ('owner','deterministic_rule')),
  created_by_person_id               text REFERENCES people (person_id),
  created_at                          timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'split') = (reverses_merge_id IS NOT NULL))
);
CREATE INDEX conversation_identity_merges_source_idx ON conversation_identity_merges (tenant_id, source_identity_id);
CREATE INDEX conversation_identity_merges_target_idx ON conversation_identity_merges (tenant_id, target_identity_id);

GRANT SELECT, INSERT, UPDATE ON
  conversation_identities, conversation_channel_links, conversation_identity_merges
  TO jarvis_app;
-- Q-20: full tenant-/memory-space-sletting krever DELETE - samme
-- begrunnelse som hver tidligere UA-3/UA-6-migrasjon.
GRANT DELETE ON
  conversation_identities, conversation_channel_links, conversation_identity_merges
  TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversation_identities', 'conversation_channel_links', 'conversation_identity_merges'
  ] LOOP
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
