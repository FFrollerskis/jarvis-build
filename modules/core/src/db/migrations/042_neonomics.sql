-- UA-6 Finance & Spend Integrity Gateway - FEMTE slice (Slice 5, D-111):
-- Neonomics Open Banking - kontoer, transaksjoner, samtykke, betalinger og
-- avstemming. D-64 Core-vs-Adapter-porten kjørt FØRST (se D-111 i
-- DECISIONS_AND_ASSUMPTIONS.md) - HYBRID_WITH_CLEAR_AUTHORITY: Jarvis EIER
-- selv intent/policy/normalisering/avstemming/avvik/kill-switch/audit
-- (JARVIS_CANONICAL); Neonomics forblir EXTERNAL_CANONICAL for bank-
-- rapportert konto-/saldo-/transaksjonsdata, samtykketilstand og provider-
-- betalingstilstand. Neonomics er TOBIAS-GODKJENT som primær open-banking-
-- leverandør (D-111, eksplisitt beslutning i byggeordren - IKKE et stille
-- Claude-leverandørvalg). CORE_DEPENDENCY_DECISION_REQUIRED=false: alle
-- tabellene under er provider-parametrisert (`provider`-kolonne, i dag kun
-- 'neonomics') slik at en fremtidig alternativ open-banking-leverandør kan
-- gjenbruke NØYAKTIG samme kanoniske struktur - Neonomics-ID-er er pekere,
-- aldri domenekjernen.
--
-- REGULATORISK MODELL (VERIFIED_SEARCH_SNIPPET, se D-111): Neonomics er
-- selv lisensiert betalingsforetak/TPP (AISP+PISP) under PSD2 - Jarvis/
-- Tobias opererer GJENNOM Neonomics sine tillatelser som deres kunde og
-- trenger IKKE egen TPP-lisens. Jarvis lagrer ALDRI bank-innloggings-/
-- SCA-legitimasjon - all sterk kundeautentisering skjer hos banken via
-- Neonomics sine redirect-URL-er (bruker-interaksjon modellert eksplisitt
-- som tilstander, aldri fabrikkert autonomt fullført).
--
-- Gjenbruk (byggeordrens §1/§27 "no parallel subsystems"):
--   - Betalingsinitiering (PIS) gjenbruker DEN EKSISTERENDE
--     `payment_intents`-livssyklusen - provider-CHECK utvides med
--     'neonomics'. INGEN egen Neonomics-betalingstabell (provider-
--     betalings-ID -> eksisterende `provider_ref`, ISO 20022-status ->
--     eksisterende observasjonelle `provider_status`).
--   - Avvik på betalinger skrives til DEN EKSISTERENDE
--     `payment_intents.anomaly_flags` (detectPaymentAnomalies() plukker
--     dem opp uendret). Bank-/samtykkenivå-avvik får to NYE
--     deterministiske OpenLoop-regler (se CHECK-utvidelsen nederst).
--   - `finance_spend_records` (Slice 2) er UENDRET - den er bevisst
--     spend-only ('marketing_spend','ai_api_cost'-CHECK). Kanonisk
--     OBSERVERT kontantstrøm (både debet OG kredit) representeres av den
--     NYE `bank_transactions` med EKSPLISITT retning - inngående penger
--     tvinges ALDRI inn i spend-modellen (byggeordrens §9).
--
-- RLS/GRANT/erasure-mønster identisk med 038/040/041 - ingen ny
-- sikkerhetsmodell.

-- === payment_intents: provider-utvidelse + Neonomics event-pointer =======

ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_provider_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_provider_check CHECK (provider IN ('fiken', 'stripe', 'vipps', 'neonomics'));

-- Peker til hvilken neonomics_webhook_events-rad som sist oppdaterte
-- provider_status - parallell til latest_stripe_event_id/
-- latest_vipps_event_key, BEVISST INGEN FK (samme sirkulær-avhengighets-
-- begrunnelse).
ALTER TABLE payment_intents ADD COLUMN latest_neonomics_event_key text;

-- === bank_consents: samtykke-/SCA-livssyklus (byggeordrens §5) ===========
-- Neonomics-modellen (VERIFIED_SEARCH_SNIPPET): en SESJON opprettes per
-- bank (POST /ics/v3/session {bankId} -> sessionId); samtykke for AIS/PIS
-- lagres PER SESJON. Feilkode 1426 ("consent required") -> GET
-- /ics/v3/consent/{sessionId} gir URL-en sluttbrukeren MÅ besøke (SCA hos
-- banken). `provider_session_id` ER derfor samtykke-bæreren hos Neonomics.
-- INGEN SCA-hemmeligheter/bank-innlogging lagres - kun referanser,
-- tidsstempler og tilstand.
CREATE TABLE bank_consents (
  consent_id                text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  provider                     text NOT NULL DEFAULT 'neonomics' CHECK (provider IN ('neonomics')),
  provider_session_id           text,
  bank_id                        text NOT NULL,
  bank_name                       text,
  requested_scope                  text NOT NULL DEFAULT 'ais_pis' CHECK (requested_scope IN ('ais', 'pis', 'ais_pis')),
  state                             text NOT NULL DEFAULT 'created' CHECK (state IN ('created','authorization_required','active','expired','revoked','rejected')),
  authorization_url                  text,
  -- CSRF-/callback-vokter (byggeordrens §22): kryptografisk tilfeldig
  -- state-verdi generert av Jarvis ved URL-utstedelse, verifisert
  -- konstant-tid ved callback - ALDRI en provider-hemmelighet.
  callback_state                      text,
  owner_person_id                      text REFERENCES people (person_id),
  created_at                            timestamptz NOT NULL DEFAULT now(),
  updated_at                             timestamptz NOT NULL DEFAULT now(),
  authorized_at                           timestamptz,
  expires_at                               timestamptz,
  revoked_at                                timestamptz,
  last_verified_at                           timestamptz,
  UNIQUE (tenant_id, provider, provider_session_id)
);
CREATE INDEX bank_consents_lookup_idx ON bank_consents (tenant_id, memory_space_id, state);

-- === bank_accounts: kanonisk bankkonto-modell (byggeordrens §4) ==========
-- Kanonisk Jarvis-identitet (`bank_account_id`) er DISTINKT fra provider-
-- identiteten (`provider_account_id`) - ingen global én-konto-antakelse,
-- flere banker/kontoer per tenant støttes strukturelt.
CREATE TABLE bank_accounts (
  bank_account_id           text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  provider                     text NOT NULL DEFAULT 'neonomics' CHECK (provider IN ('neonomics')),
  provider_account_id           text NOT NULL,
  consent_id                     text NOT NULL REFERENCES bank_consents (consent_id),
  bank_id                         text NOT NULL,
  account_name                     text,
  -- IBAN/BBAN lagres AVKORTET til de 4 siste tegnene pluss lengde
  -- (visnings-/matchingsformål) - full identifikator er IKKE operasjonelt
  -- nødvendig for avstemming (provider_account_id er nøkkelen) og
  -- minimeres derfor bevisst (byggeordrens §25 "sensitive bank/account
  -- identifiers appropriately minimized").
  account_identifier_masked          text,
  currency                            text NOT NULL DEFAULT 'NOK' CHECK (currency ~ '^[A-Z]{3}$'),
  account_type                         text,
  active                                boolean NOT NULL DEFAULT true,
  last_synced_at                         timestamptz,
  created_at                              timestamptz NOT NULL DEFAULT now(),
  updated_at                               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_account_id)
);
CREATE INDEX bank_accounts_lookup_idx ON bank_accounts (tenant_id, memory_space_id, active);

-- === bank_account_balances: saldo-observasjoner (byggeordrens §7) ========
-- Append-only observasjonslogg - Neonomics/PSD2 skiller saldotyper
-- (booked/available/expected/interim m.fl.); typene bevares RÅTT som
-- tekst, ALDRI kollapset. Beløp i øre/minste myntenhet (bigint) - ALDRI
-- flyttall-pengearitmetikk (samme invariant som hele Finance-domenet).
CREATE TABLE bank_account_balances (
  balance_id                text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  bank_account_id              text NOT NULL REFERENCES bank_accounts (bank_account_id),
  balance_type                  text NOT NULL,
  amount_ore                     bigint NOT NULL,
  currency                        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_reference_date          timestamptz,
  observed_at                       timestamptz NOT NULL DEFAULT now(),
  created_at                         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_account_balances_lookup_idx ON bank_account_balances (tenant_id, bank_account_id, observed_at DESC);

-- === bank_transactions: kanonisk observert kontantstrøm (byggeordrens §8/§9) ===
-- Deterministisk kilde-identitet: (tenant, provider, provider_transaction_id)
-- er UNIK - gjeninnlesing/inkrementell synk/paginering kan ALDRI duplisere
-- en transaksjon (ON CONFLICT DO NOTHING = idempotens-mekanismen, samme
-- mønster som webhook-events). Retning er EKSPLISITT ('debit' = utgående,
-- 'credit' = inngående) - aldri utledet av fortegn alene ved lesing.
-- pending->booked-overgangen modelleres som tilstandsendring på SAMME rad
-- (provider-ID-en er stabil); en provider-KORREKSJON av en allerede booket
-- transaksjon flagges BANK_TRANSACTION_CORRECTION_CONFLICT i stedet for å
-- stille overskrive etablert beløp/valuta.
CREATE TABLE bank_transactions (
  bank_transaction_id       text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  bank_account_id              text NOT NULL REFERENCES bank_accounts (bank_account_id),
  provider                      text NOT NULL DEFAULT 'neonomics' CHECK (provider IN ('neonomics')),
  provider_transaction_id        text NOT NULL,
  status                          text NOT NULL DEFAULT 'booked' CHECK (status IN ('pending', 'booked')),
  direction                        text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_ore                        bigint NOT NULL CHECK (amount_ore > 0),
  currency                           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  booking_date                        date,
  value_date                           date,
  counterparty_name                     text,
  reference_text                         text,
  bank_transaction_code                   text,
  -- Deterministisk avstemming (byggeordrens §10/§14): peker til den
  -- kanoniske betalingsintensjonen transaksjonen matchet mot, PLUSS
  -- hvilken regel og hvilket bevis som ga matchen. Tvetydige kandidater
  -- forblir 'unmatched' - ALDRI stille auto-lukket.
  reconciliation_state                     text NOT NULL DEFAULT 'unmatched' CHECK (reconciliation_state IN ('unmatched', 'matched', 'ambiguous')),
  matched_payment_intent_id                 text REFERENCES payment_intents (payment_intent_id),
  match_rule                                 text,
  match_evidence                              jsonb NOT NULL DEFAULT '{}'::jsonb,
  anomaly_flags                                jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at                                   timestamptz NOT NULL DEFAULT now(),
  created_at                                     timestamptz NOT NULL DEFAULT now(),
  updated_at                                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_transaction_id)
);
CREATE INDEX bank_transactions_lookup_idx ON bank_transactions (tenant_id, memory_space_id, bank_account_id, booking_date DESC);
CREATE INDEX bank_transactions_unmatched_idx ON bank_transactions (tenant_id, reconciliation_state) WHERE reconciliation_state != 'matched';

-- === neonomics_webhook_events: betalingsstatus-hendelser (byggeordrens §23) ===
-- Neonomics HAR offisiell webhook-støtte for betalingsstatus-oppdateringer
-- (VERIFIED_SEARCH_SNIPPET): registreres i Merchant-portalen med URL + en
-- kunde-valgt API-NØKKEL som Neonomics autentiserer forespørslene med -
-- IKKE en HMAC-signaturkontrakt (Stripe) eller Azure-stil
-- forespørselssignering (Vipps). Implementert som SIN EGEN kontrakt
-- (API-nøkkel-sjekk, konstant-tid) - aldri tvunget inn i et annet
-- providermønster. INGEN dokumentert global hendelses-ID i det uavhengige
-- søket - dedupe-nøkkelen er derfor Jarvis-utledet
-- (`paymentId:status`) - konservativ (samme prinsipp som Vipps sin
-- fallback-nøkkel), ordens-vokteren i FinanceService gjør en duplisert
-- levering uskadelig uansett.
CREATE TABLE neonomics_webhook_events (
  dedupe_key                text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  provider_payment_id          text NOT NULL,
  payment_status                text NOT NULL,
  payment_intent_id              text REFERENCES payment_intents (payment_intent_id),
  status                          text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'verified', 'processed', 'failed_retryable', 'unsupported')),
  payload_summary                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message                     text,
  received_at                        timestamptz NOT NULL DEFAULT now(),
  processed_at                        timestamptz,
  created_at                           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX neonomics_webhook_events_lookup_idx ON neonomics_webhook_events (tenant_id, provider_payment_id);

GRANT SELECT, INSERT, UPDATE ON bank_consents, bank_accounts, bank_account_balances, bank_transactions, neonomics_webhook_events TO jarvis_app;
-- Q-20: bankdata er KUNDEDATA (samme klasse som payment_intents) -
-- registrert i modules/erasure/src/plan.ts. Uten DELETE ville
-- ErasureService feile med permission denied (samme presedens som 038-041).
GRANT DELETE ON bank_consents, bank_accounts, bank_account_balances, bank_transactions, neonomics_webhook_events TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_consents', 'bank_accounts', 'bank_account_balances', 'bank_transactions', 'neonomics_webhook_events'
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

-- === business_open_loops: to nye deterministiske bank-regler =============
-- SAMME utvidelsesmønster som 024/026/027/038/039: kun CHECK-utvidelse +
-- regler i OpenLoopService (ren SQL, ingen pakkeavhengighet). To bevisst
-- SMALE loop-typer (detaljene bor i reason/detection_key):
--   - bank_transaction_unmatched: en vesentlig booket banktransaksjon
--     (debet ELLER kredit) forble unmatched/ambiguous etter avstemming.
--   - bank_consent_attention: et samtykke er utløpt/tilbakekalt/krever
--     (re)autorisering - kontotilgang er reelt tapt inntil brukeren
--     handler (SCA er en MENNESKELIG handling, aldri automatiserbar).
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required',
  'marketing_spend_anomaly',
  'payment_intent_anomaly', 'payment_intent_reconciliation_mismatch',
  'finance_spend_unexpected', 'finance_spend_amount_deviation', 'finance_recurring_charge_missing',
  'finance_recurring_charge_duplicate', 'finance_spend_correction_conflict',
  'bank_transaction_unmatched', 'bank_consent_attention'
));
