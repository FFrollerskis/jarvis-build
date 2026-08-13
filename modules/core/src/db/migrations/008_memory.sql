-- Fase 4: Hybridminne v1 (MEMORY_ARCHITECTURE.md). RLS haandhever baade tenant
-- OG memory space i databasen: space-tilgang settes per transaksjon via
-- jarvis.memory_spaces (kommaseparert liste). Uten kontekst: default deny.

CREATE TABLE memory_sources (
  source_id   text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (tenant_id),
  kind        text NOT NULL CHECK (kind IN ('conversation', 'document', 'tool', 'manual')),
  ref         text NOT NULL,
  trust_level text NOT NULL CHECK (trust_level IN ('trusted', 'internal', 'untrusted')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_items (
  memory_item_id  text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  space           text NOT NULL CHECK (space IN ('personal','business','project','health','home','guest','shared')),
  owner_person_id text NOT NULL,
  type            text NOT NULL CHECK (type IN ('semantic','episodic','preference','procedure','relation','project','operational','decision','commitment')),
  subject         text NOT NULL,
  content         text NOT NULL,
  source_id       text NOT NULL REFERENCES memory_sources (source_id),
  observed_at     timestamptz NOT NULL,
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  sensitivity     text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensitive','special')),
  trust_level     text NOT NULL CHECK (trust_level IN ('trusted','internal','untrusted')),
  confidence      real NOT NULL DEFAULT 0.8,
  version         integer NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','invalidated','superseded')),
  has_conflict    boolean NOT NULL DEFAULT false,
  retention_rule  text NOT NULL DEFAULT 'default',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('norwegian', subject || ' ' || content)) STORED,
  UNIQUE (tenant_id, space, type, subject)
);
CREATE INDEX memory_items_fts_idx ON memory_items USING gin (fts);
CREATE INDEX memory_items_lookup_idx ON memory_items (tenant_id, space, status);

-- Versjonshistorikk: motstrid og endringer versjoneres, aldri skjules. Append-only.
CREATE TABLE memory_versions (
  version_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memory_item_id text NOT NULL REFERENCES memory_items (memory_item_id),
  tenant_id      text NOT NULL,
  space          text NOT NULL,
  version        integer NOT NULL,
  subject        text NOT NULL,
  content        text NOT NULL,
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz NOT NULL,
  change_kind    text NOT NULL CHECK (change_kind IN ('superseded','invalidated','conflict')),
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER memory_versions_append_only
  BEFORE UPDATE OR DELETE ON memory_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE entities (
  entity_id     text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants (tenant_id),
  space         text NOT NULL,
  kind          text NOT NULL,
  name          text NOT NULL,
  canonical_key text NOT NULL,
  UNIQUE (tenant_id, canonical_key)
);

CREATE TABLE relations (
  relation_id text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (tenant_id),
  space       text NOT NULL,
  from_entity text NOT NULL REFERENCES entities (entity_id),
  to_entity   text NOT NULL REFERENCES entities (entity_id),
  kind        text NOT NULL,
  source_id   text REFERENCES memory_sources (source_id),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz
);

CREATE TABLE memory_item_entities (
  memory_item_id text NOT NULL REFERENCES memory_items (memory_item_id),
  entity_id      text NOT NULL REFERENCES entities (entity_id),
  tenant_id      text NOT NULL,
  space          text NOT NULL,
  PRIMARY KEY (memory_item_id, entity_id)
);

CREATE TABLE summaries (
  summary_id text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id),
  space      text NOT NULL,
  scope      text NOT NULL CHECK (scope IN ('daily','weekly','project','longterm')),
  scope_key  text NOT NULL,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space, scope, scope_key)
);

-- Embeddings som portabel real[] (D-28): pgvector/HNSW-konvertering er bindende
-- port ved foerste Docker-miljoe (embedded test-Postgres mangler pgvector).
CREATE TABLE embeddings (
  memory_item_id text PRIMARY KEY REFERENCES memory_items (memory_item_id),
  tenant_id      text NOT NULL,
  space          text NOT NULL,
  model          text NOT NULL,
  dim            integer NOT NULL,
  embedding      real[] NOT NULL
);

CREATE FUNCTION cosine_sim(a real[], b real[]) RETURNS double precision AS $$
DECLARE
  dot double precision := 0; na double precision := 0; nb double precision := 0; i int;
BEGIN
  IF a IS NULL OR b IS NULL OR array_length(a,1) IS NULL
     OR array_length(a,1) IS DISTINCT FROM array_length(b,1) THEN
    RETURN 0;
  END IF;
  FOR i IN 1..array_length(a,1) LOOP
    dot := dot + a[i]*b[i]; na := na + a[i]*a[i]; nb := nb + b[i]*b[i];
  END LOOP;
  IF na = 0 OR nb = 0 THEN RETURN 0; END IF;
  RETURN dot / (sqrt(na) * sqrt(nb));
END
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE decisions (
  decision_id text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (tenant_id),
  space       text NOT NULL,
  content     text NOT NULL,
  decided_at  timestamptz NOT NULL,
  source_id   text REFERENCES memory_sources (source_id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed'))
);

CREATE TABLE commitments (
  commitment_id text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants (tenant_id),
  space         text NOT NULL,
  content       text NOT NULL,
  due_at        timestamptz,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  source_id     text REFERENCES memory_sources (source_id)
);

CREATE TABLE deadlines (
  deadline_id text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (tenant_id),
  space       text NOT NULL,
  title       text NOT NULL,
  due_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','met','missed','cancelled'))
);

-- Grants (minst mulig; ingen UPDATE/DELETE paa append-only)
GRANT SELECT, INSERT ON
  memory_sources, memory_items, memory_versions, entities, relations,
  memory_item_entities, summaries, embeddings, decisions, commitments, deadlines
TO jarvis_app;
GRANT UPDATE ON memory_items, entities, relations, summaries, embeddings, decisions, commitments, deadlines TO jarvis_app;

-- RLS: tenant-isolasjon paa alle; space-isolasjon der space finnes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memory_sources','memory_items','memory_versions','entities','relations',
    'memory_item_entities','summaries','embeddings','decisions','commitments','deadlines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'memory_items','memory_versions','entities','relations',
    'memory_item_entities','summaries','embeddings','decisions','commitments','deadlines'
  ] LOOP
    -- AS RESTRICTIVE: AND-es med tenant-policyen (permissive policies OR-es ellers)
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (space = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (space = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;
