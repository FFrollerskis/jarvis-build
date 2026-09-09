-- UA-3 Native Jarvis Operations Core (D-129): Jarvis EIER selv det kanoniske
-- business-operations-domenet (JARVIS_CANONICAL, D-64 Core-vs-Adapter-porten
-- kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md D-129). Masterplan §13
-- (linje 748): "Operations - Tasks, owners, deadlines, suppliers, runbooks,
-- escalations". Dette er BEDRIFTENS driftsdomene (leverandører/oppgaver/
-- runbooks/eskalering), IKKE Jarvis sitt eget infra-driftsdomene
-- (modules/watchdog/modules/incidents/modules/policy sin InfraExecutionGate
-- forblir uendret og urelatert - navnelikhet "operations" beviser ALDRI
-- eksisterende kapasitet, D-64).
--
-- `operations_vendors` er BEVISST distinkt fra `finance_vendors`
-- (045_finance_vendor_registry.sql): `finance_vendors` er et
-- betalingsmotpart-identitetsregister for rekonsiliering (D-116, IBAN/
-- organisasjonsnummer/betalingsprovider-kobling), IKKE et leverandør-/
-- driftsregister med kategori/kontakt/eskaleringskontakt/runbooks. De to
-- tabellene kan begge referere samme reelle leverandør, men eier HVER SIN
-- del av sannheten - ingen sammenslåing i denne sliceen (ingen FK mellom
-- dem; en fremtidig kobling er en EGEN, senere beslutning om noen faktisk
-- trenger den).
--
-- ZERO ekstern leverandør-/ticketing-/runbook-plattform-avhengighet i denne
-- sliceen (ingen Jira/ServiceNow/Notion-tabeller/credentials her) - et
-- fremtidig eksternt verktøy er en VALGFRI, senere adapter, aldri
-- domeneeier. Samme RLS-/idempotens-/GRANT-/tidslinje-mønster som
-- `026_contracts.sql`/`047_product.sql` - ingen ny sikkerhetsmodell.

CREATE TABLE operations_vendors (
  vendor_id                    text PRIMARY KEY,
  vendor_number                bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id                    text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id              text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Valgfri kobling til EKSISTERENDE Business OS-entiteter dersom
  -- leverandøren OGSÅ er en kjent company/contact - ingen ny organisasjons-
  -- tabell.
  company_id                   text REFERENCES business_companies (company_id),
  contact_id                   text REFERENCES business_contacts (contact_id),
  name                         text NOT NULL,
  category                     text NOT NULL DEFAULT 'general' CHECK (category IN ('general','it','facilities','logistics','professional_services','other')),
  status                       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  -- Intern person som eskaleres til ved leverandørproblemer (§13: "escalations").
  escalation_contact_person_id text REFERENCES people (person_id),
  notes                        text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operations_vendors_lookup_idx ON operations_vendors (tenant_id, memory_space_id, status);
CREATE UNIQUE INDEX operations_vendors_number_idx ON operations_vendors (tenant_id, vendor_number);
-- Arkitekt-review MERGE BLOCKER (D-129, PR #78): en enkel `vendor_id text
-- PRIMARY KEY`-FK er IKKE en autorisasjonsgrense - Postgres sin FK-sjekk
-- kjører med forhøyet privilegium og omgår RLS, så et FK-mål fra en ANNEN
-- tenant/space ville blitt akseptert stille. Denne UNIQUE-nøkkelen er
-- FK-MÅLET for de sammensatte `(tenant_id, memory_space_id, vendor_id)`-
-- fremmednøklene under - operations_runbooks/operations_tasks kan derfor
-- STRUKTURELT (håndhevet av Postgres selv, ikke bare tillit til
-- applikasjonskode) kun peke til en leverandør i EGEN tenant+space.
ALTER TABLE operations_vendors ADD CONSTRAINT operations_vendors_tenant_space_key UNIQUE (tenant_id, memory_space_id, vendor_id);

-- Runbooks: kanonisk, Jarvis-eid driftsdokumentasjon (§13: "runbooks").
-- Innholdet lagres DIREKTE (`content`) - dette ER Jarvis sin egen
-- forfattede driftskunnskap, IKKE en peker til ubetrodd eksternt innhold
-- (annerledes enn f.eks. `knowledge_documents`, som er Ingestion Zone-data).
CREATE TABLE operations_runbooks (
  runbook_id      text PRIMARY KEY,
  runbook_number  bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Sammensatt FK til `operations_vendors` lagt til NEDENFOR (etter
  -- tabellen) - IKKE en enkel `REFERENCES operations_vendors (vendor_id)`
  -- her (arkitekt-review MERGE BLOCKER, se `operations_vendors_tenant_space_key`
  -- sin kommentar over: en enkel FK er ikke en tenant/space-autorisasjonsgrense).
  vendor_id       text,
  title           text NOT NULL,
  category        text NOT NULL DEFAULT 'general' CHECK (category IN ('general','vendor_escalation','incident_response','onboarding','offboarding','maintenance')),
  content         text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  owner_person_id text REFERENCES people (person_id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operations_runbooks_lookup_idx ON operations_runbooks (tenant_id, memory_space_id, is_active);
CREATE INDEX operations_runbooks_vendor_idx ON operations_runbooks (tenant_id, vendor_id);
CREATE UNIQUE INDEX operations_runbooks_number_idx ON operations_runbooks (tenant_id, runbook_number);
-- Sammensatt, tenant/space-trygg fremmednøkkel (MATCH SIMPLE - default -
-- betyr NULL vendor_id fortsatt tillatt, kun håndhevet naar satt): et
-- runbook kan STRUKTURELT kun kobles til en leverandør i EGEN tenant+space.
ALTER TABLE operations_runbooks ADD CONSTRAINT operations_runbooks_vendor_tenant_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, vendor_id) REFERENCES operations_vendors (tenant_id, memory_space_id, vendor_id);
-- FK-MÅL for `operations_tasks.runbook_id` sin sammensatte fremmednøkkel under.
ALTER TABLE operations_runbooks ADD CONSTRAINT operations_runbooks_tenant_space_key UNIQUE (tenant_id, memory_space_id, runbook_id);

-- Tasks: §13 "Tasks, owners, deadlines" + eskaleringstilstand (§13
-- "escalations"). Deterministisk lifecycle (operations/src/state-machine.ts)
-- - INGEN LLM avgjør en overgang (samme prinsipp som kontrakt-/produkt-
-- lifecyclen). Eskalering er en EKSPLISITT, deterministisk handling
-- (OperationsService.escalateTask, samme "state, ikke side-effekt-motor"-
-- prinsipp) - OpenLoopService overflater KUN hvilke oppgaver som trenger
-- eskalering, bygger ALDRI en ny varslings-/reminder-motor (§ "Reuse
-- OpenLoopService", samme presedens som Contracts/Product).
CREATE TABLE operations_tasks (
  task_id               text PRIMARY KEY,
  task_number           bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Sammensatte FK-er til operations_vendors/operations_runbooks lagt til
  -- NEDENFOR (samme "enkel FK er ikke en autorisasjonsgrense"-begrunnelse
  -- som operations_runbooks.vendor_id over).
  vendor_id             text,
  runbook_id            text,
  title                 text NOT NULL,
  description           text,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  priority              text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  owner_person_id       text REFERENCES people (person_id),
  due_at                timestamptz,
  -- Eskaleringsnivå 0 = ikke eskalert. Eksplisitt satt av
  -- `OperationsService.escalateTask` - ALDRI automatisk inkrementert av en
  -- sveip (deteksjon overflater behovet som et open loop; en person/agent
  -- utfører selve eskaleringen som en sporbar handling).
  escalation_level      integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  escalated_at          timestamptz,
  escalated_to_person_id text REFERENCES people (person_id),
  -- Pointer-not-payload (samme prinsipp som support_tickets/contracts/product_items).
  source_type           text NOT NULL DEFAULT 'native',
  source_instance_id    text,
  source_message_id     text,
  canonical_uri         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz
);
CREATE INDEX operations_tasks_lookup_idx ON operations_tasks (tenant_id, memory_space_id, status);
CREATE INDEX operations_tasks_vendor_idx ON operations_tasks (tenant_id, vendor_id);
CREATE UNIQUE INDEX operations_tasks_number_idx ON operations_tasks (tenant_id, task_number);
CREATE INDEX operations_tasks_due_open_idx ON operations_tasks (tenant_id, due_at) WHERE status NOT IN ('done','cancelled');
-- Sammensatte, tenant/space-trygge fremmednøkler (samme begrunnelse som
-- operations_runbooks.vendor_id over): en driftsoppgave kan STRUKTURELT
-- kun kobles til en leverandør/et runbook i EGEN tenant+space.
ALTER TABLE operations_tasks ADD CONSTRAINT operations_tasks_vendor_tenant_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, vendor_id) REFERENCES operations_vendors (tenant_id, memory_space_id, vendor_id);
ALTER TABLE operations_tasks ADD CONSTRAINT operations_tasks_runbook_tenant_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, runbook_id) REFERENCES operations_runbooks (tenant_id, memory_space_id, runbook_id);
-- FK-MÅL for `operations_task_events.task_id`/`business_open_loops.operations_task_id`
-- sine sammensatte fremmednøkler under (arkitekt-review-tillegg, PR #78:
-- "vurder hvilke av de to siste som også bør scope-bindes strukturelt" -
-- begge er billige, smale tillegg som IKKE endrer noen eksisterende
-- pre-D-129-tabell sin semantikk, derfor gjort).
ALTER TABLE operations_tasks ADD CONSTRAINT operations_tasks_tenant_space_key UNIQUE (tenant_id, memory_space_id, task_id);

-- Oppgave-tidslinje: FØRSTEKLASSES og SEPARAT fra `audit_events` - samme
-- prinsipp som `contract_events`/`support_ticket_events`/`product_item_events`.
-- `task_id` sin FK er sammensatt (se ALTER TABLE under) - IKKE en enkel
-- `REFERENCES operations_tasks (task_id)` (samme scope-trygghets-begrunnelse
-- som resten av denne migrasjonen, selv om `insertEvent()` i praksis ALDRI
-- mottar en ubetrodd `task_id` fra en ekstern kaller - kun defense-in-depth).
CREATE TABLE operations_task_events (
  event_id        text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  task_id         text NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN (
    'task_created', 'status_changed', 'priority_changed', 'owner_changed', 'due_at_changed', 'vendor_linked', 'runbook_linked', 'escalated'
  )),
  summary         text NOT NULL,
  actor_person_id text REFERENCES people (person_id),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operations_task_events_timeline_idx ON operations_task_events (tenant_id, task_id, occurred_at DESC);
ALTER TABLE operations_task_events ADD CONSTRAINT operations_task_events_task_tenant_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, task_id) REFERENCES operations_tasks (tenant_id, memory_space_id, task_id);

GRANT SELECT, INSERT, UPDATE ON operations_vendors, operations_runbooks, operations_tasks, operations_task_events TO jarvis_app;
-- Q-20: operations-domenet inneholder KUNDE-/BEDRIFTSDATA (leverandør-
-- kontaktinfo/kontaktperson-koblinger) - samme klasse som
-- `contracts`/`support_tickets`/`product_items`, IKKE append-only
-- systemrevisjon. Registrert i `modules/erasure/src/plan.ts`. Uten denne
-- GRANTen ville ErasureService sin faktiske `DELETE FROM operations_*`
-- feile med permission denied for HELE tenant-/space-erasure-operasjonen
-- (samme presedens som `026_contracts.sql`/`047_product.sql`).
GRANT DELETE ON operations_vendors, operations_runbooks, operations_tasks, operations_task_events TO jarvis_app;

ALTER TABLE operations_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_vendors FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_vendors_tenant ON operations_vendors
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY operations_vendors_space ON operations_vendors AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE operations_runbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_runbooks FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_runbooks_tenant ON operations_runbooks
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY operations_runbooks_space ON operations_runbooks AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE operations_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_tasks_tenant ON operations_tasks
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY operations_tasks_space ON operations_tasks AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE operations_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_task_events FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_task_events_tenant ON operations_task_events
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY operations_task_events_space ON operations_task_events AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Gjenbruker DEN EKSISTERENDE `business_open_loops` (020_business_open_loops.sql)
-- - additiv utvidelse, INGEN nytt task-/reminder-motor (samme mønster som
-- `047_product.sql`): én nullable, domene-prefikset `operations_task_id`-
-- pekerkolonne + to nye `loop_type`-verdier (forfalt oppgave, oppgave som
-- trenger eskalering).
-- Sammensatt FK (samme scope-trygghets-begrunnelse som resten av denne
-- migrasjonen) - IKKE en enkel `REFERENCES operations_tasks (task_id)`.
-- `OpenLoopService` skriver KUN denne kolonnen internt fra en allerede
-- RLS-scopet oppgave i SAMME transaksjon (aldri fra en ubetrodd ekstern
-- kaller), men den sammensatte FK-en lukker gapet strukturelt uansett,
-- uten å røre noen av `business_open_loops` sine ANDRE, pre-eksisterende
-- domene-pekerkolonner (ticket_id/contract_id/campaign_id/product_item_id
-- - IKKE i scope for denne sliceen, samme "unødvendig bred schema-endring"-
-- avgrensning som arkitekt-reviewen selv ba om å unngå).
ALTER TABLE business_open_loops ADD COLUMN operations_task_id text;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_operations_task_tenant_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, operations_task_id) REFERENCES operations_tasks (tenant_id, memory_space_id, task_id);
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required',
  'marketing_spend_anomaly', 'payment_intent_anomaly', 'payment_intent_reconciliation_mismatch',
  'finance_spend_unexpected', 'finance_spend_amount_deviation', 'finance_recurring_charge_missing',
  'finance_recurring_charge_duplicate', 'finance_spend_correction_conflict',
  'bank_transaction_unmatched', 'bank_consent_attention', 'card_anomaly_attention', 'finance_procurement_missing',
  'product_item_needs_triage', 'product_item_high_priority_stalled',
  'operations_task_overdue', 'operations_task_escalation_needed'
));
