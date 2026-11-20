-- WP-D3 (UA-4 Growth, D-459): (1) eksperimentets UTFALL (append-only beslutning) og (2) plattform-SKRIVEJOURNALEN (`growth_write_journal`).
--
-- (1) `marketing_experiment_outcomes`: det registrerte utfallet av et eksperiment (vinner / ingen vinner / ikke avgjort / forlatt) med den deterministiske evalueringen
-- (`evidence`, sha256-digest) som grunnlag. Append-only for runtime-rollen (kun SELECT/INSERT; ingen UPDATE) - et utfall omgjøres ved å registrere et NYTT utfall, aldri ved å
-- skrive om et gammelt. DELETE er gitt KUN for Q-20-erasure.
--
-- (2) `growth_write_journal`: Jarvis' EGEN, domenenære journal over hver skriving mot en annonse-/analyseplattform (D-64: plattformen er sluket, journalen er Jarvis'). Den fyller det
-- ToolGateway-ledgeren (`tool_executions`, nøklet på idempotensnøkkelen ALENE) ikke dekker i vekstdomenet:
--   * `request_digest` (sha256 av de kanoniserte parameterne): samme nøkkel med ANNEN nyttelast AVVISES (samme prinsipp som `business_change_log.request_hash`), aldri «det lagrede resultatet»;
--   * før-/etter-tilstand (redigert, begrenset) knyttet til kampanje/eksperiment/variant/kommando, slik at «hva endret vi på plattformen, hvorfor og med hvilket utfall» er ett oppslag;
--   * `outcome_unknown` er en førsteklasses status (UTFALL UKJENT etter en akseptert mutasjon): raden blir stående til en avstemming har satt `applied`/`failed` - en ny skriving med SAMME nøkkel utføres aldri.
-- Kjerne-kolonnene (leverandør, handling, mål, nøkkel, digest, aktør) er UFORANDERLIGE (trigger), og statusen kan bare gå requested -> applied|failed|outcome_unknown og
-- outcome_unknown -> applied|failed. Ingen hemmeligheter lagres noe sted her (kun redigerte før-/etter-tilstander og trygge feilkoder).
-- Hver rad er MERKET (regel 4): tenant + memory space + kilde + aktør + task_id/session_id/trace_id. Komposittnøkkel mot kampanjen; kommando-/eksperiment-/variant-pekerne er LØSE
-- pekere (som `marketing_campaign_observations.evidence`): en skriving skal aldri blokkere en erasure av et eksperiment, og erasure-rekkefølgen holdes enkel (ingen FK-sykler).

CREATE TABLE marketing_experiment_outcomes (
  outcome_id           text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  experiment_id        text NOT NULL,
  verdict              text NOT NULL CHECK (verdict IN ('winner', 'no_winner', 'inconclusive', 'abandoned')),
  winner_variant_id    text,
  primary_metric       text NOT NULL CHECK (primary_metric IN ('ctr', 'cvr', 'cpc', 'cpa', 'roas')),
  -- Relativ forskjell mot kontroll i prosent (positiv = bedre i metrikkens retning) og sannsynlighet for at vinneren er best; NULL når ikke beregnet.
  effect_pct           numeric(12,4),
  probability_best     numeric(7,6) CHECK (probability_best IS NULL OR (probability_best >= 0 AND probability_best <= 1)),
  -- Evalueringen utfallet bygger på (deterministisk, avgrenset) og dens sha256: samme evaluering registrert to ganger gir samme rad (idempotent), ikke to.
  evidence             jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evaluation_digest    text NOT NULL CHECK (evaluation_digest ~ '^[0-9a-f]{64}$'),
  decided_by           text NOT NULL CHECK (decided_by IN ('owner', 'rule')),
  rationale            text CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 1000),
  source               text NOT NULL CHECK (source IN ('owner', 'jarvis_rule', 'import', 'system')),
  actor_person_id      text,
  task_id              text,
  session_id           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_experiment_outcomes_winner_iff_verdict CHECK ((verdict = 'winner') = (winner_variant_id IS NOT NULL)),
  UNIQUE (tenant_id, experiment_id, evaluation_digest, decided_by),
  FOREIGN KEY (tenant_id, experiment_id) REFERENCES marketing_experiments (tenant_id, experiment_id),
  FOREIGN KEY (tenant_id, experiment_id, winner_variant_id) REFERENCES marketing_experiment_variants (tenant_id, experiment_id, variant_id)
);
CREATE INDEX marketing_experiment_outcomes_lookup_idx ON marketing_experiment_outcomes (tenant_id, memory_space_id, experiment_id, created_at DESC);

-- Mål for en eventuell fremtidig komposittnøkkel mot kommandoene (loss pointer brukes nå, men unik (tenant_id, command_id) trengs i 114 for `execution_write_id`-bindingen).
ALTER TABLE marketing_campaign_execution_commands ADD CONSTRAINT marketing_campaign_execution_commands_command_id_tenant_key UNIQUE (tenant_id, command_id);

CREATE TABLE growth_write_journal (
  write_id          text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  provider          text NOT NULL CHECK (provider IN ('google_ads', 'meta_ads', 'ga4', 'search_console', 'google_business_profile', 'linkedin', 'youtube', 'tiktok')),
  action            text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  risk_class        text NOT NULL CHECK (risk_class IN ('B', 'C', 'D')),
  -- Pengeeffekt for avstemming (IKKE en beløpsgrense): none | reduces | increases | starts | structural | unknown.
  spend_effect      text NOT NULL CHECK (spend_effect IN ('none', 'reduces', 'increases', 'starts', 'structural', 'unknown')),
  -- MÅLET (eierens egen konto/eiendom/lokasjon) og ressursen som ble endret - pekere, aldri innhold.
  target_ref        text NOT NULL CHECK (char_length(target_ref) BETWEEN 1 AND 200),
  resource_ref      text CHECK (resource_ref IS NULL OR char_length(resource_ref) BETWEEN 1 AND 300),
  campaign_id       text,
  experiment_id     text,
  variant_id        text,
  command_id        text,
  idempotency_key   text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_digest    text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  status            text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'applied', 'failed', 'outcome_unknown')),
  -- Trygg, kort feilkode (aldri leverandørtekst): `preflight_invalid:<kode>`, `tool_failed:<kode>`, `outcome_unknown:<kode>` ...
  failure_code      text CHECK (failure_code IS NULL OR char_length(failure_code) <= 160),
  before_state      jsonb,
  after_state       jsonb,
  external_id       text CHECK (external_id IS NULL OR char_length(external_id) <= 300),
  actor_person_id   text NOT NULL,
  source            text NOT NULL CHECK (source IN ('owner_route', 'script', 'system')),
  task_id           text,
  session_id        text,
  trace_id          text,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_write_journal_applied_has_completion CHECK (status = 'requested' OR completed_at IS NOT NULL OR status = 'outcome_unknown'),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, write_id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES marketing_campaigns (tenant_id, campaign_id)
);
CREATE INDEX growth_write_journal_campaign_idx ON growth_write_journal (tenant_id, memory_space_id, campaign_id, requested_at DESC);
CREATE INDEX growth_write_journal_status_idx ON growth_write_journal (tenant_id, status, requested_at DESC);

-- Uforanderlighet + lovlige statusoverganger (deterministisk, i databasen): journalen kan ikke omskrives etterpå.
CREATE FUNCTION growth_write_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.write_id IS DISTINCT FROM OLD.write_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.memory_space_id IS DISTINCT FROM OLD.memory_space_id
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.action IS DISTINCT FROM OLD.action OR NEW.risk_class IS DISTINCT FROM OLD.risk_class
     OR NEW.spend_effect IS DISTINCT FROM OLD.spend_effect OR NEW.target_ref IS DISTINCT FROM OLD.target_ref OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.actor_person_id IS DISTINCT FROM OLD.actor_person_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.experiment_id IS DISTINCT FROM OLD.experiment_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id THEN
    RAISE EXCEPTION 'growth_write_journal_immutable_column' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'requested' AND NEW.status NOT IN ('requested', 'applied', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'growth_write_journal_invalid_transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'outcome_unknown' AND NEW.status NOT IN ('outcome_unknown', 'applied', 'failed') THEN
    RAISE EXCEPTION 'growth_write_journal_invalid_transition' USING ERRCODE = '23514';
  END IF;
  -- Terminale statuser (applied/failed) endres aldri igjen.
  IF OLD.status IN ('applied', 'failed') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.before_state IS DISTINCT FROM OLD.before_state OR NEW.after_state IS DISTINCT FROM OLD.after_state
     OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.external_id IS DISTINCT FROM OLD.external_id) THEN
    RAISE EXCEPTION 'growth_write_journal_terminal_status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER growth_write_journal_guard BEFORE UPDATE ON growth_write_journal FOR EACH ROW EXECUTE FUNCTION growth_write_journal_guard();

-- Utfall: kun SELECT/INSERT (ingen UPDATE) + DELETE for Q-20-erasure. Journal: SELECT/INSERT/UPDATE (statusoverganger, vokter over) + DELETE for erasure.
GRANT SELECT, INSERT, DELETE ON marketing_experiment_outcomes TO jarvis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON growth_write_journal TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_experiment_outcomes', 'growth_write_journal'] LOOP
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
