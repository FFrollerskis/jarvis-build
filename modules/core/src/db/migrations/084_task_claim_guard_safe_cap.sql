-- D-446 (rettelse av 083, funnet i uavhengig gjennomgang): 083 er allerede på `main`, så rettelsen kommer som en FREMOVER-migrasjon (policy: forover-only; 083 kan ha vært anvendt et sted).
--
-- 083 beregnet giftpille-grensen med `COALESCE(NULLIF(contract -> 'retry_policy' ->> 'max_attempts', '')::integer, 1) + 2`. `max_attempts` er brukerstyrt JSON (kontrakten hadde ingen øvre grense),
-- så en ugyldig eller enorm verdi (f.eks. 9007199254740991, 10000000000 eller tekst) fikk `::integer`-casten til å KASTE i HVER `claim_next_task` så snart en slik jobb var 'running' med utløpt
-- lease. Alle agentprofiler claimes i ett kall (executive, coding, knowledge-ingest-email), så hele køen sto stille (`drain_error` hvert 2. sekund) til noen rettet raden for hånd.
--
-- NÅ (denne migrasjonen erstatter funksjonen; `CREATE OR REPLACE` beholder eier, låst search_path og EXECUTE kun for jarvis_app):
--  * grensen beregnes defensivt i `numeric` (jsonb_typeof + GREATEST/LEAST): manglende/ikke-numerisk = 1, og en vilkårlig stor verdi kan ikke få claim til å kaste;
--  * grensen er `max_attempts + 1` (ÉN gjenopptakelse etter krasj/omstart), ikke + 2: dagens handlere (executive, coding, e-postinnhenting) leser ikke sjekkpunkt/`ctx.attempts`, så en
--    gjenopptakelse er en kjøring fra start, og to av dem var for mye;
--  * en jobb der kansellering var bedt om ender som 'cancelled' (ikke 'failed'), og forrige feil tas med i forklaringen;
--  * delvis indeks på utløpte 'running'-jobber (hver idle polling leser dem nå, og `tasks` ryddes aldri).
-- `JobContractSchema` begrenser samtidig `max_attempts` til 1-1000 og `backoff_seconds` til 0-86 400 (nye jobber).

GRANT SELECT (cancel_requested, last_error) ON tasks TO jarvis_definer;

CREATE INDEX tasks_running_lease_idx ON tasks (lease_expires_at) WHERE status = 'running';

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
       AND t.attempts >= 1 + LEAST(
             1000000::numeric,
             CASE WHEN jsonb_typeof(t.contract #> '{retry_policy,max_attempts}') = 'number'
                  THEN GREATEST((t.contract #>> '{retry_policy,max_attempts}')::numeric, 1)
                  ELSE 1 END)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE tasks
     SET status = CASE WHEN tasks.cancel_requested THEN 'cancelled' ELSE 'failed' END,
         finished_at = now(), worker_id = NULL, lease_expires_at = NULL, not_before = NULL,
         last_error = 'lease_expired_claims_exhausted: jobben er startet ' || tasks.attempts
                      || ' ganger uten å fullføre (leasen utløp: worker krasjet eller ble stoppet) - ikke startet på nytt. Forrige feil: '
                      || COALESCE(left(tasks.last_error, 300), 'ingen')
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
