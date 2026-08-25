-- UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2, D-107
-- forblir gjeldende beslutningsgrunnlag - D-64 Core-vs-Adapter-porten
-- ALLEREDE kjørt for finans-domenet, ingen ny ekstern leverandør
-- introduseres i denne sliceen: ZERO nye credentials/OAuth/leverandør-
-- beslutninger her - HELE denne migrasjonen er JARVIS_CANONICAL).
--
-- §2 i byggeordren (designvalg Claude kan ta uten Tobias): EGEN, DEDIKERT
-- `finance_spend_records`-tabell FREMFOR gjenbruk av `payment_intents`.
-- Begrunnelse: `payment_intents` modellerer en FREMTIDIG, eier-initiert
-- betalingsintensjon med en eksplisitt provider-innsendings-lifecycle
-- (draft -> submitted -> provider_acknowledged -> settled/failed/
-- cancelled, state-machine.ts) og et eier-oppgitt `idempotency_key`.
-- Observert intern utgift (annonseforbruk/AI-API-kostnad) har INGEN slik
-- lifecycle - den har ALLEREDE skjedd når Jarvis ser den, kommer fra en
-- EKSISTERENDE kildetabell (`marketing_spend_events`/`cost_events`) med
-- SIN EGEN idempotens-nøkkel, og skal ALDRI "sendes inn" noe sted. Å
-- tvinge den inn i `payment_intents` ville enten (a) korrumpert state-
-- machinen (en observert utgift har ingen "draft" å sende fra), eller
-- (b) krevd å svekke `payment_intents` sine CHECK-constraints/semantikk
-- for en heldig ubeslektet bruk. En egen tabell bevarer BEGGE domenenes
-- presise betydning: `payment_intents` = "noe Jarvis skal/har bedt om å
-- betale", `finance_spend_records` = "noe som FAKTISK har skjedd, observert
-- fra en kilde Jarvis allerede eier". Kort dokumentert her (ikke en ny
-- D-beslutning - se byggeordrens §2 "do NOT create a new D-decision unless
-- genuinely necessary" - dette er en implementasjonsdetalj innenfor D-107,
-- ikke et nytt arkitekturvalg).
--
-- Kildefamilier denne sliceen (KUN interne, allerede-eksisterende Jarvis-
-- kilder - INGEN Google Ads/Fiken-live her, se D-108):
--   'marketing' -> `marketing_spend_events` (027_growth.sql, GrowthService.recordSpendEvent)
--   'model_cost' -> `cost_events` (004_audit_cost.sql + additive migrasjoner, ModelGateway.recordCost/recordFailedAttempt)
-- Samme RLS-/idempotens-/GRANT-/CHECK-mønster som `038_finance.sql`/
-- `027_growth.sql` - ingen ny sikkerhetsmodell.

-- Rekkefølge: commitments og procurement FØR spend_records (spend_records
-- refererer til begge). `finance_procurement_items` refererer BEVISST
-- ALDRI tilbake til `finance_spend_records` (ville vært en sirkulær FK) -
-- oppfyllelse spørres opp via `finance_spend_records.procurement_item_id`,
-- aldri en reverse-FK på procurement-raden selv.

CREATE TABLE finance_recurring_commitments (
  commitment_id            text PRIMARY KEY,
  tenant_id                 text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id            text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  vendor_name                 text NOT NULL,
  description                  text NOT NULL,
  -- Bevisst enkel, ikke en "vilkårlig faktureringsspråk"-motor (byggeordren
  -- §6: "Do not overengineer arbitrary billing languages"). 'custom_days'
  -- dekker enhver annen deterministisk intervall-basert kadanse UTEN å
  -- bygge et fullt cron-uttrykks-språk.
  cadence                       text NOT NULL CHECK (cadence IN ('monthly','yearly','custom_days')),
  cadence_interval_days          integer CHECK (cadence_interval_days > 0),
  expected_billing_day_of_month   integer CHECK (expected_billing_day_of_month BETWEEN 1 AND 31),
  expected_amount_ore              bigint NOT NULL CHECK (expected_amount_ore > 0),
  currency                          text NOT NULL DEFAULT 'NOK' CHECK (currency ~ '^[A-Z]{3}$'),
  -- Deterministisk toleranse for AMOUNT_DEVIATION-avviksregelen (§8C) -
  -- ALDRI en AI-vurdert "rimelig avvik".
  amount_tolerance_ore               bigint NOT NULL DEFAULT 0 CHECK (amount_tolerance_ore >= 0),
  -- Deterministiske, EKSPLISITT av eier/agent angitte mapping-regler for å
  -- koble innkommende spend-records til DENNE forpliktelsen (f.eks.
  -- {"campaign_id": "..."} eller {"model": "..."}) - ALDRI AI-gjettet
  -- kobling (Q-26-grensen), kun en pointer-struktur.
  source_mapping                       jsonb NOT NULL DEFAULT '{}'::jsonb,
  state                                  text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','cancelled')),
  -- Deterministiske avviksflagg SATT PÅ forpliktelsen selv (ALDRI AI-
  -- inferert - Q-26-grensen), for avvikstyper uten noen naturlig
  -- spend-record-rad å flagge (f.eks. MISSING_EXPECTED_SPEND/
  -- DUPLICATE_RECURRING_CHARGE - se SpendService.runAnomalyDetection()).
  anomaly_flags                          jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_intent_id                        text REFERENCES payment_intents (payment_intent_id),
  owner_person_id                            text REFERENCES people (person_id),
  start_date                                  date NOT NULL,
  end_date                                     date,
  next_expected_charge_at                       timestamptz,
  last_expected_charge_at                        timestamptz,
  created_at                                      timestamptz NOT NULL DEFAULT now(),
  updated_at                                       timestamptz NOT NULL DEFAULT now(),
  cancelled_at                                      timestamptz,
  -- Deterministisk husregel (§7-mønster - kryss-kolonne-invariant håndhevet
  -- i Postgres, ikke bare applikasjonskode): 'custom_days' MÅ ha et
  -- eksplisitt intervall, ellers er kadansen meningsløs.
  CHECK (cadence != 'custom_days' OR cadence_interval_days IS NOT NULL)
);
CREATE INDEX finance_recurring_commitments_lookup_idx ON finance_recurring_commitments (tenant_id, memory_space_id, state);

CREATE TABLE finance_procurement_items (
  procurement_item_id      text PRIMARY KEY,
  tenant_id                 text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id            text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  vendor_name                 text NOT NULL,
  description                  text NOT NULL,
  expected_amount_ore           bigint NOT NULL CHECK (expected_amount_ore > 0),
  currency                       text NOT NULL DEFAULT 'NOK' CHECK (currency ~ '^[A-Z]{3}$'),
  expected_date                   date NOT NULL,
  -- Deterministisk vindu (dager før/etter expected_date) for MISSING_EXPECTED_SPEND-
  -- regelen (§8D) - ALDRI en AI-vurdert "passe lenge å vente".
  expected_window_days             integer NOT NULL DEFAULT 0 CHECK (expected_window_days >= 0),
  status                             text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','fulfilled','cancelled')),
  reconciliation_state                text NOT NULL DEFAULT 'unreconciled' CHECK (reconciliation_state IN ('unreconciled','matched','mismatched')),
  -- Deterministiske avviksflagg (ALDRI AI-inferert - Q-26-grensen) - SAMME
  -- begrunnelse som `finance_recurring_commitments.anomaly_flags`: MISSING_EXPECTED_SPEND
  -- (§8D) gjelder ANSKAFFELSEN selv (ingen matchende utgift funnet), ikke en
  -- enkelt spend-record-rad.
  anomaly_flags                        jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_intent_id                    text REFERENCES payment_intents (payment_intent_id),
  owner_person_id                       text REFERENCES people (person_id),
  created_at                             timestamptz NOT NULL DEFAULT now(),
  updated_at                              timestamptz NOT NULL DEFAULT now(),
  fulfilled_at                             timestamptz,
  cancelled_at                              timestamptz
);
CREATE INDEX finance_procurement_items_lookup_idx ON finance_procurement_items (tenant_id, memory_space_id, status);

CREATE TABLE finance_spend_records (
  spend_record_id          text PRIMARY KEY,
  tenant_id                 text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id            text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Deterministisk kildeklassifisering - EKSAKT de to interne kildene
  -- denne sliceen faktisk integrerer med (se toppkommentar). En FREMTIDIG
  -- kildefamilie krever en egen skjemaendring (ingen spekulativ
  -- forhåndsklargjøring - samme prinsipp som `payment_intents.provider`).
  source_family              text NOT NULL CHECK (source_family IN ('marketing','model_cost')),
  -- Kildens EGEN primærnøkkel (marketing_spend_events.spend_event_id,
  -- eller cost_events.cost_id::text) - EKSAKT sporbarhet tilbake til
  -- kildehendelsen (byggeordrens §3-krav "exact source event traceability"),
  -- ALDRI en kopi av kildeinnholdet selv (pointer-not-payload).
  source_record_id            text NOT NULL,
  occurred_at                   timestamptz NOT NULL,
  -- Beløp i øre (SAMME konvensjon som payment_intents/marketing_spend_events/
  -- cost_events) - ALDRI flyttall for pengebeløp. >= 0 (IKKE > 0 - en kilde
  -- kan legitimt rapportere en 0-øre hendelse, f.eks. en mislykket AI-
  -- forespørsel kostnadsført til 0 i cost_events, se ModelGateway.recordFailedAttempt).
  amount_ore                     bigint NOT NULL CHECK (amount_ore >= 0),
  currency                        text NOT NULL DEFAULT 'NOK' CHECK (currency ~ '^[A-Z]{3}$'),
  -- Deterministisk, KODE-utledet (SpendService), ALDRI brukerinput direkte -
  -- CHECK er et andre, uavhengig sikkerhetsnett (samme "validert i
  -- applikasjonslaget FØR innsetting, CHECK som backstop"-mønster som
  -- payment_intents.account_code). Nøyaktig én kategori per kildefamilie i
  -- denne sliceen - ingen spekulativ, ubrukt underkategorisering.
  category                         text NOT NULL CHECK (category IN ('marketing_spend', 'ai_api_cost')),
  -- Valgfri leverandør-/tjenesteidentifikator DER kilden faktisk har en
  -- (cost_events.provider for 'model_cost'; NULL for 'marketing' - kanalen
  -- ligger allerede på `marketing_campaigns.channel` via campaign_id-
  -- koblingen, IKKE duplisert her).
  source_provider                   text,
  -- Valgfri modell-/tjeneste-identifikator (cost_events.model for
  -- 'model_cost'; NULL for 'marketing').
  source_model_or_service             text,
  campaign_id                          text REFERENCES marketing_campaigns (campaign_id),
  payment_intent_id                     text REFERENCES payment_intents (payment_intent_id),
  recurring_commitment_id                text REFERENCES finance_recurring_commitments (commitment_id),
  procurement_item_id                     text REFERENCES finance_procurement_items (procurement_item_id),
  reconciliation_state                     text NOT NULL DEFAULT 'unreconciled' CHECK (reconciliation_state IN ('unreconciled','matched','mismatched')),
  -- Deterministiske avviksflagg (ALDRI AI-inferert - Q-26-grensen), SAMME
  -- mønster som payment_intents.anomaly_flags.
  anomaly_flags                             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- §5-krav ("preserve estimate vs settled distinction... do not promote an
  -- estimate into a verified invoice/accounting fact"): kolonnen finnes for
  -- å IKKE kreve en fremtidig skjemaendring den dagen en kilde faktisk
  -- rapporterer estimater - BEGGE dagens kilder (marketing_spend_events/
  -- cost_events) beregner beløpet synkront som endelig ved innsetting
  -- (INGEN separat oppgjørs-/faktureringssteg finnes noe sted i kodebasen,
  -- verifisert i denne sliceens audit) - derfor ALLTID 'settled' i dag,
  -- ALDRI 'estimated' fabrikkert. Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED
  -- forblir false.
  source_amount_status                       text NOT NULL DEFAULT 'settled' CHECK (source_amount_status IN ('settled','estimated')),
  -- §4-krav ("updated/corrected source events handled") + avvikstype G
  -- (SOURCE_CORRECTION_CONFLICT, §8G): satt av SpendService ved re-synk av
  -- en ALLEREDE synkronisert kilderad med et ENDRET beløp/valuta ETTER at
  -- posten allerede er avstemt/flagget - ALDRI stille overskrevet.
  source_correction_state                     text NOT NULL DEFAULT 'original' CHECK (source_correction_state IN ('original','corrected','correction_conflict')),
  -- Pointer-metadata (f.eks. hvilken synk-kjøring/markør produserte denne
  -- raden) - ALDRI en kopi av kildens rå innhold (samme prinsipp som
  -- `contracts.canonical_uri`/`marketing_campaigns.external_campaign_id`).
  provenance                                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                                     timestamptz NOT NULL DEFAULT now(),
  updated_at                                      timestamptz NOT NULL DEFAULT now(),
  -- Kilde-idempotens (byggeordrens §3-krav "source idempotent... repeated
  -- sync MUST NOT duplicate money"): ÉN rad per (tenant, kildefamilie,
  -- kilderad) UANSETT hvor mange ganger synk-jobben kjøres. Re-synk av
  -- SAMME kilderad oppdaterer SAMME rad (ON CONFLICT DO UPDATE i
  -- SpendService), oppretter ALDRI en duplikat.
  UNIQUE (tenant_id, source_family, source_record_id)
);
CREATE INDEX finance_spend_records_lookup_idx ON finance_spend_records (tenant_id, memory_space_id, source_family, occurred_at DESC);
CREATE INDEX finance_spend_records_reconciliation_idx ON finance_spend_records (tenant_id, reconciliation_state) WHERE reconciliation_state != 'matched';
CREATE INDEX finance_spend_records_campaign_idx ON finance_spend_records (tenant_id, campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX finance_spend_records_commitment_idx ON finance_spend_records (tenant_id, recurring_commitment_id) WHERE recurring_commitment_id IS NOT NULL;

-- Deterministisk synk-markør/checkpoint (byggeordrens §12-krav "deterministic
-- checkpoints/cursors... safe restart after crash"): ETT rad per (tenant,
-- kildefamilie) - REN operativ bokføringstilstand, ikke kundeinnhold (samme
-- klasse som `scheduler_state`/`finance_kill_switch`) - derfor tenant-only
-- RLS, ingen memory_space_id (se finance_kill_switch-presedens i 038_finance.sql).
-- `cursor_value` er en ugjennomsiktig streng SpendService selv tolker
-- (siste synkroniserte event_date for 'marketing', siste synkroniserte
-- cost_id for 'model_cost') - INGEN antakelse om format håndheves i SQL,
-- kun i applikasjonslaget som eier tolkningen.
CREATE TABLE finance_spend_sync_cursors (
  tenant_id                text NOT NULL REFERENCES tenants (tenant_id),
  source_family              text NOT NULL CHECK (source_family IN ('marketing','model_cost')),
  cursor_value                 text,
  last_synced_at                 timestamptz,
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_family)
);

GRANT SELECT, INSERT, UPDATE ON
  finance_recurring_commitments, finance_procurement_items, finance_spend_records, finance_spend_sync_cursors
  TO jarvis_app;
-- Q-20: finans-utgifts-domenet er KUNDEDATA (samme klasse som
-- `payment_intents`/`marketing_spend_events`, IKKE append-only
-- systemrevisjon) - registrert i `modules/erasure/src/plan.ts`. Uten denne
-- GRANTen ville ErasureService sin faktiske `DELETE FROM
-- finance_spend_records/...` feile med permission denied for HELE tenant-/
-- space-erasure-operasjonen (samme presedens som 038_finance.sql).
-- `finance_spend_sync_cursors` er REN operativ tilstand (ikke kundeinnhold),
-- men registreres likevel i `planTenant()` (samme "en full tenant-sletting
-- skal ikke etterlate et dinglende cursor-rad"-begrunnelse som andre
-- tenant-only-rader) - trenger derfor samme DELETE-grant.
GRANT DELETE ON
  finance_recurring_commitments, finance_procurement_items, finance_spend_records, finance_spend_sync_cursors
  TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_recurring_commitments', 'finance_procurement_items', 'finance_spend_records'
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

-- finance_spend_sync_cursors: tenant-only RLS (ingen memory_space_id-kolonne
-- - se toppkommentar, SAMME mønster som finance_kill_switch).
ALTER TABLE finance_spend_sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_spend_sync_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_spend_sync_cursors_tenant ON finance_spend_sync_cursors
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));

-- Byggeordren §10: "Reuse OpenLoopService... No separate shadow task
-- system." Additiv utvidelse av DEN EKSISTERENDE `business_open_loops`
-- (SAMME mønster som payment_intent_id/campaign_id/contract_id-kolonnene
-- over): to nye nullable peker-kolonner + fem nye `loop_type`-verdier for
-- deterministisk utgifts-/forpliktelses-avviksdeteksjon.
ALTER TABLE business_open_loops ADD COLUMN finance_spend_record_id text REFERENCES finance_spend_records (spend_record_id);
ALTER TABLE business_open_loops ADD COLUMN finance_recurring_commitment_id text REFERENCES finance_recurring_commitments (commitment_id);
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (
  'overdue_followup', 'stalled_opportunity',
  'support_ticket_needs_reply', 'support_ticket_overdue', 'support_ticket_unassigned', 'support_ticket_waiting_internal',
  'contract_renewal_due', 'contract_termination_deadline', 'contract_obligation_due', 'contract_review_required',
  'marketing_spend_anomaly',
  'payment_intent_anomaly', 'payment_intent_reconciliation_mismatch',
  'finance_spend_unexpected', 'finance_spend_amount_deviation', 'finance_recurring_charge_missing',
  'finance_recurring_charge_duplicate', 'finance_spend_correction_conflict'
));
