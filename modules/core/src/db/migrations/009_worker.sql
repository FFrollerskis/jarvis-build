-- Fase 6: durable workers - lease/reclaim, checkpoints, kansellering, artefakter

ALTER TABLE tasks
  ADD COLUMN worker_id        text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN checkpoint       jsonb,
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN last_error       text;

CREATE TABLE artifacts (
  artifact_id text PRIMARY KEY,
  task_id     text NOT NULL REFERENCES tasks (task_id),
  tenant_id   text NOT NULL,
  kind        text NOT NULL,
  name        text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON artifacts TO jarvis_app;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY artifacts_tenant ON artifacts
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));

-- Lease-bevisst claim (erstatter 007-varianten): reclaim av utløpte leases er
-- trygg mot dobbelkjøring via FOR UPDATE SKIP LOCKED + worker_id-guard ved
-- complete/fail. Fortsatt eneste smale SECURITY DEFINER-flate.
DROP FUNCTION claim_next_task();

CREATE FUNCTION claim_next_task(p_worker_id text, p_lease_seconds integer)
RETURNS TABLE (task_id text, tenant_id text, contract jsonb, attempts integer, checkpoint jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  SELECT t.task_id, t.tenant_id, t.contract, t.attempts, t.checkpoint INTO r
  FROM tasks t
  WHERE t.status = 'created'
     OR (t.status = 'running' AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at < now())
  ORDER BY t.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE tasks SET status = 'running', claimed_at = now(), attempts = tasks.attempts + 1,
    worker_id = p_worker_id,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  WHERE tasks.task_id = r.task_id;
  task_id := r.task_id;
  tenant_id := r.tenant_id;
  contract := r.contract;
  attempts := r.attempts + 1;
  checkpoint := r.checkpoint;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION claim_next_task(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_task(text, integer) TO jarvis_app;
