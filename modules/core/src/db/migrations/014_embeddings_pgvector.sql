-- BO-06 D-28: konverter ekte embeddings real[] -> pgvector vector(dim) NÅR pgvector
-- er tilgjengelig (Docker-PG). Betinget: embedded test-Postgres mangler utvidelsen,
-- da beholdes real[] + cosine_sim (identisk resultat). Additiv, ikke-destruktiv.
DO $$
DECLARE has_vector boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') INTO has_vector;
  IF has_vector THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    -- Kolonne + backfill fra eksisterende real[] (dim leses fra data, ingen gjetting).
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'embeddings' AND column_name = 'vec') THEN
      ALTER TABLE embeddings ADD COLUMN vec vector;
      UPDATE embeddings SET vec = embedding::text::vector WHERE embedding IS NOT NULL;
      -- HNSW med cosine (matcher eksisterende cosine_sim-retrieval-semantikk).
      -- Partial: bygges når rader finnes; dim settes av data.
      CREATE INDEX IF NOT EXISTS embeddings_vec_hnsw ON embeddings
        USING hnsw ((vec::vector(64)) vector_cosine_ops);
    END IF;
  END IF;
END
$$;
