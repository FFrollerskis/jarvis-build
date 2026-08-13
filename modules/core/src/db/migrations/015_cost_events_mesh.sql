-- UA-1 AI Mesh (BO-08 §14): cost_events utvides slik at providers kan
-- sammenlignes på purpose/suksess/fallback/critic/latency. Ikke-destruktiv.
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS success boolean NOT NULL DEFAULT true;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS fallback boolean NOT NULL DEFAULT false;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS critic boolean NOT NULL DEFAULT false;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS latency_ms integer;
