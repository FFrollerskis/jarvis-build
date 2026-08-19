-- UA-4 Growth & Marketing Control Plane - Deterministisk UTM-/klikk-ID-basert
-- auto-attribusjon (D-82). Lukker Q-29 punkt (6) og innfrir kommentaren i
-- 027_growth.sql sin `marketing_attributions.attribution_model`-kolonne
-- ("se OPEN_QUESTIONS.md for fremtidig deterministisk UTM-basert
-- auto-matching"). D-64-gate kjørt FØRST (se D-82 i
-- DECISIONS_AND_ASSUMPTIONS.md): denne kapabiliteten er RENT
-- JARVIS_CANONICAL - matchingen er applikasjonslaget sin egen deterministiske
-- oppslagslogikk mot Jarvis sine EGNE registrerte kampanje-sporingstagger,
-- INGEN ekstern annonseplattform-avhengighet innføres her (ZERO
-- Google Ads/Meta Ads/GA4/etc-credential/tabell, EKSAKT samme prinsipp som
-- 027_growth.sql sin egen ZERO-leverandør-erklæring).
--
-- Deterministisk, ALDRI AI-gjettet (Q-26-grensen): en tagg matcher EKSAKT
-- eller matcher IKKE - ingen fuzzy/sannsynlighetsbasert matching. To
-- uavhengige, gjensidig utelukkende taggtyper:
--   'click_id' - ett enkelt, entydig sporingsparameter (gclid/fbclid/msclkid)
--     med én verdi - den sterkeste signaltypen (én klikk-ID peker praktisk
--     talt alltid til NØYAKTIG én kampanje hos avsenderplattformen selv).
--   'utm'      - den klassiske (utm_source, utm_medium, utm_campaign)-
--     tripletten (RFC-løs, men bransjestandard) - alle tre kreves sammen,
--     ALDRI et delvis/enkeltfelt-matchende oppslag (unngår falske positiver
--     fra f.eks. "utm_source=google" alene, som er altfor grovt).
--
-- Partial UNIQUE-indekser (ikke en enkelt sammensatt UNIQUE-kolonne, siden
-- feltene som brukes avhenger av tag_type): sikrer BÅDE idempotent
-- registrering (samme tagg registrert på nytt oppdaterer samme rad via
-- ON CONFLICT, oppretter aldri en duplikat) OG at én tagg-verdi ALDRI kan
-- peke til to forskjellige kampanjer samtidig (strukturelt umulig
-- tvetydig match, håndhevet av databasen selv - ikke bare applikasjonskoden).
CREATE TABLE marketing_campaign_tracking_tags (
  tag_id                 text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  campaign_id            text NOT NULL REFERENCES marketing_campaigns (campaign_id),
  tag_type                text NOT NULL CHECK (tag_type IN ('click_id','utm')),
  click_id_param          text CHECK (click_id_param IN ('gclid','fbclid','msclkid')),
  click_id_value          text,
  utm_source              text,
  utm_medium              text,
  utm_campaign             text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- Håndhever gjensidig eksklusivitet i databasen selv - en rad kan ALDRI
  -- være halvveis begge taggtyper, uansett hva applikasjonslaget sender inn.
  CHECK (
    (tag_type = 'click_id' AND click_id_param IS NOT NULL AND click_id_value IS NOT NULL AND utm_source IS NULL AND utm_medium IS NULL AND utm_campaign IS NULL)
    OR
    (tag_type = 'utm' AND utm_source IS NOT NULL AND utm_medium IS NOT NULL AND utm_campaign IS NOT NULL AND click_id_param IS NULL AND click_id_value IS NULL)
  )
);
CREATE UNIQUE INDEX marketing_tracking_tags_click_id_uidx ON marketing_campaign_tracking_tags (tenant_id, click_id_param, click_id_value) WHERE tag_type = 'click_id';
CREATE UNIQUE INDEX marketing_tracking_tags_utm_uidx ON marketing_campaign_tracking_tags (tenant_id, utm_source, utm_medium, utm_campaign) WHERE tag_type = 'utm';
CREATE INDEX marketing_tracking_tags_campaign_idx ON marketing_campaign_tracking_tags (tenant_id, campaign_id);

GRANT SELECT, INSERT, UPDATE ON marketing_campaign_tracking_tags TO jarvis_app;
-- Q-20: samme kundedata-klassifisering som marketing_attributions (ikke
-- append-only systemrevisjon) - registrert i modules/erasure/src/plan.ts.
GRANT DELETE ON marketing_campaign_tracking_tags TO jarvis_app;

ALTER TABLE marketing_campaign_tracking_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaign_tracking_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_campaign_tracking_tags_tenant ON marketing_campaign_tracking_tags
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY marketing_campaign_tracking_tags_space ON marketing_campaign_tracking_tags AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Ny hendelsestype for vekst-tidslinjen (marketing_campaign_events,
-- 027_growth.sql) - en registrert sporingstagg er en reell, auditerbar
-- kampanjekonfigurasjons-hendelse, samme prinsipp som 'budget_changed'.
ALTER TABLE marketing_campaign_events DROP CONSTRAINT marketing_campaign_events_event_type_check;
ALTER TABLE marketing_campaign_events ADD CONSTRAINT marketing_campaign_events_event_type_check CHECK (event_type IN (
  'campaign_created', 'status_changed', 'spend_recorded', 'budget_changed', 'attribution_created',
  'experiment_created', 'experiment_status_changed', 'tracking_tag_registered'
));
