-- UA-4 Growth & Marketing Control Plane - Marketing Memory v1 (D-89). Lukker
-- masterplanens EGEN literale nevning ("Experiment registry, anomaly
-- detection, creative intelligence og marketing memory", input/02_...v4.0.md
-- linje 479) - EKSPLISITT et NARROW v1: en deterministisk, evidens-forankret
-- OBSERVASJON-lag over ALLEREDE eksisterende kanonisk data (kampanje/
-- utgift/attribusjon/møte/anbefaling/kommando), ALDRI et generalisert
-- "AI lærer alt"-system. Gjenbruker DENNE pakkens EGNE, allerede-etablerte
-- observasjonsarkitektur (`business_scores`, 022_business_scoring.sql -
-- entity_type/entity_id/factor_summary/evidence/UNIQUE-per-type-mønsteret)
-- FREMFOR den generelle UA-2 `memory_items`-motoren (008_memory.sql): den
-- er bygget for fritekst-utdrag fra samtaler/dokumenter (subject/content/
-- embedding/entity-linking) - FEIL form for strukturerte, numeriske
-- kampanje-observasjoner med eksplisitte evidens-ID-er. Samme RLS-/
-- idempotens-/GRANT-mønster som ALLE øvrige marketing_*-tabeller
-- (027/028/029/030_growth_*.sql) - ingen ny sikkerhetsmodell.
--
-- Q-26-grensen er den PRIMÆRE sikkerhetsporten for denne migrasjonen:
-- `detection_method` er BEVISST LÅST til KUN 'deterministic' (samme
-- strenge ett-verdi-mønster som `marketing_campaign_action_recommendations.
-- source` i 029_growth_action_recommendations.sql/D-85 - IKKE det løsere
-- to-verdi-mønsteret ('deterministic'/'ai_assisted') `business_open_loops`/
-- `business_scores` bruker som en FREMTIDIG utvidelsesplass) - ZERO
-- ModelGateway/AI-inferens er mulig i denne sliceen, håndhevet i databasen
-- selv, ikke bare kode-konvensjon. `status` inneholder BEVISST INGEN
-- 'verified'-verdi - kun 'open'/'resolved' (en observasjon som IKKE lenger
-- gjelder, ALDRI en "sannhet" som er blitt "bekreftet") - Truth Promotion
-- (Q-26) forblir EKSPLISITT ubygget og usimulert her.
--
-- observation_type er BEVISST begrenset til to typer som BEGGE er trygt
-- avledbare fra data som ALLEREDE finnes UTEN noe tidsvindu-behov (unngår
-- "sammenlign livstids-kampanje A mot 7-dagers-kampanje B"-fellen, siden
-- `campaignPerformance()` er livstids-only) - se GrowthService for full
-- avledningslogikk. En FREMTIDIG trend-/tidsvindu-basert observasjonstype
-- er eksplisitt IKKE bygget her (krever ekte tidsseriedata som ikke finnes
-- ennå), se D-89 i DECISIONS_AND_ASSUMPTIONS.md.
CREATE TABLE marketing_campaign_observations (
  observation_id          text PRIMARY KEY,
  tenant_id                text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id          text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  campaign_id              text NOT NULL REFERENCES marketing_campaigns (campaign_id),
  observation_type         text NOT NULL CHECK (observation_type IN ('meetings_without_conversion', 'recommendation_disposition_summary')),
  -- Q-26-grensen: BEVISST kun 'deterministic' mulig (samme strenge mønster
  -- som marketing_campaign_action_recommendations.source, D-85) - ingen
  -- fremtidig AI-utvidelsesplass antydet her, i motsetning til
  -- business_open_loops/business_scores sine 'ai_assisted'-plassholdere.
  detection_method          text NOT NULL DEFAULT 'deterministic' CHECK (detection_method = 'deterministic'),
  -- BEVISST INGEN 'verified'-verdi - en observasjon er ALDRI "bekreftet
  -- sannhet", kun tilstede ('open') eller ikke lenger gjeldende ('resolved').
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  -- Kort, menneskelesbar oppsummering (norsk, brukervendt tekst) - ALDRI
  -- kausalt språk ("forårsaket"/"genererte"), kun beskrivende ("har",
  -- "mangler", "ble generert").
  summary                   text NOT NULL,
  -- Strukturerte evidens-pekere (kampanje-/anbefaling-/kommando-/
  -- attribusjon-ID-er + de faktiske tallene observasjonen er avledet fra)
  -- - ALDRI kopiert kildeinnhold, samme pointer-not-payload-prinsipp som
  -- business_scores.evidence/business_activities.canonical_uri.
  evidence                  jsonb NOT NULL,
  observed_at               timestamptz NOT NULL DEFAULT now(),
  resolved_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- Idempotent regenerering (samme mønster som business_scores/business_
  -- open_loops): re-kjøring for SAMME (kampanje, observasjonstype)
  -- oppdaterer SAMME rad, oppretter aldri en duplikat.
  UNIQUE (tenant_id, campaign_id, observation_type)
);
CREATE INDEX marketing_campaign_observations_lookup_idx ON marketing_campaign_observations (tenant_id, memory_space_id, campaign_id, status);

GRANT SELECT, INSERT, UPDATE ON marketing_campaign_observations TO jarvis_app;
-- Q-20: samme kundedata-klassifisering som øvrige marketing_*-tabeller
-- (ikke append-only systemrevisjon) - registrert i modules/erasure/src/plan.ts.
GRANT DELETE ON marketing_campaign_observations TO jarvis_app;

ALTER TABLE marketing_campaign_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaign_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_campaign_observations_tenant ON marketing_campaign_observations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY marketing_campaign_observations_space ON marketing_campaign_observations AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Ny hendelsestype for vekst-tidslinjen (marketing_campaign_events,
-- 027_growth.sql) - en generert/oppdatert observasjon er en reell,
-- auditerbar kampanje-analysehendelse, samme prinsipp som 'tracking_tag_registered'.
ALTER TABLE marketing_campaign_events DROP CONSTRAINT marketing_campaign_events_event_type_check;
ALTER TABLE marketing_campaign_events ADD CONSTRAINT marketing_campaign_events_event_type_check CHECK (event_type IN (
  'campaign_created', 'status_changed', 'spend_recorded', 'budget_changed', 'attribution_created',
  'experiment_created', 'experiment_status_changed', 'tracking_tag_registered',
  'action_recommendation_created', 'action_recommendation_resolved',
  'execution_command_generated', 'execution_command_cancelled',
  'marketing_observation_generated'
));
