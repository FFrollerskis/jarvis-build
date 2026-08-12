-- Fase 2: sesjoner, meldinger og append-only hendelseslogg

CREATE TABLE sessions (
  session_id     text PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants (tenant_id),
  person_id      text NOT NULL REFERENCES people (person_id),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  last_channel   text NOT NULL,
  last_device_id text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_person_active_idx ON sessions (tenant_id, person_id, status);

CREATE TABLE messages (
  message_id text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id),
  session_id text NOT NULL REFERENCES sessions (session_id),
  role       text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only hendelseslogg (minnelag 1). Idempotent per (tenant_id, idempotency_key).
CREATE TABLE events (
  event_id        uuid PRIMARY KEY,
  idempotency_key text NOT NULL,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  person_id       text,
  session_id      text,
  task_id         text,
  source          text NOT NULL,
  type            text NOT NULL,
  trust_level     text NOT NULL CHECK (trust_level IN ('trusted', 'internal', 'untrusted')),
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

-- Append-only håndheves i databasen selv, ikke bare via grants.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table: % tillater ikke %', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
