-- Q-44 / D-435 (JARVIS-076): tenant-kryssende fremmednøkler -> (tenant_id, id)-komposittnøkler, domene for domene.
-- Problem: en enkeltkolonne-FK mellom to tenant-eide tabeller kan peke på en ANNEN tenants rad (FK-kontrollen går utenom RLS).
-- Løsning: foreldrekolonnen får UNIQUE (tenant_id, kol) og barnets FK blir (tenant_id, kol) -> foreldre (tenant_id, kol).
-- Hjelpefunksjonen bevarer ON DELETE/ON UPDATE/DEFERRABLE fra den gamle FK-en og er idempotent (ingen gammel enkeltkolonne-FK = ingenting å gjøre).
-- Brukes kun av migrasjoner (REVOKE fra PUBLIC); senere domener kaller samme funksjon.
CREATE FUNCTION jarvis_scope_fk(child regclass, child_col name, parent regclass, parent_col name) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  old_name   name;
  del_type   "char";
  upd_type   "char";
  is_defer   boolean;
  is_init    boolean;
  child_att  smallint;
  tenant_att_p smallint;
  parent_att smallint;
  has_unique boolean;
  new_name   text;
  del_clause text;
  upd_clause text;
BEGIN
  SELECT attnum INTO child_att FROM pg_attribute WHERE attrelid = child AND attname = child_col AND NOT attisdropped;
  SELECT attnum INTO parent_att FROM pg_attribute WHERE attrelid = parent AND attname = parent_col AND NOT attisdropped;
  SELECT attnum INTO tenant_att_p FROM pg_attribute WHERE attrelid = parent AND attname = 'tenant_id' AND NOT attisdropped;
  IF child_att IS NULL OR parent_att IS NULL OR tenant_att_p IS NULL THEN
    RAISE EXCEPTION 'jarvis_scope_fk: ukjent kolonne (% .% -> % .%) eller foreldre uten tenant_id', child, child_col, parent, parent_col;
  END IF;

  SELECT c.conname, c.confdeltype, c.confupdtype, c.condeferrable, c.condeferred
    INTO old_name, del_type, upd_type, is_defer, is_init
    FROM pg_constraint c
   WHERE c.conrelid = child AND c.confrelid = parent AND c.contype = 'f'
     AND c.conkey = ARRAY[child_att] AND c.confkey = ARRAY[parent_att];
  IF old_name IS NULL THEN
    RETURN; -- allerede konvertert (eller aldri en enkeltkolonne-FK)
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = parent AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnatts = 2
       AND i.indkey::smallint[] @> ARRAY[tenant_att_p, parent_att]
  ) INTO has_unique;
  IF NOT has_unique THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (tenant_id, %I)',
      parent, left(parent_col || '_tenant_key', 63), parent_col);
  END IF;

  new_name := left(old_name::text, 55) || '_tenant';
  del_clause := CASE del_type
    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN format('SET NULL (%I)', child_col) WHEN 'd' THEN format('SET DEFAULT (%I)', child_col) END;
  upd_clause := CASE upd_type
    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END;
  IF upd_type IN ('n', 'd') THEN
    RAISE EXCEPTION 'jarvis_scope_fk: ON UPDATE SET NULL/DEFAULT støttes ikke for komposittnøkkel (%)', old_name;
  END IF;

  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) REFERENCES %s (tenant_id, %I) ON DELETE %s ON UPDATE %s%s%s',
    child, new_name, child_col, parent, parent_col, del_clause, upd_clause,
    CASE WHEN is_defer THEN ' DEFERRABLE' ELSE '' END,
    CASE WHEN is_defer AND is_init THEN ' INITIALLY DEFERRED' ELSE '' END);
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', child, old_name);
END;
$$;
REVOKE ALL ON FUNCTION jarvis_scope_fk(regclass, name, regclass, name) FROM PUBLIC;

-- Domene 1: identitet og samtaler (høyest risiko: en feilkoblet identitet kan slå sammen/lese en annen tenants samtalepartner).
SELECT jarvis_scope_fk('conversation_identities', 'linked_business_contact_id', 'business_contacts', 'contact_id');
SELECT jarvis_scope_fk('conversation_identities', 'merged_into_identity_id', 'conversation_identities', 'identity_id');
SELECT jarvis_scope_fk('conversation_channel_links', 'identity_id', 'conversation_identities', 'identity_id');
SELECT jarvis_scope_fk('conversation_identity_merges', 'source_identity_id', 'conversation_identities', 'identity_id');
SELECT jarvis_scope_fk('conversation_identity_merges', 'target_identity_id', 'conversation_identities', 'identity_id');
SELECT jarvis_scope_fk('conversation_identity_merges', 'reverses_merge_id', 'conversation_identity_merges', 'merge_id');
SELECT jarvis_scope_fk('messages', 'session_id', 'sessions', 'session_id');
