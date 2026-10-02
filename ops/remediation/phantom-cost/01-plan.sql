-- Remediation part 1 / JARVIS-006: phantom `gemma_local` cost - STEP 1 of 3 (READ-ONLY).
-- Shows what would be compensated. Changes nothing. Safe to run any time, as any DB admin.
--   psql -X -A -t -v ON_ERROR_STOP=1 -d jarvis -f 01-plan.sql
-- Output is ONE JSON document with counts and sums only (no prompts, no row content).
--
-- (It creates only a session-local TEMP function, so the report can tolerate a missing archive table;
-- no persistent object is created or changed.)
--
-- Why this exists: `gemma_local` (a LOCAL model, API cost is always 0) had no pricing row and was
-- billed at default_rate (30 / 150 ore per 1k tokens). Those rows sit in cost_events, count against
-- the 3 000 kr monthly hard limit (BudgetGuard sums ALL cost_events of the month), tripped the durable
-- cost kill switch, and were mirrored into finance_spend_records (source_family = 'model_cost').

CREATE OR REPLACE FUNCTION pg_temp.previous_compensations() RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
  IF to_regclass('remediation_cost_events_archive') IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN (SELECT coalesce(jsonb_agg(DISTINCT compensation_id), '[]'::jsonb) FROM remediation_cost_events_archive);
END
$fn$;

SELECT jsonb_pretty(jsonb_build_object(
  'generated_at_utc', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'scope', 'provider = gemma_local only',
  'cost_events', (
    SELECT jsonb_build_object(
      'rows_with_cost', count(*) FILTER (WHERE amount_ore > 0),
      'rows_total', count(*),
      'sum_amount_ore', coalesce(sum(amount_ore), 0),
      'input_tokens', coalesce(sum(input_tokens), 0),
      'output_tokens', coalesce(sum(output_tokens), 0),
      'first_at', min(at),
      'last_at', max(at)
    ) FROM cost_events WHERE provider = 'gemma_local'
  ),
  'by_tenant_month', (
    SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.tenant_id, t.month), '[]'::jsonb) FROM (
      SELECT tenant_id, to_char(date_trunc('month', at), 'YYYY-MM') AS month, count(*) AS rows, coalesce(sum(amount_ore), 0) AS sum_amount_ore
      FROM cost_events WHERE provider = 'gemma_local' AND amount_ore > 0 GROUP BY 1, 2
    ) t
  ),
  'current_month_effect', jsonb_build_object(
    'all_providers_sum_ore', (SELECT coalesce(sum(amount_ore), 0) FROM cost_events WHERE at >= date_trunc('month', now())),
    'gemma_local_sum_ore', (SELECT coalesce(sum(amount_ore), 0) FROM cost_events WHERE provider = 'gemma_local' AND at >= date_trunc('month', now())),
    'note', 'BudgetGuard.monthlySpentOre sums amount_ore of ALL cost_events since the start of the month; hard limit is 300000 ore (3000 kr)'
  ),
  'finance_mirror', (
    SELECT jsonb_build_object(
      'rows_with_cost', count(*) FILTER (WHERE amount_ore > 0),
      'sum_amount_ore', coalesce(sum(amount_ore), 0)
    ) FROM finance_spend_records WHERE source_family = 'model_cost' AND source_provider = 'gemma_local'
  ),
  'kill_switch', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', control_kind, 'target', control_target, 'reason', left(reason, 120), 'changed_at', changed_at)), '[]'::jsonb)
    FROM owner_control_state WHERE control_kind = 'kill_switch'
  ),
  'previous_compensations', pg_temp.previous_compensations()
));
