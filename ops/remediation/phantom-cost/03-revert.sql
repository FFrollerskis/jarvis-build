-- Remediation part 1 / JARVIS-006: phantom `gemma_local` cost - STEP 3 of 3 (REVERT).
-- Restores the original amounts of ONE compensation from the archive tables. Use if the compensation
-- turns out to be wrong. Needs the compensation id printed by 02-apply.sql (also in audit_events).
--
--   PGOPTIONS="-c jarvis.remediation_confirm=RESTORE_GEMMA_LOCAL_COSTS -c jarvis.compensation_id=phantom-gemma-local-YYYYMMDDTHHMMSSZ" \
--     psql -X -v ON_ERROR_STOP=1 -d jarvis -f 03-revert.sql
-- The archive rows are kept (marked via the audit row), so the revert is itself traceable.

BEGIN;

DO $$
BEGIN
  IF current_setting('jarvis.remediation_confirm', true) IS DISTINCT FROM 'RESTORE_GEMMA_LOCAL_COSTS' THEN
    RAISE EXCEPTION 'refusing to run: set jarvis.remediation_confirm=RESTORE_GEMMA_LOCAL_COSTS (see header)';
  END IF;
  IF coalesce(current_setting('jarvis.compensation_id', true), '') = '' THEN
    RAISE EXCEPTION 'refusing to run: set jarvis.compensation_id to the compensation to revert';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM remediation_cost_events_archive WHERE compensation_id = current_setting('jarvis.compensation_id')) THEN
    RAISE EXCEPTION 'no archived rows for compensation %', current_setting('jarvis.compensation_id');
  END IF;
END $$;

UPDATE cost_events c SET amount_ore = a.amount_ore
FROM remediation_cost_events_archive a
WHERE a.compensation_id = current_setting('jarvis.compensation_id') AND a.cost_id = c.cost_id;

UPDATE finance_spend_records f
SET amount_ore = a.amount_ore,
    source_correction_state = a.source_correction_state,
    provenance = a.provenance,
    updated_at = now()
FROM remediation_finance_spend_records_archive a
WHERE a.compensation_id = current_setting('jarvis.compensation_id') AND a.spend_record_id = f.spend_record_id;

INSERT INTO audit_events (tenant_id, person_id, type, decision, reason, payload)
SELECT a.tenant_id, 'remediation', 'remediation.phantom_cost_compensation_reverted', 'ALLOW',
       'restore of archived gemma_local cost_events',
       jsonb_build_object('compensation_id', current_setting('jarvis.compensation_id'), 'rows', count(*), 'restored_sum_ore', sum(a.amount_ore))
FROM remediation_cost_events_archive a
WHERE a.compensation_id = current_setting('jarvis.compensation_id')
GROUP BY a.tenant_id;

COMMIT;
