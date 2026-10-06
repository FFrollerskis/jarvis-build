-- D-421 (UA0-RUNRATE, masterplan v4.0 kap. 7/8): connector maintenance ledger. Hvor mye eierens tid/uro hver connector faktisk koster (feil,
-- rotasjon av credentials, API-endringer, manuelle rettelser) - sammen med modellkostnaden i `cost_events` gir det den ærlige run-rate-prisen.
-- Append-only (en rettelse er en NY rad): samme disiplin som revisjonssporet. Kun metadata - aldri hemmeligheter eller innhold.
CREATE TABLE connector_maintenance_log (
  log_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants (tenant_id),
  connector_id text NOT NULL CHECK (length(connector_id) BETWEEN 1 AND 80),
  event_kind   text NOT NULL CHECK (event_kind IN ('incident', 'credential_rotation', 'api_change', 'manual_fix', 'upgrade', 'outage', 'other')),
  minutes      integer NOT NULL CHECK (minutes BETWEEN 0 AND 100000),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  recorded_by  text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_maintenance_log_tenant_idx ON connector_maintenance_log (tenant_id, occurred_at);

ALTER TABLE connector_maintenance_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_maintenance_log FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_maintenance_log_tenant ON connector_maintenance_log
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
GRANT SELECT, INSERT ON connector_maintenance_log TO jarvis_app;

CREATE FUNCTION connector_maintenance_log_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table: connector_maintenance_log tillater ikke %', TG_OP;
END;
$$;
CREATE TRIGGER connector_maintenance_log_no_update_delete
  BEFORE UPDATE OR DELETE ON connector_maintenance_log
  FOR EACH ROW EXECUTE FUNCTION connector_maintenance_log_forbid_mutation();
CREATE TRIGGER connector_maintenance_log_no_truncate
  BEFORE TRUNCATE ON connector_maintenance_log
  FOR EACH STATEMENT EXECUTE FUNCTION connector_maintenance_log_forbid_mutation();
