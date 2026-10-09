-- WP-E1 (UA-5, JARVIS-068): helse for de deterministiske incident-produsentene.
--
-- En produsent som STILLE er død er verre enn ingen produsent (eieren tror «ingen hendelser = alt OK»), så hver kjøring registrerer start/slutt/utfall/antall, og
-- `executive.get_infra_status` viser produsentene med alder og antall på rad-feil. Ren driftsstatus per tenant (ingen person-/space-nøkkel, intet innhold) - samme klasse som
-- `deployments`/`infra_executions` og bevisst IKKE del av Q-20 memory-space-erasure-planen (en tenant-sletting fjerner den via `tenants`).
CREATE TABLE incident_producer_runs (
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  producer             text NOT NULL CHECK (producer IN ('scheduler', 'deployment', 'sentry', 'slo', 'provider', 'infra_execution', 'watchdog')),
  last_started_at      timestamptz NOT NULL,
  last_finished_at     timestamptz,
  last_status          text NOT NULL CHECK (last_status IN ('running', 'ok', 'failed', 'skipped')),
  -- Kort, sanert feilbeskrivelse (aldri rå leverandørtekst, aldri en hemmelighet).
  last_error           text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  facts_seen           integer NOT NULL DEFAULT 0 CHECK (facts_seen >= 0),
  opened               integer NOT NULL DEFAULT 0 CHECK (opened >= 0),
  updated              integer NOT NULL DEFAULT 0 CHECK (updated >= 0),
  resolved             integer NOT NULL DEFAULT 0 CHECK (resolved >= 0),
  suppressed           integer NOT NULL DEFAULT 0 CHECK (suppressed >= 0),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  PRIMARY KEY (tenant_id, producer)
);
GRANT SELECT, INSERT, UPDATE ON incident_producer_runs TO jarvis_app;
ALTER TABLE incident_producer_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_producer_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_producer_runs_tenant ON incident_producer_runs
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
