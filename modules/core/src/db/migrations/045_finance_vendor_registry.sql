-- UA-6 Finance & Spend Integrity Gateway - HARDENING (D-116): lukker
-- masterplanens akseptansekriterium 3 sitt eneste gjenværende delgap,
-- dokumentert PARTIAL siden D-115 (UA-6 dedikert closeout-audit).
--
-- D-115 sitt funn: en SYNTAKTISK gyldig, men FEIL `payment_intents.
-- vendor_provider_ref` kunne IKKE skilles fra en korrekt verdi uten enten
-- (A) et ekte leverandør-oppslag (utenfor scope - ingen credentials/live
-- calls i denne sliceen) eller (B) et Jarvis-eid vendor-identitetsregister
-- (valgt av Tobias, D-116). Kun FRAVÆR av referansen ble fanget
-- deterministisk (MissingVendorProviderRefError, D-107) - en feil-MEN-
-- TILSTEDEVÆRENDE referanse gikk uhindret gjennom.
--
-- D-64 Core-vs-Adapter-disiplin: `finance_vendors`/
-- `finance_vendor_provider_bindings` er JARVIS_CANONICAL (intern
-- vendor-identitet, koblingen mellom vendor og EIER-/systemregistrerte
-- provider-referanser, aktiv/inaktiv, tenant-tilhørighet, proveniens) -
-- registeret sier KUN "denne provider-referansen er DEN registrerte
-- referansen for denne Jarvis-vendor-identiteten", ALDRI at referansen
-- faktisk eksisterer hos leverandøren (det ville krevd et EKTE
-- leverandør-oppslag - D-108, fortsatt utsatt). Leverandørens EGEN
-- interne vendor-/customer-/merchant-objekt forblir EXTERNAL_CANONICAL,
-- utenfor Jarvis sin kunnskap.
--
-- Reuse-audit FØR denne migrasjonen (se D-116 i DECISIONS_AND_ASSUMPTIONS.md
-- for full begrunnelse): `business_companies` (019_business.sql) ble
-- vurdert og EKSPLISITT AVVIST som gjenbrukskandidat - den er en CRM-/
-- salgspipeline-motpartsmodell (status prospect/active/inactive/churned,
-- INGEN provider-referanse-/kontonummer-felt noe sted) orientert mot
-- KUNDER Kundeoppfølging AS selger TIL, ikke leverandører Jarvis BETALER -
-- og er selv IKKE registrert i Q-20 erasure-planen (kjent, dokumentert
-- gap, urørt av denne sliceen). Alle eksisterende vendor-felt i UA-6
-- (`payment_intents.vendor_name`, `finance_recurring_commitments.
-- vendor_name`, `finance_procurement_items.vendor_name`,
-- `provider_cards.vendor_name`) er uavhengig fritekst UTEN dedupliserende
-- kanonisk identitet. Ingen egnet eksisterende struktur funnet - en
-- minimal, additiv ny struktur er derfor nødvendig.
--
-- To tabeller, EKSAKT samme RLS-/GRANT-/erasure-/UNIQUE-mønster som
-- `043_wallester.sql`/`044_finance_procurement_openloop.sql`:
--
-- `finance_vendors`: kanonisk Jarvis-vendor-identitet (kun navn +
-- proveniens - INGEN status-felt her, aktiv/inaktiv styres PER BINDING,
-- se punkt D under).
--
-- `finance_vendor_provider_bindings`: den deterministiske X<->Y<->Z-
-- koblingen (canonical vendor <-> provider <-> provider_vendor_ref).
-- `UNIQUE (tenant_id, provider, provider_vendor_ref)` håndhever
-- STRUKTURELT at samme (tenant, provider, provider_vendor_ref) ALDRI kan
-- peke på to forskjellige vendors (akseptansekrav A) - en revokert
-- binding oppdateres i SAMME rad (status-overgang), ALDRI en ny rad, så
-- constrainten forblir intakt over hele bindingens livsløp. `provider`
-- inngår i UNIQUE-nøkkelen og i enhver oppslags-spørring - en Stripe-
-- referanse kan derfor ALDRI tilfredsstille en Fiken/Vipps/Neonomics-
-- binding bare fordi teksten er lik (akseptansekrav F).
--
-- `payment_intents.vendor_id`: NY, NULLABLE peker-kolonne (SAMME
-- "additiv, ingen eksisterende data røres"-mønster som
-- `finance_recurring_commitment_id`/`finance_procurement_item_id` i
-- tidligere migrasjoner). Eksisterende rader (og enhver FREMTIDIG
-- pengehandling som bevisst IKKE oppgir en canonical vendor) forblir
-- `vendor_id = NULL` - "ukjent forblir ukjent", INGEN retroaktiv
-- gjetting/backfill av historiske rader. Gaten i
-- `FinanceService.submitPaymentIntent()` er derfor STRUKTURELT
-- betinget: den utløses KUN når en pengehandling EKSPLISITT hevder en
-- canonical vendor-identitet (`vendor_id IS NOT NULL`) - historiske og
-- fremtidige vendor-id-løse intents er UPÅVIRKET (akseptansekrav 13,
-- ingen retroaktiv omskriving).

CREATE TABLE finance_vendors (
  vendor_id             text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  name                  text NOT NULL,
  created_by_person_id  text REFERENCES people (person_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance_vendor_provider_bindings (
  binding_id             text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  vendor_id               text NOT NULL REFERENCES finance_vendors (vendor_id),
  -- SAMME `PaymentProvider`-verdisett som `payment_intents.provider`
  -- (038/040/041/042_*.sql) - registeret dekker de fire providerne som
  -- faktisk utfører vendor-rettede pengehandlinger via
  -- `submitPaymentIntent()`. Wallester (kort/wallet) er BEVISST IKKE
  -- inkludert her - kortdomenet avstemmer mot en FORMÅLSBUNDET
  -- forpliktelse (`card_transactions.matched_commitment_id`), ALDRI mot
  -- `vendor_provider_ref` - et strukturelt ANNET avstemmingsprinsipp, se
  -- D-116 for full begrunnelse (IKKE et stille utelatt gap).
  provider                 text NOT NULL CHECK (provider IN ('fiken','stripe','vipps','neonomics')),
  -- Opak identifikator - ALDRI parset/regex-validert utover
  -- tilstedeværelse. Identitetsmatch mot DENNE registrerte verdien er
  -- selve invarianten, ikke syntaktisk kosmetikk (byggeordrens §7).
  provider_vendor_ref        text NOT NULL,
  status                       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by_person_id          text REFERENCES people (person_id),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  revoked_at                       timestamptz,
  UNIQUE (tenant_id, provider, provider_vendor_ref)
);
CREATE INDEX finance_vendor_provider_bindings_vendor_idx ON finance_vendor_provider_bindings (tenant_id, vendor_id);

ALTER TABLE payment_intents ADD COLUMN vendor_id text REFERENCES finance_vendors (vendor_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_vendors', 'finance_vendor_provider_bindings'
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

GRANT SELECT, INSERT, UPDATE ON finance_vendors, finance_vendor_provider_bindings TO jarvis_app;
-- Q-20: full tenant-/memory-space-sletting krever DELETE - samme
-- begrunnelse som HVER tidligere UA-6-migrasjon (043/044).
GRANT DELETE ON finance_vendors, finance_vendor_provider_bindings TO jarvis_app;
