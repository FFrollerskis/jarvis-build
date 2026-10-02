-- Remediering del 3 (JARVIS-002/014): bundne bekreftelsesobjekter for handlinger i en TAINTED tur.
--
-- Når beslutningsgrunnlaget til modellen inneholder ubetrodd materiale (e-post, nett, verktøyoutput, upålitelig tale), kan en
-- konsekvensiell handling (klasse C/D, utgående, betalt eller ekstern skriving) KUN kjøres med en NY, eksplisitt eier-bekreftelse
-- bundet til den EKSAKTE handlingen: `binding_hash` = SHA-256 over kanonisk (verktøy, handling, parametre, mål, mottaker, beløp,
-- person, enhet, utløp, nonce). Endres én parameter, matcher ikke hashen - og bekreftelsen er ugyldig.
--  * `call_fingerprint` = hash UTEN nonce/utløp, kun for å finne raden igjen ved retry av samme kall.
--  * Bekreftelsen er ENGANGS: `consumed_at` settes atomisk (UPDATE ... WHERE status = 'approved').
--  * Modellen kan ikke opprette, godkjenne eller forbruke en bekreftelse - kun trusted lag (executor) og eierens grant-rute.
CREATE TABLE action_confirmations (
  confirmation_id        text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  person_id              text NOT NULL,
  device_id              text,
  session_id             text,
  tool_id                text NOT NULL,
  action                 text NOT NULL,
  call_fingerprint       text NOT NULL,
  binding_hash           text NOT NULL,
  nonce                  text NOT NULL,
  summary                jsonb NOT NULL,
  taint_reasons          text[] NOT NULL DEFAULT '{}',
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz,
  decided_by_person_id   text,
  decided_via_device_id  text,
  consumed_at            timestamptz,
  UNIQUE (tenant_id, nonce)
);

CREATE INDEX action_confirmations_lookup_idx ON action_confirmations (tenant_id, person_id, call_fingerprint, status);
CREATE INDEX action_confirmations_pending_idx ON action_confirmations (tenant_id, person_id, created_at) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON action_confirmations TO jarvis_app;
ALTER TABLE action_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY action_confirmations_tenant_isolation ON action_confirmations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
