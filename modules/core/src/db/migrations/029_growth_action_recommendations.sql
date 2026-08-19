-- UA-4 Growth & Marketing Control Plane - "Anomaly -> recommended-action"
-- control-plane-fundament (D-85). Lukker den delen av Q-29 punkt (2) som er
-- kodbar UTEN en live annonseplattform-forbindelse: BESLUTNINGS-laget
-- ("hva BØR gjøres") atskilt fra UTFØRELSES-laget ("gjør det MOT en
-- leverandør"), som forblir låst bak Finance Integrity-grensen (UA-6, ikke
-- bygget) og en fremtidig provider-mutate-kapabilitet (D-41, ikke bygget for
-- Google Ads i denne omgang). D-64-gate: RENT JARVIS_CANONICAL - denne
-- tabellen refererer INGEN ekstern leverandør, ZERO credential/API-endepunkt,
-- `CORE_DEPENDENCY_DECISION_REQUIRED=false`.
--
-- `status`-verdien 'accepted' representerer KUN Jarvis sin EGEN interne
-- disposisjon-sporing (eieren har sett og godkjent anbefalingen) - den
-- utfører ALDRI noe mot en ekte annonseplattform. Ekte utførelse krever en
-- SEPARAT, fremtidig kapabilitet (provider-mutate + UA-6), eksplisitt utenfor
-- denne sliceens omfang.
--
-- `source` er BEVISST en enkelt, hardkodet CHECK-verdi ('deterministic_rule')
-- i DENNE runden - ZERO ModelGateway-kall her (Q-26-grensen: en anbefaling
-- generert av ren SQL/statistikk er et deterministisk FAKTUM, ikke en
-- AI-inferens, og skal ALDRI forveksles med én). En fremtidig AI-generert
-- anbefaling ville kreve en egen CHECK-verdi (f.eks. 'ai_inference') OG
-- eksplisitt OBSERVATION/INFERENCE/PROVISIONAL/VERIFIED-merking - IKKE lagt
-- til her fordi INGEN slik generator finnes ennå (ingen ubrukt enum-verdi).
CREATE TABLE marketing_campaign_action_recommendations (
  recommendation_id       text PRIMARY KEY,
  tenant_id                text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id          text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  campaign_id               text NOT NULL REFERENCES marketing_campaigns (campaign_id),
  open_loop_id              text REFERENCES business_open_loops (open_loop_id),
  recommendation_type       text NOT NULL CHECK (recommendation_type IN ('reduce_budget','investigate')),
  status                    text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','dismissed','superseded')),
  rationale                 text NOT NULL,
  evidence                  jsonb NOT NULL,
  source                    text NOT NULL DEFAULT 'deterministic_rule' CHECK (source = 'deterministic_rule'),
  detection_key             text NOT NULL,
  resolved_at                timestamptz,
  resolved_by_person_id       text REFERENCES people (person_id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- SAMME idempotens-mønster som `business_open_loops` sin egen
  -- `(tenant_id, detection_key)`-nøkkel: ÉN aktiv anbefaling per
  -- kampanje+regel-type samtidig, ny deteksjon av SAMME vilkår oppdaterer
  -- den samme raden i stedet for å hope opp duplikater.
  UNIQUE (tenant_id, detection_key)
);
CREATE INDEX marketing_campaign_action_recommendations_campaign_idx ON marketing_campaign_action_recommendations (tenant_id, campaign_id);
CREATE INDEX marketing_campaign_action_recommendations_status_idx ON marketing_campaign_action_recommendations (tenant_id, status);

GRANT SELECT, INSERT, UPDATE ON marketing_campaign_action_recommendations TO jarvis_app;
-- Q-20: samme kundedata-klassifisering som marketing_campaign_tracking_tags
-- (ikke append-only systemrevisjon) - registrert i modules/erasure/src/plan.ts.
GRANT DELETE ON marketing_campaign_action_recommendations TO jarvis_app;

ALTER TABLE marketing_campaign_action_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaign_action_recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_campaign_action_recommendations_tenant ON marketing_campaign_action_recommendations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY marketing_campaign_action_recommendations_space ON marketing_campaign_action_recommendations AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Ny hendelsestype for vekst-tidslinjen (marketing_campaign_events,
-- 027_growth.sql) - en generert/løst anbefaling er en reell, auditerbar
-- kampanjehendelse, samme prinsipp som 'tracking_tag_registered' (D-82).
ALTER TABLE marketing_campaign_events DROP CONSTRAINT marketing_campaign_events_event_type_check;
ALTER TABLE marketing_campaign_events ADD CONSTRAINT marketing_campaign_events_event_type_check CHECK (event_type IN (
  'campaign_created', 'status_changed', 'spend_recorded', 'budget_changed', 'attribution_created',
  'experiment_created', 'experiment_status_changed', 'tracking_tag_registered',
  'action_recommendation_created', 'action_recommendation_resolved'
));
