-- WP-D2 (UA-3 Business OS, mandat D-450): lead-/mulighetsoppdatering (JARVIS-049 «oppdaterings-/produsentverktøy»).
-- Additiv migrasjon PÅ P0-skjemaet (019_business.sql) - ingen eksisterende kolonne endres.
--
--  1. `next_action` (+ valgfri frist) og `closed_at`/`close_reason` på leads og opportunities: «hva er neste steg» og «lukket med utfall» er første-klasses
--     tilstand i stedet for fritekst i en oppfølging. Stagnasjonsregelen («Sett neste handling …») kan dermed faktisk tilfredsstilles.
--  2. `business_change_log`: før/etter-registrering for HVER lead-/opportunity-endring (opprett, oppdater, stadium/status, neste handling, lukk, slett) i SAMME
--     transaksjon som endringen, og tabellen som gir tjeneste-nivå IDEMPOTENS (`UNIQUE (tenant_id, idempotency_key)`: samme nøkkel = samme effekt, aldri to ganger).
--     Rader er uforanderlige for runtime-rollen (kun SELECT/INSERT; INGEN UPDATE) - DELETE er gitt KUN for Q-20-erasure (kundedata, ikke append-only systemrevisjon,
--     samme klassifisering og begrunnelse som support_*/contract_* i 024/026). Ingen FK til entiteten: en slettet lead/opportunity beholder sin før-tilstand her
--     (løs peker, samme prinsipp som business_scores.evidence) til erasure.
--  3. `GRANT DELETE` på business_leads / business_opportunities / business_scores: trengs for `delete_lead`/`delete_opportunity` (klasse C, bak bekreftelse).
--     Runtime hadde tidligere kun SELECT/INSERT/UPDATE her. Sletting detacher/rydder avhengige rader i samme transaksjon (se pipeline-service.ts); RLS er uendret.
-- Alle tabeller er FORCE RLS med tenant- OG memory-space-policy (samme mønster som resten av Business OS); ingen enkeltkolonne-FK til tenant-eid forelder (JARVIS-076).

ALTER TABLE business_leads
  ADD COLUMN next_action        text,
  ADD COLUMN next_action_due_at timestamptz,
  ADD COLUMN closed_at          timestamptz,
  ADD COLUMN close_reason       text,
  ADD CONSTRAINT business_leads_next_action_len CHECK (next_action IS NULL OR char_length(next_action) BETWEEN 1 AND 500),
  ADD CONSTRAINT business_leads_next_action_due_needs_action CHECK (next_action_due_at IS NULL OR next_action IS NOT NULL),
  ADD CONSTRAINT business_leads_close_reason_len CHECK (close_reason IS NULL OR char_length(close_reason) BETWEEN 1 AND 500);

ALTER TABLE business_opportunities
  ADD COLUMN next_action        text,
  ADD COLUMN next_action_due_at timestamptz,
  ADD COLUMN closed_at          timestamptz,
  ADD COLUMN close_reason       text,
  ADD CONSTRAINT business_opportunities_next_action_len CHECK (next_action IS NULL OR char_length(next_action) BETWEEN 1 AND 500),
  ADD CONSTRAINT business_opportunities_next_action_due_needs_action CHECK (next_action_due_at IS NULL OR next_action IS NOT NULL),
  ADD CONSTRAINT business_opportunities_close_reason_len CHECK (close_reason IS NULL OR char_length(close_reason) BETWEEN 1 AND 500);

-- Eksisterende terminale rader får et omtrentlig lukketidspunkt (siste endring), så `closed_at` er konsistent med status/stage fra dag én.
UPDATE business_leads SET closed_at = updated_at WHERE status IN ('disqualified', 'converted') AND closed_at IS NULL;
UPDATE business_opportunities SET closed_at = updated_at WHERE stage IN ('won', 'lost') AND closed_at IS NULL;

CREATE TABLE business_change_log (
  change_id        text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id  text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  entity_type      text NOT NULL CHECK (entity_type IN ('lead', 'opportunity')),
  entity_id        text NOT NULL,
  action           text NOT NULL CHECK (action IN ('create', 'update', 'set_status', 'move_stage', 'set_next_action', 'close', 'delete')),
  -- Tjeneste-nivå idempotens: samme (tenant, nøkkel) = samme endring. `request_hash` fanger gjenbruk av en nøkkel med ANNET innhold (avvises).
  idempotency_key  text,
  request_hash     text,
  -- Aktør: person-id fra den autentiserte identiteten (ingen FK - en systemaktør «system» er gyldig og skal aldri blokkere logging).
  actor_person_id  text,
  changed_fields   text[] NOT NULL DEFAULT '{}',
  before_state     jsonb,
  after_state      jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT business_change_log_state_present CHECK (before_state IS NOT NULL OR after_state IS NOT NULL)
);
CREATE INDEX business_change_log_entity_idx ON business_change_log (tenant_id, memory_space_id, entity_type, entity_id, created_at DESC);

ALTER TABLE business_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_change_log FORCE ROW LEVEL SECURITY;
CREATE POLICY business_change_log_tenant ON business_change_log
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY business_change_log_space ON business_change_log AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Uforanderlig for runtime (ingen UPDATE). DELETE KUN for Q-20-erasure (modules/erasure/src/plan.ts).
GRANT SELECT, INSERT, DELETE ON business_change_log TO jarvis_app;

-- Sletting av lead/opportunity (klasse C, bak bekreftelse) - og ryddig fjerning av den deriverte scoren (ingen FK; løs entity_id-peker).
GRANT DELETE ON business_leads, business_opportunities, business_scores TO jarvis_app;
