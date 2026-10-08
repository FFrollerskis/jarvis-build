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
     WHERE i.indrelid = parent AND i.indisunique AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL
       AND i.indnatts = 2 AND i.indnkeyatts = 2
       AND i.indkey::smallint[] @> ARRAY[tenant_att_p, parent_att]
  ) INTO has_unique;
  IF NOT has_unique THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (tenant_id, %I)',
      parent, left((SELECT relname FROM pg_class WHERE oid = parent) || '_' || parent_col || '_tenant_key', 63), parent_col);
  END IF;

  new_name := left(regexp_replace(old_name::text, '_fkey$', ''), 50) || '_tenant_fkey';
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

-- Variant som slår opp enkeltkolonne-FK-en på navn (baseline-id `tabell.constraint`) - brukes av senere domener, så migrasjonene
-- kan listes 1:1 mot `scope-fk-baseline.json`.
CREATE FUNCTION jarvis_scope_fk_named(child regclass, constraint_name name) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  child_col  name;
  parent     regclass;
  parent_col name;
  n          int;
BEGIN
  SELECT cardinality(c.conkey), c.confrelid::regclass,
         (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]),
         (SELECT attname FROM pg_attribute WHERE attrelid = c.confrelid AND attnum = c.confkey[1])
    INTO n, parent, child_col, parent_col
    FROM pg_constraint c
   WHERE c.conrelid = child AND c.conname = constraint_name AND c.contype = 'f';
  IF n IS NULL THEN
    -- Idempotent KUN hvis den konverterte nøkkelen faktisk finnes; ellers er navnet feil (skrivefeil/omdøpt) og skal feile høyt.
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = child AND contype = 'f'
                  AND conname = left(regexp_replace(constraint_name::text, '_fkey$', ''), 50) || '_tenant_fkey') THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'jarvis_scope_fk_named: ukjent constraint % på % (verken enkeltkolonne-FK eller konvertert)', constraint_name, child;
  END IF;
  IF n <> 1 THEN
    RAISE EXCEPTION 'jarvis_scope_fk_named: % er ikke en enkeltkolonne-FK', constraint_name;
  END IF;
  PERFORM jarvis_scope_fk(child, child_col, parent, parent_col);
END;
$$;
REVOKE ALL ON FUNCTION jarvis_scope_fk_named(regclass, name) FROM PUBLIC;

-- Pre-flight: rapporter ALLE enkeltkolonne-FK-er (barn med tenant_id) der en eksisterende rad peker på en annen tenants forelder-rad, i ÉN feilmelding
-- (ellers avslører en generisk FK-feil bare én constraint per mislykket oppstart). Ingenting endres hvis den kaster. Rader identifiseres kun med id-er.
CREATE FUNCTION jarvis_scope_fk_preflight() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r      record;
  found  text := '';
  sample text;
  n      int := 0;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS child, c.conname,
           (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS child_col,
           c.confrelid::regclass AS parent,
           (SELECT attname FROM pg_attribute WHERE attrelid = c.confrelid AND attnum = c.confkey[1]) AS parent_col
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND cardinality(c.conkey) = 1
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) <> 'tenant_id'
  LOOP
    EXECUTE format(
      'SELECT string_agg(t.v, '', '') FROM (SELECT format(''%%s/%%s'', c.tenant_id, c.%I) AS v FROM %s c WHERE c.%I IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM %s p WHERE p.%I = c.%I AND p.tenant_id = c.tenant_id) LIMIT 5) t',
      r.child_col, r.child, r.child_col, r.parent, r.parent_col, r.child_col) INTO sample;
    IF sample IS NOT NULL THEN
      n := n + 1;
      IF n <= 40 THEN found := found || E'\n  ' || r.child || '.' || r.child_col || ' -> ' || r.parent || ' (' || r.conname || '): tenant/id ' || sample; END IF;
    END IF;
  END LOOP;
  IF n > 0 THEN
    RAISE EXCEPTION E'tenant_scope_fk_preflight: % FK-er har rader som peker på en annen tenants rad (tenant/id, maks 5 per FK, maks 40 FK-er):%\nRett eller fjern radene; fjern ALDRI nøkkelen.', n, found;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION jarvis_scope_fk_preflight() FROM PUBLIC;
SELECT jarvis_scope_fk_preflight();

-- Domene 1: identitet og samtaler (høyest risiko: en feilkoblet identitet kan slå sammen/lese en annen tenants samtalepartner).
SELECT jarvis_scope_fk('conversation_identities', 'linked_business_contact_id', 'business_contacts', 'contact_id');
SELECT jarvis_scope_fk('conversation_identities', 'merged_into_identity_id', 'conversation_identities', 'identity_id');
SELECT jarvis_scope_fk('conversation_channel_links', 'identity_id', 'conversation_identities', 'identity_id');
SELECT jarvis_scope_fk('conversation_identity_merges', 'source_identity_id', 'conversation_identities', 'identity_id');
SELECT jarvis_scope_fk('conversation_identity_merges', 'target_identity_id', 'conversation_identities', 'identity_id');
SELECT jarvis_scope_fk('conversation_identity_merges', 'reverses_merge_id', 'conversation_identity_merges', 'merge_id');
SELECT jarvis_scope_fk('messages', 'session_id', 'sessions', 'session_id');
