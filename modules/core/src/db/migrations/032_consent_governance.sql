-- D-91 (UA-4 NEXT SLICE): Consent / Cookie / Data-Processing Governance Core.
--
-- Append-only, immutable decision ledger - NOT a current-state-overwrite
-- table like `marketing_campaign_observations` (D-89). Consent/legal-basis
-- history is itself the record of legal significance (proving WHEN a
-- decision was made, not merely what the latest state is), so every
-- recorded decision gets its own permanent row. Effective current state
-- for a (tenant, contact, purpose) is derived by the application as the
-- most recent row by `recorded_at` - never computed by mutating a prior
-- row. Deliberately NO UPDATE grant below (see GRANT block) - immutability
-- is enforced at the database-permission level, not merely by convention.
--
-- `purpose` is a CLOSED, deliberately narrow set - see D-91 in
-- DECISIONS_AND_ASSUMPTIONS.md for why exactly these two and no more.
-- `legal_basis` is an OWNER-CONFIGURED authority reference, never a Jarvis-
-- inferred legal conclusion - Jarvis enforces the recorded value, it does
-- not decide what legal basis applies.
CREATE TABLE consent_decisions (
  decision_id       text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  contact_id        text NOT NULL REFERENCES business_contacts (contact_id),
  purpose           text NOT NULL CHECK (purpose IN ('attribution', 'tracking')),
  state             text NOT NULL CHECK (state IN ('granted', 'denied', 'withdrawn')),
  legal_basis       text NOT NULL CHECK (legal_basis IN ('consent', 'legitimate_interest', 'contract', 'legal_obligation')),
  evidence          jsonb NOT NULL,
  policy_version    text NOT NULL,
  actor_person_id   text REFERENCES people (person_id),
  expires_at        timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_decisions_lookup_idx
  ON consent_decisions (tenant_id, memory_space_id, contact_id, purpose, recorded_at DESC);

-- Deliberately NO UPDATE grant - the ledger is append-only by database
-- permission, not merely by application convention (same "structural, not
-- conventional" principle as D-87's missing 'executed' CHECK value).
GRANT SELECT, INSERT ON consent_decisions TO jarvis_app;
GRANT DELETE ON consent_decisions TO jarvis_app; -- required for Q-20 erasure

ALTER TABLE consent_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_decisions_tenant ON consent_decisions
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY consent_decisions_space ON consent_decisions AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
