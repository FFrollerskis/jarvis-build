-- JARVIS-040 (rest, D-446): jobbkøen hadde to hull.
--
-- (1) GIFTPILLE: `claim_next_task` ga en 'running'-jobb med utløpt lease til en worker igjen UTEN noen grense (D-393 la lease-fornyelse til for jobber som lever, men en
-- jobb som DREPER worker-prosessen - OOM, krasj, `process.exit` - ble gjenopptatt etter hver lease-utløp for alltid). `restart: unless-stopped` + 60 s lease = en krasjløkke som
-- kjører samme jobb om og om igjen, med de reelle sideeffektene den måtte ha (verktøykall, kodejobber). `max_attempts` ble kun vurdert i `fail()` (handlerfeil), aldri ved gjenopptakelse.
-- NÅ: en utløpt jobb som allerede er startet `max_attempts + 2` ganger gjenopptas ikke, men settes til 'failed' med forklaring (to gjenopptakelser tåler en deploy/omstart pluss én krasj;
-- jobber har sjekkpunkt/`ctx.attempts` for å fortsette der de slapp).
--
-- (2) INGEN BACKOFF: `fail()` satte en jobb med forsøk igjen rett tilbake til 'created', og drain-løkken (2 s) tok den med en gang - alle forsøkene ble brukt opp på sekunder, uten
-- at en forbigående feil (leverandør nede, rate limit) rakk å gå over. `retry_policy.backoff_seconds` fantes i kontrakten, men ble aldri brukt. NÅ: `tasks.not_before` settes av `fail()`
-- (backoff_seconds * 2^(forsøk-1), maks 1 time) og `claim_next_task` hopper over 'created'-jobber til tidspunktet er passert.
--
-- Funksjonen beholder eier (jarvis_definer), låst search_path og EXECUTE kun for jarvis_app (CREATE OR REPLACE endrer ikke eierskap/rettigheter); kolonne-rettighetene for definer-rollen
-- utvides akkurat med det den nye logikken trenger.

ALTER TABLE tasks ADD COLUMN not_before timestamptz;

GRANT SELECT (not_before) ON tasks TO jarvis_definer;
GRANT UPDATE (finished_at, last_error, not_before) ON tasks TO jarvis_definer;

CREATE OR REPLACE FUNCTION claim_next_task(p_worker_id text, p_lease_seconds integer, p_agent_profiles text[])
RETURNS TABLE (task_id text, tenant_id text, contract jsonb, attempts integer, checkpoint jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  -- Giftpille-vern: kun jobber denne workeren kunne ha claimet (egne agentprofiler), og aldri en rad en annen claim holder låst akkurat nå.
  WITH poisoned AS (
    SELECT t.task_id
      FROM tasks t
     WHERE t.status = 'running'
       AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at < now()
       AND t.contract ->> 'agent_profile' = ANY (p_agent_profiles)
       AND t.attempts >= COALESCE(NULLIF(t.contract -> 'retry_policy' ->> 'max_attempts', '')::integer, 1) + 2
     FOR UPDATE SKIP LOCKED
  )
  UPDATE tasks
     SET status = 'failed', finished_at = now(), worker_id = NULL, lease_expires_at = NULL, not_before = NULL,
         last_error = 'lease_expired_claims_exhausted: jobben er startet ' || tasks.attempts
                      || ' ganger uten å fullføre (worker krasjet eller ble stoppet hver gang) - ikke startet på nytt'
    FROM poisoned
   WHERE tasks.task_id = poisoned.task_id;

  SELECT t.task_id, t.tenant_id, t.contract, t.attempts, t.checkpoint INTO r
  FROM tasks t
  WHERE ((t.status = 'created' AND (t.not_before IS NULL OR t.not_before <= now()))
     OR (t.status = 'running' AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at < now()))
    AND t.contract ->> 'agent_profile' = ANY (p_agent_profiles)
  ORDER BY t.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE tasks SET status = 'running', claimed_at = now(), attempts = tasks.attempts + 1,
    worker_id = p_worker_id, not_before = NULL,
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
