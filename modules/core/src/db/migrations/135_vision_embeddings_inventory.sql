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
  -- Review A-M1: tegnklasse-regel i tillegg til lengden. Inventaret skrives kun av pipelinen, så regelen er STRENG (normalisert form): kun bokstaver/tall/mellomrom/bindestrek - ingen tegnsetting
  -- (inkl. alle strukturtegn) eller kontrolltegn, ingen ledende/etterfølgende/doble mellomrom eller bindestreker, minst ett tegn som ikke er siffer, høyst 4 ord. Små bokstaver håndheves av
  -- normalizeObjectLabel (ikke av databasen: lower() er locale-avhengig). Åpent ordforråd er fortsatt UBETRODD data (se labels.ts): regelen er et nett, ikke et navnefilter.
  object_label        text NOT NULL CHECK (
    char_length(object_label) BETWEEN 1 AND 64
    AND translate(object_label, '-', '') !~ '[[:punct:][:cntrl:]\x01-\x1f\x7f-\x9f\xad\x34f\x61c\x115f-\x1160\x17b4-\x17b5\x180b-\x180f\x200b-\x200f\x202a-\x202e\x2060-\x206f\x3164\xfe00-\xfe0f\xfeff\xffa0\xfff0-\xfffb\xe0000-\xe0fff]'
    AND object_label ~ '[^[:digit:][:space:][:punct:]]'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON vision_inventory_items TO jarvis_app;
ALTER TABLE vision_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_inventory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_inventory_items_tenant ON vision_inventory_items
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_inventory_items_space ON vision_inventory_items AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
