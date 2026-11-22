-- WP-G3 (D-465), UA-9 Vision & Physical World, del 3: objekt-/hendelses-embeddings, tidsminne og inventar per rom.
--
-- EMBEDDINGS (ingen ny vektorleverandør): vektorene ligger i den EKSISTERENDE `memory_vectors` (068, modellbevisst, tenant + RESTRICTIVE
-- space-RLS, pgvector-HNSW der utvidelsen finnes) under en ny `ref_kind` = 'vision_event' og bruker minnets EGET EmbeddingProvider-lag
-- (kun lokal embedding, `assertLocalEmbedding`). Det som embeddes er den VALIDERTE tekstbeskrivelsen av hendelsen (hendelsestype,
-- normalisert objektnavn, romnavn) - aldri bildet (ingen bildeembedding-modell finnes i Jarvis, det er DEFERRED) og aldri rå
-- modelltekst. `ref_id` = observation_id. En AFTER DELETE-trigger på vision_event_observations fjerner vektoren når hendelsen
-- slettes (oppbevaring, erasure), slik at en vektor aldri overlever hendelsen den beskriver og erasure-planen ikke må vite om den.
--
-- TIDSMINNE: vision_event_observations (055) ER tidsminnet (append-only, observed_at-indeksert); "sist sett" slår opp i den og i
-- vektorene (fuzzy match på objektnavn). INVENTAR (`vision_inventory_items`) er den AVLEDEDE tilstanden «hva står i dette rommet nå»:
-- én rad per (person, rom, normalisert objektnavn) med confidence som FORFALLER med tiden (halveringstid, se inventory.ts) og et
-- utløp (`expires_at`, forankret på databasens egen klokke ved siste observasjon). Raden er endringsbar (UPSERT), i motsetning til
-- hendelsene, og følger derfor retensjon (sweep) og erasure (plan.ts) selvstendig.
--
-- ENDRET PÅ STEDET FØR FØRSTE UTGIVELSE (review B MEDIUM-D2; sist i mini-fiks-runden: etikett-CHECK uten locale-avhengige POSIX-klasser): 133-136 er redigert
-- direkte (flere ganger, i review-rundene) i stedet for å få nye migrasjoner. Ingen utrullet database har kjørt en tidligere variant, og testklyngene er
-- flyktige. En SANDKASSE-DB som kjørte en tidligere variant av denne filen må GJENSKAPES (drop + migrer på nytt): runMigrations feiler høyt med
-- `migration_checksum_mismatch` (D-395) i stedet for å anvende den endrede filen, og planMigrations() melder den under `checksum_mismatches`. Fra første
-- utgivelse gjelder vanlig regel: en anvendt migrasjon endres aldri, det lages en NY. Se docs/runbooks/WPG3_VISION.md (avsnitt «Utrulling og oppgradering»).

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'memory_vectors'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ref_kind%' LOOP
    EXECUTE format('ALTER TABLE memory_vectors DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE memory_vectors ADD CONSTRAINT memory_vectors_ref_kind_check
  CHECK (ref_kind IN ('item', 'episode', 'summary', 'vision_event'));

CREATE FUNCTION vision_observation_release_vector() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  DELETE FROM memory_vectors
   WHERE ref_kind = 'vision_event' AND ref_id = OLD.observation_id AND tenant_id = OLD.tenant_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER vision_observations_release_vector AFTER DELETE ON vision_event_observations
  FOR EACH ROW EXECUTE FUNCTION vision_observation_release_vector();

CREATE TABLE vision_inventory_items (
  item_id             text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id     text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  person_id           text NOT NULL,
  room_id             text NOT NULL,
  -- Normalisert (små bokstaver, NFKC, kun bokstaver/tall/mellomrom/bindestrek, maks 64 tegn): se normalizeObjectLabel() i labels.ts.
  -- Review A-M1: tegnklasse-regel i tillegg til lengden. Inventaret skrives kun av pipelinen, så regelen er STRENG (normalisert form): ingen tegnsetting (inkl. alle strukturtegn), kontrolltegn,
  -- usynlige tegn eller mellomrom utenom ASCII-mellomrom, ingen ledende/etterfølgende/doble mellomrom eller bindestreker, minst ett tegn som ikke er siffer/mellomrom/bindestrek, høyst 4 ord.
  -- Små bokstaver håndheves av normalizeObjectLabel (ikke av databasen: lower() er locale-avhengig). Åpent ordforråd er fortsatt UBETRODD data (se labels.ts): regelen er et nett, ikke et navnefilter.
  -- Review delta D1 (mini-fiks-runden): regelen er skrevet UTEN POSIX-klasser. `[:punct:]`/`[:cntrl:]`/`[:digit:]`/`[:space:]` er LOCALE-AVHENGIGE: i en glibc-UTF-8-locale (C.UTF-8, en_US.UTF-8) regnes tall-tegn av
  -- kategori No (U+09F4-09F9, U+0B72-0B77, U+0BF0-0BF2, U+0C78-0C7E, U+0D58-0D5E, U+2776-2793 ...) som tegnsetting, og den forrige varianten avviste da etiketter normalizeObjectLabel selv lager (1498 av 286495
  -- kodepunkt målt), slik at HELE hendelsestransaksjonen rullet tilbake. Nå er forbudt-klassen eksplisitte kodepunktområder (identisk i alle locales; hex-escape `\xhhh` MÅ følges av `\` eller `-`, siden hex-sifre
  -- ellers spises videre): C0/C1-kontrolltegn og DEL, ASCII-tegnsetting UNNTATT bindestrek (0x2D), Latin-1-tegnsetting/-symboler (ikke ª ² ³ µ ¹ º ¼-¾), usynlige tegn (som 133), Ogham-/ideografisk mellomrom og HELE blokken
  -- Generell tegnsetting (U+2000-206F: mellomrom, null-bredde, bidi, anførselstegn, tankestreker). Øvrig Unicode-tegnsetting har ingen egen klasse: normalizeObjectLabel fjerner den allerede, og regelen er et NETT som
  -- aldri er strengere enn normaliseringen. Spegelen i JS er isInventoryLabel() i labels.ts; sveipetesten (g3-migrations/g3-label-locale) feller enhver forskjell mellom disse tre, i to klyngelocaler.
  object_label        text NOT NULL CHECK (
    char_length(object_label) BETWEEN 1 AND 64
    AND object_label !~ '[\x01-\x1f\x21-\x2c\x2e\x2f\x3a-\x40\x5b-\x60\x7b-\xa9\xab-\xb1\xb4\xb6-\xb8\xbb\xbf\xd7\xf7\x34f\x61c\x1680\x115f-\x1160\x17b4-\x17b5\x180b-\x180f\x2000-\x206f\x3000\x3164\xfe00-\xfe0f\xfeff\xffa0\xfff0-\xfffb\xe0000-\xe0fff]'
    AND object_label ~ '[^0-9 -]'
    AND object_label !~ '(^[ -])|([ -]$)|([ -]{2})'
    AND array_length(regexp_split_to_array(object_label, ' '), 1) <= 4
  ),
  -- Confidence ved siste observasjon (blandet med forfalt tidligere confidence). Effektiv confidence NÅ regnes ved lesing.
  confidence          double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  seen_count          integer NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  first_seen_at       timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  -- Peker (ingen FK): hendelsen følger sin egen retensjon, inventarraden sin.
  last_observation_id text,
  source_type         text NOT NULL,
  source_instance_id  text NOT NULL,
  -- Forankret på databasens egen klokke ved hver oppdatering, aldri på kildens tidsstempel.
  expires_at          timestamptz NOT NULL,
  task_id             text NOT NULL,
  session_id          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vision_inventory_room_idx ON vision_inventory_items (tenant_id, memory_space_id, person_id, room_id, last_seen_at DESC);
CREATE INDEX vision_inventory_expiry_idx ON vision_inventory_items (expires_at);
ALTER TABLE vision_inventory_items ADD CONSTRAINT vision_inventory_person_tenant_fkey
  FOREIGN KEY (person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id);
-- Rommet slettes sammen med sitt inventar (erasure av rommet), og et rom kan bare ha inventar for SAMME (tenant, space, person).
ALTER TABLE vision_inventory_items ADD CONSTRAINT vision_inventory_room_fkey
  FOREIGN KEY (tenant_id, memory_space_id, person_id, room_id) REFERENCES vision_rooms (tenant_id, memory_space_id, person_id, room_id) ON DELETE CASCADE;
ALTER TABLE vision_inventory_items ADD CONSTRAINT vision_inventory_item_key
  UNIQUE (tenant_id, memory_space_id, person_id, room_id, object_label);

-- Minste privilegium (review B-L9): kun kolonnene UPSERTEN i inventory.ts oppdaterer (ikke rom, navn, person eller tenant).
GRANT SELECT, INSERT, DELETE ON vision_inventory_items TO jarvis_app;
GRANT UPDATE (confidence, seen_count, first_seen_at, last_seen_at, last_observation_id, source_type, source_instance_id, expires_at, task_id, session_id, updated_at) ON vision_inventory_items TO jarvis_app;
ALTER TABLE vision_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_inventory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_inventory_items_tenant ON vision_inventory_items
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_inventory_items_space ON vision_inventory_items AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
