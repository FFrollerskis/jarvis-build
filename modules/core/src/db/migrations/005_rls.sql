-- Fase 2: Row Level Security per tenant (SECURITY_MODEL, TENANT_MODEL).
-- Applikasjonen kjører som jarvis_app (NOLOGIN gruppe-rolle uten RLS-bypass);
-- innloggingsbrukere GRANTes inn i rollen per miljø. Tenant-kontekst settes
-- per transaksjon med set_config('jarvis.tenant_id', ..., true).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jarvis_app') THEN
    CREATE ROLE jarvis_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO jarvis_app;

-- Minst mulig: SELECT/INSERT bredt; UPDATE kun der det trengs; ALDRI UPDATE/DELETE på append-only.
GRANT SELECT, INSERT ON
  tenants, people, person_tenants, organizations, projects, sites, rooms,
  devices, memory_spaces, sessions, messages, events, tasks, capabilities,
  approvals, audit_events, cost_events
TO jarvis_app;
GRANT UPDATE ON sessions, tasks, devices, projects TO jarvis_app;

-- Tenant-skopede tabeller: RLS på, også for tabelleier (FORCE).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'person_tenants', 'organizations', 'projects', 'sites', 'rooms', 'devices',
    'memory_spaces', 'sessions', 'messages', 'events', 'tasks', 'approvals',
    'audit_events', 'cost_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))',
      t, t
    );
  END LOOP;
END
$$;

-- tenants og people er referansedata uten tenant_id-kolonne i seg selv:
-- tenants: en rad er synlig kun for sin egen tenant-kontekst.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_self ON tenants
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));

-- people: synlig kun hvis personen er medlem av gjeldende tenant.
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE people FORCE ROW LEVEL SECURITY;
CREATE POLICY people_via_membership ON people
  USING (EXISTS (
    SELECT 1 FROM person_tenants pt
    WHERE pt.person_id = people.person_id
      AND pt.tenant_id = current_setting('jarvis.tenant_id', true)
  ))
  WITH CHECK (true);

-- capabilities er globalt verktøyregister (ikke tenant-data): kun lesing for app-rollen.
REVOKE INSERT ON capabilities FROM jarvis_app;
