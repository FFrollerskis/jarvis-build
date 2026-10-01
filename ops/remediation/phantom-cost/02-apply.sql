-- Remediation part 1 / JARVIS-006: phantom `gemma_local` cost - STEP 2 of 3 (APPLY, reversible).
-- ARCHIVE-THEN-ZERO. Nothing is deleted. Original rows are copied to archive tables first; the live
-- rows then get amount_ore = 0 (local inference has no API cost). Reversible with 03-revert.sql.
--
-- PRE-CONDITIONS (the script cannot check these for you):
--   1. A restore-VERIFIED backup of `jarvis` exists (ops/backup, status BLOCKED_EXTERNAL until proven).
--   2. 01-plan.sql was run and reviewed.
--   3. The code with the explicit gemma_local pricing row (JARVIS-006 fix) is DEPLOYED - otherwise
--      new phantom rows are written while you compensate the old ones.
-- Must run as a superuser / table owner: cost_events has no UPDATE grant for the runtime role (by design).
--
--   PGOPTIONS="-c jarvis.remediation_confirm=ARCHIVE_THEN_ZERO_GEMMA_LOCAL_COSTS" \
--     psql -X -v ON_ERROR_STOP=1 -d jarvis -f 02-apply.sql
-- Idempotent: a second run finds no rows with cost and changes nothing.

BEGIN;

DO $$
BEGIN
  IF current_setting('jarvis.remediation_confirm', true) IS DISTINCT FROM 'ARCHIVE_THEN_ZERO_GEMMA_LOCAL_COSTS' THEN
    RAISE EXCEPTION 'refusing to run: set jarvis.remediation_confirm=ARCHIVE_THEN_ZERO_GEMMA_LOCAL_COSTS (see header)';
  END IF;
END $$;

-- Archive tables: admin-owned, NOT granted to the runtime role (it cannot read or change them).
CREATE TABLE IF NOT EXISTS remediation_cost_events_archive (
  LIKE cost_events INCLUDING DEFAULTS,
  compensation_id text NOT NULL,
  archived_at     timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL
);
CREATE TABLE IF NOT EXISTS remediation_finance_spend_records_archive (
  LIKE finance_spend_records INCLUDING DEFAULTS,
  compensation_id text NOT NULL,
  archived_at     timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL
);

SELECT set_config(
  'jarvis.compensation_id',
  'phantom-gemma-local-' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6),
  true
);

-- 1. Archive, then zero, the cost events.
INSERT INTO remediation_cost_events_archive
  SELECT c.*, current_setting('jarvis.compensation_id'), now(),
         'gemma_local is a local model: API cost is 0; rows were billed at default_rate before the explicit pricing row existed'
  FROM cost_events c
  WHERE c.provider = 'gemma_local' AND c.amount_ore > 0;

UPDATE cost_events c SET amount_ore = 0
WHERE c.provider = 'gemma_local' AND c.amount_ore > 0
  AND EXISTS (
    SELECT 1 FROM remediation_cost_events_archive a
    WHERE a.cost_id = c.cost_id AND a.compensation_id = current_setting('jarvis.compensation_id')
  );

-- 2. Archive, then zero, the finance mirror of those events (source_family = 'model_cost').
INSERT INTO remediation_finance_spend_records_archive
  SELECT f.*, current_setting('jarvis.compensation_id'), now(),
         'mirror of a phantom gemma_local cost_event (JARVIS-006)'
  FROM finance_spend_records f
  WHERE f.source_family = 'model_cost' AND f.source_provider = 'gemma_local' AND f.amount_ore > 0;

UPDATE finance_spend_records f
SET amount_ore = 0,
    source_correction_state = 'corrected',
    provenance = f.provenance || jsonb_build_object('phantom_cost_compensation', current_setting('jarvis.compensation_id')),
    updated_at = now()
WHERE f.source_family = 'model_cost' AND f.source_provider = 'gemma_local' AND f.amount_ore > 0
  AND EXISTS (
    SELECT 1 FROM remediation_finance_spend_records_archive a
    WHERE a.spend_record_id = f.spend_record_id AND a.compensation_id = current_setting('jarvis.compensation_id')
  );

-- 3. One audit row per affected tenant (append-only audit_events). Counts and sums only.
INSERT INTO audit_events (tenant_id, person_id, type, decision, reason, payload)
SELECT a.tenant_id, 'remediation', 'remediation.phantom_cost_compensation', 'ALLOW',
       'archive-then-zero of gemma_local cost_events (JARVIS-006)',
       jsonb_build_object(
         'compensation_id', current_setting('jarvis.compensation_id'),
         'rows', count(*),
         'original_sum_ore', sum(a.amount_ore)
       )
FROM remediation_cost_events_archive a
WHERE a.compensation_id = current_setting('jarvis.compensation_id')
GROUP BY a.tenant_id;

-- 4. Post-condition: no gemma_local cost remains. Anything else rolls the WHOLE transaction back.
DO $$
DECLARE remaining bigint;
BEGIN
  SELECT coalesce(sum(amount_ore), 0) INTO remaining FROM cost_events WHERE provider = 'gemma_local';
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'post-condition failed: gemma_local cost_events still sum to % ore', remaining;
  END IF;
  SELECT coalesce(sum(amount_ore), 0) INTO remaining
    FROM finance_spend_records WHERE source_family = 'model_cost' AND source_provider = 'gemma_local';
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'post-condition failed: gemma_local finance mirror still sums to % ore', remaining;
  END IF;
  RAISE NOTICE 'compensation % applied', current_setting('jarvis.compensation_id');
END $$;

COMMIT;
