-- Fase 2: append-only audit og kostnadshendelser

CREATE TABLE audit_events (
  audit_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  tenant_id        text NOT NULL,
  person_id        text NOT NULL,
  session_id       text,
  device_id        text,
  type             text NOT NULL,
  decision         text,
  reason           text,
  tool_id          text,
  action           text,
  capability_class text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_tenant_at_idx ON audit_events (tenant_id, at);

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE cost_events (
  cost_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id),
  task_id    text,
  session_id text,
  kind       text NOT NULL,
  amount_ore integer NOT NULL CHECK (amount_ore >= 0),
  currency   text NOT NULL DEFAULT 'NOK'
);
