-- UA-1 P1A delta (BO-11.1 §3): SQL-spørrbare streaming-/tool-metrics i
-- cost_events, slik at P1B kan analysere ttft/stream/tool-bruk per
-- provider/model/purpose direkte i SQL (kompletterer Langfuse, erstatter ikke).
-- Ikke-destruktiv: kun nye kolonner med defaults; eksisterende rader overlever.
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS ttft_ms integer;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS stream boolean NOT NULL DEFAULT false;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS tool_calls integer NOT NULL DEFAULT 0;
