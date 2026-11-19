-- WP-G2 (UA-8 Personal Twin, D-464) P1d: HELSE-INNTAK fra iPhone/Watch (selve appen er BLOCKED_EXTERNAL; dette er serversiden).
--
-- 1. LUKKET utvidelse av metrikksettet. Hver ny metrikk er verifisert mot Apples OFFISIELLE dokumentasjon (developer.apple.com/documentation/healthkit, hentet 2026-11-18) - identifikator, enhetsfamilie og
--    aggregeringsstil står i `METRIC_HEALTHKIT_SOURCE` (modules/health/src/types.ts). Alle nye størrelser er naturlig ikke-negative, så den eksisterende `value >= 0`-CHECK-en gjelder uendret.
-- 2. IDEMPOTENT inntak: `external_sample_id` (HealthKits `HKObject.uuid`) + en partiell unik indeks per (tenant, person, kilde, sample-id). Samme prøve på nytt endrer ingenting (`ON CONFLICT DO NOTHING`);
--    NULL (eksisterende rader og fake-kilden) er unntatt, så ingenting av det som finnes påvirkes.
-- Tabellen forblir append-only (ingen UPDATE-grant), FORCE RLS og `memory_space_id = 'health'`-CHECK er uendret. Ingen ny tabell, derfor ingen ny erasure-/inventarrad (`health_metric_observations` er dekket).

-- Metrikk-CHECK-en er inline og navnet er en PG-konvensjon: drop den uansett navn ved å finne den på definisjonen (en feilgjettet navn ville gitt en halvkjørt migrasjon).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'health_metric_observations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%metric_type%'
  LOOP
    EXECUTE format('ALTER TABLE health_metric_observations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

ALTER TABLE health_metric_observations
  ADD CONSTRAINT health_metric_observations_metric_type_check CHECK (metric_type IN (
    'heart_rate', 'steps', 'sleep_duration_minutes', 'weight_kg',
    'resting_heart_rate', 'heart_rate_variability_ms', 'oxygen_saturation_percent', 'respiratory_rate', 'active_energy_kcal', 'exercise_minutes'
  ));

ALTER TABLE health_metric_observations ADD COLUMN external_sample_id text;
ALTER TABLE health_metric_observations
  ADD CONSTRAINT health_metric_observations_external_sample_id_check CHECK (external_sample_id IS NULL OR char_length(external_sample_id) BETWEEN 8 AND 128);

CREATE UNIQUE INDEX health_metric_observations_external_sample_uidx
  ON health_metric_observations (tenant_id, person_id, source_type, external_sample_id) WHERE external_sample_id IS NOT NULL;
