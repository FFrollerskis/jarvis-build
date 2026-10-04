-- D-395 (JARVIS-074): ubegrenset vekst uten oppbevaringstid.
-- `approvals`, `session_grants`, `device_enrollment_tickets`, `tool_executions` og `scheduler_state` samlet seg opp for alltid, og `messages`/`cost_events`
-- manglet indeks (full tabellskanning per samtaleoppslag og per budsjettsjekk). Denne migrasjonen legger til:
--   1) manglende indekser (additivt, `IF NOT EXISTS`),
--   2) `prune_operational_data()` - en SECURITY DEFINER-funksjon som sletter KUN utlopte driftsrader i begrensede batcher, med faste gulv
--      (aldri under 7 dager; ferdige verktoyutforelser aldri under 30 dager). `jarvis_app` far EXECUTE pa funksjonen - IKKE DELETE pa tabellene:
--      en kompromittert runtime kan ikke slette replay-/dedupe-bevis direkte. Funksjonen eies av `jarvis_definer` (064: NOLOGIN, NOSUPERUSER,
--      NOBYPASSRLS) og styres av EKSPLISITTE, smale RLS-policyer som i seg selv hindrer sletting av ferske rader - selv om funksjonen skulle misbrukes.
--   `audit_events`, `events` og `memory_versions` er append-only (trigger) og beroeres bevisst IKKE: oppbevaringspolicy for revisjon er en eierbeslutning
--   (se JARVIS-074 i FINDINGS_LEDGER). `tool_executions` rader med status `unverified` (og `reserved` fra D-392) er bevis pa et ukjent utfall og slettes aldri.

CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages (tenant_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS cost_events_tenant_at_idx ON cost_events (tenant_id, at);
CREATE INDEX IF NOT EXISTS tool_executions_executed_idx ON tool_executions (tenant_id, executed_at);
CREATE INDEX IF NOT EXISTS approvals_expires_idx ON approvals (expires_at);
CREATE INDEX IF NOT EXISTS session_grants_expires_idx ON session_grants (expires_at);
CREATE INDEX IF NOT EXISTS device_enrollment_tickets_expires_idx ON device_enrollment_tickets (expires_at);
CREATE INDEX IF NOT EXISTS scheduler_state_run_date_idx ON scheduler_state (run_date);

-- Smale rettigheter for definer-rollen: akkurat kolonnene funksjonen leser, pluss DELETE.
GRANT SELECT (nonce, expires_at) ON approvals TO jarvis_definer;
GRANT DELETE ON approvals TO jarvis_definer;
GRANT SELECT (expires_at, revoked_at) ON session_grants TO jarvis_definer;
GRANT DELETE ON session_grants TO jarvis_definer;
GRANT SELECT (ticket_id, expires_at) ON device_enrollment_tickets TO jarvis_definer;
GRANT DELETE ON device_enrollment_tickets TO jarvis_definer;
GRANT SELECT (tenant_id, idempotency_key, status, executed_at) ON tool_executions TO jarvis_definer;
GRANT DELETE ON tool_executions TO jarvis_definer;
GRANT SELECT (job_name, run_date, completed_at) ON scheduler_state TO jarvis_definer;
GRANT DELETE ON scheduler_state TO jarvis_definer;

-- FORCE RLS gjelder ogsa eieren. Policyene under er rettet KUN mot definer-rollen og binder faste gulv i selve policyen (permissive policyer OR-es,
-- sa de eksisterende tenant-policyene er uendret for alle andre roller). `session_grants` har allerede `session_grants_definer_lookup` (SELECT, 064).
CREATE POLICY approvals_definer_prune_select ON approvals FOR SELECT TO jarvis_definer
  USING (expires_at < now() - interval '7 days');
CREATE POLICY approvals_definer_prune ON approvals FOR DELETE TO jarvis_definer
  USING (expires_at < now() - interval '7 days');
CREATE POLICY session_grants_definer_prune ON session_grants FOR DELETE TO jarvis_definer
  USING (expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days');
CREATE POLICY device_enrollment_tickets_definer_prune_select ON device_enrollment_tickets FOR SELECT TO jarvis_definer
  USING (expires_at < now() - interval '7 days');
CREATE POLICY device_enrollment_tickets_definer_prune ON device_enrollment_tickets FOR DELETE TO jarvis_definer
  USING (expires_at < now() - interval '7 days');
CREATE POLICY tool_executions_definer_prune_select ON tool_executions FOR SELECT TO jarvis_definer
  USING (status IN ('succeeded', 'failed') AND executed_at < now() - interval '30 days');
CREATE POLICY tool_executions_definer_prune ON tool_executions FOR DELETE TO jarvis_definer
  USING (status IN ('succeeded', 'failed') AND executed_at < now() - interval '30 days');

CREATE OR REPLACE FUNCTION prune_operational_data(
  p_approvals_days  integer DEFAULT 30,
  p_grants_days     integer DEFAULT 30,
  p_tickets_days    integer DEFAULT 30,
  p_tool_exec_days  integer DEFAULT 180,
  p_scheduler_days  integer DEFAULT 90,
  p_batch           integer DEFAULT 5000
) RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n bigint;
  b integer := LEAST(GREATEST(COALESCE(p_batch, 5000), 100), 50000);
  d_appr integer := GREATEST(COALESCE(p_approvals_days, 30), 7);
  d_grant integer := GREATEST(COALESCE(p_grants_days, 30), 7);
  d_ticket integer := GREATEST(COALESCE(p_tickets_days, 30), 7);
  d_exec integer := GREATEST(COALESCE(p_tool_exec_days, 180), 30);
  d_sched integer := GREATEST(COALESCE(p_scheduler_days, 90), 7);
BEGIN
  -- Engangs-nonce-er: en utlopt godkjenning kan aldri gjenbrukes uansett (utlopskontrollen avviser den), sa raden trengs ikke etter utlop + karens.
  WITH doomed AS (
    SELECT nonce FROM approvals WHERE expires_at < now() - make_interval(days => d_appr) LIMIT b
  ) DELETE FROM approvals a USING doomed WHERE a.nonce = doomed.nonce;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'approvals'; deleted := n; RETURN NEXT;

  WITH doomed AS (
    SELECT grant_id FROM session_grants
     WHERE expires_at < now() - make_interval(days => d_grant) OR revoked_at < now() - make_interval(days => d_grant) LIMIT b
  ) DELETE FROM session_grants g USING doomed WHERE g.grant_id = doomed.grant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'session_grants'; deleted := n; RETURN NEXT;

  WITH doomed AS (
    SELECT ticket_id FROM device_enrollment_tickets WHERE expires_at < now() - make_interval(days => d_ticket) LIMIT b
  ) DELETE FROM device_enrollment_tickets t USING doomed WHERE t.ticket_id = doomed.ticket_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'device_enrollment_tickets'; deleted := n; RETURN NEXT;

  -- Kun AVSLUTTEDE rader: `unverified` (og `reserved` fra D-392) er bevis pa et ukjent utfall og slettes aldri automatisk.
  WITH doomed AS (
    SELECT tenant_id, idempotency_key FROM tool_executions
     WHERE status IN ('succeeded', 'failed') AND executed_at < now() - make_interval(days => d_exec) LIMIT b
  ) DELETE FROM tool_executions e USING doomed WHERE e.tenant_id = doomed.tenant_id AND e.idempotency_key = doomed.idempotency_key;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'tool_executions'; deleted := n; RETURN NEXT;

  -- `scheduler_state` er ikke tenant-skopet; kun ferdige dager (en uavsluttet dag kan vaere en krasjet jobb som skal kunne gjenopptas/inspiseres).
  WITH doomed AS (
    SELECT job_name, run_date FROM scheduler_state
     WHERE run_date < current_date - d_sched AND completed_at IS NOT NULL LIMIT b
  ) DELETE FROM scheduler_state s USING doomed WHERE s.job_name = doomed.job_name AND s.run_date = doomed.run_date;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'scheduler_state'; deleted := n; RETURN NEXT;
END;
$$;

ALTER FUNCTION prune_operational_data(integer, integer, integer, integer, integer, integer) OWNER TO jarvis_definer;
REVOKE ALL ON FUNCTION prune_operational_data(integer, integer, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_operational_data(integer, integer, integer, integer, integer, integer) TO jarvis_app;
