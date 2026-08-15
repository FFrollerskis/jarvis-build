-- UA-2 P0 (Universal Knowledge Layer-fundament): kilde-uavhengig
-- dokumentlager med sync/dedupe/tombstones/provenance + FTS/vector-retrieval.
-- Samme RLS-monster som memory_items (008_memory.sql): tenant_id OG
-- memory_space_id haandheves i databasen, ikke bare i applikasjonskoden.
-- Portabel real[]-embedding + betinget pgvector-konvertering (samme monster
-- som D-28/014_embeddings_pgvector.sql) - embedded test-Postgres mangler
-- utvidelsen, ekte Docker-PG konverterer automatisk.

CREATE TABLE knowledge_documents (
  knowledge_document_id text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  source_type          text NOT NULL,
  source_instance_id   text NOT NULL,
  external_id          text NOT NULL,
  canonical_uri         text NOT NULL,
  title                 text NOT NULL,
  content               text NOT NULL,
  content_type          text NOT NULL,
  content_hash          text NOT NULL,
  version               integer NOT NULL DEFAULT 1,
  modified_at           timestamptz,
  deleted               boolean NOT NULL DEFAULT false,
  deleted_at            timestamptz,
  -- Trusted provenance-ekstra fra kilden - ALDRI credentials, ALDRI modellgenerert.
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('norwegian', title || ' ' || content)) STORED,
  -- Canonical identity for dedupe (§4): samme eksternt dokument = samme rad,
  -- oppdatert in-place ved endring - aldri duplisert ved re-sync.
  UNIQUE (tenant_id, source_type, source_instance_id, external_id)
);
CREATE INDEX knowledge_documents_fts_idx ON knowledge_documents USING gin (fts);
CREATE INDEX knowledge_documents_lookup_idx ON knowledge_documents (tenant_id, memory_space_id, deleted);

CREATE TABLE knowledge_embeddings (
  knowledge_document_id text PRIMARY KEY REFERENCES knowledge_documents (knowledge_document_id),
  tenant_id             text NOT NULL,
  memory_space_id       text NOT NULL,
  model                 text NOT NULL,
  dim                   integer NOT NULL,
  embedding             real[] NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON knowledge_documents, knowledge_embeddings TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_documents', 'knowledge_embeddings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    -- AS RESTRICTIVE: AND-es med tenant-policyen (default deny uten gyldig space-kontekst,
    -- identisk prinsipp til memory_items sin space-RESTRICTIVE-policy).
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;

-- D-28-monster: pgvector NAAR utvidelsen finnes (Docker-PG); ellers real[]+cosine_sim
-- (embedded test-Postgres). `cosine_sim` finnes allerede fra 008_memory.sql.
DO $$
DECLARE has_vector boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') INTO has_vector;
  IF has_vector THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'knowledge_embeddings' AND column_name = 'vec') THEN
      ALTER TABLE knowledge_embeddings ADD COLUMN vec vector;
      UPDATE knowledge_embeddings SET vec = embedding::text::vector WHERE embedding IS NOT NULL;
      CREATE INDEX IF NOT EXISTS knowledge_embeddings_vec_hnsw ON knowledge_embeddings
        USING hnsw ((vec::vector(64)) vector_cosine_ops);
    END IF;
  END IF;
END
$$;
