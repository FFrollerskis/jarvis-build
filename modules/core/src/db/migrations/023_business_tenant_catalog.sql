-- Q-27 (2026-08-18, D-65): fikser en reell, host-uverifisert produksjonsbug
-- - `runOpenLoopSweepForAllTenants()`, `runBusinessEventSyncForAllTenants()`
-- og `runScoringSweepForAllTenants()` (alle `DailyScheduler`-trigget i
-- `apps/api/src/main.ts`) kjørte en rå, uskopet `SELECT tenant_id FROM
-- tenants WHERE kind='business'...` mot den DELTE `jarvis_runtime`-poolen,
-- FØR noen `jarvis.tenant_id`-kontekst er satt. `tenants` har `FORCE ROW
-- LEVEL SECURITY` (005_rls.sql, policy `tenants_self`:
-- `tenant_id = current_setting('jarvis.tenant_id', true)`) - uten satt
-- kontekst evaluerer denne ALDRI til true, og spørringen returnerer
-- STRUKTURELT 0 rader under en ekte NOSUPERUSER/NOBYPASSRLS-rolle (Q-21).
--
-- Løsning: samme mønster som den eksisterende `claim_next_task()`
-- (007_claim_function.sql/009_worker.sql) - én smal, eid-av-admin-rollen
-- SECURITY DEFINER-katalogfunksjon som EKSPLISITT kun eksponerer
-- `tenant_id` for `kind='business'` (hardkodet, IKKE en caller-styrt
-- parameter - minimerer overflaten ytterligere enn å akseptere en fri
-- `kind text`). `jarvis_runtime` beholder UENDRET NOSUPERUSER/NOBYPASSRLS
-- (Q-21) - ingen RLS-bypass innføres for rollen selv, kun ett smalt,
-- begrunnet unntak for kryss-tenant-katalog-oppslag som scheduler-fan-out
-- strukturelt krever.

CREATE FUNCTION jarvis_list_business_tenant_ids(p_limit integer DEFAULT 200)
RETURNS TABLE(tenant_id text)
SECURITY DEFINER
SET search_path = public
LANGUAGE sql STABLE AS $$
  SELECT t.tenant_id
  FROM tenants t
  WHERE t.kind = 'business'
  ORDER BY t.tenant_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
$$;

-- Fail-closed leverandør-flate: PUBLIC har INGEN tilgang, KUN jarvis_app
-- (som jarvis_runtime alltid er medlem av, se runtime-role.ts) kan kjøre
-- funksjonen. `SET search_path = public` over hindrer search_path-hijacking
-- uansett hvilken søkevei den kallende sesjonen selv har satt.
REVOKE ALL ON FUNCTION jarvis_list_business_tenant_ids(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jarvis_list_business_tenant_ids(integer) TO jarvis_app;
