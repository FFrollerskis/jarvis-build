-- WP-G3 (D-465), UA-9 Vision & Physical World, del 1: kameraregister med sone- og rutingpolicy.
--
-- 055_vision.sql la den kanoniske hendelsesmodellen (JARVIS_CANONICAL, D-64/D-153). Denne migrasjonen (133-136) legger til det som
-- manglet for at en EKTE kilde skal kunne mate den: hvilke kameraer Jarvis kjenner til, hva hvert kamera har lov til å gjøre med et
-- øyeblikksbilde (deterministisk datapolicy), og sporingsfelt (task_id/session_id) på hendelsene.
--
-- `vision_cameras` er Jarvis sitt EGET register (JARVIS_CANONICAL). Home Assistant og iPhone er KILDER: `source_type` +
-- `source_ref` er en PEKER (HA: entity_id for kameraet; iPhone: device_id), aldri en kopi av leverandørens tilstand. Kameraer
-- registreres KUN av eieren (eier-rute med signert enhetsøkt); det finnes ingen modellvei til denne tabellen.
--
-- DATAPOLICY (UA-9 akseptansekriterium 3, "sensitive camera streams are routed according to data policy"): `route_policy` har
-- BEVISST kun tre verdier og INGEN sky-verdi - et kamerabilde kan ikke ruteres ut av maskinen fordi det ikke finnes noe
-- alternativ å velge:
--   discard         - hendelsen forkastes (ingen bilde hentes, ingen klassifisering, ingenting lagres)
--   local_only      - bildet klassifiseres av en LOKAL modell i minnet og forkastes deretter (kun det strukturerte resultatet lagres)
--   store_snapshot  - som local_only, og ETT øyeblikksbilde lagres lokalt med kort oppbevaring (vision_snapshots, 134)
-- SONER (`zone_kind`): home / workplace / shared. Regelen "kun hjemmesonen kan lagre bilder" er en DB-CHECK (se under), ikke bare
-- kode: arbeidsplass- og delte områder (gjester, naboer, kolleger) får aldri lagrede bilder uten en ny, eksplisitt beslutning.
-- Reglene her er et UTKAST: juridisk gjennomgang av kameraovervåking på arbeidsplass er IKKE gjort (se UA9_VISION_DPIA.md).
--
-- Biometrisk identifikasjon er UTENFOR masterplanen (UA-9): ingen kolonne i 133-136 representerer en identitet, et ansikt eller en
-- biometrisk mal. En vakttest (modules/vision/test/g3-guards.test.ts) feller bygget hvis det innføres.

CREATE TABLE vision_cameras (
  camera_id        text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id  text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  person_id        text NOT NULL,
  label            text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  source_type      text NOT NULL CHECK (source_type IN ('home_assistant','iphone')),
  source_ref       text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 200),
  -- HA: entity-id-ene (binary_sensor.* / event.*) som produserer hendelser for dette kameraet. iPhone: tom (opptak er på forespørsel).
  trigger_entities text[] NOT NULL DEFAULT '{}' CHECK (cardinality(trigger_entities) <= 8),
  room_id          text,
  zone_kind        text NOT NULL CHECK (zone_kind IN ('home','workplace','shared')),
  route_policy     text NOT NULL CHECK (route_policy IN ('discard','local_only','store_snapshot')),
  -- Minste tid mellom to behandlede hendelser fra samme kamera (flomvern mot en sensor som flakker).
  cooldown_seconds integer NOT NULL DEFAULT 30 CHECK (cooldown_seconds BETWEEN 5 AND 3600),
  enabled          boolean NOT NULL DEFAULT true,
  task_id          text,
  session_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vision_cameras_zone_storage_rule CHECK (route_policy <> 'store_snapshot' OR zone_kind = 'home')
);
CREATE INDEX vision_cameras_lookup_idx ON vision_cameras (tenant_id, memory_space_id, person_id);
-- Samme fysiske kilde registreres kun én gang per (tenant, space).
CREATE UNIQUE INDEX vision_cameras_source_key ON vision_cameras (tenant_id, memory_space_id, source_type, source_ref);
ALTER TABLE vision_cameras ADD CONSTRAINT vision_cameras_person_tenant_fkey
  FOREIGN KEY (person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id);
-- FK-MÅL for snapshots/innhenting (134/136): person_id er MED i nøkkelen, samme "enkel FK er ikke en autorisasjonsgrense"-
-- begrunnelse som vision_rooms_tenant_space_key (055).
ALTER TABLE vision_cameras ADD CONSTRAINT vision_cameras_scope_key UNIQUE (tenant_id, memory_space_id, person_id, camera_id);
-- Rommet kameraet står i (nullable; MATCH SIMPLE gjør at FK-en kun håndheves når room_id er satt).
ALTER TABLE vision_cameras ADD CONSTRAINT vision_cameras_room_fkey
  FOREIGN KEY (tenant_id, memory_space_id, person_id, room_id) REFERENCES vision_rooms (tenant_id, memory_space_id, person_id, room_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON vision_cameras TO jarvis_app;
ALTER TABLE vision_cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_cameras FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_cameras_tenant ON vision_cameras
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_cameras_space ON vision_cameras AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Oppbevaring av ØYEBLIKKSBILDER har eget, kortere vindu enn hendelsene (bilder er mer sensitive enn de strukturerte resultatene).
-- NULL = standard (DEFAULT_SNAPSHOT_RETENTION_DAYS i service.ts, 7 dager); det effektive vinduet er aldri lengre enn hendelsesvinduet.
ALTER TABLE vision_retention_policies
  ADD COLUMN snapshot_retention_days integer CHECK (snapshot_retention_days IS NULL OR snapshot_retention_days > 0);

-- Sporing (CLAUDE.md regel 4): hendelser skrevet av en kildepipeline bærer task_id (og session_id når en eier-sesjon utløste den).
-- classification_status/classifier forteller HVORDAN det strukturerte resultatet oppsto (modellutdata er ubetrodd, se classifier.ts):
-- ingen modell (not_applicable), en lokal modell ga et gyldig svar (classified), modellen var utilgjengelig (model_unavailable),
-- modellens svar ble avvist av den strenge parseren (model_rejected), eller policyen forbød klassifisering (skipped_by_policy).
-- Eksisterende rader får not_applicable. Kolonnene legges til på en append-only tabell (ingen UPDATE-grant trengs).
ALTER TABLE vision_event_observations
  ADD COLUMN task_id text,
  ADD COLUMN session_id text,
  ADD COLUMN classification_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (classification_status IN ('not_applicable','classified','model_unavailable','model_rejected','skipped_by_policy')),
  ADD COLUMN classifier text CHECK (classifier IS NULL OR char_length(classifier) <= 120);

-- Lagringsregel for objektnavn (review A-M1). Et objektnavn kommer fra en UBETRODD lokal modell (modules/vision/src/labels.ts): normaliseringen i appen er ETT choke point, så databasen får et
-- nett under den - lengde, tegnklasse og ordtall. IKKE et navne-/instruksjonsfilter (åpent ordforråd er fortsatt ubetrodd data, se labels.ts): kun 1-64 tegn, høyst 4 ord, ingen strukturtegn
-- (<>{}[]\/|;:"`=#@$%^&*~+), ingen kontrolltegn (U+0001-001F, U+007F-009F) eller usynlige/formaterende tegn (soft hyphen, fyllere, null-bredde, bidi, usynlige operatorer, variasjonsvelgere, BOM,
-- tag-tegn U+E0000-E0FFF), og minst ett tegn som ikke er siffer/mellomrom/tegnsetting. Tegnklassen er skrevet med eksplisitte kodepunkt-områder (ikke [:cntrl:]), slik at den er lik i alle
-- locales. Mild (krever ikke små bokstaver): en P0-kilde kan levere «Nøkler». Speilet i JS (`isStorableObjectLabel`, labels.ts); paritet bevist i g3-migrations.test.ts (sveip over alle kodepunkt).
-- NOT VALID først (055-tabellen kan ha rader fra P0 som bryter regelen), og VALIDATE forsøkes straks: består alle eksisterende rader blir den fullt gyldig; ellers forblir den NOT VALID
-- (håndheves for alle nye/endrede rader) og eieren validerer manuelt etter å ha vurdert de gamle radene.
ALTER TABLE vision_event_observations ADD CONSTRAINT vision_event_observations_object_label_check CHECK (
  object_label IS NULL OR (
    char_length(object_label) BETWEEN 1 AND 64
    AND object_label !~ '[<>{}\[\]\\/|;:"`=#@$%^&*~+\x01-\x1f\x7f-\x9f\xad\x34f\x61c\x115f-\x1160\x17b4-\x17b5\x180b-\x180f\x200b-\x200f\x202a-\x202e\x2060-\x206f\x3164\xfe00-\xfe0f\xfeff\xffa0\xfff0-\xfffb\xe0000-\xe0fff]'
    AND object_label ~ '[^[:digit:][:space:][:punct:]]'
    AND array_length(regexp_split_to_array(btrim(object_label), '[[:space:]]+'), 1) <= 4
  )
) NOT VALID;
DO $$
BEGIN
  ALTER TABLE vision_event_observations VALIDATE CONSTRAINT vision_event_observations_object_label_check;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'vision_event_observations_object_label_check forblir NOT VALID: eksisterende rader bryter regelen (nye og endrede rader håndheves)';
END
$$;
