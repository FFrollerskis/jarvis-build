-- WP-G2 (UA-8 Personal Twin, D-464) P1c: FELLES innhold i familiesirkelen - delte lister og delt kalender. Dette er sirkelens EGET innhold (ikke ett medlems private data): det bor i `shared`-rommet i sirkel-tenanten,
-- skrives av medlemmer etter rolle (se `modules/context/src/family/permissions.ts`), og bærer HVEM som gjorde det og - hvis noen handlet på vegne av en annen - hvem det var på vegne av (proveniens, regel 4).
-- Tekst i lister/hendelser er UBETRODD data (skrevet av et menneske eller importert): den lagres som tekst med lengdegrense og er aldri en instruks.
-- Forfatterkolonnene er rene tekstpekere uten FK (forfatterens sletting håndteres av erasure-planen: forfatterens egne elementer slettes), med sammensatte FK-er der de binder rader sammen (liste -> element).

CREATE TABLE family_lists (
  list_id              text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL DEFAULT 'shared' CHECK (memory_space_id = 'shared'),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by_person_id text NOT NULL,
  on_behalf_of_person_id text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  UNIQUE (tenant_id, list_id)
);
CREATE INDEX family_lists_lookup_idx ON family_lists (tenant_id, archived_at, created_at DESC);

CREATE TABLE family_list_items (
  item_id              text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL DEFAULT 'shared' CHECK (memory_space_id = 'shared'),
  list_id              text NOT NULL,
  body                 text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  done                 boolean NOT NULL DEFAULT false,
  added_by_person_id   text NOT NULL,
  on_behalf_of_person_id text,
  done_by_person_id    text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  done_at              timestamptz,
  CONSTRAINT family_list_items_done_iff CHECK (done = (done_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, list_id) REFERENCES family_lists (tenant_id, list_id)
);
CREATE INDEX family_list_items_lookup_idx ON family_list_items (tenant_id, list_id, created_at);

CREATE TABLE family_events (
  event_id             text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL DEFAULT 'shared' CHECK (memory_space_id = 'shared'),
  title                text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  all_day              boolean NOT NULL DEFAULT false,
  created_by_person_id text NOT NULL,
  on_behalf_of_person_id text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  cancelled_at         timestamptz,
  cancelled_by_person_id text,
  CONSTRAINT family_events_order CHECK (ends_at >= starts_at),
  CONSTRAINT family_events_cancel CHECK ((cancelled_at IS NULL) = (cancelled_by_person_id IS NULL))
);
CREATE INDEX family_events_window_idx ON family_events (tenant_id, starts_at) WHERE cancelled_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON family_lists, family_list_items, family_events TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['family_lists', 'family_list_items', 'family_events'] LOOP
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
