-- v4.0 UA-0A: run-rate-detaljer og D-pipeline-evidens (additivt, ingen destruktive endringer)

ALTER TABLE cost_events
  ADD COLUMN provider      text,
  ADD COLUMN model         text,
  ADD COLUMN input_tokens  integer,
  ADD COLUMN output_tokens integer;

ALTER TABLE tool_executions
  ADD COLUMN before_state jsonb,
  ADD COLUMN after_state  jsonb;
GRANT UPDATE (after_state) ON tool_executions TO jarvis_app;
