-- UA-8 Personal Digital Twin: Health ingestion/read canonical contract
-- (D-64 Core-vs-Adapter-porten kjørt FØRST, se DECISIONS_AND_ASSUMPTIONS.md).
--
-- Dette er et JARVIS_CANONICAL kontrakt-/ingestion-lag - Jarvis eier den
-- kanoniske helse-observasjons-modellen; en fremtidig leverandør (Apple
-- Health, en annen wearable/plattform) er ALDRI stedet domenemodellen bor,
-- KUN en kilde som skriver inn via `HealthMetricSource`-adapterkontrakten
-- (@jarvis/health, src/service.ts). Denne migrasjonen inneholder INGEN
-- leverandør-spesifikk kode/credential/entitlement-antakelse - ZERO live
-- Apple Health-avhengighet (dette miljøet har verken en fysisk iPhone eller
-- en Apple-entitlement - se byggeordren for UA-8).
--
-- SEGREGERING (ufravikelig, MEMORY_ARCHITECTURE §4 + `modules/memory/src/
-- spaces.ts` sin `assertSpacesAllowed()`: "health er strengere enn andre
-- spaces og kan ALDRI kombineres med andre i samme lesing/skriving"):
-- `memory_spaces`-CHECK-constraint (001_identity.sql) reserverte allerede
-- 'health' som en egen verdi. `health_metric_observations.memory_space_id`
-- har en EGEN CHECK som kun tillater literal 'health' - IKKE bare en
-- DEFAULT 'health' (som fortsatt ville tillatt en caller å sette et annet
-- gyldig space-navn). Dette er en STRUKTURELL databasegaranti: en helse-
-- observasjon kan ALDRI havne i 'personal'/'business'/et annet space, uansett
-- hva applikasjonskoden gjør. RLS-space-policyen under (RESTRICTIVE) er
-- BEVISST tilnærmet redundant med denne CHECK-en - dette ER poenget
-- (forsvar-i-dybden: CHECK-en beviser at raden STRUKTURELT ikke kan skrives
-- til feil space i det hele tatt; RLS-policyen beviser UAVHENGIG at en
-- sesjon uten 'health' i `jarvis.memory_spaces` ALDRI kan LESE/SKRIVE raden
-- selv om CHECK-en av en eller annen grunn skulle mangle - samme
-- "strukturelt, ikke konvensjonelt"-prinsipp som D-129 krevde for de
-- sammensatte FK-ene i 048_operations.sql).
--
-- `metric_type` er et BEVISST SMALT, LUKKET MVP-sett (v1) - IKKE et forsøk
-- på å modellere hele Apple HealthKit sin ontologi (hundrevis av typer,
-- enheter, korrelasjonstyper). Kun de fire mest grunnleggende, universelt
-- forståtte målingene er inkludert her; en fremtidig slice utvider settet
-- NÅR en faktisk kilde/brukstilfelle krever det (samme utvidelsesmønster
-- som `consent_decisions.purpose`/`operations_vendors.category`).
--
-- `source_type`/`source_instance_id` er en POINTER til den innhentende
-- adapteren (`HealthMetricSource.name` + en kilde-spesifikk instans-ID,
-- f.eks. "apple_health"/"<device-id>" i en FREMTIDIG, IKKE-bygget adapter,
-- eller "fake"/"<test-id>" for `FakeHealthMetricSource`) - ALDRI en
-- duplisert kopi av rå leverandør-payload et annet sted (samme "pointer-
-- not-payload"-prinsipp som `product_items`/`support_tickets`/`operations_
-- tasks`).
--
-- `retention_expires_at` er nullable og beregnes VED INNSETTING fra en
-- EIER-KONFIGURERT retention-vindu-rad i `health_retention_policies`
-- (samme "eksplisitt eier-konfigurert, ALDRI stille hardkodet"-prinsipp som
-- `consent_enforcement_policies`, 033_consent_enforcement.sql). Fravær av en
-- konfigurert policy for tenanten => `retention_expires_at = NULL` ved
-- innsetting => raden IKKE automatisk slettet av `purgeExpiredObservations()`
-- før eieren eksplisitt har konfigurert et vindu (samme "default bevarer
-- eksisterende oppførsel inntil eieren aktiverer"-prinsipp som D-92 sin
-- 'disabled'-standardmodus - her betyr "ingen policy" imidlertid "ingen
-- automatisk sletting", ALDRI "ingen beskyttelse", som er den tryggeste
-- retningen å feile i for helsedata).
CREATE TABLE health_retention_policies (
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'health' CHECK (memory_space_id = 'health'),
  retention_days  integer NOT NULL CHECK (retention_days > 0),
  actor_person_id text REFERENCES people (person_id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_space_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON health_retention_policies TO jarvis_app;

ALTER TABLE health_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY health_retention_policies_tenant ON health_retention_policies
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY health_retention_policies_space ON health_retention_policies AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Observasjonene selv er BEVISST append-only (SAMME "strukturelt, ikke
-- konvensjonelt"-prinsipp som `consent_decisions`, 032_consent_governance.sql:
-- ingen UPDATE-grant under). En feilregistrert måling korrigeres av en NY
-- observasjon (fra kilden, ved neste synk), ALDRI ved å mutere en historisk
-- helse-rad - historikken er i seg selv av verdi (f.eks. for en fremtidig
-- trend-analyse) og skal aldri stille endres i ettertid.
-- `seq` er SAMME monotoniske tie-breaker-mønster som `consent_decisions.seq`
-- (mikrosekund-oppløsning på `observed_at`/`recorded_at` er IKKE alltid nok
-- til å garantere en unik/deterministisk rekkefølge under samtidige
-- innsettinger).
CREATE TABLE health_metric_observations (
  seq                  bigserial UNIQUE,
  observation_id       text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  -- Strukturell garanti (se migrasjons-kommentaren over) - IKKE bare en
  -- DEFAULT: helsedata kan ALDRI havne i et annet memory space enn 'health'.
  memory_space_id      text NOT NULL DEFAULT 'health' CHECK (memory_space_id = 'health'),
  person_id            text NOT NULL REFERENCES people (person_id),
  -- BEVISST SMALT MVP-sett (v1) - se migrasjons-kommentaren over. IKKE et
  -- forsøk på å dekke hele Apple HealthKit-ontologien.
  metric_type          text NOT NULL CHECK (metric_type IN ('heart_rate', 'steps', 'sleep_duration_minutes', 'weight_kg')),
  -- Strukturell defense-in-depth for "ingen negativ måling" (§ akseptansekriterium
  -- B i byggeordren, f.eks. en negativ hjertefrekvens) - ALLE fire MVP-
  -- metric_type-verdiene er naturlig ikke-negative størrelser, så en generisk
  -- `value >= 0`-CHECK er en ærlig, korrekt DB-garanti for hele det nåværende
  -- settet (IKKE en påstand om at DETTE alene er all validering som trengs -
  -- `HealthService.ingestObservation()` validerer i tillegg enhet-konsistens
  -- og MVP-fornuftige øvre grenser per metric_type, se service.ts).
  value                numeric NOT NULL CHECK (value >= 0),
  unit                 text NOT NULL CHECK (unit <> ''),
  -- Pointer-not-payload til den innhentende adapteren (se migrasjons-
  -- kommentaren over) - ALDRI rå leverandør-payload duplisert her.
  source_type          text NOT NULL,
  source_instance_id   text,
  observed_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  -- Beregnet VED INNSETTING fra `health_retention_policies` (se over) - NULL
  -- inntil eieren har konfigurert et retention-vindu for tenanten.
  retention_expires_at timestamptz
);
CREATE INDEX health_metric_observations_lookup_idx
  ON health_metric_observations (tenant_id, person_id, metric_type, observed_at DESC);
-- Understøtter `purgeExpiredObservations()` sitt oppslag ("finn alle rader
-- forbi utløp") uten full tabellskann.
CREATE INDEX health_metric_observations_retention_idx
  ON health_metric_observations (retention_expires_at) WHERE retention_expires_at IS NOT NULL;

-- Deliberately NO UPDATE grant - append-only, samme "strukturelt, ikke
-- konvensjonelt"-prinsipp som consent_decisions (032).
GRANT SELECT, INSERT ON health_metric_observations TO jarvis_app;
-- Q-20 (erasure) + reell retention-håndhevelse (`purgeExpiredObservations()`)
-- krever begge DELETE - uten denne GRANTen ville BÅDE en full tenant-/
-- person-erasure OG den løpende retention-jobben feile med permission
-- denied (samme presedens som `consent_decisions`/`operations_*`).
GRANT DELETE ON health_metric_observations TO jarvis_app;
GRANT USAGE, SELECT ON SEQUENCE health_metric_observations_seq_seq TO jarvis_app;

ALTER TABLE health_metric_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_metric_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY health_metric_observations_tenant ON health_metric_observations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
-- RESTRICTIVE, samme mønster som resten av kodebasen - se migrasjons-
-- kommentaren øverst for hvorfor dette er BEVISST tilnærmet redundant med
-- `memory_space_id = 'health'`-CHECK-en over (forsvar-i-dybden, ikke
-- duplisering å fjerne).
CREATE POLICY health_metric_observations_space ON health_metric_observations AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
