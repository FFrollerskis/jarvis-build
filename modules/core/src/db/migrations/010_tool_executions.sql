-- Fase 7: idempotensdedupe for eksterne verktoyhandlinger.
-- PRIMARY KEY paa (tenant_id, idempotency_key) gir atomisk "utfoert en gang";
-- retry etter timeout returnerer lagret eksternt resultat i stedet for dobbel handling.

CREATE TABLE tool_executions (
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  idempotency_key text NOT NULL,
  tool_id         text NOT NULL,
  action          text NOT NULL,
  external_id     text,
  status          text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  executed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);
GRANT SELECT, INSERT ON tool_executions TO jarvis_app;
ALTER TABLE tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_executions_tenant ON tool_executions
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
