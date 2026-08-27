-- UA-6 Finance & Spend Integrity Gateway - SJETTE slice (Slice 6, D-112):
-- Wallester programmerbare kort, wallet og spend-kontroll. D-64 Core-vs-
-- Adapter-porten kjørt FØRST (se D-112 i DECISIONS_AND_ASSUMPTIONS.md) -
-- HYBRID_WITH_CLEAR_AUTHORITY: Jarvis EIER selv kortformål/eierpolicy/
-- ØNSKEDE spend-grenser/prosjekt-leverandør-kobling/avstemming/avvik/
-- kill-switch/audit (JARVIS_CANONICAL); Wallester forblir
-- EXTERNAL_CANONICAL for faktisk utstedt kortidentitet, provider-
-- kortlivssyklustilstand, nettverks-autorisasjonstilstand, transaksjons-/
-- oppgjørstilstand, provider-saldo og webhook-hendelsesidentitet.
-- Wallester er TOBIAS-GODKJENT som primær programmerbar kort-/wallet-
-- leverandør (D-112, eksplisitt beslutning i byggeordren - IKKE et stille
-- Claude-leverandørvalg). CORE_DEPENDENCY_DECISION_REQUIRED=false: alle
-- tabellene under er provider-parametrisert (`provider`-kolonne, i dag kun
-- 'wallester') - Wallester-ID-er er pekere, aldri domenekjernen.
--
-- REGULATORISK MODELL (VERIFIED_SEARCH_SNIPPET, se D-112): Wallester AS er
-- selv lisensiert finansforetak (estisk e-pengeinstitusjon, Visa-
-- Principal-Member-utsteder) - kortutstedelsen skjer under WALLESTER sin
-- konsesjon; Jarvis/Tobias er kunde av Wallester Business og blir ALDRI
-- egen regulert utsteder. KYB (selskap) og KYC (kortholder) er WALLESTER-
-- kanoniske prosesser - Jarvis modellerer kun observert status.
--
-- PCI-GRENSEN (byggeordrens §23 - KRITISK): Jarvis lagrer ALDRI rå PAN,
-- CVV/CVC eller PIN. Kanonisk kortmodell holder KUN maskert kortreferanse
-- (siste 4 sifre) + provider-kort-ID. Sensitive kortdata forblir hos
-- Wallester (provider-portal/mobil-wallet) - endepunkter for krypterte
-- sensitive kortdata brukes IKKE (ikke operasjonelt nødvendig for UA-6).
--
-- Gjenbruk (byggeordrens §1/§26 "no duplicate financial subsystems"):
--   - `finance_spend_records` (Slice 2) er UENDRET - korttransaksjoner er
--     et EGET kanonisk observert-kortøkonomi-ledger (`card_transactions`,
--     samme arkitekturrolle som `bank_transactions` i Slice 5), IKKE nok
--     en spend-record-kilde (ellers ville samme økonomiske effekt kunne
--     telles dobbelt - §13 "No duplicate economic record").
--   - Avstemming lenker korttransaksjoner mot EKSISTERENDE
--     `finance_recurring_commitments` (abonnement/anskaffelse) -
--     deterministisk, aldri AI-inferert (Q-26).
--   - Kortavvik overflates via EKSISTERENDE OpenLoopService (én ny
--     loop-type i CHECK-utvidelsen nederst).
--   - `finance_kill_switch` (038) gjenbrukes UENDRET som eier-nødbryter
--     (aktiv spend-mulighet blokkeres; passiv synk/avstemming fortsetter).
--
-- RLS/GRANT/erasure-mønster identisk med 038/040/041/042 - ingen ny
-- sikkerhetsmodell.

-- === provider_cards: kanonisk programmerbar kortmodell (byggeordrens §4) ===
-- Kanonisk Jarvis-identitet (`card_id`) er DISTINKT fra provider-
-- identiteten (`provider_card_id` - NULL til provider har kvittert
-- opprettelsen). Livssyklus: draft -> (submitCard, kill-switch-gated) ->
-- pending_provider/active -> frozen <-> active -> closed. En provider-feil
-- endrer ALDRI kanonisk tilstand (§6). `single_use`-semantikk
-- (VERIFIED_SEARCH_SNIPPET): et engangskort auto-lukkes hos Wallester
-- etter ÉN VELLYKKET transaksjon (avslag holder kortet aktivt).
CREATE TABLE provider_cards (
  card_id                   text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  provider                     text NOT NULL DEFAULT 'wallester' CHECK (provider IN ('wallester')),
  provider_card_id              text,
  provider_account_id            text,
  -- Deterministisk opprettelses-idempotens (§5): retry kan ALDRI skape
  -- utilsiktede duplikatkort - samme nøkkel -> samme kanoniske kort.
  idempotency_key                 text NOT NULL,
  name                             text NOT NULL,
  purpose                           text NOT NULL,
  card_type                          text NOT NULL CHECK (card_type IN ('virtual', 'physical', 'disposable')),
  state                               text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'pending_provider', 'active', 'frozen', 'closed')),
  currency                             text NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  cardholder_person_id                  text REFERENCES people (person_id),
  -- Maskert kortreferanse (KUN siste 4 sifre, provider-returnert) - ALDRI
  -- full PAN (PCI-grensen, §23). CHECK håndhever at ingen full PAN kan
  -- smugles inn i kolonnen.
  masked_card_number                     text CHECK (masked_card_number IS NULL OR length(masked_card_number) <= 12),
  -- Formåls-/leverandørbinding (§8): eksplisitte, eier-satte pekere -
  -- ALDRI AI-gjettet kobling (Q-26). Jarvis håndhever formål via policy/
  -- avvik/avstemming - kortnettverket selv er bredere.
  commitment_id                           text REFERENCES finance_recurring_commitments (commitment_id),
  campaign_id                              text REFERENCES marketing_campaigns (campaign_id),
  vendor_name                               text,
  -- Wallet-sannhet (§16): Wallester-kort ER tokeniserbare til Apple Pay/
  -- Google Pay/Samsung Pay (VERIFIED_SEARCH_SNIPPET) - men API-drevet
  -- wallet-PROVISJONERING er IKKE verifisert for Business-programmet.
  -- Derfor modelleres kun kompatibilitet + observert provider-status.
  wallet_compatible                          boolean NOT NULL DEFAULT true,
  wallet_tokenization_status                  text,
  -- Observasjonell rå provider-tilstand (EXTERNAL_CANONICAL) - kanonisk
  -- `state` over er Jarvis-eid; konflikt flagges CARD_PROVIDER_STATE_CONFLICT.
  provider_state                               text,
  anomaly_flags                                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at                                     timestamptz NOT NULL DEFAULT now(),
  updated_at                                      timestamptz NOT NULL DEFAULT now(),
  submitted_at                                     timestamptz,
  activated_at                                      timestamptz,
  frozen_at                                          timestamptz,
  closed_at                                           timestamptz,
  last_synced_at                                       timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, provider, provider_card_id)
);
CREATE INDEX provider_cards_lookup_idx ON provider_cards (tenant_id, memory_space_id, state);

-- === card_spend_policies: ØNSKET vs PROVIDER-ANVENDT policy (§7) =========
-- Kjernedistinksjonen i byggeordren: en grenseendring antas ALDRI vellykket
-- før provider bekrefter - `requested_*` (Jarvis-eid intensjon) holdes
-- ADSKILT fra `applied_*` (provider-bekreftet ekte tilstand).
-- Wallester-kontrakten (VERIFIED_SEARCH_SNIPPET): per-transaksjons-/dag-/
-- uke-/månedsgrenser + av/på for ATM-uttak, internett-kjøp og contactless,
-- PATCH-oppdaterbare i sanntid; provider auto-avslår over grensen.
-- INGEN kunstig global Jarvis-beløpstak (§7) - eier setter grensene.
CREATE TABLE card_spend_policies (
  policy_id                 text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  card_id                      text NOT NULL REFERENCES provider_cards (card_id),
  requested_transaction_limit_ore  bigint CHECK (requested_transaction_limit_ore > 0),
  requested_daily_limit_ore         bigint CHECK (requested_daily_limit_ore > 0),
  requested_weekly_limit_ore         bigint CHECK (requested_weekly_limit_ore > 0),
  requested_monthly_limit_ore         bigint CHECK (requested_monthly_limit_ore > 0),
  requested_atm_enabled                boolean NOT NULL DEFAULT false,
  requested_online_enabled              boolean NOT NULL DEFAULT true,
  requested_contactless_enabled          boolean NOT NULL DEFAULT true,
  applied_transaction_limit_ore           bigint,
  applied_daily_limit_ore                  bigint,
  applied_weekly_limit_ore                  bigint,
  applied_monthly_limit_ore                  bigint,
  applied_atm_enabled                         boolean,
  applied_online_enabled                       boolean,
  applied_contactless_enabled                   boolean,
  sync_state                                     text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'applied', 'rejected')),
  requested_at                                    timestamptz NOT NULL DEFAULT now(),
  applied_at                                       timestamptz,
  created_at                                        timestamptz NOT NULL DEFAULT now(),
  updated_at                                         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id)
);
CREATE INDEX card_spend_policies_lookup_idx ON card_spend_policies (tenant_id, sync_state);

-- === card_events: append-only kort-audit (byggeordrens §24) ==============
-- Samme arkitekturrolle som payment_intent_events (038): hendelses-
-- historikken er Jarvis-eid revisjonsbevis - lukking av et kort sletter
-- ALDRI historikken (§6).
CREATE TABLE card_events (
  card_event_id             text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  card_id                      text NOT NULL REFERENCES provider_cards (card_id),
  event_type                    text NOT NULL CHECK (event_type IN (
    'requested', 'submitted', 'activated', 'frozen', 'unfrozen', 'closed',
    'limits_requested', 'limits_applied', 'limits_rejected',
    'provider_state_conflict', 'reconciled', 'provider_error'
  )),
  actor_person_id                text REFERENCES people (person_id),
  detail                          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_events_lookup_idx ON card_events (tenant_id, card_id, created_at DESC);

-- === card_authorizations: autorisasjonslivssyklus (byggeordrens §9) ======
-- Wallester-modellen (VERIFIED_SEARCH_SNIPPET): autorisasjon (reservasjon,
-- approve/decline besluttes av WALLESTER mot konfigurerte grenser/kontroller)
-- er DISTINKT fra oppgjør. En autorisasjon er ALDRI en egen økonomisk
-- spend-post - oppgjøret (card_transactions) er den økonomiske sannheten,
-- lenket tilbake hit (§9 "Do not count authorization and settlement as two
-- separate spend events").
CREATE TABLE card_authorizations (
  authorization_id          text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  card_id                      text NOT NULL REFERENCES provider_cards (card_id),
  provider                      text NOT NULL DEFAULT 'wallester' CHECK (provider IN ('wallester')),
  provider_authorization_id      text NOT NULL,
  -- 'unknown' lagt til i owner-provided primary-source-korrigeringen (PR #62,
  -- runde 4): en ubekreftet providerstatus er en EKTE, lagringsbar
  -- fail-safe-tilstand - ALDRI en stille CHECK-avvist verdi som ville
  -- tvunget koden til å gjette et positivt utfall for å unngå constraint-brudd.
  status                          text NOT NULL CHECK (status IN ('approved', 'declined', 'reversed', 'settled', 'expired', 'unknown')),
  amount_ore                       bigint NOT NULL CHECK (amount_ore > 0),
  currency                          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  merchant_name                      text,
  merchant_category_code              text,
  channel                              text NOT NULL DEFAULT 'unknown' CHECK (channel IN ('pos', 'online', 'atm', 'contactless', 'unknown')),
  decline_reason                        text,
  authorized_at                          timestamptz,
  anomaly_flags                           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at                               timestamptz NOT NULL DEFAULT now(),
  updated_at                                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_authorization_id)
);
CREATE INDEX card_authorizations_lookup_idx ON card_authorizations (tenant_id, card_id, authorized_at DESC);

-- === card_transactions: kanonisk observert kortøkonomi (byggeordrens §12) ===
-- Oppgjorte økonomiske fakta (kjøp/refusjon/reversering/gebyr). Samme
-- idempotens-invariant som bank_transactions: (tenant, provider,
-- provider_transaction_id) UNIK -> re-synk/paginering/webhook+polling-
-- dobbeltobservasjon kan ALDRI duplisere. En provider-KORREKSJON av
-- etablert beløp/valuta flagges CARD_TRANSACTION_CORRECTION_CONFLICT -
-- aldri stille overskrevet. Retningssemantikk er EKSPLISITT via
-- transaction_type ('purchase'/'fee' = utgående, 'refund'/'reversal' =
-- inngående) - aldri utledet av fortegn.
CREATE TABLE card_transactions (
  card_transaction_id       text PRIMARY KEY,
  tenant_id                  text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  card_id                      text NOT NULL REFERENCES provider_cards (card_id),
  provider                      text NOT NULL DEFAULT 'wallester' CHECK (provider IN ('wallester')),
  provider_transaction_id        text NOT NULL,
  -- Deterministisk autorisasjon<->oppgjør-lenking (§9): oppgjøret peker på
  -- autorisasjonen det gjør opp. TO oppgjør mot SAMME autorisasjon er
  -- avviket DUPLICATE_ECONOMIC_EFFECT (aldri stille akseptert).
  authorization_id                text REFERENCES card_authorizations (authorization_id),
  -- 'unknown' - samme fail-safe-begrunnelse som card_authorizations.status over.
  transaction_type                 text NOT NULL CHECK (transaction_type IN ('purchase', 'refund', 'reversal', 'fee', 'unknown')),
  amount_ore                        bigint NOT NULL CHECK (amount_ore > 0),
  currency                           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  merchant_name                       text,
  merchant_category_code               text,
  channel                               text NOT NULL DEFAULT 'unknown' CHECK (channel IN ('pos', 'online', 'atm', 'contactless', 'unknown')),
  transaction_at                         timestamptz,
  settled_at                              timestamptz,
  -- Deterministisk avstemming (§13): korttransaksjon <-> forventet spend
  -- (finance_recurring_commitments). Tvetydige kandidater forblir
  -- 'unmatched'/'ambiguous' - ALDRI stille auto-lukket (Q-26).
  reconciliation_state                     text NOT NULL DEFAULT 'unmatched' CHECK (reconciliation_state IN ('unmatched', 'matched', 'ambiguous')),
  matched_commitment_id                     text REFERENCES finance_recurring_commitments (commitment_id),
  match_rule                                 text,
  match_evidence                              jsonb NOT NULL DEFAULT '{}'::jsonb,
  anomaly_flags                                jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at                                   timestamptz NOT NULL DEFAULT now(),
  created_at                                     timestamptz NOT NULL DEFAULT now(),
  updated_at                                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_transaction_id)
);
CREATE INDEX card_transactions_lookup_idx ON card_transactions (tenant_id, memory_space_id, card_id, transaction_at DESC);
CREATE INDEX card_transactions_unmatched_idx ON card_transactions (tenant_id, reconciliation_state) WHERE reconciliation_state != 'matched';

-- === wallester_webhook_events: hendelses-ingestion (byggeordrens §15) ====
-- Wallester-webhooks (VERIFIED_SEARCH_SNIPPET) er VARSLER om hendelser
-- (autorisasjon approve/decline i beslutningsøyeblikket, oppgjør, kort-
-- hendelser) levert som HTTP POST til forhåndskonfigurert endepunkt -
-- autentisert med HTTP BASIC (kunde-konfigurert brukernavn/passord),
-- verifisert konstant-tid. Dette er IKKE en beslutnings-callback: ingen
-- kilde i det uavhengige søket viser at Wallester Business lar kunden
-- svare approve/decline i sanntid - beslutningen fattes av WALLESTER mot
-- konfigurerte grenser/kontroller (derfor er §10 sanntidsautorisasjons-
-- policy ærlig NOT_APPLICABLE - Jarvis uttrykker policy GJENNOM
-- provider-anvendte grenser + frys, se D-112). Tenant-ruting skjer via
-- KJENT provider-kort-mapping (provider_cards-oppslag) - ALDRI via
-- payload-tenant-metadata som autoritet (§15). INGEN bekreftet global
-- hendelses-ID i søket - dedupe-nøkkelen er Jarvis-utledet (hendelses-id
-- når til stede, ellers deterministisk type:objekt-id:status - samme
-- konservative prinsipp som Vipps/Neonomics).
CREATE TABLE wallester_webhook_events (
  dedupe_key                text PRIMARY KEY,
  tenant_id                  text REFERENCES tenants (tenant_id),
  memory_space_id             text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  event_type                   text NOT NULL,
  provider_object_id            text NOT NULL,
  card_id                        text REFERENCES provider_cards (card_id),
  status                          text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'verified', 'processed', 'failed_retryable', 'unsupported')),
  payload_summary                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message                     text,
  received_at                        timestamptz NOT NULL DEFAULT now(),
  processed_at                        timestamptz,
  created_at                           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallester_webhook_events_lookup_idx ON wallester_webhook_events (tenant_id, provider_object_id);

GRANT SELECT, INSERT, UPDATE ON provider_cards, card_spend_policies, card_events, card_authorizations, card_transactions, wallester_webhook_events TO jarvis_app;
-- Q-20: kortdata er KUNDEDATA (samme klasse som payment_intents/bank-
-- tabellene) - registrert i modules/erasure/src/plan.ts. Erasure-planen
-- skiller slettbar bruker-metadata fra finansielt revisjonsbevis (§24) -
-- se plan.ts-kommentaren. Uten DELETE ville ErasureService feile med
-- permission denied (samme presedens som 038-042).
GRANT DELETE ON provider_cards, card_spend_policies, card_events, card_authorizations, card_transactions, wallester_webhook_events TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'provider_cards', 'card_spend_policies', 'card_events', 'card_authorizations', 'card_transactions', 'wallester_webhook_events'
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

-- === business_open_loops: én ny deterministisk kort-regel ================
-- SAMME utvidelsesmønster som 042: kun CHECK-utvidelse + regel i
-- OpenLoopService (ren SQL). Én bevisst SMAL loop-type (detaljene bor i
-- reason/detection_key): card_anomaly_attention - et kort ELLER en
-- korttransaksjon har uløste deterministiske avviksflagg.
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required',
  'marketing_spend_anomaly',
  'payment_intent_anomaly', 'payment_intent_reconciliation_mismatch',
  'finance_spend_unexpected', 'finance_spend_amount_deviation', 'finance_recurring_charge_missing',
  'finance_recurring_charge_duplicate', 'finance_spend_correction_conflict',
  'bank_transaction_unmatched', 'bank_consent_attention',
  'card_anomaly_attention'
));
