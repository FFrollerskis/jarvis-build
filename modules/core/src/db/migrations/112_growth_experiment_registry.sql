-- WP-D3 (UA-4 Growth, D-459, mandat D-450/D-470): EKSPERIMENTREGISTER v2 - plan (hypotese-/metrikk-/tidsvindu-rammen), varianter og observasjoner.
-- Additiv migrasjon PÅ vekst-skjemaet (027_growth.sql) - ingen eksisterende kolonne endres. `marketing_experiments` (navn, hypotese, status, resultat) er uendret og
-- forblir eksperimentets identitet; denne migrasjonen legger til det masterplanen krever av et eksperimentregister: HYPOTESE (finnes), VARIANT, TIDSVINDU, METRIKK, (UTFALL i 113).
--
-- D-64/D-74: Jarvis EIER eksperimentregisteret (`JARVIS_CANONICAL`). Plattformene (Google Ads, Meta Ads ...) er kilder til observasjonstall og sluk for handlinger -
-- en variant peker kun på plattformressursen (`external_ref`, pointer-not-payload), aldri omvendt. Alt her er deterministisk: ingen modell skriver, tolker eller
-- avgjør noe (Q-26-grensen); statistikken er rene funksjoner i `modules/growth/src/experiments/stats.ts`.
--
-- Hver rad er MERKET (CLAUDE.md regel 4): tenant + memory space + kilde (`source`) + aktør (`actor_person_id`, ingen FK: en systemaktør er gyldig) + `task_id`/`session_id`.
-- Alle FK-er mot tenant-eide tabeller er KOMPOSITTNØKLER (tenant_id, id) (JARVIS-076/Q-44): en variant/observasjon kan aldri peke på en annen tenants rad.
-- Alle tabeller er FORCE RLS med tenant- OG memory-space-policy (samme mønster som resten av vekstdomenet). KUNDEDATA (ikke append-only systemrevisjon):
-- `jarvis_app` får DELETE for Q-20-erasure (modules/erasure/src/plan.ts).

-- Forelder for komposittnøkler (uten denne kan ingen barnetabell referere eksperimentet med (tenant_id, experiment_id)).
ALTER TABLE marketing_experiments ADD CONSTRAINT marketing_experiments_experiment_id_tenant_key UNIQUE (tenant_id, experiment_id);

-- Plan: ÉN per eksperiment. Hypotesen står på `marketing_experiments.hypothesis`; planen legger til HVA som måles, i HVILKET tidsvindu og med hvilke terskler.
CREATE TABLE marketing_experiment_plans (
  plan_id                      text PRIMARY KEY,
  tenant_id                    text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id              text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  experiment_id                text NOT NULL,
  -- Metrikkene registeret kan teste deterministisk (stats.ts): ctr = klikk/visninger, cvr = konverteringer/klikk, cpc = utgift/klikk, cpa = utgift/konvertering, roas = omsetning/utgift.
  primary_metric               text NOT NULL CHECK (primary_metric IN ('ctr', 'cvr', 'cpc', 'cpa', 'roas')),
  metric_direction             text NOT NULL CHECK (metric_direction IN ('higher_is_better', 'lower_is_better')),
  window_start                 date NOT NULL,
  window_end                   date NOT NULL,
  -- Terskler for «nok data»: under dem er utfallet aldri en vinner (`inconclusive`), uansett p-verdi.
  min_impressions_per_variant  bigint NOT NULL DEFAULT 1000 CHECK (min_impressions_per_variant >= 0),
  min_conversions_per_variant  bigint NOT NULL DEFAULT 0 CHECK (min_conversions_per_variant >= 0),
  confidence_level             numeric(5,4) NOT NULL DEFAULT 0.9500 CHECK (confidence_level >= 0.8000 AND confidence_level <= 0.9990),
  -- Praktisk signifikans: en statistisk sikker, men bitteliten forskjell (under terskelen, i prosent av kontrollen) er ikke en vinner.
  min_effect_pct               numeric(7,3) NOT NULL DEFAULT 5 CHECK (min_effect_pct >= 0 AND min_effect_pct <= 1000),
  -- Proveniens (regel 4).
  source                       text NOT NULL CHECK (source IN ('owner', 'jarvis_rule', 'import', 'system')),
  actor_person_id              text,
  task_id                      text,
  session_id                   text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_experiment_plans_window_order CHECK (window_end >= window_start),
  -- Retningen er en funksjon av metrikken (ikke et fritt valg som kan snus stille): høyere er bedre for ctr/cvr/roas, lavere for cpc/cpa.
  CONSTRAINT marketing_experiment_plans_direction_matches_metric CHECK (
    (primary_metric IN ('ctr', 'cvr', 'roas') AND metric_direction = 'higher_is_better')
    OR (primary_metric IN ('cpc', 'cpa') AND metric_direction = 'lower_is_better')
  ),
  UNIQUE (tenant_id, experiment_id),
  FOREIGN KEY (tenant_id, experiment_id) REFERENCES marketing_experiments (tenant_id, experiment_id)
);

CREATE TABLE marketing_experiment_variants (
  variant_id        text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  experiment_id     text NOT NULL,
  -- Stabil, menneskelesbar nøkkel per eksperiment ('control', 'b', 'headline-2' ...): brukes i rapporter og CSV-import, aldri en intern id.
  variant_key       text NOT NULL CHECK (variant_key ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  label             text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  variant_kind      text NOT NULL CHECK (variant_kind IN ('creative', 'keyword', 'bid', 'budget', 'audience', 'landing_page', 'other')),
  is_control        boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'live', 'paused', 'retired')),
  campaign_id       text,
  channel           text CHECK (channel IS NULL OR channel IN ('google_ads', 'meta_ads', 'ga4', 'search_console', 'google_business_profile', 'linkedin', 'youtube', 'tiktok', 'other')),
  -- Pointer-not-payload: peker til plattformressursen (annonse-id, nøkkelord-id ...), aldri kopiert plattforminnhold. Ikke en hemmelighet.
  external_ref      text CHECK (external_ref IS NULL OR char_length(external_ref) BETWEEN 1 AND 300),
  -- Kreativ-innholdet registeret sammenligner (overskrifter/beskrivelser/handlingsoppfordring). Størrelsen begrenses i applikasjonslaget (zod, 8 KB); kun et objekt.
  creative          jsonb CHECK (creative IS NULL OR jsonb_typeof(creative) = 'object'),
  source            text NOT NULL CHECK (source IN ('owner', 'jarvis_rule', 'import', 'system')),
  actor_person_id   text,
  task_id           text,
  session_id        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, experiment_id, variant_key),
  -- Mål for observasjonenes/utfallenes komposittnøkkel: en observasjon kan bare peke på en variant som hører til DET eksperimentet.
  UNIQUE (tenant_id, experiment_id, variant_id),
  FOREIGN KEY (tenant_id, experiment_id) REFERENCES marketing_experiments (tenant_id, experiment_id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES marketing_campaigns (tenant_id, campaign_id)
);
-- Høyst ÉN kontroll per eksperiment (ellers er «uplift mot kontroll» tvetydig).
CREATE UNIQUE INDEX marketing_experiment_variants_one_control_idx ON marketing_experiment_variants (tenant_id, experiment_id) WHERE is_control;
CREATE INDEX marketing_experiment_variants_lookup_idx ON marketing_experiment_variants (tenant_id, memory_space_id, experiment_id);

CREATE TABLE marketing_experiment_observations (
  observation_id    text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  experiment_id     text NOT NULL,
  variant_id        text NOT NULL,
  observed_on       date NOT NULL,
  impressions       bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks            bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  conversions       bigint NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  spend_ore         bigint NOT NULL DEFAULT 0 CHECK (spend_ore >= 0),
  revenue_ore       bigint NOT NULL DEFAULT 0 CHECK (revenue_ore >= 0),
  -- `derived_from_campaign` = utledet av Jarvis' EGNE rader (utgifts-/attribusjonstabellene) for en kampanje-variant - ingen nytt eksternt kall.
  source_type       text NOT NULL CHECK (source_type IN ('manual', 'csv_import', 'provider_sync', 'derived_from_campaign')),
  source_pointer    text CHECK (source_pointer IS NULL OR char_length(source_pointer) <= 300),
  source            text NOT NULL CHECK (source IN ('owner', 'jarvis_rule', 'import', 'system')),
  actor_person_id   text,
  task_id           text,
  session_id        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Idempotent innlasting (samme mønster som marketing_spend_events): samme (variant, dag, kildetype) oppdaterer SAMME rad, aldri en duplikat.
  UNIQUE (tenant_id, variant_id, observed_on, source_type),
  FOREIGN KEY (tenant_id, experiment_id, variant_id) REFERENCES marketing_experiment_variants (tenant_id, experiment_id, variant_id)
);
CREATE INDEX marketing_experiment_observations_lookup_idx ON marketing_experiment_observations (tenant_id, memory_space_id, experiment_id, observed_on DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_experiment_plans, marketing_experiment_variants, marketing_experiment_observations TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_experiment_plans', 'marketing_experiment_variants', 'marketing_experiment_observations'] LOOP
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

-- Vekst-tidslinjen (`marketing_campaign_events`) får typene registeret og skrive-sporet trenger. Tidslinjen er vekstdomenets EGEN historikk (ikke `audit_events`).
ALTER TABLE marketing_campaign_events DROP CONSTRAINT marketing_campaign_events_event_type_check;
ALTER TABLE marketing_campaign_events ADD CONSTRAINT marketing_campaign_events_event_type_check CHECK (event_type IN (
  'campaign_created', 'status_changed', 'spend_recorded', 'budget_changed', 'attribution_created',
  'experiment_created', 'experiment_status_changed', 'tracking_tag_registered',
  'action_recommendation_created', 'action_recommendation_resolved',
  'execution_command_generated', 'execution_command_cancelled',
  'marketing_observation_generated',
  -- WP-D3 (D-459): eksperimentregister og plattform-skrivinger
  'experiment_variant_added', 'experiment_outcome_recorded',
  'provider_write_applied', 'provider_write_unknown', 'provider_write_failed', 'execution_command_executed', 'execution_command_unknown'
));
