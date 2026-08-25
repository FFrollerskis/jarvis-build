-- UA-6 Finance & Spend Integrity Gateway - TREDJE slice (Slice 3, D-107):
-- Stripe Payments, Refunds, Webhooks & Reconciliation Adapter. D-64
-- Core-vs-Adapter-porten kjørt FØRST (se DECISIONS_AND_ASSUMPTIONS.md) -
-- HYBRID_WITH_CLEAR_AUTHORITY, SAMME mønster som D-107 sin Fiken-port:
-- Jarvis EIER selv payment_intents/idempotens/kill-switch/avviksdeteksjon/
-- avstemming (JARVIS_CANONICAL), Stripe forblir EXTERNAL_CANONICAL for
-- selve PaymentIntent-/Charge-/Refund-tilstanden og webhook-hendelses-
-- identiteten. Stripe er masterplan-navngitt P1 (SAMME liste som Vipps/
-- bank - "Fiken=P0/bank+Stripe+Vipps=P1", D-107 §innledning) - ALDRI et
-- stille Claude-leverandørvalg (CORE_DEPENDENCY_DECISION_REQUIRED=false).
--
-- Gjenbruker den EKSISTERENDE `payment_intents`-livssyklusen (038_finance.sql)
-- UENDRET i struktur - `provider`-CHECK utvides fra KUN 'fiken' til
-- ('fiken','stripe') (038 sin egen toppkommentar varslet eksplisitt at
-- dette ville komme "utvidbar uten skjemaendring senere" for selve
-- tabellen - CHECK-utvidelsen her ER den varslede utvidelsen).
-- `account_code`/`counter_account_code` sitt strenge Fiken-kontoformat
-- (`^\d{4}(:\d{5})?$`) gjøres betinget PÅ provider - Stripe har intet
-- norsk kontoplan-konsept, men account_code forblir en obligatorisk
-- generell intern bokføringskategori-tag (ALDRI gjettet av Jarvis - eier/
-- agent oppgir den fortsatt eksplisitt ved opprettelse, uavhengig av
-- provider). `provider_ref` (eksisterende generisk pointer-kolonne)
-- gjenbrukes UENDRET for Stripe sin PaymentIntent-id (pi_xxx) - SAMME
-- "pointer, aldri en kopi av leverandørdata"-prinsipp som Fiken sin
-- journalpost-id.
--
-- Nye observasjonelle kolonner på payment_intents (provider-rapportert
-- tilstand, ALDRI autoritativ over Jarvis sin egen `state`-maskin):
-- `provider_status`/`provider_reported_amount_ore`/`provider_reported_currency`/
-- `provider_status_updated_at` (vokter mot at en eldre webhook noensinne
-- overskriver en nyere allerede etablert tilstand - byggeordrens §7) og
-- `latest_stripe_event_id` (BEVISST INGEN FK mot stripe_webhook_events -
-- ville vært en sirkulær FK mellom de to tabellene, samme "pointer, ikke
-- fremmednøkkel" prinsipp som provider_ref).
--
-- To nye tabeller (BEGGE plassert bak den EKSISTERENDE payment_intents-
-- FKen, ALDRI en ny Stripe-spesifikk "shadow"-avstemmingsmekanisme):
-- `stripe_webhook_events` (leverandør-hendelses-idempotens - Stripe sin
-- egen `event.id` ER primærnøkkelen, SAMME ON-CONFLICT-DO-NOTHING-
-- idempotensmønster som `payment_intents.idempotency_key`) og
-- `stripe_refunds` (refusjon som egen finans-handling, SAMME 6-tilstands
-- livssyklus-vokabular som payment_intents - gjenbruker mønsteret, ikke
-- et nytt).
--
-- Eier-tilkoblet, ETT-GLOBALT-Stripe-konto-mønster (SAMME "single-owner,
-- ikke multi-kunde-SaaS" presedens som JARVIS_FIKEN_*/JARVIS_GOOGLE_ADS_*/
-- JARVIS_GITHUB_TOKEN) - `JARVIS_STRIPE_TENANT_ID` (.env.example) er den
-- ENE eier-autoriserte tenanten dette Stripe-kontoet tilhører. Ekte
-- multi-konto/multi-tenant Stripe (Stripe Connect) er EKSPLISITT IKKE
-- bygget denne sliceen (D-41: ingen skjema-klargjøring for ubygget
-- kapabilitet) - men selve sikkerhetsinvarianten (webhook-ruting stoler
-- ALDRI på nyttelast-metadata alene, enhver payment_intents-oppslag via
-- provider_ref kryssjekker tenant_id FØR noe skrives -
-- PROVIDER_OBJECT_TENANT_CONFLICT ved avvik) HÅNDHEVES i applikasjonskode
-- (FinanceService), uavhengig av at kun ĒN tenant faktisk er konfigurert
-- i dag.
--
-- RLS/GRANT/erasure-mønster IDENTISK med 038_finance.sql/039_finance_spend_
-- integrity.sql - ingen ny sikkerhetsmodell.

-- === payment_intents: provider-utvidelse + observasjonelle Stripe-felt ===

ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_provider_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_provider_check CHECK (provider IN ('fiken', 'stripe'));

ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_account_code_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_account_code_check
  CHECK (provider != 'fiken' OR account_code ~ '^\d{4}(:\d{5})?$');

ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_counter_account_code_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_counter_account_code_check
  CHECK (counter_account_code IS NULL OR provider != 'fiken' OR counter_account_code ~ '^\d{4}(:\d{5})?$');

-- Siste kjente leverandør-rapporterte tilstand - REN observasjon, ALDRI
-- autoritativ (Jarvis sin egen `state`-kolonne er den eneste autoritative
-- livssyklusen - byggeordrens §5: "no direct bypass around Finance intent").
ALTER TABLE payment_intents ADD COLUMN provider_status text;
ALTER TABLE payment_intents ADD COLUMN provider_reported_amount_ore bigint;
ALTER TABLE payment_intents ADD COLUMN provider_reported_currency text;
-- Ordens-vokter: en eldre hendelse skal ALDRI overskrive en nyere allerede
-- lagret provider_status (byggeordrens §7, "Never let an older webhook
-- silently overwrite newer established provider state").
ALTER TABLE payment_intents ADD COLUMN provider_status_updated_at timestamptz;
ALTER TABLE payment_intents ADD COLUMN latest_stripe_event_id text;

-- === stripe_webhook_events: leverandør-hendelses-idempotens ===
-- Stripe sin egen `event.id` (globalt unik på tvers av kontoer) ER
-- primærnøkkelen - ON CONFLICT DO NOTHING ved innsettelse ER hele
-- dedup-/idempotens-mekanismen (SAMME mønster som payment_intents sin
-- egen idempotency_key-UNIQUE). RECEIVED -> VERIFIED -> PROCESSED/
-- FAILED_RETRYABLE (byggeordrens §8) er `status`-progresjonen.
CREATE TABLE stripe_webhook_events (
  stripe_event_id           text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  event_type                   text NOT NULL,
  api_version                   text,
  payment_intent_id              text REFERENCES payment_intents (payment_intent_id),
  status                          text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'verified', 'processed', 'failed_retryable', 'unsupported')),
  -- Kun et lite, trygt, IKKE-sensitivt utdrag (objekt-id/status/beløp/
  -- valuta) - ALDRI hele Stripe-nyttelasten (kan inneholde
  -- betalingsmetode-detaljer Jarvis aldri skal lagre, byggeordrens §4/§13).
  payload_summary                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message                      text,
  stripe_created_at                    timestamptz NOT NULL,
  received_at                            timestamptz NOT NULL DEFAULT now(),
  processed_at                             timestamptz,
  created_at                                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_webhook_events_lookup_idx ON stripe_webhook_events (tenant_id, memory_space_id, payment_intent_id);
CREATE INDEX stripe_webhook_events_retry_idx ON stripe_webhook_events (status) WHERE status = 'failed_retryable';

-- === stripe_refunds: refusjon som egen finans-handling ===
-- SAMME 6-tilstands livssyklus-vokabular som payment_intents (draft ->
-- submitted -> provider_acknowledged -> settled/failed, cancelled fra
-- draft) - gjenbruker det EKSISTERENDE mønsteret, IKKE et nytt vokabular
-- (byggeordrens §9). Finansiell historikk forblir append-only/auditerbar -
-- en refusjon SLETTER ALDRI/reverserer ALDRI den opprinnelige
-- payment_intent-raden, kun en egen, ny rad som PEKER til den.
CREATE TABLE stripe_refunds (
  refund_id                 text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  payment_intent_id            text NOT NULL REFERENCES payment_intents (payment_intent_id),
  -- Eier-/agent-oppgitt idempotens-nøkkel - SAMME UNIQUE-per-tenant-mønster
  -- som payment_intents (akseptansekriterium: retry kan ALDRI doble en
  -- refusjon).
  idempotency_key                text NOT NULL,
  state                             text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted','provider_acknowledged','settled','failed','cancelled')),
  amount_ore                          bigint NOT NULL CHECK (amount_ore > 0),
  currency                              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Stripe sin egen dokumenterte reason-enum (owner-oppgitt underdel -
  -- 'expired_uncaptured_charge' er Stripe-INTERN-generert, ALDRI noe
  -- Jarvis selv setter ved opprettelse).
  reason                                  text CHECK (reason IS NULL OR reason IN ('duplicate', 'fraudulent', 'requested_by_customer')),
  provider_ref                              text,
  failure_reason                              text,
  -- Deterministiske avviksflagg PÅ selve refusjonen (f.eks.
  -- REFUND_AMOUNT_CONFLICT) - propageres OGSÅ opp til den overordnede
  -- payment_intents.anomaly_flags slik at DEN EKSISTERENDE
  -- detectPaymentAnomalies()-overflatingen fanger det uten noen ny
  -- OpenLoop-mekanisme (byggeordrens §11, "Reuse existing anomaly
  -- structures").
  anomaly_flags                                jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_person_id                                text REFERENCES people (person_id),
  created_at                                       timestamptz NOT NULL DEFAULT now(),
  updated_at                                         timestamptz NOT NULL DEFAULT now(),
  submitted_at                                         timestamptz,
  settled_at                                             timestamptz,
  failed_at                                                timestamptz,
  cancelled_at                                               timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX stripe_refunds_lookup_idx ON stripe_refunds (tenant_id, memory_space_id, payment_intent_id);

GRANT SELECT, INSERT, UPDATE ON stripe_webhook_events, stripe_refunds TO jarvis_app;
-- Q-20: samme kundedata-klasse som payment_intents/finance_spend_records -
-- registrert i modules/erasure/src/plan.ts. Uten denne GRANTen ville
-- ErasureService sin faktiske DELETE feile med permission denied for HELE
-- tenant-/space-erasure-operasjonen (samme presedens som 038/039).
GRANT DELETE ON stripe_webhook_events, stripe_refunds TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stripe_webhook_events', 'stripe_refunds'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;

-- Byggeordrens §11: gjenbruk DEN EKSISTERENDE payment_intent_anomaly/
-- payment_intent_reconciliation_mismatch-overflatingen (detectPaymentAnomalies()
-- i modules/business/src/open-loop-service.ts leser payment_intents.anomaly_flags/
-- reconciliation_state HELT provider-nøytralt allerede - INGEN ny
-- loop_type, INGEN ny FK-kolonne på business_open_loops trengs for at
-- Stripe-spesifikke avvik (PROVIDER_AMOUNT_MISMATCH osv., skrevet til
-- SAMME payment_intents.anomaly_flags-kolonne av FinanceService sin nye
-- runProviderAnomalyDetection()) skal overflate automatisk).
