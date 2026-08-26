-- UA-6 Finance & Spend Integrity Gateway - FJERDE slice (Slice 4, D-110):
-- Vipps MobilePay Payments, Captures, Refunds, Webhooks & Reconciliation
-- Adapter. D-64 Core-vs-Adapter-porten kjørt FØRST (se
-- DECISIONS_AND_ASSUMPTIONS.md) - HYBRID_WITH_CLEAR_AUTHORITY, SAMME
-- mønster som D-107 (Fiken) / D-109 (Stripe): Jarvis EIER selv
-- payment_intents/idempotens/kill-switch/avviksdeteksjon/avstemming
-- (JARVIS_CANONICAL), Vipps forblir EXTERNAL_CANONICAL for selve
-- betalings-/capture-/refund-tilstanden og webhook-hendelses-identiteten.
-- Vipps er masterplan-navngitt P1 (SAMME liste som Stripe/bank) - ALDRI et
-- stille Claude-leverandørvalg (CORE_DEPENDENCY_DECISION_REQUIRED=false).
--
-- Gjenbruker den EKSISTERENDE `payment_intents`-livssyklusen (038_finance.sql,
-- utvidet av 040_stripe.sql) UENDRET i struktur - `provider`-CHECK utvides
-- fra ('fiken','stripe') til ('fiken','stripe','vipps'). `account_code`
-- sitt strenge Fiken-kontoformat forblir betinget PÅ provider (uendret
-- betingelse fra 040_stripe.sql - Vipps trenger, som Stripe, kun en
-- ikke-tom generell bokføringskategori-tag).
--
-- Vipps sin egen `reference` (Jarvis sin `payment_intent_id` gjenbrukt
-- DIREKTE som referanse ved opprettelse, se vipps-transport.ts) lagres i
-- DEN EKSISTERENDE generiske `provider_ref`-kolonnen - SAMME "pointer,
-- aldri en kopi av leverandørdata"-prinsipp som Fiken/Stripe.
--
-- Observasjonelle Vipps-felt PÅ payment_intents: gjenbruker de EKSISTERENDE
-- generiske `provider_status`/`provider_reported_amount_ore`/
-- `provider_reported_currency`/`provider_status_updated_at`-kolonnene
-- (040_stripe.sql, allerede provider-nøytralt navngitt - INGEN nye
-- duplikate kolonner trengs for disse fire). ÉN ny, Vipps-navngitt
-- pointer-kolonne trengs likevel: `latest_vipps_event_key` (parallell til
-- `latest_stripe_event_id`, men peker til `vipps_webhook_events.dedupe_key`
-- - BEVISST INGEN FK, samme sirkulær-avhengighets-begrunnelse som Stripe).
--
-- Tre nye tabeller (ALLE bak den EKSISTERENDE payment_intents-FKen, ALDRI
-- en ny Vipps-spesifikk "shadow"-avstemmingsmekanisme):
--   - `vipps_webhook_events` (leverandør-hendelses-idempotens - Vipps gir
--     INGEN bekreftet global hendelses-id (se vipps-webhook.ts sin
--     toppkommentar), så PRIMÆRNØKKELEN er Jarvis sin egen utledede
--     `dedupe_key`, IKKE en rå Vipps-verdi).
--   - `vipps_captures` (capture som egen finans-handling - Vipps sin
--     ePayment API støtter delvis/flere capture-kall mot samme reservasjon,
--     SAMME 6-tilstands livssyklus-vokabular og aggregat-sum-mønster som
--     `stripe_refunds`, gjenbrukt for en ANNEN økonomisk retning: penger
--     INN i selskapet, ikke ut).
--   - `vipps_refunds` (refusjon som egen finans-handling - STRUKTURELT
--     IDENTISK med `stripe_refunds`, gjenbruker mønsteret, IKKE et nytt).
--
-- Eier-tilkoblet, ETT-GLOBALT-Vipps-konto-mønster (SAMME "single-owner,
-- ikke multi-kunde-SaaS" presedens som JARVIS_STRIPE_*/JARVIS_FIKEN_*) -
-- `JARVIS_VIPPS_TENANT_ID` (.env.example) er den ENE eier-autoriserte
-- tenanten dette Vipps-selgerkontoet (MSN) tilhører. Ekte multi-MSN/multi-
-- tenant Vipps er EKSPLISITT IKKE bygget denne sliceen (D-41: ingen skjema-
-- klargjøring for ubygget kapabilitet) - men webhook-ruting stoler ALDRI på
-- nyttelast-metadata alene (SAMME PROVIDER_OBJECT_TENANT_CONFLICT-
-- håndhevelse i FinanceService som Stripe).
--
-- RLS/GRANT/erasure-mønster IDENTISK med 038_finance.sql/040_stripe.sql -
-- ingen ny sikkerhetsmodell.

-- === payment_intents: provider-utvidelse + Vipps-spesifikk event-pointer ===

ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_provider_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_provider_check CHECK (provider IN ('fiken', 'stripe', 'vipps'));

ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_account_code_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_account_code_check
  CHECK (provider != 'fiken' OR account_code ~ '^\d{4}(:\d{5})?$');

ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_counter_account_code_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_counter_account_code_check
  CHECK (counter_account_code IS NULL OR provider != 'fiken' OR counter_account_code ~ '^\d{4}(:\d{5})?$');

-- Peker til hvilken vipps_webhook_events-rad som sist oppdaterte
-- provider_status - parallell til `latest_stripe_event_id`, BEVISST INGEN
-- FK (samme sirkulær-avhengighets-begrunnelse).
ALTER TABLE payment_intents ADD COLUMN latest_vipps_event_key text;

-- `captured` er en NY event_type - Vipps sitt payment.state-felt forblir
-- BEVISST 'AUTHORIZED' selv ETTER en vellykket capture (VERIFIED_SEARCH_
-- SNIPPET, se vipps-transport.ts sin toppkommentar - fundamentalt
-- annerledes enn Stripe, som HAR en egen "succeeded"-status). En capture er
-- derfor en genuint distinkt hendelsestype, ALDRI korrekt uttrykt som
-- 'settled' (som betyr HELE intensjonen er økonomisk fullført, ikke ett
-- enkelt delvis capture-steg).
ALTER TABLE payment_intent_events DROP CONSTRAINT payment_intent_events_event_type_check;
ALTER TABLE payment_intent_events ADD CONSTRAINT payment_intent_events_event_type_check CHECK (event_type IN (
  'intent_created', 'submitted', 'provider_acknowledged', 'settled', 'failed', 'cancelled',
  'anomaly_flagged', 'reconciled', 'kill_switch_blocked', 'captured'
));

-- === vipps_webhook_events: leverandør-hendelses-idempotens ===
-- Jarvis sin egen utledede `dedupe_key` (se vipps-webhook.ts) ER
-- primærnøkkelen - ON CONFLICT DO NOTHING ved innsettelse ER hele
-- dedup-/idempotens-mekanismen (SAMME mønster som stripe_webhook_events).
CREATE TABLE vipps_webhook_events (
  dedupe_key                text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  event_name                   text NOT NULL,
  payment_intent_id              text REFERENCES payment_intents (payment_intent_id),
  status                          text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'verified', 'processed', 'failed_retryable', 'unsupported')),
  -- Kun et lite, trygt, IKKE-sensitivt utdrag - ALDRI hele Vipps-nyttelasten
  -- (byggeordrens §4/§13).
  payload_summary                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message                      text,
  vipps_event_timestamp                timestamptz,
  received_at                            timestamptz NOT NULL DEFAULT now(),
  processed_at                             timestamptz,
  created_at                                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vipps_webhook_events_lookup_idx ON vipps_webhook_events (tenant_id, memory_space_id, payment_intent_id);
CREATE INDEX vipps_webhook_events_retry_idx ON vipps_webhook_events (status) WHERE status = 'failed_retryable';

-- === vipps_captures: capture som egen finans-handling ===
-- SAMME 6-tilstands livssyklus-vokabular som payment_intents/stripe_refunds
-- - gjenbruker det EKSISTERENDE mønsteret for en INNGÅENDE økonomisk
-- handling (penger faktisk fanget/oppgjort, i motsetning til refusjon som
-- er utgående). Aggregat-sum av vellykkede captures kan ALDRI overstige
-- payment_intents.amount_ore (håndhevet i FinanceService, samme
-- over-refusjon-vokter-mønster som stripe_refunds).
CREATE TABLE vipps_captures (
  capture_id                 text PRIMARY KEY,
  tenant_id                   text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id              text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  payment_intent_id             text NOT NULL REFERENCES payment_intents (payment_intent_id),
  idempotency_key                 text NOT NULL,
  state                              text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted','provider_acknowledged','settled','failed','cancelled')),
  amount_ore                          bigint NOT NULL CHECK (amount_ore > 0),
  currency                              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  failure_reason                          text,
  anomaly_flags                             jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_person_id                             text REFERENCES people (person_id),
  created_at                                    timestamptz NOT NULL DEFAULT now(),
  updated_at                                      timestamptz NOT NULL DEFAULT now(),
  submitted_at                                      timestamptz,
  settled_at                                          timestamptz,
  failed_at                                             timestamptz,
  cancelled_at                                            timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX vipps_captures_lookup_idx ON vipps_captures (tenant_id, memory_space_id, payment_intent_id);

-- === vipps_refunds: refusjon som egen finans-handling ===
-- Strukturelt identisk med stripe_refunds (SAMME livssyklus-vokabular,
-- SAMME idempotens-/aggregat-mønster) - refusjon SLETTER/reverserer ALDRI
-- den opprinnelige payment_intent-raden eller noen capture-rad, kun en
-- egen, ny rad som PEKER til betalingsintensjonen.
CREATE TABLE vipps_refunds (
  refund_id                 text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  payment_intent_id            text NOT NULL REFERENCES payment_intents (payment_intent_id),
  idempotency_key                text NOT NULL,
  state                             text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted','provider_acknowledged','settled','failed','cancelled')),
  amount_ore                          bigint NOT NULL CHECK (amount_ore > 0),
  currency                              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_ref                              text,
  failure_reason                              text,
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
CREATE INDEX vipps_refunds_lookup_idx ON vipps_refunds (tenant_id, memory_space_id, payment_intent_id);

GRANT SELECT, INSERT, UPDATE ON vipps_webhook_events, vipps_captures, vipps_refunds TO jarvis_app;
-- Q-20: samme kundedata-klasse som payment_intents/stripe_refunds -
-- registrert i modules/erasure/src/plan.ts. Uten denne GRANTen ville
-- ErasureService sin faktiske DELETE feile med permission denied for HELE
-- tenant-/space-erasure-operasjonen (samme presedens som 038/040).
GRANT DELETE ON vipps_webhook_events, vipps_captures, vipps_refunds TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vipps_webhook_events', 'vipps_captures', 'vipps_refunds'
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

-- Byggeordrens §12: gjenbruk DEN EKSISTERENDE payment_intents.anomaly_flags/
-- reconciliation_state-overflatingen (detectPaymentAnomalies() i
-- modules/business/src/open-loop-service.ts leser den HELT provider-
-- nøytralt allerede) - INGEN ny loop_type, INGEN ny FK-kolonne på
-- business_open_loops trengs for at Vipps-spesifikke avvik (skrevet til
-- SAMME payment_intents.anomaly_flags-kolonne av FinanceService sin
-- runVippsProviderAnomalyDetection()) skal overflate automatisk.
