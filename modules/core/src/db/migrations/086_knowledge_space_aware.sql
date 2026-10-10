-- WP-D1 (UA-2 Universal Knowledge Layer, JARVIS-032): kunnskapslaget blir space-bevisst, og treff får strukturerte sensitivitetsmerker.
--
-- (1) CANONICAL IDENTITY: UNIQUE-nøkkelen i 017 var (tenant_id, source_type, source_instance_id, external_id) - UTEN memory_space_id. Kilderegisteret (UA-2 P1A §17) sier at en kildeinstans er unik per
--     (tenant, space, instans): to rom i samme tenant kan ha en instans med samme navn og samme dokument-id (f.eks. «docs» i personal og business). Databasen avviste da den andre synkroniseringen
--     (UNIQUE-brudd, telt som `failed` per record). Nøkkelen får memory_space_id. Å UTVIDE en UNIQUE-nøkkel kan ikke gi kollisjoner i eksisterende data (den gamle er strengere), så pre-flighten under
--     gjelder den ANDRE endringen (embedding-nøkkelen), ikke denne.
-- (2) EMBEDDINGS: knowledge_embeddings bærer sin EGEN memory_space_id, men databasen krevde aldri at den er lik dokumentets (080 gjorde FK-en tenant-sikker, ikke space-sikker). Komposittnøkkelen
--     (tenant_id, memory_space_id, knowledge_document_id) gjør en embedding i feil rom umulig (samme lærdom som 081: en sammensatt FK er ikke en autorisasjonsgrense uten space i nøkkelen).
--     Pre-flight (mønsteret fra 078-081): rapporterer ALLE eksisterende rader som ville brutt den nye nøkkelen, i ÉN feilmelding (kun id-er, aldri innhold), og endrer ingenting hvis den kaster.
-- (3) MERKER: `sensitivity` (normal|sensitive|special) og `trust_level` (untrusted|internal) på dokumentet. Standard `sensitive`/`untrusted` = fail-closed for rader som ble skrevet før denne
--     migrasjonen (e-postvedlegg): de er private, aldri `normal`, og aldri betrodde. Neste synkronisering regner dem om fra kildekonfigurasjonen + klassifisering av teksten; treff-tidspunktet
--     klassifiserer teksten på nytt uansett, så en gammel rad kan aldri slippe forbi et utvidet ordforråd.
CREATE FUNCTION jarvis_knowledge_space_preflight() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n      int;
  sample text;
BEGIN
  SELECT count(*) INTO n
    FROM knowledge_embeddings e
    JOIN knowledge_documents d ON d.tenant_id = e.tenant_id AND d.knowledge_document_id = e.knowledge_document_id
   WHERE e.memory_space_id <> d.memory_space_id;
  IF n > 0 THEN
    SELECT string_agg(t.v, ', ') INTO sample FROM (
      SELECT format('%s/%s (embedding=%s, dokument=%s)', e.tenant_id, e.knowledge_document_id, e.memory_space_id, d.memory_space_id) AS v
        FROM knowledge_embeddings e
        JOIN knowledge_documents d ON d.tenant_id = e.tenant_id AND d.knowledge_document_id = e.knowledge_document_id
       WHERE e.memory_space_id <> d.memory_space_id
       ORDER BY e.tenant_id, e.knowledge_document_id LIMIT 20) t;
    RAISE EXCEPTION E'knowledge_space_preflight: % embeddings ligger i et annet memory space enn dokumentet sitt (tenant/dokument, maks 20):\n  %\nRett eller fjern radene (kun id-er vises, aldri innhold); fjern ALDRI nøkkelen.', n, sample;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION jarvis_knowledge_space_preflight() FROM PUBLIC;
SELECT jarvis_knowledge_space_preflight();

-- (1) Space-bevisst canonical identity. Den gamle nøkkelen finnes under et auto-generert (avkortet) navn: slå den opp på kolonnene, ikke på navnet.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'knowledge_documents'::regclass AND con.contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(con.conkey) k(attnum)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
           = ARRAY['external_id', 'source_instance_id', 'source_type', 'tenant_id']
  LOOP
    EXECUTE format('ALTER TABLE knowledge_documents DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_identity_key UNIQUE (tenant_id, memory_space_id, source_type, source_instance_id, external_id);
-- Målet for den space-bevisste fremmednøkkelen (embeddings, og senere entitetslenker): (tenant, space, dokument-id).
ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_tenant_space_id_key UNIQUE (tenant_id, memory_space_id, knowledge_document_id);

-- (2) Embedding-FK med space i nøkkelen. Erstatter (tenant_id, knowledge_document_id)-nøkkelen fra 080 (funnet på kolonnene, ikke på navnet).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'knowledge_embeddings'::regclass AND con.contype = 'f' AND con.confrelid = 'knowledge_documents'::regclass
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(con.conkey) k(attnum)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
           IN (ARRAY['knowledge_document_id', 'tenant_id'], ARRAY['knowledge_document_id'])
  LOOP
    EXECUTE format('ALTER TABLE knowledge_embeddings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE knowledge_embeddings
  ADD CONSTRAINT knowledge_embeddings_document_space_fkey
  FOREIGN KEY (tenant_id, memory_space_id, knowledge_document_id)
  REFERENCES knowledge_documents (tenant_id, memory_space_id, knowledge_document_id);

-- (3) Strukturerte merker. GRANT UPDATE er allerede på tabellnivå (017), så de nye kolonnene dekkes.
ALTER TABLE knowledge_documents
  ADD COLUMN sensitivity text NOT NULL DEFAULT 'sensitive' CHECK (sensitivity IN ('normal', 'sensitive', 'special')),
  ADD COLUMN trust_level text NOT NULL DEFAULT 'untrusted' CHECK (trust_level IN ('untrusted', 'internal'));
