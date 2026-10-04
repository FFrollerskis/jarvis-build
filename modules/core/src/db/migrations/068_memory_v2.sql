-- D-386 Minne v2 (Tobias direkte i chat 2026-10-03: «fiks og bygg den beste minnestrukturen mulig»).
--
-- Bakgrunn (Understand-gjennomgang med 8 linser, se D-386): produksjonens «vektorsøk» var en 64-dim tegn-trigram-
-- hash (ingen semantikk), HNSW-indeksen var hardlåst til vector(64), sammendrag ble skrevet men aldri lest,
-- ingen viktighet/sist-brukt-signal, ingen nøkkelord, ingen verbatim episodelagring (kun LLM-omformuleringen var
-- søkbar), og ingen alltid-tilstede eierprofil. Denne migrasjonen er ADDITIV og ikke-destruktiv: ingen eksisterende
-- rader slettes eller endres i betydning. `embeddings` (008) beholdes FROSSET som historisk tabell (erasure/backup-
-- kompatibilitet); all ny vektorskriving/-lesing går via `memory_vectors`, som er MODELL-BEVISST (vektorer fra ulike
-- modeller sammenlignes aldri).
--
-- Nye objekter: memory_vectors (polymorf, per modell, HNSW per kjent dimensjon), memory_episodes (verbatim eierytringer,
-- lag 1 for samtale), memory_profiles (kompilert eierprofil per space), memory_links (A-MEM-stil lenker), nye kolonner
-- på memory_items (importance, keywords(+fts), last_accessed_at, access_count, event_time_raw, evidence_episode_id),
-- summaries får fts + evidence. Alle nye tabeller: FORCE RLS med tenant-policy + RESTRICTIVE space-policy (samme
-- mønster som 008), minste grants, og registreres i modules/erasure/src/plan.ts.

-- ---------------------------------------------------------------------------------------------------------------
-- memory_items: nye signaler for rangering, nøkkelord og bevis
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE memory_items
  ADD COLUMN importance          smallint    NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  ADD COLUMN keywords            text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN last_accessed_at    timestamptz,
  ADD COLUMN access_count        integer     NOT NULL DEFAULT 0,
  -- Rå tidsuttrykk fra eieren («neste fredag», «i fjor sommer») - bevares ved siden av oppløst valid_from (D-386 §2).
  ADD COLUMN event_time_raw      text,
  -- Peker (ikke FK: episoder kan konsolideres/slettes uavhengig) til den verbatim ytringen faktumet ble trukket ut av.
  ADD COLUMN evidence_episode_id text;

-- Nøkkelord som egen tsvector (array_to_tsvector er IMMUTABLE; array_to_string er det ikke, så den kan ikke brukes i
-- en generert kolonne). Søket spør BÅDE `fts` (stemmet norsk) og `keywords_fts` (eksakte navn/steder/produkter).
ALTER TABLE memory_items
  ADD COLUMN keywords_fts tsvector GENERATED ALWAYS AS (array_to_tsvector(keywords)) STORED;
CREATE INDEX memory_items_keywords_fts_idx ON memory_items USING gin (keywords_fts);
CREATE INDEX memory_items_type_idx ON memory_items (tenant_id, space, status, type);
CREATE INDEX memory_items_accessed_idx ON memory_items (tenant_id, space, last_accessed_at DESC NULLS LAST);
-- Komposittnøkkel så andre tabeller kan ha scope-sikre FK-er (tenant_id, memory_item_id) - JARVIS-076-mønsteret.
ALTER TABLE memory_items ADD CONSTRAINT memory_items_tenant_item_unique UNIQUE (tenant_id, memory_item_id);

-- Manglende indekser for de faktiske spørringsformene (versjonshistorikk per item, entitet -> items).
CREATE INDEX memory_versions_item_idx ON memory_versions (memory_item_id, version);
CREATE INDEX memory_item_entities_entity_idx ON memory_item_entities (entity_id);

-- ---------------------------------------------------------------------------------------------------------------
-- memory_vectors: modellbevisst vektorlager for items, episoder og sammendrag
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE memory_vectors (
  ref_kind   text        NOT NULL CHECK (ref_kind IN ('item', 'episode', 'summary')),
  ref_id     text        NOT NULL,
  tenant_id  text        NOT NULL REFERENCES tenants (tenant_id),
  space      text        NOT NULL CHECK (space IN ('personal','business','project','health','home','guest','shared')),
  model      text        NOT NULL,
  dim        integer     NOT NULL CHECK (dim > 0),
  embedding  real[]      NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ref_kind, ref_id, model)
);
CREATE INDEX memory_vectors_lookup_idx ON memory_vectors (tenant_id, space, ref_kind, model);

-- Backfill fra den frosne `embeddings`-tabellen (kjøres som migrasjonsrolle = superbruker, RLS gjelder ikke).
INSERT INTO memory_vectors (ref_kind, ref_id, tenant_id, space, model, dim, embedding)
SELECT 'item', e.memory_item_id, e.tenant_id, e.space, e.model, e.dim, e.embedding
  FROM embeddings e
ON CONFLICT DO NOTHING;

-- pgvector-kolonne + HNSW per KJENT dimensjon (partielle indekser). Et uttrykk `vec::vector(N)` kan bare brukes av
-- en spørring med NØYAKTIG samme uttrykk og `WHERE dim = N` - retrieveren bygger spørringen deterministisk fra
-- providerens `dim`. 64 = local-hash (fallback), 768 = nomic/embeddinggemma, 1024 = bge-m3/multilingual-e5/arctic2.
-- Ukjente dimensjoner fungerer fortsatt (sekvensielt skann over cosine), bare uten indeks.
DO $$
DECLARE has_vector boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') INTO has_vector;
  IF has_vector THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE memory_vectors ADD COLUMN vec vector;
    -- real[]::text er `{a,b,c}`, mens pgvector parser `[a,b,c]` - bytt klammer (feilet på NAS med ekte embeddings).
    UPDATE memory_vectors SET vec = translate(embedding::text, '{}', '[]')::vector;
    CREATE INDEX memory_vectors_hnsw_64   ON memory_vectors USING hnsw ((vec::vector(64))   vector_cosine_ops) WHERE dim = 64;
    CREATE INDEX memory_vectors_hnsw_768  ON memory_vectors USING hnsw ((vec::vector(768))  vector_cosine_ops) WHERE dim = 768;
    CREATE INDEX memory_vectors_hnsw_1024 ON memory_vectors USING hnsw ((vec::vector(1024)) vector_cosine_ops) WHERE dim = 1024;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- memory_episodes: verbatim eierytringer (lag 1 for samtale) - «struktur skal utfylle verbatim tekst, ikke erstatte»
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE memory_episodes (
  episode_id      text        PRIMARY KEY,
  tenant_id       text        NOT NULL REFERENCES tenants (tenant_id),
  space           text        NOT NULL CHECK (space IN ('personal','business','project','health','home','guest','shared')),
  owner_person_id text        NOT NULL,
  session_id      text        NOT NULL,
  channel         text        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text        NOT NULL,
  content_hash    text        NOT NULL,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  sensitivity     text        NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensitive','special')),
  trust_level     text        NOT NULL CHECK (trust_level IN ('trusted','internal','untrusted')),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','consolidated','invalidated')),
  retention_rule  text        NOT NULL DEFAULT 'episode_default',
  fts tsvector GENERATED ALWAYS AS (to_tsvector('norwegian', content)) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Samme ytring i samme sesjon lagres én gang (retry/duplikat-send).
  UNIQUE (tenant_id, space, session_id, content_hash)
);
CREATE INDEX memory_episodes_fts_idx ON memory_episodes USING gin (fts);
CREATE INDEX memory_episodes_time_idx ON memory_episodes (tenant_id, space, status, observed_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- memory_profiles: kompilert, alltid-tilstede eierprofil per (tenant, space) - deterministisk fra høy-konfidens items
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE memory_profiles (
  tenant_id       text        NOT NULL REFERENCES tenants (tenant_id),
  space           text        NOT NULL CHECK (space IN ('personal','business','project','health','home','guest','shared')),
  content         text        NOT NULL,
  version         integer     NOT NULL DEFAULT 1,
  source_item_ids text[]      NOT NULL DEFAULT '{}',
  generated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space)
);

-- ---------------------------------------------------------------------------------------------------------------
-- memory_links: lenker mellom minner (A-MEM-stil, 1-hopp i SQL - ingen grafdatabase, Q-10 forblir et målepunkt)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE memory_links (
  tenant_id    text        NOT NULL REFERENCES tenants (tenant_id),
  space        text        NOT NULL CHECK (space IN ('personal','business','project','health','home','guest','shared')),
  from_item_id text        NOT NULL,
  to_item_id   text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('similar', 'supersedes', 'related', 'contradicts')),
  score        real        NOT NULL DEFAULT 0,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, from_item_id, to_item_id, kind),
  CHECK (from_item_id <> to_item_id),
  FOREIGN KEY (tenant_id, from_item_id) REFERENCES memory_items (tenant_id, memory_item_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_item_id)   REFERENCES memory_items (tenant_id, memory_item_id) ON DELETE CASCADE
);
CREATE INDEX memory_links_to_idx ON memory_links (tenant_id, to_item_id);

-- ---------------------------------------------------------------------------------------------------------------
-- summaries: gjør sammendragslaget LESBART (fts) og sporbart (evidence)
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE summaries
  ADD COLUMN evidence_item_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN generated_by      text   NOT NULL DEFAULT 'template',
  ADD COLUMN fts tsvector GENERATED ALWAYS AS (to_tsvector('norwegian', content)) STORED;
CREATE INDEX summaries_fts_idx ON summaries USING gin (fts);

-- ---------------------------------------------------------------------------------------------------------------
-- Grants (minste mulige) + RLS (tenant + RESTRICTIVE space, identisk mønster som 008)
-- ---------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON memory_vectors, memory_episodes, memory_profiles, memory_links TO jarvis_app;
-- Erasure (018-mønster): kun tabellene ErasureService faktisk hard-sletter fra.
GRANT DELETE ON memory_vectors, memory_episodes, memory_profiles, memory_links TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memory_vectors', 'memory_episodes', 'memory_profiles', 'memory_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (space = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (space = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;
