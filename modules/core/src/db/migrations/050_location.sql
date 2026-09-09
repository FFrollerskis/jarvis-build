-- UA-8 Personal Digital Twin - Native Jarvis Location/Geofencing Core (D-64
-- Core-vs-Adapter-porten kjørt FØRST): Jarvis EIER selv den kanoniske
-- lokasjons-/geofence-domenemodellen (JARVIS_CANONICAL). Posisjonsdata er
-- INTRINSIC til Jarvis sin egen tverr-domene-resonnering (geofence-baserte
-- automasjoner, tilstedeværelse, senere kontekst-motor) - en ekstern
-- leverandør (Apple/Google/etc.) skal ALDRI være spørrbar "source of truth"
-- for dette domenet. Et fremtidig eksternt system (f.eks. Apple Find My via
-- en fremtidig adapter) er UTELUKKENDE en KILDE som SKRIVER INN i denne
-- modellen via `location_observations.source_type`/`source_instance_id`
-- (pointer-not-payload, samme prinsipp som `operations_tasks.source_type`/
-- `source_instance_id` i 048_operations.sql) - ALDRI spurt live, ALDRI
-- domeneeier. ZERO PostGIS-avhengighet i denne sliceen: geofences er
-- BEVISST sirkulære (senter + radius), ingen polygon-boundary (se
-- `LocationService` sin filhode-kommentar for utvidelsesnotatet).
--
-- Tre tabeller:
--   1. `location_zones` - eier-definerte geofences (typisk PERSONLIGE - én
--      person sine soner, IKKE et delt bedrifts-konsept i denne sliceen).
--   2. `location_observations` - rå, leverandør-nøytralt innhentede
--      posisjonspunkter (aldri en rå Apple/Google-payload - kun
--      `source_type`/`source_instance_id`-PEKERE til den innhentende
--      adapteren/enheten, samme "pointer-not-payload"-prinsipp som resten av
--      dette repoet).
--   3. `location_zone_visits` - DERIVERT tilstand (inn/ut av en sone),
--      beregnet av `LocationService.evaluateZoneTransitions()` fra
--      observasjoner - ALDRI direkte skrevet av en ekstern kaller.
--
-- Retensjon (samme "eier-konfigurert, Jarvis håndhever, Jarvis GJETTER
-- ALDRI"-disiplin som D-91/D-92 i 032_consent_governance.sql/
-- 033_consent_enforcement.sql): `location_retention_policies` er en
-- EKSPLISITT, eier-konfigurerbar per-(tenant, space) retensjonsvindu-
-- konfigurasjon (samme UPSERT-current-state-form som
-- `consent_enforcement_policies` - operasjonell konfigurasjon, IKKE en
-- append-only juridisk beslutningslogg). `location_observations.
-- retention_expires_at` beregnes VED INNSETTING av `LocationService.
-- ingestObservation()` fra denne konfigurasjonen (aldri en triggerberegning
-- - samme "applikasjonslaget beregner, databasen lagrer resultatet"-mønster
-- som resten av repoet). Location-domenet er SENSITIV PERSONLIG DATA
-- (posisjonshistorikk) - i FRAVÆR av en eier-konfigurert policy-rad brukes
-- et PERSONVERN-BESKYTTENDE, ENDELIG standardvindu (90 dager, se
-- `DEFAULT_RETENTION_DAYS` i `modules/location/src/service.ts`) - MOTSATT
-- retning av D-92 sin "disabled" fail-open-standard (der fravær av
-- konfigurasjon bevisst betyr "håndhev ingenting ennå"): for
-- posisjonsdata betyr fravær av eksplisitt eierkonfigurasjon ALDRI "behold
-- for alltid" - det ville vært en stille personvernsrisiko, ikke en trygg
-- standard. Eieren kan eksplisitt konfigurere et LENGRE (eller kortere)
-- vindu via `LocationService.setRetentionPolicy()`; det finnes bevisst
-- INGEN "uendelig retensjon"-verdi i denne sliceen (se filhode-kommentar i
-- `modules/location/src/service.ts` for full begrunnelse).

CREATE TABLE location_retention_policies (
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  retention_days  integer NOT NULL CHECK (retention_days > 0),
  actor_person_id text REFERENCES people (person_id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_space_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON location_retention_policies TO jarvis_app;

ALTER TABLE location_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY location_retention_policies_tenant ON location_retention_policies
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY location_retention_policies_space ON location_retention_policies AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Geofences: sirkulær (senter + radius) - dependency-fri MVP, INGEN
-- PostGIS/polygon i denne sliceen (dokumentert fremtidig utvidelse, se
-- `modules/location/src/service.ts`). Typisk PERSONLIG (`person_id` NOT
-- NULL - en sone tilhører alltid én navngitt person i denne sliceen; en
-- fremtidig DELT husholdningssone er en SEPARAT, senere beslutning).
CREATE TABLE location_zones (
  zone_id         text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  person_id       text NOT NULL REFERENCES people (person_id),
  name            text NOT NULL,
  center_lat      double precision NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lon      double precision NOT NULL CHECK (center_lon BETWEEN -180 AND 180),
  radius_meters   double precision NOT NULL CHECK (radius_meters > 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX location_zones_lookup_idx ON location_zones (tenant_id, memory_space_id, person_id);
-- Arkitekt-review-lærdom (D-129, samme prinsipp gjenbrukt her): en enkel
-- `zone_id text PRIMARY KEY`-FK er IKKE en tenant/space-autorisasjonsgrense
-- - Postgres sin FK-sjekk kjører med forhøyet privilegium og omgår RLS, saa
-- et FK-maal fra en ANNEN tenant/space ville blitt akseptert stille. Denne
-- UNIQUE-nøkkelen er FK-MÅLET for `location_zone_visits.zone_id` sin
-- sammensatte fremmednøkkel under.
ALTER TABLE location_zones ADD CONSTRAINT location_zones_tenant_space_key UNIQUE (tenant_id, memory_space_id, zone_id);

-- Rå, leverandør-nøytrale posisjonspunkter. `source_type`/
-- `source_instance_id` er en POINTER til den innhentende adapteren/enheten
-- (f.eks. `source_type='device'`, `source_instance_id=<device_id>`) -
-- ALDRI en rå leverandør-payload (samme "Ingestion Zone er data, aldri
-- autoritativt minne direkte"-prinsipp fra CLAUDE.md regel 7, anvendt her
-- som "pointer-not-payload" siden posisjonspunkter uansett er strukturerte
-- tall, ikke ubetrodd fritekst). `retention_expires_at` er NULLABLE i
-- skjemaet (representerer "ingen policy kunne evalueres på innsettings-
-- tidspunktet" som en EKSPLISITT, synlig tilstand - se
-- `LocationService.ingestObservation()`, som i praksis ALLTID setter en
-- konkret verdi via standardvinduet dersom ingen eier-policy finnes).
CREATE TABLE location_observations (
  observation_id      text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  person_id            text NOT NULL REFERENCES people (person_id),
  source_type          text NOT NULL,
  source_instance_id   text,
  lat                  double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon                  double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  accuracy_meters      double precision CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
  observed_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  retention_expires_at timestamptz
);
CREATE INDEX location_observations_lookup_idx ON location_observations (tenant_id, memory_space_id, person_id, observed_at DESC);
-- Trengs av `LocationService.purgeExpiredObservations()` sin faktiske
-- håndhevings-spørring - partial index (kun rader med en satt frist) holder
-- den billig å skanne selv med et stort, voksende observasjonsvolum.
CREATE INDEX location_observations_retention_idx ON location_observations (retention_expires_at) WHERE retention_expires_at IS NOT NULL;
-- FK-MÅL for `location_zone_visits.source_observation_id` sin sammensatte
-- fremmednøkkel under (SAMME "enkel FK er ikke en autorisasjonsgrense"-
-- begrunnelse som `location_zones_tenant_space_key` over).
ALTER TABLE location_observations ADD CONSTRAINT location_observations_tenant_space_key UNIQUE (tenant_id, memory_space_id, observation_id);

-- DERIVERT tilstand: inn/ut av en sone. Skrives UTELUKKENDE av
-- `LocationService.evaluateZoneTransitions()` (deterministisk punkt-i-
-- sirkel-geometri, INGEN LLM/ekstern geo-bibliotek nødvendig for MVP-
-- sirkel-boundary) - ALDRI direkte fra en ubetrodd ekstern kaller.
-- `left_at` er NULL mens besøket er PÅGÅENDE.
CREATE TABLE location_zone_visits (
  visit_id             text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  person_id            text NOT NULL REFERENCES people (person_id),
  -- Sammensatt FK til `location_zones` lagt til NEDENFOR (etter tabellen) -
  -- IKKE en enkel `REFERENCES location_zones (zone_id)` her (samme D-129-
  -- lærdom som resten av denne migrasjonen: en enkel FK er ikke en
  -- tenant/space-autorisasjonsgrense).
  zone_id              text NOT NULL,
  entered_at           timestamptz NOT NULL,
  left_at              timestamptz,
  -- Sammensatt FK til `location_observations` lagt til NEDENFOR - PEKER til
  -- observasjonen som UTLØSTE denne besøksraden (inngangs-observasjonen).
  source_observation_id text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX location_zone_visits_lookup_idx ON location_zone_visits (tenant_id, memory_space_id, person_id, zone_id);
-- Trengs av `evaluateZoneTransitions()` for å finne det EVENTUELT allerede
-- PÅGÅENDE besøket for en (person, sone) den skal lukke - partial index
-- (kun åpne besøk) holder oppslaget billig.
CREATE INDEX location_zone_visits_open_idx ON location_zone_visits (tenant_id, memory_space_id, person_id, zone_id) WHERE left_at IS NULL;
ALTER TABLE location_zone_visits ADD CONSTRAINT location_zone_visits_zone_tenant_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, zone_id) REFERENCES location_zones (tenant_id, memory_space_id, zone_id);
ALTER TABLE location_zone_visits ADD CONSTRAINT location_zone_visits_observation_tenant_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, source_observation_id) REFERENCES location_observations (tenant_id, memory_space_id, observation_id);

-- Q-20-mønster (samme presedens som `048_operations.sql`): location-
-- domenet er PERSONLIG POSISJONSDATA, IKKE append-only systemrevisjon -
-- `DELETE`-grant er PÅKREVD for BÅDE ErasureService (registreres sentralt,
-- se byggeordrens rapporteringskrav) OG `LocationService.
-- purgeExpiredObservations()` sin faktiske retensjonshåndheving.
GRANT SELECT, INSERT, UPDATE, DELETE ON location_zones, location_observations, location_zone_visits TO jarvis_app;

ALTER TABLE location_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY location_zones_tenant ON location_zones
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY location_zones_space ON location_zones AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE location_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY location_observations_tenant ON location_observations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY location_observations_space ON location_observations AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE location_zone_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_zone_visits FORCE ROW LEVEL SECURITY;
CREATE POLICY location_zone_visits_tenant ON location_zone_visits
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY location_zone_visits_space ON location_zone_visits AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
