-- UA-3 Native Jarvis Product Core (D-128): Jarvis EIER selv det kanoniske
-- produkt-tilbakemeldings-/roadmap-domenet (JARVIS_CANONICAL, D-64 Core-vs-
-- Adapter-porten kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md D-128). ZERO
-- ekstern produkt-analytics-/issue-tracker-leverandør-avhengighet i denne
-- sliceen (ingen Linear/Jira/GitHub Issues/Mixpanel/Amplitude-tabeller/
-- credentials her) - et fremtidig eksternt verktøy er en VALGFRI, senere
-- adapter, aldri domeneeier. Rapportør modelleres via de EKSISTERENDE
-- `business_companies`/`business_contacts`-entitetene (ingen ny
-- rapportør-/organisasjon-tabell). Samme RLS-/idempotens-/GRANT-mønster som
-- `019_business.sql`/`024_support.sql`/`026_contracts.sql` - ingen ny
-- sikkerhetsmodell.

CREATE TABLE product_items (
  item_id                text PRIMARY KEY,
  -- Menneskelesbart, tenant-uavhengig sekvensnummer - samme IDENTITY-mønster
  -- som `contracts.contract_number`/`support_tickets.ticket_number`.
  item_number            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Rapportør (kunden som meldte inn): gjenbruker EKSISTERENDE Business OS-
  -- entiteter - ingen ny rapportør-/organisasjon-tabell. Nullable: interne
  -- produktideer/utsagn har ikke nødvendigvis en ekstern rapportør.
  company_id             text REFERENCES business_companies (company_id),
  contact_id             text REFERENCES business_contacts (contact_id),
  title                  text NOT NULL,
  description            text,
  item_type              text NOT NULL DEFAULT 'feature_request' CHECK (item_type IN ('feature_request','bug_report','usage_feedback','improvement')),
  -- Deterministisk lifecycle (product/src/state-machine.ts) - INGEN LLM
  -- avgjør om en overgang er gyldig (samme prinsipp som kontrakt-lifecyclen).
  status                 text NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','planned','in_progress','shipped','declined','closed')),
  priority               text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  owner_person_id        text REFERENCES people (person_id),
  -- Pointer-not-payload (samme prinsipp som support_tickets/contracts):
  -- pekere til kilden, ALDRI kopiert innhold. `source_type='native'` for
  -- manuelt opprettede punkter uten ekstern kilde.
  source_type            text NOT NULL DEFAULT 'native',
  source_instance_id     text,
  source_message_id      text,
  canonical_uri          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  closed_at              timestamptz
);
CREATE INDEX product_items_lookup_idx ON product_items (tenant_id, memory_space_id, status);
CREATE INDEX product_items_company_idx ON product_items (tenant_id, company_id);
CREATE INDEX product_items_contact_idx ON product_items (tenant_id, contact_id);
CREATE UNIQUE INDEX product_items_number_idx ON product_items (tenant_id, item_number);
CREATE INDEX product_items_priority_open_idx ON product_items (tenant_id, priority) WHERE status NOT IN ('shipped','declined','closed');

-- Produkt-tidslinje: FØRSTEKLASSES og SEPARAT fra `audit_events` - dette ER
-- produkt-punktets historikk, ikke en duplisert audit-mekanisme. Samme
-- prinsipp som `contract_events`/`support_ticket_events`.
CREATE TABLE product_item_events (
  event_id               text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  item_id                text NOT NULL REFERENCES product_items (item_id),
  event_type             text NOT NULL CHECK (event_type IN (
    'item_created', 'status_changed', 'priority_changed', 'owner_changed', 'reporter_linked'
  )),
  summary                text NOT NULL,
  actor_person_id        text REFERENCES people (person_id),
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_item_events_timeline_idx ON product_item_events (tenant_id, item_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON product_items, product_item_events TO jarvis_app;
-- Q-20: produkt-domenet er KUNDEDATA (samme klasse som
-- `contracts`/`support_tickets`, IKKE append-only systemrevisjon som
-- `audit_events`) - registrert i `modules/erasure/src/plan.ts`. Uten denne
-- GRANTen ville ErasureService sin faktiske `DELETE FROM product_items/...`
-- feile med permission denied for HELE tenant-/space-erasure-operasjonen
-- (samme presedens/begrunnelse som `026_contracts.sql`).
GRANT DELETE ON product_items, product_item_events TO jarvis_app;

ALTER TABLE product_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_items FORCE ROW LEVEL SECURITY;
CREATE POLICY product_items_tenant ON product_items
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY product_items_space ON product_items AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE product_item_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_item_events FORCE ROW LEVEL SECURITY;
CREATE POLICY product_item_events_tenant ON product_item_events
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY product_item_events_space ON product_item_events AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Gjenbruker DEN EKSISTERENDE `business_open_loops` (020_business_open_loops.sql)
-- - additiv utvidelse, INGEN nytt task-/reminder-motor (samme mønster som
-- `026_contracts.sql`): én nullable, domene-prefikset `product_item_id`-
-- pekerkolonne (samme "prefikset i open-loops, kort i egen tabell"-mønster
-- som `finance_procurement_item_id` -> `finance_procurement_items.procurement_item_id`
-- i 044_finance_procurement_openloop.sql) + to nye `loop_type`-verdier.
ALTER TABLE business_open_loops ADD COLUMN product_item_id text REFERENCES product_items (item_id);
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required',
  'marketing_spend_anomaly', 'payment_intent_anomaly', 'payment_intent_reconciliation_mismatch',
  'finance_spend_unexpected', 'finance_spend_amount_deviation', 'finance_recurring_charge_missing',
  'finance_recurring_charge_duplicate', 'finance_spend_correction_conflict',
  'bank_transaction_unmatched', 'bank_consent_attention', 'card_anomaly_attention', 'finance_procurement_missing',
  'product_item_needs_triage', 'product_item_high_priority_stalled'
));
