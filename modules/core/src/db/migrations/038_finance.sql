-- UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107, D-64
-- Core-vs-Adapter-porten kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md
-- D-107): Jarvis EIER selv det kanoniske Payment/Spend Intent-domenet
-- (intent -> provider-forespørsel -> utfall -> avstemming, idempotens,
-- deterministisk avviksdeteksjon, eier-kontrollert kill switch) -
-- HYBRID_WITH_CLEAR_AUTHORITY: `payment_intents`/idempotens/avviks-
-- deteksjon/kill-switch er JARVIS_CANONICAL, mens selve den offisielle
-- bokførte regnskapsposten (norsk bokføringslov) forblir Fiken sitt
-- EXTERNAL_CANONICAL ansvar - Jarvis bygger ALDRI om dobbel bokføring/
-- MVA-regelverk selv (masterplanens egen UA-6-prioritering: "Fiken
-- primary accounting connector" er P0, eksplisitt navngitt, ikke et
-- Claude-valgt leverandørvalg - CORE_DEPENDENCY_DECISION_REQUIRED=false).
-- `provider_ref` er en POINTER til Fiken sin egen journalpost, ALDRI en
-- kopi av bokførte data (samme prinsipp som `contracts.canonical_uri`/
-- `marketing_campaigns.external_campaign_id`). Samme RLS-/GRANT-/
-- erasure-mønster som `019_business.sql`/`026_contracts.sql`/
-- `027_growth.sql` - ingen ny sikkerhetsmodell.
--
-- Denne sliceen bygger KUN Fiken (P0). Stripe/Vipps/bank-betaling (P1) og
-- programmerbart bedriftskort/wallet (P2) er BEVISST IKKE bygget - se
-- `provider` CHECK-constraint under (kun 'fiken' foreløpig, utvidbar uten
-- skjemaendring senere).

CREATE TABLE payment_intents (
  payment_intent_id      text PRIMARY KEY,
  tenant_id               text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id          text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Eier-/agent-oppgitt idempotens-nøkkel - UNIQUE per tenant garanterer
  -- deterministisk at en retry ALDRI oppretter en ny intent (akseptanse-
  -- kriterium 1, "Retry cannot double-pay"). ON CONFLICT DO NOTHING
  -- RETURNING i FinanceService.createPaymentIntent() returnerer alltid
  -- SAMME eksisterende rad på gjentatt kall - aldri en duplikat-feil,
  -- aldri en duplikat-intent.
  idempotency_key          text NOT NULL,
  -- Deterministisk lifecycle (finance/src/state-machine.ts) - INGEN LLM
  -- avgjør en overgang.
  state                    text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted','provider_acknowledged','settled','failed','cancelled')),
  purpose                  text NOT NULL,
  -- Beløp i øre (SAMME konvensjon som `marketing_spend_events.spend_amount_ore`/
  -- `business_scores`) - ALDRI flyttall for pengebeløp. > 0 er en DB-håndhevet
  -- deterministisk fangst av feil beløpsformat (akseptansekriterium 3).
  amount_ore                bigint NOT NULL CHECK (amount_ore > 0),
  currency                  text NOT NULL DEFAULT 'NOK' CHECK (currency ~ '^[A-Z]{3}$'),
  vendor_name                text NOT NULL,
  -- Pointer til Fiken sin egen kontakt-ID (contactId), ALDRI en hard FK
  -- (Fiken sitt eget ID-rom, samme "pointer-not-payload"-prinsipp som
  -- `external_campaign_id`) - NULL tillatt for en intent opprettet FØR
  -- vendor er slått opp/matchet i Fiken.
  vendor_provider_ref        text,
  -- Fiken kontokode (format `NNNN` eller `NNNN:NNNNN` for reskontro,
  -- verifisert mot offisiell swagger-spec, D-41). Validert i applikasjons-
  -- laget FØR noe providerkall (deterministisk fangst av feil konto -
  -- akseptansekriterium 3) - CHECK her er et andre, uavhengig sikkerhetsnett.
  account_code               text NOT NULL CHECK (account_code ~ '^\d{4}(:\d{5})?$'),
  -- Motkonto (f.eks. bank-/kontantkonto) for en balansert dobbel bokføring-
  -- postering. BEVISST NULLABLE og IKKE gjettet av Jarvis (D-41: å oppdikte
  -- Tobias sin faktiske bankkontokode i Fiken sin kontoplan ville vært et
  -- reelt gjetning-brudd) - `FinanceService.submitPaymentIntent()` kaster
  -- deterministisk `MissingCounterAccountError` FØR noe providerkall dersom
  -- denne mangler ved innsending (akseptansekriterium 3: feil/manglende
  -- konto fanges deterministisk, aldri stille anta/gjette).
  counter_account_code        text CHECK (counter_account_code ~ '^\d{4}(:\d{5})?$'),
  -- Kun 'fiken' bygget denne sliceen (P0). 'stripe'/'vipps'/'bank' (P1) og
  -- 'card_wallet' (P2) er masterplan-navngitte FREMTIDIGE providere -
  -- CHECK utvides IKKE spekulativt før de faktisk bygges (ingen skjema-
  -- klargjøring for ubygget kapabilitet).
  provider                   text NOT NULL DEFAULT 'fiken' CHECK (provider IN ('fiken')),
  -- Fiken sin egen journalpost-ID etter vellykket postering - pointer,
  -- ALDRI en kopi av den bokførte posten selv.
  provider_ref                text,
  reconciliation_state         text NOT NULL DEFAULT 'unreconciled' CHECK (reconciliation_state IN ('unreconciled','matched','mismatched')),
  -- Deterministiske avviksflagg (ALDRI AI-inferert - Q-26-grensen), f.eks.
  -- "vendor_provider_ref_missing_at_submission" - se FinanceService.
  anomaly_flags                jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason                text,
  owner_person_id                text REFERENCES people (person_id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  submitted_at                     timestamptz,
  settled_at                        timestamptz,
  failed_at                          timestamptz,
  cancelled_at                        timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX payment_intents_lookup_idx ON payment_intents (tenant_id, memory_space_id, state);
CREATE INDEX payment_intents_reconciliation_idx ON payment_intents (tenant_id, reconciliation_state) WHERE reconciliation_state != 'matched';

-- Finans-tidslinje: FØRSTEKLASSES og SEPARAT fra `audit_events` (samme
-- prinsipp som `marketing_campaign_events`/`contract_events`) - dette ER
-- finans-domenets egen historikk.
CREATE TABLE payment_intent_events (
  event_id                 text PRIMARY KEY,
  tenant_id                 text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  payment_intent_id            text NOT NULL REFERENCES payment_intents (payment_intent_id),
  event_type                    text NOT NULL CHECK (event_type IN (
    'intent_created', 'submitted', 'provider_acknowledged', 'settled', 'failed', 'cancelled',
    'anomaly_flagged', 'reconciled', 'kill_switch_blocked'
  )),
  summary                        text NOT NULL,
  actor_person_id                  text REFERENCES people (person_id),
  metadata                          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at                        timestamptz NOT NULL DEFAULT now(),
  created_at                          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_intent_events_timeline_idx ON payment_intent_events (tenant_id, payment_intent_id, occurred_at DESC);

-- Eier-kontrollert finans-nødbryter (akseptansekriterium 5, "Finance kill
-- switch stops new transactions immediately if owner invokes it") -
-- HÅNDHEVES DETERMINISTISK i FinanceService.submitPaymentIntent() (CLAUDE.md
-- regel 2: klasse D-handlinger håndheves i kode, ALDRI kun promptregler).
-- Ett rad per tenant (ikke space-skopet - finans er kontonivå, ikke et
-- minne-space-konsept) - RLS her er derfor en egen, enklere tenant-only
-- policy (IKKE loopet sammen med de space-skopede tabellene under).
CREATE TABLE finance_kill_switch (
  tenant_id                text PRIMARY KEY REFERENCES tenants (tenant_id),
  enabled                    boolean NOT NULL DEFAULT false,
  enabled_by_person_id         text REFERENCES people (person_id),
  enabled_at                    timestamptz,
  disabled_at                    timestamptz,
  reason                          text,
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON
  payment_intents, payment_intent_events, finance_kill_switch
  TO jarvis_app;
-- Q-20: finans-domenet er KUNDEDATA (samme klasse som
-- `contracts`/`marketing_campaigns`, IKKE append-only systemrevisjon som
-- `audit_events`) - registrert i `modules/erasure/src/plan.ts`. Uten
-- denne GRANTen ville ErasureService sin faktiske
-- `DELETE FROM payment_intents/...` feile med permission denied for HELE
-- tenant-/space-erasure-operasjonen (samme presedens/begrunnelse som
-- `024_support.sql`/`026_contracts.sql`/`027_growth.sql`).
GRANT DELETE ON
  payment_intents, payment_intent_events, finance_kill_switch
  TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payment_intents', 'payment_intent_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    -- AS RESTRICTIVE: AND-es med tenant-policyen (default deny uten gyldig
    -- space-kontekst - identisk prinsipp til alle andre business_*/contract_*/
    -- marketing_*-tabeller).
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;

-- finance_kill_switch: tenant-only RLS (ingen memory_space_id-kolonne - se
-- toppkommentar).
ALTER TABLE finance_kill_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_kill_switch FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_kill_switch_tenant ON finance_kill_switch
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));

-- Byggeordren: "Reuse OpenLoopService... No second task/reminder engine."
-- Additiv utvidelse av DEN EKSISTERENDE `business_open_loops`
-- (020_business_open_loops.sql t.o.m. 027_growth.sql), ikke en ny
-- mekanisme: én nullable `payment_intent_id`-pekerkolonne + to nye
-- `loop_type`-verdier for deterministisk betalings-avviks-/avstemmings-
-- deteksjon.
ALTER TABLE business_open_loops ADD COLUMN payment_intent_id text REFERENCES payment_intents (payment_intent_id);
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required',
  'marketing_spend_anomaly',
  'payment_intent_anomaly', 'payment_intent_reconciliation_mismatch'
));
