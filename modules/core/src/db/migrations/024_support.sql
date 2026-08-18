-- UA-3 Native Jarvis Support Core (D-66, Q-27 basen uendret): Jarvis EIER
-- selv det kanoniske support/ticket-domenet (JARVIS_CANONICAL, D-64
-- Core-vs-Adapter-porten kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md D-66).
-- ZERO ekstern support-leverandør-avhengighet (ingen Zendesk/Intercom/
-- Freshdesk-tabeller/credentials her). Gmail er FØRSTE ingress-/egress-kanal,
-- men KUN via den EKSISTERENDE `GmailTransport` (ToolGateway) - ticket-
-- domenemodellen holder seg leverandørnøytral: kun generiske
-- `source_type`/`source_instance_id`/`source_thread_id`/`source_message_id`/
-- `canonical_uri`-pekere, ALDRI Gmail-spesifikke kolonner (§6/§11 i
-- byggeordren). Samme RLS-/idempotens-/GRANT-mønster som `019_business.sql`/
-- `020_business_open_loops.sql` - ingen ny sikkerhetsmodell.

CREATE TABLE support_tickets (
  ticket_id             text PRIMARY KEY,
  -- Menneskelesbart, tenant-uavhengig sekvensnummer (§4 i byggeordren:
  -- "ticket number") - IDENTITY er kollisjonsfri på tvers av tenants uten
  -- ekstra koordinering, samme pattern som Postgres sin egen anbefalte
  -- erstatning for SERIAL.
  ticket_number          bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  company_id             text REFERENCES business_companies (company_id),
  contact_id             text REFERENCES business_contacts (contact_id),
  subject                text NOT NULL,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','waiting_customer','waiting_internal','resolved','closed')),
  priority               text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assignee_person_id     text REFERENCES people (person_id),
  -- §6 i byggeordren: provider-nøytral kanal-modell - "email" er FØRSTE kanal,
  -- fremtidige kanaler (portal/chat/sms/adapter) legges til her UTEN å endre
  -- ticket-domenemodellen for øvrig.
  channel                text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','manual','other')),
  -- Pointer-not-payload (§11): pekere til kilden, ALDRI kopiert
  -- meldingsinnhold. `source_type='native'` for manuelt/internt opprettede
  -- tickets uten noen ekstern kilde.
  source_type            text NOT NULL DEFAULT 'native',
  source_instance_id     text,
  source_thread_id       text,
  source_message_id      text,
  canonical_uri          text,
  -- §9 i byggeordren: deterministisk entitetsgjenkjenning - MATCHED/
  -- UNMATCHED/AMBIGUOUS. En ambiguous/unmatched ticket forblir GYLDIG
  -- (§9: "should not necessarily be discarded"), kun uten company_id/
  -- contact_id-kobling.
  entity_resolution      text NOT NULL DEFAULT 'unmatched' CHECK (entity_resolution IN ('matched','unmatched','ambiguous')),
  next_response_due_at   timestamptz,
  next_action_due_at     timestamptz,
  resolved_at            timestamptz,
  closed_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- Idempotent ingestion (§8: "same provider thread -> same logical ticket"),
  -- SAMME mønster som `business_activities`/`business_leads` sin
  -- UNIQUE-basert kilde-ingestion. NULL `source_thread_id` (manuelt
  -- opprettede tickets) deltar ALDRI i denne unikheten - Postgres behandler
  -- NULL <> NULL i unique-constraints, samme presedens som
  -- `business_followups.idempotency_key`.
  UNIQUE (tenant_id, source_type, source_instance_id, source_thread_id)
);
CREATE INDEX support_tickets_lookup_idx ON support_tickets (tenant_id, memory_space_id, status, priority);
CREATE INDEX support_tickets_company_idx ON support_tickets (tenant_id, company_id);
CREATE INDEX support_tickets_contact_idx ON support_tickets (tenant_id, contact_id);
CREATE UNIQUE INDEX support_tickets_number_idx ON support_tickets (tenant_id, ticket_number);

CREATE TABLE support_ticket_events (
  event_id               text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  ticket_id              text NOT NULL REFERENCES support_tickets (ticket_id),
  -- §12 i byggeordren: ticket-historikk er FØRSTEKLASSES og SEPARAT fra
  -- `audit_events` (systemets egen operasjonelle revisjonslogg) - dette ER
  -- kunde-tidslinjen, ikke en duplisert audit-mekanisme.
  event_type             text NOT NULL CHECK (event_type IN (
    'ticket_created', 'customer_message', 'agent_reply', 'internal_note', 'status_changed',
    'priority_changed', 'assigned', 'unassigned', 'resolved', 'closed', 'reopened', 'deadline_changed'
  )),
  summary                text NOT NULL,
  actor_person_id        text REFERENCES people (person_id),
  -- Pointer-not-payload - samme prinsipp som business_activities.
  source_type            text,
  source_instance_id     text,
  source_message_id      text,
  canonical_uri          text,
  -- Strukturert, ikke-hemmelig ekstra kontekst (f.eks. gammel/ny status ved
  -- status_changed) - ALDRI rå eksternt meldingsinnhold (det ligger i
  -- Knowledge/kildelaget, kun pekt til via canonical_uri).
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- §8: "same provider message -> one logical support_ticket_event", "repeated
  -- worker delivery -> no duplicate event" - idempotent via UNIQUE, SAMME
  -- ON CONFLICT-mønster som resten av Business OS. NULL source_message_id
  -- (interne hendelser: status_changed/assigned/internal_note uten en ekstern
  -- melding) deltar ALDRI i denne unikheten.
  UNIQUE (tenant_id, source_type, source_instance_id, source_message_id)
);
CREATE INDEX support_ticket_events_timeline_idx ON support_ticket_events (tenant_id, ticket_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON support_tickets, support_ticket_events TO jarvis_app;
-- Q-20 (§21 i byggeordren): support-tickets/-events er KUNDEDATA (samme
-- klasse som `memory_items`/`knowledge_documents`, IKKE append-only
-- systemrevisjon som `audit_events` - se `018_erasure.sql` sin eksplisitte
-- DELETE-allowliste-begrunnelse) - registrert i `modules/erasure/src/plan.ts`
-- sin `planMemorySpaceInContext()`. Uten denne GRANTen ville ErasureService
-- sin faktiske `DELETE FROM support_tickets/...`-utfoerelse feile med
-- permission denied for HELE tenant-/space-erasure-operasjonen, ikke bare
-- disse to tabellene.
GRANT DELETE ON support_tickets, support_ticket_events TO jarvis_app;

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY support_tickets_tenant ON support_tickets
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY support_tickets_space ON support_tickets AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE support_ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_events FORCE ROW LEVEL SECURITY;
CREATE POLICY support_ticket_events_tenant ON support_ticket_events
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY support_ticket_events_space ON support_ticket_events AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- §17 i byggeordren: "Reuse existing OpenLoopService. Do not build another
-- work queue." - additiv utvidelse av DEN EKSISTERENDE `business_open_loops`
-- (020_business_open_loops.sql), ikke en ny mekanisme: én nullable
-- `ticket_id`-pekerkolonne + fire nye `loop_type`-verdier for support-regler.
ALTER TABLE business_open_loops ADD COLUMN ticket_id text REFERENCES support_tickets (ticket_id);
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal'
));
