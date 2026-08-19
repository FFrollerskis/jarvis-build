-- UA-4 Native Jarvis Growth Core (D-74, D-64 Core-vs-Adapter-porten kjørt
-- FØRST - se DECISIONS_AND_ASSUMPTIONS.md D-74): Jarvis EIER selv det
-- kanoniske vekst-/markedsførings-domenet (kampanjeregister, utgifts-
-- ledger, attribusjonsgraf mot EKSISTERENDE CRM-entiteter, eksperiment-
-- register, deterministisk utgifts-avviksdeteksjon) - HYBRID_WITH_CLEAR_
-- AUTHORITY: attribusjon/kampanjesporing/eksperimentregister/avviks-
-- deteksjon er JARVIS_CANONICAL, mens de RÅ utgifts-/klikk-/visnings-
-- tallene en fremtidig live-tilkoblet annonseplattform rapporterer forblir
-- EXTERNAL_CANONICAL fakta (Jarvis kan ikke selv frembringe dem - samme
-- pointer-not-payload-prinsipp som kontraktdokumenter). ZERO ekstern
-- annonseplattform-avhengighet i denne sliceen (ingen Google Ads/Meta Ads/
-- GA4/Search Console/Google Business Profile/LinkedIn/YouTube/TikTok-
-- credentials/tabeller her) - live-tilkobling er en FREMTIDIG, valgfri
-- datakilde-/utførelsesadapter, aldri domeneeier (D-74 REPLACEMENT_PATH).
-- Attribusjon kobler til de EKSISTERENDE `business_leads`/
-- `business_opportunities`-entitetene via et polymorft
-- `entity_type`/`entity_id`-par (SAMME etablerte mønster som
-- `business_scores`, `022_business_scoring.sql`) - ingen ny lead-/
-- opportunity-tabell. Samme RLS-/idempotens-/GRANT-mønster som
-- `019_business.sql`/`026_contracts.sql` - ingen ny sikkerhetsmodell.
--
-- Kampanjer er BEVISST IKKE knyttet til ett enkelt selskap (`company_id`) -
-- i motsetning til Support/Contracts (som alltid gjelder én kunde) sikter
-- en markedsføringskampanje mot fremtidige/ukjente leads, ikke én eksisterende
-- kunde. "Hva skjer med kunde X?" dekkes i stedet via
-- `growth.list_by_company()` (kampanjer koblet til selskap X GJENNOM en
-- attribuert lead/opportunity, aldri en direkte FK på kampanjen selv).

CREATE TABLE marketing_campaigns (
  campaign_id            text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Deterministisk kanal-enum - EKSAKT de kanalene masterplanens UA-4-avsnitt
  -- navngir ("Google Ads, Meta Ads, GA4, Search Console, GBP, LinkedIn/
  -- YouTube/TikTok"), pluss 'other' for fremtidig utvidelse uten skjemaendring.
  channel                text NOT NULL CHECK (channel IN ('google_ads','meta_ads','ga4','search_console','google_business_profile','linkedin','youtube','tiktok','other')),
  name                   text NOT NULL,
  -- Deterministisk lifecycle (growth/src/state-machine.ts) - INGEN LLM
  -- avgjør en overgang.
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','ended')),
  budget_amount_ore      bigint,
  currency               text NOT NULL DEFAULT 'NOK',
  -- Pointer-not-payload (samme prinsipp som contracts/support): peker til
  -- kampanjen i leverandørens egen konsoll, ALDRI kopiert kampanjeinnhold.
  -- NULL for kampanjer opprettet uten noen ekstern kilde ennå ('native').
  external_campaign_id   text,
  canonical_uri          text,
  owner_person_id        text REFERENCES people (person_id),
  started_at             timestamptz,
  ended_at               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- Idempotent ingestion for en fremtidig live-synk (samme mønster som
  -- business_leads.external_id): NULL tillater vilkårlig mange native
  -- kampanjer uten ekstern kilde (Postgres NULL != NULL i UNIQUE).
  UNIQUE (tenant_id, channel, external_campaign_id)
);
CREATE INDEX marketing_campaigns_lookup_idx ON marketing_campaigns (tenant_id, memory_space_id, status);
CREATE INDEX marketing_campaigns_channel_idx ON marketing_campaigns (tenant_id, channel);

CREATE TABLE marketing_spend_events (
  spend_event_id         text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  campaign_id            text NOT NULL REFERENCES marketing_campaigns (campaign_id),
  event_date             date NOT NULL,
  spend_amount_ore       bigint NOT NULL CHECK (spend_amount_ore >= 0),
  currency               text NOT NULL DEFAULT 'NOK',
  clicks                 integer,
  impressions            integer,
  -- Deterministisk kilde-klassifisering (ALDRI en gjettet/utledet verdi):
  -- 'manual' = lagt inn av eier/agent, 'csv_import' = batch-importert,
  -- 'provider_sync' = en FREMTIDIG, IKKE bygget live-adapter i denne sliceen.
  source_type            text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','csv_import','provider_sync')),
  source_pointer         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- Idempotent ingestion (samme mønster som business_activities/business_leads):
  -- annonseplattformer rapporterer utgift PER KAMPANJE PER DAG - én rad per
  -- (kampanje, dato, kildetype); re-synk av SAMME dag oppdaterer SAMME rad
  -- (ON CONFLICT DO UPDATE i GrowthService.recordSpendEvent), oppretter aldri
  -- en duplikatrad.
  UNIQUE (tenant_id, campaign_id, event_date, source_type)
);
CREATE INDEX marketing_spend_events_lookup_idx ON marketing_spend_events (tenant_id, campaign_id, event_date DESC);

CREATE TABLE marketing_attributions (
  attribution_id         text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  campaign_id            text NOT NULL REFERENCES marketing_campaigns (campaign_id),
  -- Polymorf kobling til EKSISTERENDE CRM-entiteter (SAMME mønster som
  -- business_scores.entity_type/entity_id, 022_business_scoring.sql) -
  -- ingen ny lead-/opportunity-tabell, ingen krysstabell-FK (polymorf,
  -- håndhevet i applikasjonslaget - samme presedens, samme begrunnelse:
  -- en hard FK mot to mulige måltabeller er ikke uttrykkelig i ren SQL).
  entity_type            text NOT NULL CHECK (entity_type IN ('lead','opportunity')),
  entity_id              text NOT NULL,
  -- Deterministisk attribusjonsmodell - INGEN AI-gjettet/utledet tilskrivning
  -- (Q-26-grensen: ingen inferert kausal påstand). Attribusjon opprettes
  -- EKSPLISITT av kaller (agent/eier), aldri auto-utledet fra fritekst/UTM
  -- i denne sliceen - se OPEN_QUESTIONS.md for fremtidig deterministisk
  -- UTM-basert auto-matching.
  attribution_model      text NOT NULL DEFAULT 'first_touch' CHECK (attribution_model IN ('first_touch','last_touch')),
  source_pointer         text,
  attributed_at          timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, entity_id, campaign_id, attribution_model)
);
CREATE INDEX marketing_attributions_campaign_idx ON marketing_attributions (tenant_id, campaign_id);
CREATE INDEX marketing_attributions_entity_idx ON marketing_attributions (tenant_id, entity_type, entity_id);

CREATE TABLE marketing_experiments (
  experiment_id          text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  campaign_id            text REFERENCES marketing_campaigns (campaign_id),
  name                   text NOT NULL,
  hypothesis             text,
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','concluded','abandoned')),
  -- Menneske-/deterministisk-registrert resultatoppsummering - ALDRI en
  -- AI-generert kausal påstand (samme Q-26-grense som attribution_model
  -- over og contract_versions.summary: strukturert, ikke inferert "sannhet").
  result_summary         text,
  owner_person_id        text REFERENCES people (person_id),
  started_at             timestamptz,
  ended_at               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketing_experiments_lookup_idx ON marketing_experiments (tenant_id, memory_space_id, status);

-- Vekst-tidslinje: FØRSTEKLASSES og SEPARAT fra `audit_events` (samme
-- prinsipp som `contract_events`/`support_ticket_events`) - dette ER
-- vekst-domenets egen historikk, ikke en duplisert audit-mekanisme.
CREATE TABLE marketing_campaign_events (
  event_id               text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  campaign_id            text NOT NULL REFERENCES marketing_campaigns (campaign_id),
  event_type             text NOT NULL CHECK (event_type IN (
    'campaign_created', 'status_changed', 'spend_recorded', 'budget_changed', 'attribution_created',
    'experiment_created', 'experiment_status_changed'
  )),
  summary                text NOT NULL,
  actor_person_id        text REFERENCES people (person_id),
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketing_campaign_events_timeline_idx ON marketing_campaign_events (tenant_id, campaign_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON
  marketing_campaigns, marketing_spend_events, marketing_attributions, marketing_experiments, marketing_campaign_events
  TO jarvis_app;
-- Q-20: vekst-domenet er KUNDEDATA (samme klasse som
-- `contracts`/`support_tickets`/`memory_items`, IKKE append-only
-- systemrevisjon som `audit_events`) - registrert i `modules/erasure/src/plan.ts`.
-- Uten denne GRANTen ville ErasureService sin faktiske
-- `DELETE FROM marketing_campaigns/...` feile med permission denied for
-- HELE tenant-/space-erasure-operasjonen (samme presedens/begrunnelse som
-- `024_support.sql`/`026_contracts.sql`).
GRANT DELETE ON
  marketing_campaigns, marketing_spend_events, marketing_attributions, marketing_experiments, marketing_campaign_events
  TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'marketing_campaigns', 'marketing_spend_events', 'marketing_attributions', 'marketing_experiments', 'marketing_campaign_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    -- AS RESTRICTIVE: AND-es med tenant-policyen (default deny uten gyldig
    -- space-kontekst - identisk prinsipp til alle andre business_*/contract_*-tabeller).
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;

-- Byggeordren §8: "Reuse OpenLoopService... No second task/reminder engine."
-- Additiv utvidelse av DEN EKSISTERENDE `business_open_loops`
-- (020_business_open_loops.sql/024_support.sql/026_contracts.sql), ikke en
-- ny mekanisme: én nullable `campaign_id`-pekerkolonne + én ny
-- `loop_type`-verdi for deterministisk utgifts-avviksdeteksjon.
ALTER TABLE business_open_loops ADD COLUMN campaign_id text REFERENCES marketing_campaigns (campaign_id);
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required',
  'marketing_spend_anomaly'
));
