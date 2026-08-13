-- Fase 3: kø-claiming på tvers av tenants uten privilegert app-rolle.
-- Workeren er systemintern og må kunne claime neste jobb uansett tenant, men
-- app-rollen skal IKKE ha generell RLS-bypass. Løsning: én smal SECURITY
-- DEFINER-funksjon (eies av migrasjonsbrukeren) som kun claimer én jobb.

CREATE FUNCTION claim_next_task()
RETURNS TABLE (task_id text, tenant_id text, contract jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  SELECT t.task_id, t.tenant_id, t.contract INTO r
  FROM tasks t
  WHERE t.status = 'created'
  ORDER BY t.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE tasks SET status = 'running', claimed_at = now(), attempts = attempts + 1
  WHERE tasks.task_id = r.task_id;
  task_id := r.task_id;
  tenant_id := r.tenant_id;
  contract := r.contract;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION claim_next_task() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_task() TO jarvis_app;
