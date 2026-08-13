-- Fase 2: jobber (datamodell), verktøyregister-skjelett og persistente godkjenninger

CREATE TABLE tasks (
  task_id         text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  owner_person_id text NOT NULL REFERENCES people (person_id),
  goal            text NOT NULL,
  status          text NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  -- Full jobbkontrakt (JobContractSchema) valideres i applikasjonslaget.
  contract        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Verktøyregister-skjelett (Tool Gateway fylles i fase 3/7). Ikke tenant-skopet.
CREATE TABLE capabilities (
  tool_id          text NOT NULL,
  action           text NOT NULL,
  capability_class text NOT NULL CHECK (capability_class IN ('A', 'B', 'C', 'D')),
  PRIMARY KEY (tool_id, action)
);

-- Persistent engangs-lager for signerte godkjenninger (replay-vern på tvers av
-- prosessrestart). PRIMARY KEY på nonce gir atomisk single-use via INSERT.
CREATE TABLE approvals (
  nonce               text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  action              text NOT NULL,
  parameters          jsonb NOT NULL,
  approving_device_id text NOT NULL,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz NOT NULL DEFAULT now()
);
