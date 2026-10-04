-- D-394 (JARVIS-054): revisjonssporet kunne ikke rekonstruere «hva skjedde kl. 03:17». En rad hadde kun person/sesjon/enhet - ingen oppgave- eller
-- sporings-ID, ingen skille mellom en person og systemet, og ingen angivelse av hvilken prosess (api/worker) som utførte handlingen.
-- Nå: `task_id`/`trace_id` (korrelasjon mot jobb og modellspor), `actor_kind` ('person' | 'system' - aldri en fabrikkert person), `process`.
-- Kolonnene er nullbare/har default slik at eksisterende rader og kallere er uberørt; tabellen er fortsatt append-only (trigger).
ALTER TABLE audit_events
  ADD COLUMN task_id    text,
  ADD COLUMN trace_id   text,
  ADD COLUMN actor_kind text NOT NULL DEFAULT 'person' CHECK (actor_kind IN ('person', 'system')),
  ADD COLUMN process    text;
CREATE INDEX audit_events_task_idx ON audit_events (tenant_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX audit_events_trace_idx ON audit_events (tenant_id, trace_id) WHERE trace_id IS NOT NULL;
