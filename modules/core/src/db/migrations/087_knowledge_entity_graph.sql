-- WP-D1 (UA-2): deterministisk entitetsgraf over kunnskapslaget («hvilke dokumenter nevner X», «hva henger sammen med Y»).
--
-- BEGRUNNELSE FOR EGNE TABELLER (i stedet for å gjenbruke minnets `entities`/`memory_links`): entiteter uttrukket fra dokumenter er AVLEDET, ubetrodd data (fra e-post, delte dokumenter, referater - og
-- eventuelt en modell) og skal aldri blandes inn i det autoritative minnets navnerom (CLAUDE.md regel 7: ubetrodd innhold går aldri direkte til autoritativt minne). De har også en annen livssyklus
-- (gjenoppbygges når dokumentet endres; følger dokumentet ved sletting/erasure), og `entities` er unik per (tenant, canonical_key) uavhengig av rom, mens grafen er rom-skopet. Minnets entiteter LESES
-- (aldri skrives) som ordliste for den deterministiske uttrekkeren; en treff-entitet kan peke løst tilbake (`memory_entity_id`, ingen FK - avledede rader skal aldri blokkere minne-erasure).
--
-- Co-mention-kanter («hva henger sammen med Y») MATERIALISERES IKKE: de utledes ved spørring fra `knowledge_links` (to entiteter som nevnes i samme IKKE-slettede dokument), så de er alltid konsistente
-- med tombstones og erasure uten en vedlikeholdsløkke. En materialisert kanttabell innføres først for en relasjonstype som ikke kan utledes.
--
-- PERSONVERN: en e-postadresse lagres ALDRI i klartekst her: `canonical_key` er sha256 av adressen (små bokstaver) og `display_name` er maskert («o***@acme.no»). Søk etter en adresse hasher spørringen.
CREATE TABLE knowledge_entities (
  entity_id        text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id  text NOT NULL CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  kind             text NOT NULL CHECK (kind IN ('known_entity','person','organization','place','topic','email_address','domain','repo','project_key')),
  canonical_key    text NOT NULL CHECK (length(canonical_key) BETWEEN 1 AND 200),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  -- Løs peker til minnets `entities.entity_id` når navnet ble gjenkjent fra minnets ordliste (ingen FK, se over).
  memory_entity_id text,
  method           text NOT NULL CHECK (method IN ('deterministic','llm')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, memory_space_id, kind, canonical_key),
  -- Mål for den space-bevisste fremmednøkkelen fra knowledge_links.
  UNIQUE (tenant_id, memory_space_id, entity_id)
);

CREATE TABLE knowledge_links (
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  knowledge_document_id text NOT NULL,
  entity_id             text NOT NULL,
  link_kind             text NOT NULL DEFAULT 'mentions' CHECK (link_kind IN ('mentions')),
  mention_count         integer NOT NULL DEFAULT 1 CHECK (mention_count BETWEEN 1 AND 1000000),
  method                text NOT NULL CHECK (method IN ('deterministic','llm')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (knowledge_document_id, entity_id, link_kind),
  -- Space i nøkkelen (som 086/081): en lenke kan aldri binde et dokument og en entitet i ulike rom eller ulike tenants.
  FOREIGN KEY (tenant_id, memory_space_id, knowledge_document_id)
    REFERENCES knowledge_documents (tenant_id, memory_space_id, knowledge_document_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, memory_space_id, entity_id)
    REFERENCES knowledge_entities (tenant_id, memory_space_id, entity_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_links_entity_idx ON knowledge_links (tenant_id, memory_space_id, entity_id);
CREATE INDEX knowledge_entities_lookup_idx ON knowledge_entities (tenant_id, memory_space_id, canonical_key);

-- Hvilken uttrekker-versjon + innholds-hash dokumentets lenker ble bygget for (`<content_hash>:<extractor_version>`). Uendret nøkkel = ingenting å gjøre; endret innhold ELLER ny uttrekker-versjon
-- = lenkene bygges på nytt (dermed også etterfylling når grafen slås på for dokumenter som allerede er synkronisert). To nøkler, fordi den deterministiske uttrekkeren kjører inline i synkroniseringen
-- (rask, ingen modellkall) mens den valgfrie, modellassisterte kjører i et eget pass UTENFOR synk-transaksjonen (modellkall holder aldri en databasetransaksjon åpen). Lenker har `method`, så
-- ny deterministisk indeksering aldri sletter modellassisterte lenker og omvendt.
ALTER TABLE knowledge_documents ADD COLUMN entities_indexed_key text, ADD COLUMN entities_llm_key text;

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_entities, knowledge_links TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_entities', 'knowledge_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;
