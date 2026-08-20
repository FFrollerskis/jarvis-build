-- D-92 (UA-4 NEXT SLICE): Consent Enforcement Activation / Rollout v1.
--
-- Layers two NEW concerns on top of D-91's (032) already-merged consent
-- engine, WITHOUT modifying it:
--   1. `consent_enforcement_policies` - an explicit, owner-configured,
--      per (tenant, space, purpose) ROLLOUT MODE. Default (no row) is
--      'disabled' - the D-91 engine exists but is NOT authoritative for
--      blocking anything, preserving 100% pre-D-92 behavior until the
--      owner explicitly activates a stricter mode. This is deliberately
--      NOT append-only (unlike consent_decisions) - it is operational
--      configuration, not a legally significant decision record, so a
--      plain UPSERT-on-conflict current-state table is the correct shape
--      (mirrors the reasoning D-89 used for `marketing_campaign_
--      observations` vs D-91's append-only ledger - see 031/032 for the
--      contrast).
--   2. `consent_enforcement_events` - an append-only OBSERVABILITY log of
--      every evaluate-and-enforce check actually performed (both AUDIT
--      mode "observe only" and ENFORCE mode "block or proceed" checks).
--      NEVER written for 'disabled' mode (no evaluation occurs there -
--      zero overhead, exactly current behavior). Deliberately does NOT
--      reuse `audit_events` (004_audit_cost.sql): that table requires a
--      NOT NULL person_id backed by a full IdentityContext, but growth's
--      `GrowthTransport` (unlike e.g. SupportTransport post-D-68) does
--      NOT currently thread ToolInvocationContext/identity down to
--      service methods - EVERY existing writeAudit() call site in this
--      codebase has a real, non-optional identity available; growth's
--      attribution path does not, and threading one through would be a
--      much larger, separate wiring change touching 25+ existing test
--      call sites and a live-host script (out of scope for this slice -
--      see D-92 for the explicit reasoning). Fabricating a person_id
--      would be dishonest data, which this codebase consistently
--      refuses to do (same principle as "no fake consent backfill").
--      `actor_person_id` here is therefore NULLABLE, same pattern as
--      `consent_decisions.actor_person_id`.
CREATE TABLE consent_enforcement_policies (
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  purpose           text NOT NULL CHECK (purpose IN ('attribution', 'tracking')),
  mode              text NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'audit', 'enforce')),
  actor_person_id   text REFERENCES people (person_id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_space_id, purpose)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON consent_enforcement_policies TO jarvis_app;

ALTER TABLE consent_enforcement_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_enforcement_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_enforcement_policies_tenant ON consent_enforcement_policies
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY consent_enforcement_policies_space ON consent_enforcement_policies AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- `seq` tie-breaker for the SAME deterministic-ordering reason as D-91's
-- consent_decisions.seq (032) - never repeat the pre-closeout mistake of
-- ordering solely by `recorded_at`.
CREATE TABLE consent_enforcement_events (
  seq                 bigserial UNIQUE,
  event_id            text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id     text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  contact_id          text NOT NULL REFERENCES business_contacts (contact_id),
  purpose             text NOT NULL CHECK (purpose IN ('attribution', 'tracking')),
  operation           text NOT NULL,
  enforcement_mode    text NOT NULL CHECK (enforcement_mode IN ('audit', 'enforce')),
  processing_outcome  text NOT NULL CHECK (processing_outcome IN ('ALLOWED', 'DENIED', 'UNKNOWN_NOT_CONFIGURED')),
  enforcement_result  text NOT NULL CHECK (enforcement_result IN ('proceed', 'blocked')),
  decision_id         text,
  policy_version      text,
  actor_person_id     text REFERENCES people (person_id),
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_enforcement_events_lookup_idx
  ON consent_enforcement_events (tenant_id, memory_space_id, contact_id, purpose, recorded_at DESC, seq DESC);

-- Append-only, same "structural, not conventional" principle as
-- consent_decisions (032) and D-87's execution-commands CHECK-constraint -
-- deliberately NO UPDATE grant.
GRANT SELECT, INSERT ON consent_enforcement_events TO jarvis_app;
GRANT DELETE ON consent_enforcement_events TO jarvis_app; -- required for Q-20 erasure
GRANT USAGE, SELECT ON SEQUENCE consent_enforcement_events_seq_seq TO jarvis_app;

ALTER TABLE consent_enforcement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_enforcement_events FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_enforcement_events_tenant ON consent_enforcement_events
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY consent_enforcement_events_space ON consent_enforcement_events AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
