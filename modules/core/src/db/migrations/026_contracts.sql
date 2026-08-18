-- UA-3 Native Jarvis Contracts Core (D-71, Q-28): Jarvis EIER selv det
-- kanoniske kontrakt-domenet (JARVIS_CANONICAL, D-64 Core-vs-Adapter-porten
-- kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md D-71). ZERO ekstern e-sign-
-- leverandør-avhengighet i denne sliceen (ingen DocuSign/PandaDoc/Signicat/
-- Adobe Sign-tabeller/credentials her) - juridisk signeringsutførelse er en
-- FREMTIDIG, valgfri utførelsesadapter (D-71 REPLACEMENT_PATH), aldri
-- domeneeier. Motpart modelleres via de EKSISTERENDE
-- `business_companies`/`business_contacts`-entitetene (ingen ny
-- motpart-tabell). Samme RLS-/idempotens-/GRANT-mønster som
-- `019_business.sql`/`024_support.sql` - ingen ny sikkerhetsmodell.
--
-- Pakkenavn-merknad: domenepakken heter `@jarvis/agreements`
-- (`modules/agreements`), IKKE `@jarvis/contracts` - det navnet er allerede
-- den delte type-kontrakt-pakken (`packages/contracts`, `IdentityContext`/
-- `MemorySpace`/`JsonValue` osv.), brukt av ALLE moduler inkludert denne.
-- ToolGateway-navnerommet forblir `contract.*` (kun en streng, ingen
-- pakke-kollisjon).

CREATE TABLE contracts (
  contract_id            text PRIMARY KEY,
  -- Menneskelesbart, tenant-uavhengig sekvensnummer (deterministisk
  -- kontraktnummer) - samme IDENTITY-mønster som `support_tickets.ticket_number`.
  contract_number        bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Motpart: gjenbruker EKSISTERENDE Business OS-entiteter (byggeordren §:
  -- "counterparties via existing Business OS company/contact entities") -
  -- ingen ny motpart-/organisasjon-tabell.
  company_id             text REFERENCES business_companies (company_id),
  contact_id             text REFERENCES business_contacts (contact_id),
  title                  text NOT NULL,
  contract_type          text NOT NULL DEFAULT 'other',
  -- Deterministisk lifecycle (agreements/src/state-machine.ts) - INGEN LLM
  -- avgjør om en overgang er juridisk gyldig.
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','active','expiring','expired','terminated','cancelled')),
  effective_date         date,
  start_date             date,
  end_date               date,
  -- Frist for oppsigelse/kansellering (siste dato varsel kan gis for at
  -- kontrakten IKKE skal fornyes automatisk).
  termination_deadline   timestamptz,
  -- Neste fornyelsesdato.
  renewal_date           timestamptz,
  auto_renew             boolean NOT NULL DEFAULT false,
  owner_person_id        text REFERENCES people (person_id),
  -- Pointer-not-payload (samme prinsipp som support_tickets): pekere til
  -- kilden (f.eks. Gmail-tråd/Drive-fil der selve dokumentet ligger), ALDRI
  -- kopiert dokumentinnhold. `source_type='native'` for manuelt opprettede
  -- kontrakter uten noen ekstern kilde.
  source_type            text NOT NULL DEFAULT 'native',
  source_instance_id     text,
  source_thread_id       text,
  source_message_id      text,
  canonical_uri          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contracts_lookup_idx ON contracts (tenant_id, memory_space_id, status);
CREATE INDEX contracts_company_idx ON contracts (tenant_id, company_id);
CREATE INDEX contracts_contact_idx ON contracts (tenant_id, contact_id);
CREATE UNIQUE INDEX contracts_number_idx ON contracts (tenant_id, contract_number);
CREATE INDEX contracts_renewal_idx ON contracts (tenant_id, renewal_date) WHERE renewal_date IS NOT NULL;
CREATE INDEX contracts_termination_idx ON contracts (tenant_id, termination_deadline) WHERE termination_deadline IS NOT NULL;

-- Kontraktversjoner: EKSPLISITTE og IMMUTABLE (ingen updated_at, aldri
-- UPDATE-t etter innsetting - kun nye rader). `contracts` holder bevisst
-- INGEN `current_version_id`-kolonne (ville skapt en sirkulær FK mot denne
-- tabellen og komplisert Q-20-sletterekkefølgen unødvendig) - "gjeldende
-- versjon" er alltid `SELECT ... ORDER BY version_number DESC LIMIT 1`.
CREATE TABLE contract_versions (
  version_id             text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  contract_id            text NOT NULL REFERENCES contracts (contract_id),
  version_number         bigint NOT NULL,
  -- Kort, strukturert sammendrag av HVA som endret seg i denne versjonen
  -- (ALDRI full dokumenttekst - pointer-not-payload).
  summary                text NOT NULL,
  status_at_version      text,
  source_type            text,
  source_instance_id     text,
  source_message_id      text,
  canonical_uri          text,
  created_by_person_id   text REFERENCES people (person_id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contract_id, version_number)
);
CREATE INDEX contract_versions_lookup_idx ON contract_versions (tenant_id, contract_id, version_number DESC);

CREATE TABLE contract_obligations (
  obligation_id          text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  contract_id            text NOT NULL REFERENCES contracts (contract_id),
  description            text NOT NULL,
  owner_person_id        text REFERENCES people (person_id),
  due_at                 timestamptz,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','waived')),
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_obligations_lookup_idx ON contract_obligations (tenant_id, contract_id, status);
CREATE INDEX contract_obligations_due_idx ON contract_obligations (tenant_id, due_at) WHERE status = 'open';

-- Kontrakt-tidslinje: FØRSTEKLASSES og SEPARAT fra `audit_events` (systemets
-- egen operasjonelle revisjonslogg, skrevet automatisk av ToolGateway for
-- klasse B/C/D-handlinger) - dette ER kontrakt-historikken, ikke en
-- duplisert audit-mekanisme. Samme prinsipp som `support_ticket_events`.
CREATE TABLE contract_events (
  event_id               text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  contract_id            text NOT NULL REFERENCES contracts (contract_id),
  event_type             text NOT NULL CHECK (event_type IN (
    'contract_created', 'version_added', 'status_changed', 'obligation_added', 'obligation_completed',
    'obligation_waived', 'renewal_date_changed', 'termination_deadline_changed', 'counterparty_linked', 'owner_changed'
  )),
  summary                text NOT NULL,
  actor_person_id        text REFERENCES people (person_id),
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_events_timeline_idx ON contract_events (tenant_id, contract_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON contracts, contract_versions, contract_obligations, contract_events TO jarvis_app;
-- Q-20: kontrakt-domenet er KUNDEDATA (samme klasse som
-- `support_tickets`/`memory_items`, IKKE append-only systemrevisjon som
-- `audit_events`) - registrert i `modules/erasure/src/plan.ts`. Uten denne
-- GRANTen ville ErasureService sin faktiske `DELETE FROM contracts/...`
-- feile med permission denied for HELE tenant-/space-erasure-operasjonen
-- (samme presedens/begrunnelse som `024_support.sql`).
GRANT DELETE ON contracts, contract_versions, contract_obligations, contract_events TO jarvis_app;

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY contracts_tenant ON contracts
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY contracts_space ON contracts AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE contract_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_versions_tenant ON contract_versions
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY contract_versions_space ON contract_versions AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE contract_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_obligations_tenant ON contract_obligations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY contract_obligations_space ON contract_obligations AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE contract_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_events FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_events_tenant ON contract_events
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY contract_events_space ON contract_events AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Byggeordren: "Reuse OpenLoopService for things such as: contract_renewal_due,
-- contract_termination_deadline, contract_obligation_due,
-- contract_review_required. No second task/reminder engine." - additiv
-- utvidelse av DEN EKSISTERENDE `business_open_loops`
-- (020_business_open_loops.sql/024_support.sql), ikke en ny mekanisme: én
-- nullable `contract_id`-pekerkolonne + fire nye `loop_type`-verdier.
ALTER TABLE business_open_loops ADD COLUMN contract_id text REFERENCES contracts (contract_id);
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required'
));
