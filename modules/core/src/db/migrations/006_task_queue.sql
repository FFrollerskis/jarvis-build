-- Fase 3: kø-felter for in-process worker (pg-boss-klasse claiming med SKIP LOCKED, D-13)

ALTER TABLE tasks
  ADD COLUMN attempts    integer NOT NULL DEFAULT 0,
  ADD COLUMN claimed_at  timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN result      jsonb;

CREATE INDEX tasks_queue_idx ON tasks (status, created_at) WHERE status = 'created';
