-- D-416 (chat/agent-skille): leveringsmerke for delegerte bakgrunnsjobber. Sweeperen (apps/api/src/chat-jobs.ts) leverer resultatet tilbake til
-- samtalen (melding i opprinnelig økt + Telegram) nøyaktig én gang: `delivered_at` settes atomisk (UPDATE ... WHERE delivered_at IS NULL).
-- Eksisterende rader er ikke delegert fra chat og får aldri levering (sweeperen filtrerer på `delegated_from_chat`), så de berøres ikke.
ALTER TABLE tasks ADD COLUMN delivered_at timestamptz;
CREATE INDEX tasks_undelivered_idx ON tasks (tenant_id, finished_at)
  WHERE delivered_at IS NULL AND status IN ('completed', 'failed', 'cancelled');
