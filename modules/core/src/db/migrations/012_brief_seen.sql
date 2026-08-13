-- v4.0 BO-02: seen/stale-suppression for Daily Brief (enkel, IKKE Situation Engine)
CREATE TABLE brief_seen (
  tenant_id      text NOT NULL REFERENCES tenants (tenant_id),
  item_key       text NOT NULL, -- source:ref
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  last_presented timestamptz,
  dismissed      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, item_key)
);
GRANT SELECT, INSERT, UPDATE ON brief_seen TO jarvis_app;
ALTER TABLE brief_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_seen FORCE ROW LEVEL SECURITY;
CREATE POLICY brief_seen_tenant ON brief_seen
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
