-- Remediering del 3 (JARVIS-024): holdbar Telegram getUpdates-offset.
-- FØR: offset lå kun i minnet, så en restart ga `offset=0` og Telegram leverte allerede behandlede meldinger på nytt
-- (dobbel kommando/dobbel samtaleoppføring). NÅ lagres neste offset per bot (nøkkel = trunkert SHA-256 av tokenet - aldri tokenet selv).
-- Global infrastruktur-tilstand (ikke tenant-data): står i RLS-unntakslisten i remediation-2-schema-invariants.test.ts.
CREATE TABLE telegram_poll_state (
  bot_key      text PRIMARY KEY,
  next_offset  bigint NOT NULL CHECK (next_offset >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON telegram_poll_state TO jarvis_app;
