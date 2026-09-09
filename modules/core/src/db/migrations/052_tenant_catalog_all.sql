-- UA-8 Personal Digital Twin (D-130): scheduler-fan-out for de nye
-- tenant-uavhengige domenene (`location`/`health` retensjons-sveip) trenger
-- Å telle opp ALLE tenants (BÅDE `kind='business'` OG `kind='person'`) -
-- personlig lokasjons-/helsedata er like gjerne knyttet til en persons EGEN
-- tenant som til en bedrifts-tenant. `jarvis_list_business_tenant_ids()`
-- (023_business_tenant_catalog.sql, Q-27/D-65) er BEVISST snevret til
-- `kind='business'` og skal IKKE utvides/generaliseres her - den brukes
-- fortsatt av ALLE eksisterende bedrifts-sveip akkurat som før.
--
-- SAMME mønster, SAMME begrunnelse (Q-27/D-65): `tenants` har `FORCE ROW
-- LEVEL SECURITY` - en rå, uskopet spørring mot den delte poolen FØR noen
-- `jarvis.tenant_id`-kontekst er satt returnerer STRUKTURELT 0 rader under
-- en ekte NOSUPERUSER/NOBYPASSRLS-rolle. Løsning: samme smale,
-- eid-av-admin-rollen SECURITY DEFINER-katalogfunksjon, denne gangen UTEN
-- `kind`-filter (returnerer ALLE tenants, uansett kind).

CREATE FUNCTION jarvis_list_all_tenant_ids(p_limit integer DEFAULT 200)
RETURNS TABLE(tenant_id text)
SECURITY DEFINER
SET search_path = public
LANGUAGE sql STABLE AS $$
  SELECT t.tenant_id
  FROM tenants t
  ORDER BY t.tenant_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
$$;

-- Fail-closed leverandør-flate: PUBLIC har INGEN tilgang, KUN jarvis_app
-- (samme mønster som 023_business_tenant_catalog.sql).
REVOKE ALL ON FUNCTION jarvis_list_all_tenant_ids(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jarvis_list_all_tenant_ids(integer) TO jarvis_app;
