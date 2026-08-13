-- BO-06 / D-28: migrer FAKTISKE Jarvis-embeddings til pgvector der utvidelsen
-- finnes (Docker-PG: pgvector 0.8.6). Betinget og additiv: paa Postgres uten
-- pgvector (embedded test-PG) beholdes real[]-banen uendret - retrieval
-- detekterer kolonnen ved runtime. Dimensjon 64 = LocalHashEmbedding (faktisk
-- provider i drift); cosine beholdes som metric (uendret semantikk).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS v vector(64);
    -- Konverter eksisterende real[]-data (kun dim-64-rader; andre faller til NULL og reindekseres av writer)
    UPDATE embeddings SET v = ('[' || array_to_string(embedding, ',') || ']')::vector(64)
      WHERE v IS NULL AND dim = 64;
    CREATE INDEX IF NOT EXISTS embeddings_hnsw ON embeddings USING hnsw (v vector_cosine_ops);
  END IF;
END
$$;
