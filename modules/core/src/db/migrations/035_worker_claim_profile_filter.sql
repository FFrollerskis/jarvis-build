-- D-103 (UA-5 Production Coding Reachability Repair v1) - Blokker A: atomisk
-- profil-filtrert claim. FØR denne migrasjonen var claim_next_task() agent-
-- profil-blind: HVILKEN SOM HELST worker-prosess kunne claime en jobb med
-- agent_profile den ikke hadde en handler for (f.eks. apps/api/src/main.ts
-- sin egen "executive"-only InProcessWorker som claimet en agent_profile=
-- "coding"-jobb før apps/api/src/worker-main.ts sin "coding"-worker fikk
-- sjansen), som terminalt feilet jobben med "ingen handler for agentprofil
-- ...". Fikset ved å utvide claim-funksjonen med en eksplisitt liste over
-- agent_profile-verdier ANROPENDE worker faktisk har registrerte handlere
-- for - filtreringen skjer ATOMISK i SAME FOR UPDATE SKIP LOCKED-transaksjon
-- som selve claimet, så en jobb en worker ikke støtter forblir ganske enkelt
-- 'created' (aldri feilet, aldri feilrutet) til en kompatibel worker henter
-- den. Additiv/idempotent: DROP+CREATE av SAMME funksjonsnavn (identisk
-- mønster som 009_worker.sql sin egen erstatning av 007-varianten),
-- lease/reclaim/tenant-isolasjon/RLS uendret - INGEN tabellendring, INGEN
-- datatap, eksisterende 'created'/'running'-rader forblir fullt claimbare.

DROP FUNCTION claim_next_task(text, integer);

CREATE FUNCTION claim_next_task(p_worker_id text, p_lease_seconds integer, p_agent_profiles text[])
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
  WHERE (t.status = 'created'
     OR (t.status = 'running' AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at < now()))
    AND t.contract ->> 'agent_profile' = ANY (p_agent_profiles)
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

REVOKE ALL ON FUNCTION claim_next_task(text, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_task(text, integer, text[]) TO jarvis_app;
