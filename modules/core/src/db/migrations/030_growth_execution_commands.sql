-- UA-4 Growth & Marketing Control Plane - provider-neutral CAMPAIGN EXECUTION
-- COMMAND MODEL (D-87). This is the missing structural link between the
-- BESLUTNINGS-lag ("hva BØR gjøres", D-85 `marketing_campaign_action_
-- recommendations`) and en FREMTIDIG UTFØRELSES-lag ("gjør det MOT en
-- leverandør") - denne migrasjonen legger INGEN utførelseskapabilitet til.
-- Et "command" er en deterministisk, provider-nøytral OVERSETTELSE av en
-- ALLEREDE eier-godkjent (`status='accepted'`) anbefaling til de EKSAKTE
-- parametrene en fremtidig utførelseskapabilitet ville trengt (f.eks.
-- "reduser budsjett fra X til Y øre") - beregnet og lagret NÅ, slik at en
-- fremtidig utfører (etter UA-6 Finance Integrity Gateway + en fremtidig
-- provider-mutate-kapabilitet, INGEN av delene bygget) IKKE trenger å
-- re-utlede beslutningen, men ALDRI slik at noe i DENNE kodebasen faktisk
-- utfører den.
--
-- STRUKTURELL Finance Integrity-håndhevelse (ikke bare en kode-konvensjon):
-- `status`-CHECK-constrainten under inneholder BEVISST INGEN 'executed'-
-- verdi. Det er derfor UMULIG - selv ved en fremtidig kodefeil i DENNE
-- migrasjonens levetid - for noen kode noensinne å markere et command som
-- utført; databasen selv nekter det. En fremtidig utførelses-slice MÅ kjøre
-- sin EGEN migrasjon (DROP/ADD CONSTRAINT, samme mønster som
-- `029_growth_action_recommendations.sql` sin utvidelse av
-- `marketing_campaign_events`) for eksplisitt å legge til den kapabiliteten -
-- den kan ALDRI "snike seg inn" via denne tabellen slik den står.
--
-- `command_type` er BEVISST begrenset til KUN 'reduce_budget' i denne runden
-- - det ENESTE `recommendation_type` (D-85: 'reduce_budget'|'investigate')
-- som har en entydig, deterministisk beregnbar provider-parameter
-- (et nytt budsjettbeløp). 'investigate' har INGEN direkte utførbar
-- provider-handling - genererer aldri et command (håndhevet i
-- `modules/growth/src/service.ts`, ikke bare her).
CREATE TABLE marketing_campaign_execution_commands (
  command_id              text PRIMARY KEY,
  tenant_id                text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id          text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  campaign_id              text NOT NULL REFERENCES marketing_campaigns (campaign_id),
  -- KREVES (ikke nullable) - et command eksisterer ALDRI uten en eier-
  -- godkjent anbefaling som sin eneste opprinnelse (ingen "fri" kommando-
  -- opprettelse noe sted i service-laget).
  recommendation_id        text NOT NULL REFERENCES marketing_campaign_action_recommendations (recommendation_id),
  command_type             text NOT NULL CHECK (command_type = 'reduce_budget'),
  current_budget_ore       bigint NOT NULL CHECK (current_budget_ore >= 0),
  proposed_budget_ore      bigint NOT NULL CHECK (proposed_budget_ore >= 0 AND proposed_budget_ore < current_budget_ore),
  reduction_fraction       numeric NOT NULL CHECK (reduction_fraction > 0 AND reduction_fraction < 1),
  currency                 text NOT NULL DEFAULT 'NOK',
  -- BEVISST INGEN 'executed' her - se toppkommentaren.
  status                   text NOT NULL DEFAULT 'pending_execution' CHECK (status IN ('pending_execution','cancelled','superseded')),
  cancelled_at             timestamptz,
  cancelled_by_person_id   text REFERENCES people (person_id),
  cancellation_reason      text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- ÉTT aktivt command per anbefaling samtidig - SAMME idempotens-prinsipp
  -- som `marketing_campaign_action_recommendations (tenant_id, detection_key)`.
  UNIQUE (tenant_id, recommendation_id)
);
CREATE INDEX marketing_campaign_execution_commands_campaign_idx ON marketing_campaign_execution_commands (tenant_id, campaign_id);
CREATE INDEX marketing_campaign_execution_commands_status_idx ON marketing_campaign_execution_commands (tenant_id, status);

GRANT SELECT, INSERT, UPDATE ON marketing_campaign_execution_commands TO jarvis_app;
-- Q-20: samme kundedata-klassifisering som de øvrige marketing_campaign_*-
-- tabellene (ikke append-only systemrevisjon) - registrert i
-- modules/erasure/src/plan.ts.
GRANT DELETE ON marketing_campaign_execution_commands TO jarvis_app;

ALTER TABLE marketing_campaign_execution_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaign_execution_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_campaign_execution_commands_tenant ON marketing_campaign_execution_commands
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY marketing_campaign_execution_commands_space ON marketing_campaign_execution_commands AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Ny hendelsestype for vekst-tidslinjen (marketing_campaign_events,
-- 027_growth.sql/029_growth_action_recommendations.sql) - et generert/
-- kansellert command er en reell, auditerbar kampanjehendelse, samme
-- prinsipp som 'action_recommendation_created'/'_resolved' (D-85).
ALTER TABLE marketing_campaign_events DROP CONSTRAINT marketing_campaign_events_event_type_check;
ALTER TABLE marketing_campaign_events ADD CONSTRAINT marketing_campaign_events_event_type_check CHECK (event_type IN (
  'campaign_created', 'status_changed', 'spend_recorded', 'budget_changed', 'attribution_created',
  'experiment_created', 'experiment_status_changed', 'tracking_tag_registered',
  'action_recommendation_created', 'action_recommendation_resolved',
  'execution_command_generated', 'execution_command_cancelled'
));
