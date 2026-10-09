-- WP-E1 (UA-5, JARVIS-068): SANNHETSTYPE-REGIME for hendelsesbevis og -diagnoser. Før dette kunne avsenderen selv sette `status = 'VERIFIED'` (via /incidents/evidence/add
-- og /incidents/diagnosis/create), så «VERIFIED» betydde «noen påsto det». Nå betyr VERIFIED at en DETERMINISTISK kontroll eller en uavhengig kilde har bekreftet det, og
-- grunnlaget lagres sammen med statusen (`verified_by` + `verification_basis` + `verified_at`). Håndheves både i tjenestekoden (modules/incidents/src/truth.ts) og HER,
-- så rå SQL fra app-rollen heller ikke kan omgå det.
--   UNVERIFIED  = påstått (eier, modell, ekstern tekst) - ingenting er kontrollert.
--   PROVISIONAL = observert av deterministisk kode fra en Jarvis-intern kilde (én måling) - sannsynlig, ikke bekreftet.
--   VERIFIED    = bekreftet av en deterministisk kontroll/uavhengig kilde, med lagret grunnlag.
--
-- Forward-safe: nye kolonner med trygge standarder. Eksisterende VERIFIED-rader som ikke kan bevises nedgraderes ærlig (se bakfyllet) - aldri en stille «gjenbruk» av en påstand.

ALTER TABLE incident_evidence ADD COLUMN asserted_by text NOT NULL DEFAULT 'owner' CHECK (asserted_by IN ('owner', 'producer', 'check', 'model'));
ALTER TABLE incident_evidence ADD COLUMN verified_by text
  CHECK (verified_by IS NULL OR verified_by IN ('correlation_deployment_match', 'source_recheck', 'independent_probe'));
ALTER TABLE incident_evidence ADD COLUMN verification_basis text CHECK (verification_basis IS NULL OR char_length(verification_basis) <= 300);
ALTER TABLE incident_evidence ADD COLUMN verified_at timestamptz;

-- Nye kilder for de deterministiske produsentene (watchdog-/leverandørhelse, bakgrunnsjobber, tjenestemål, journalførte infra-eksekusjoner). Sentry-funn bruker den eksisterende `application_error`.
ALTER TABLE incident_evidence DROP CONSTRAINT incident_evidence_source_type_check;
ALTER TABLE incident_evidence ADD CONSTRAINT incident_evidence_source_type_check
  CHECK (source_type IN ('uptime', 'application_error', 'deployment', 'commit', 'infra_change', 'database_state', 'log', 'manual', 'health_check', 'scheduler_job', 'slo_breach', 'infra_execution'));

-- BAKFYLL (a): deployment-bevis som peker på en faktisk deployments-rad i samme tenant er det den eksisterende korrelasjonen (correlation.ts) kunne forfremme - behold VERIFIED med grunnlag.
UPDATE incident_evidence e
   SET verified_by = 'correlation_deployment_match', verification_basis = left('backfill 097: deployments:' || e.source_ref, 300), verified_at = e.created_at
 WHERE e.status = 'VERIFIED' AND e.source_type = 'deployment' AND e.source_ref IS NOT NULL
   AND EXISTS (SELECT 1 FROM deployments d WHERE d.tenant_id = e.tenant_id AND d.deployment_id = e.source_ref);
-- BAKFYLL (b): alle andre VERIFIED-rader hadde ingen etterprøvbart grunnlag (selv-påstått) -> PROVISIONAL («sannsynlig, ikke bekreftet»).
UPDATE incident_evidence SET status = 'PROVISIONAL' WHERE status = 'VERIFIED' AND verified_by IS NULL;

ALTER TABLE incident_evidence ADD CONSTRAINT incident_evidence_verified_requires_basis
  CHECK (status <> 'VERIFIED' OR (verified_by IS NOT NULL AND verification_basis IS NOT NULL AND verified_at IS NOT NULL));
-- Bare VERIFIED-bevis bærer verifiseringsfeltene (ingen halvt fylt rad som later som den er sjekket).
ALTER TABLE incident_evidence ADD CONSTRAINT incident_evidence_verification_only_when_verified
  CHECK (status = 'VERIFIED' OR (verified_by IS NULL AND verification_basis IS NULL AND verified_at IS NULL));
-- En modell kan aldri etablere sannhet: modellskrevet bevis står på UNVERIFIED.
ALTER TABLE incident_evidence ADD CONSTRAINT incident_evidence_model_stays_unverified CHECK (asserted_by <> 'model' OR status = 'UNVERIFIED');

-- Bevis er append-only i innhold: kun status/verifiseringsfeltene kan endres (og aldri nedover fra VERIFIED, og aldri omskrevet etter VERIFIED).
-- Motsigelser registreres som NYE rader (contradicts_evidence_id).
CREATE FUNCTION incident_evidence_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_id <> OLD.evidence_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.memory_space_id <> OLD.memory_space_id OR NEW.incident_id <> OLD.incident_id
     OR NEW.source_type <> OLD.source_type OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.summary <> OLD.summary OR NEW.observed_at <> OLD.observed_at
     OR NEW.captured_at <> OLD.captured_at OR NEW.contradicts_evidence_id IS DISTINCT FROM OLD.contradicts_evidence_id OR NEW.asserted_by <> OLD.asserted_by THEN
    RAISE EXCEPTION 'incident_evidence_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'VERIFIED' AND (
       NEW.status <> 'VERIFIED' OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
       OR NEW.verification_basis IS DISTINCT FROM OLD.verification_basis OR NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    RAISE EXCEPTION 'incident_evidence_verified_is_final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER incident_evidence_guard_update_trg BEFORE UPDATE ON incident_evidence FOR EACH ROW EXECUTE FUNCTION incident_evidence_guard_update();

-- DIAGNOSER: en modell-hypotese er alltid UNVERIFIED; kun en deterministisk diagnose kan være VERIFIED, og da kun med minst ett VERIFIED støttebevis (se triggeren under).
UPDATE incident_diagnoses SET status = 'UNVERIFIED' WHERE source = 'model_assisted' AND status <> 'UNVERIFIED';
UPDATE incident_diagnoses SET status = 'PROVISIONAL' WHERE status = 'VERIFIED' AND source <> 'deterministic';
UPDATE incident_diagnoses d SET status = 'PROVISIONAL'
 WHERE d.status = 'VERIFIED' AND NOT EXISTS (
   SELECT 1 FROM incident_diagnosis_evidence de JOIN incident_evidence e ON e.tenant_id = de.tenant_id AND e.evidence_id = de.evidence_id
    WHERE de.tenant_id = d.tenant_id AND de.diagnosis_id = d.diagnosis_id AND de.relation = 'supports' AND e.status = 'VERIFIED');
ALTER TABLE incident_diagnoses ADD CONSTRAINT incident_diagnoses_model_stays_unverified CHECK (source <> 'model_assisted' OR status = 'UNVERIFIED');
ALTER TABLE incident_diagnoses ADD CONSTRAINT incident_diagnoses_verified_only_deterministic CHECK (status <> 'VERIFIED' OR source = 'deterministic');

-- En diagnose er aldri omskrevet etter opprettelse (037: «en revurdering oppretter en NY rad»): innholdet og kilden er uforanderlige, og en VERIFIED diagnose forblir VERIFIED.
-- (Tjenesten har aldri hatt en UPDATE mot tabellen; vakten gjør at heller ikke rå SQL kan flytte en påstand fra `owner` til `deterministic`.)
CREATE FUNCTION incident_diagnoses_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.diagnosis_id <> OLD.diagnosis_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.memory_space_id <> OLD.memory_space_id OR NEW.incident_id <> OLD.incident_id
     OR NEW.conclusion <> OLD.conclusion OR NEW.source <> OLD.source OR NEW.supersedes_diagnosis_id IS DISTINCT FROM OLD.supersedes_diagnosis_id THEN
    RAISE EXCEPTION 'incident_diagnosis_content_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'VERIFIED' AND NEW.status <> 'VERIFIED' THEN
    RAISE EXCEPTION 'incident_diagnosis_verified_is_final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER incident_diagnoses_guard_update_trg BEFORE UPDATE ON incident_diagnoses FOR EACH ROW EXECUTE FUNCTION incident_diagnoses_guard_update();

-- En VERIFIED diagnose må ha minst ett VERIFIED STØTTEbevis ved commit (lenkeradene skrives etter diagnoseraden i samme transaksjon, derfor utsatt). VERIFIED-bevis er endelige
-- (se vakten over), så et støttebevis kan ikke nedgraderes i ettertid.
CREATE FUNCTION incident_diagnoses_verified_needs_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'VERIFIED' AND NOT EXISTS (
    SELECT 1 FROM incident_diagnosis_evidence de JOIN incident_evidence e ON e.tenant_id = de.tenant_id AND e.evidence_id = de.evidence_id
     WHERE de.tenant_id = NEW.tenant_id AND de.diagnosis_id = NEW.diagnosis_id AND de.relation = 'supports' AND e.status = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'incident_diagnosis_verified_without_verified_evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER incident_diagnoses_verified_needs_evidence_trg
  AFTER INSERT OR UPDATE OF status ON incident_diagnoses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION incident_diagnoses_verified_needs_evidence();
