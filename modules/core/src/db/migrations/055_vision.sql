-- UA-9 Vision & Physical World - Native Jarvis Vision Event Core (D-64
-- Core-vs-Adapter-porten kjørt FØRST, se DECISIONS_AND_ASSUMPTIONS.md D-153):
-- Jarvis EIER selv den kanoniske domenemodellen for objekt-/hendelses-
-- observasjoner og romassosiasjon (JARVIS_CANONICAL). Et fremtidig eksternt
-- system (iPhone-kamera, Home Assistant kamera-events, dørklokke/sikkerhets-
-- events) er UTELUKKENDE en ADAPTER som SKRIVER INN allerede klassifiserte,
-- strukturerte hendelser via `vision_event_observations.source_type`/
-- `source_instance_id` (pointer-not-payload, SAMME prinsipp som
-- `location_observations`/`health_metric_observations`) - ALDRI spurt live,
-- ALDRI domeneeier. Selve BILDE-/OBJEKTKLASSIFISERINGEN (den faktiske
-- ML-modell-inferensen på et kamerabilde) skjer i en FREMTIDIG, IKKE bygget
-- her, adapter - denne migrasjonen lagrer KUN det strukturerte RESULTATET
-- av en slik klassifisering (`event_type`/`object_label`/`confidence`), ALDRI
-- rå bilde-/videobytes (se `snapshot_ref`-kommentar under - en PEKER,
-- ALDRI en lagret payload, i tråd med masterplanens "event snapshots by
-- default instead of continuous raw video").
--
-- ARKITEKT-REVIEW-FIKS (PR #83, P1 x2, 2026-09-15): (1) `source_event_id`
-- er en NY, PÅKREVD kilde-stabil dedupe-nøkkel - en adapter/poll-sløyfe med
-- overlappende vinduer, en transport-retry, eller en krasjet delvis batch
-- produserte tidligere en STILLE duplikat-rad (fersk `randomUUID()` per
-- innsetting, INGEN identitetsbevaring fra kilden). Se `vision_event_
-- observations_source_dedupe_key` under - `VisionService.ingestObservation()`
-- gjør nå en `INSERT ... ON CONFLICT DO NOTHING` mot DENNE nøkkelen og
-- returnerer den EKSISTERENDE raden ved konflikt (deterministisk replay,
-- ALDRI en ny rad for samme kilde-hendelse). (2) `snapshot_ref` forbys nå
-- STRUKTURELT (se CHECK-en under) - se den kommentaren for begrunnelsen.
--
-- Biometrisk ansiktsgjenkjenning er EKSPLISITT UTENFOR denne migrasjonen
-- (masterplan v4.0 UA-9: "Biometric face identification remains outside
-- this masterplan unless separately decided and lawfully implemented") -
-- INGEN kolonne her representerer en biometrisk identitet.
--
-- MULTI-SPACE (location-stil, IKKE health-stil enkelt-låst space): ingen
-- 'vision'-verdi er reservert i den kanoniske `memory_spaces`-enumereringen
-- (001_identity.sql), og å legge til én ville krevd å røre svært mange
-- eksisterende tabellers inline CHECK-constraints (uakseptabelt stort,
-- urelatert blast radius for denne sliceen). Kamera-/hendelsesdata hører i
-- tillegg naturlig til FLERE spaces (personlig hjem, bedriftskontor,
-- gjesteområder) - SAMME begrunnelse som `location_*` bruker det generelle
-- multi-space-mønsteret i stedet for et enkelt låst space. Se D-153.
--
-- To tabeller:
--   1. `vision_rooms` - eier-definerte navngitte rom (romassosiasjon for
--      hendelser), strukturelt PARALLELL til `location_zones` men UTEN
--      geofence-geometri (et "rom" er en navngitt logisk enhet, ikke et
--      lat/lon-senter+radius - romgjenkjenning skjer i en fremtidig adapter,
--      IKKE her).
--   2. `vision_event_observations` - rå, leverandør-nøytrale, allerede
--      klassifiserte hendelser (append-only, samme disiplin som
--      `health_metric_observations` - en feilklassifisert hendelse
--      korrigeres av en NY observasjon fra kilden, ALDRI ved å mutere en
--      historisk rad).
--
-- Retensjon (samme "eier-konfigurert, Jarvis håndhever, Jarvis GJETTER
-- ALDRI"-disiplin som location/health): `vision_retention_policies` er en
-- EKSPLISITT, eier-konfigurerbar per-(tenant, space) retensjonsvindu-
-- konfigurasjon (UPSERT-current-state-form). `vision_event_observations.
-- retention_expires_at` beregnes VED INNSETTING av `VisionService.
-- ingestObservation()`. Kamera-/hendelsesdata er MINST like sensitiv som
-- posisjonsdata (viser fysisk tilstedeværelse OG aktivitet) - i FRAVÆR av en
-- eier-konfigurert policy-rad brukes derfor et KORTERE, personvern-
-- beskyttende standardvindu (30 dager, se `DEFAULT_RETENTION_DAYS` i
-- `modules/vision/src/service.ts`) enn location sitt 90-dagers-vindu -
-- SAMME "fravær av konfigurasjon betyr ALDRI 'behold for alltid'"-prinsipp.
--
-- ARKITEKT-REVIEW-FIKS (PR #83, P1, 2026-09-15): utløpet ANKRES på
-- `recorded_at`/`now()` (databasens EGEN, BETRODDE mottakstid), IKKE på det
-- UBETRODDE, kilde-produserte `observed_at` - en feilkonfigurert eller
-- ondsinnet kilde kunne ellers sendt et tidsstempel langt inn i fremtiden
-- og dermed effektivt omgått retensjonsvinduet i årevis. `observed_at` sin
-- proveniens er UENDRET for alt annet (visning/filtrering/`getLastSeen`) -
-- KUN utløpsberegningen bytter ankerpunkt.

CREATE TABLE vision_retention_policies (
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  retention_days  integer NOT NULL CHECK (retention_days > 0),
  actor_person_id text REFERENCES people (person_id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_space_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON vision_retention_policies TO jarvis_app;

ALTER TABLE vision_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_retention_policies_tenant ON vision_retention_policies
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_retention_policies_space ON vision_retention_policies AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Eier-definerte, navngitte rom - romassosiasjon for hendelser under.
-- Typisk PERSONLIG (`person_id` NOT NULL, samme mønster som
-- `location_zones` - en fremtidig DELT husholdnings-rom-liste er en
-- SEPARAT, senere beslutning, IKKE bygget her).
CREATE TABLE vision_rooms (
  room_id         text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Sammensatt FK mot `person_tenants` (D-129-lærdommen, gjenbrukt direkte
  -- fra `location_zones`/`health`-migrasjonene): en enkel `people`-FK
  -- beviser KUN at personen finnes GLOBALT, ikke at personen faktisk er
  -- MEDLEM av tenanten raden hevder å tilhøre.
  person_id       text NOT NULL,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vision_rooms_lookup_idx ON vision_rooms (tenant_id, memory_space_id, person_id);
ALTER TABLE vision_rooms ADD CONSTRAINT vision_rooms_person_tenant_fkey
  FOREIGN KEY (person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id);
-- FK-MÅL for `vision_event_observations.room_id` sin sammensatte
-- fremmednøkkel under (SAMME "enkel FK er ikke en autorisasjonsgrense"-
-- begrunnelse som `location_zones_tenant_space_key`) - `person_id` er MED i
-- nøkkelen slik at en observasjon kun kan peke til et rom som tilhører
-- SAMME person.
ALTER TABLE vision_rooms ADD CONSTRAINT vision_rooms_tenant_space_key UNIQUE (tenant_id, memory_space_id, person_id, room_id);

-- Rå, leverandør-nøytrale, allerede klassifiserte hendelser. `source_type`/
-- `source_instance_id` er en POINTER til den innhentende adapteren/enheten
-- (samme "pointer-not-payload"-prinsipp som `location_observations`/
-- `health_metric_observations`). `room_id` er NULLABLE (ikke alle hendelser
-- er rom-assosierte, f.eks. et dørklokke-event) - en sammensatt FK mot
-- `vision_rooms` under bruker Postgres sin standard MATCH SIMPLE-semantikk:
-- FK-en håndheves KUN når `room_id` faktisk er satt.
--
-- `source_event_id` (ARKITEKT-REVIEW-FIKS, PR #83, P1): kilde-produsert,
-- STABIL identitet for DENNE hendelsen (adapterens egen unike ID/sekvens-
-- nøkkel for det den observerte) - PÅKREVD, IKKE valgfri, fordi den er selve
-- grunnlaget for `vision_event_observations_source_dedupe_key` under.
-- `VisionService.ingestObservation()` bruker `INSERT ... ON CONFLICT DO
-- NOTHING` mot denne nøkkelen og returnerer den EKSISTERENDE raden ved
-- konflikt - en gjentatt levering av SAMME kilde-hendelse (overlappende
-- poll-vindu, transport-retry, en krasjet delvis batch som prøves på nytt)
-- oppdager seg selv strukturelt i stedet for å skrive en ny, duplikat rad.
--
-- `snapshot_ref` (ARKITEKT-REVIEW-FIKS, PR #83, P1): FORBUDT (CHECK under)
-- i denne P0-sliceen. Kolonnen fantes opprinnelig som en PEKER til et
-- eksternt lagret enkeltbilde, men INGEN levetids-eid lagringsadapter
-- finnes ennå som faktisk sletter/tilbakekaller det RETTE objektet når
-- `purgeExpiredObservations()`/Q-20-erasure sletter PEKEREN - denne PR-en
-- kan derfor IKKE hevde at retensjons-/slette-reglene faktisk er håndhevet
-- for et objekt Jarvis ikke selv eier. En fremtidig slice som bygger en
-- ekte, levetids-eid snapshot-lagring fjerner denne CHECK-en OG legger til
-- transaksjonell/kompenserende sletting av det refererte objektet FØRST.
CREATE TABLE vision_event_observations (
  observation_id       text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Sammensatt FK mot `person_tenants` legges til RETT under tabellen
  -- (samme begrunnelse som `vision_rooms.person_id` over).
  person_id             text NOT NULL,
  room_id               text,
  event_type            text NOT NULL
    CHECK (event_type IN ('object_detected','person_present','motion_detected','doorbell_event','security_alert')),
  object_label          text,
  confidence             double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  snapshot_ref           text CHECK (snapshot_ref IS NULL),
  source_type            text NOT NULL,
  source_instance_id     text,
  source_event_id        text NOT NULL,
  observed_at            timestamptz NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  retention_expires_at   timestamptz
);
-- Trengs av `VisionService.getRecentEvents()`/generell lese-scoping.
CREATE INDEX vision_event_observations_lookup_idx ON vision_event_observations (tenant_id, memory_space_id, person_id, observed_at DESC);
-- ARKITEKT-REVIEW-FIKS (PR #83, P1): scoped dedupe-nøkkel - se
-- `source_event_id`-kommentaren over. `ON CONFLICT`-målet for
-- `VisionService.ingestObservation()` sin idempotente innsetting.
CREATE UNIQUE INDEX vision_event_observations_source_dedupe_key ON vision_event_observations (tenant_id, memory_space_id, person_id, source_type, source_event_id);
-- Trengs av `VisionService.getLastSeen()` ("object identification and
-- 'last seen' workflows" - masterplan UA-9 akseptansekriterium 1) - partial
-- index (kun rader med et satt objektnavn) holder oppslaget billig.
CREATE INDEX vision_event_observations_object_label_idx ON vision_event_observations (tenant_id, memory_space_id, person_id, object_label, observed_at DESC) WHERE object_label IS NOT NULL;
-- Trengs av `VisionService.purgeExpiredObservations()` (samme mønster som
-- `location_observations_retention_idx`/`health_metric_observations`).
CREATE INDEX vision_event_observations_retention_idx ON vision_event_observations (retention_expires_at) WHERE retention_expires_at IS NOT NULL;
ALTER TABLE vision_event_observations ADD CONSTRAINT vision_event_observations_person_tenant_fkey
  FOREIGN KEY (person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id);
-- Sammensatt FK mot `vision_rooms` - en observasjon kan KUN peke til et rom
-- som tilhører SAMME (tenant, space, person) som observasjonen selv (D-129-
-- lærdommen, gjenbrukt fra `location_zone_visits`). NULLABLE `room_id` betyr
-- FK-en kun håndheves når satt (Postgres MATCH SIMPLE-standard).
ALTER TABLE vision_event_observations ADD CONSTRAINT vision_event_observations_room_tenant_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, person_id, room_id) REFERENCES vision_rooms (tenant_id, memory_space_id, person_id, room_id);

-- Q-20-mønster: append-only sensordata (SAMME disiplin som
-- `health_metric_observations` - INGEN UPDATE-grant, en feilklassifisert
-- hendelse korrigeres av en NY observasjon, ALDRI ved å mutere historikk).
-- `vision_rooms` er en strukturell definisjonstabell (samme som
-- `location_zones` - ingen UPDATE i denne P0-sliceen, ingen rename-endepunkt
-- bygget). `DELETE` er PÅKREVD på begge for BÅDE `ErasureService`
-- (registreres i `modules/erasure/src/plan.ts`) OG `VisionService.
-- purgeExpiredObservations()` sin faktiske retensjonshåndheving.
GRANT SELECT, INSERT, DELETE ON vision_rooms, vision_event_observations TO jarvis_app;

ALTER TABLE vision_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_rooms_tenant ON vision_rooms
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_rooms_space ON vision_rooms AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE vision_event_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_event_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_event_observations_tenant ON vision_event_observations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_event_observations_space ON vision_event_observations AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
