-- WP-G3 (D-465), UA-9 Vision & Physical World, del 2: levetids-eid lagring av ØYEBLIKKSBILDER (event snapshots).
--
-- 055_vision.sql forbød `snapshot_ref` (CHECK ... IS NULL) med denne begrunnelsen (arkitekt-review PR #83): "en fremtidig slice som
-- bygger en ekte, levetids-eid snapshot-lagring fjerner denne CHECK-en OG legger til transaksjonell/kompenserende sletting av det
-- refererte objektet FØRST". Denne migrasjonen gjør nettopp det, i denne rekkefølgen:
--   1. `vision_snapshots` er Jarvis' EGEN metadata for hvert lagret bilde (storage_key peker til bildet bak StorageAdapter; selve
--      bildebytes ligger ALDRI i databasen). Raden opprettes som 'pending' FØR bildet skrives og settes 'stored' etterpå, så et
--      krasj mellom de to stegene etterlater en rad vi kan rydde, aldri et bilde uten eier.
--   2. `vision_snapshot_tombstones` er en ARBEIDSKØ for sletting av bildeobjekter. En BEFORE DELETE-trigger på vision_snapshots
--      skriver en gravstein for HVER slettet rad - uansett hvilken vei raden forsvinner (oppbevaringssveip, Q-20-erasure, kamera
--      fjernet, manuell sletting). Selve bildet slettes av en gjentakbar "reaper" (modules/vision/src/snapshots.ts) som kun fjerner
--      graven NÅR StorageAdapter har bekreftet at objektet er borte. Sletting er dermed ENDELIG KONSISTENT og aldri stille tapt:
--      en feil gir en gravstein med attempts/last_error som står igjen til neste kjøring (og vises i status).
--   3. Først DERETTER fjernes snapshot_ref-forbudet og erstattes av en sammensatt FK med ON DELETE SET NULL (snapshot_ref): når et
--      bilde slettes (eget, kortere vindu enn hendelsene) mister hendelsen pekeren, men beholdes (append-only, ingen UPDATE-grant -
--      FK-handlingen kjører som tabelleier og omgår FORCE RLS, samme mekanisme som 074 sin session_grants-kaskade).
--   4. En AFTER DELETE-trigger på vision_event_observations sletter bildet når SISTE hendelse som peker på det forsvinner (flere
--      hendelser fra samme øyeblikk deler ett bilde). Dermed følger bildet hendelsene ut ved oppbevaring og erasure uten at
--      erasure-planen må vite om bilder.
--
-- Biometri: tabellen har ingen kolonne for ansikt/identitet/mal. Bildet er et vanlig øyeblikksbilde fra én hendelse - aldri en
-- kontinuerlig strøm (CHECK på byte_length, én rad per kilde-hendelse via unik nøkkel).

CREATE TABLE vision_snapshots (
  snapshot_id          text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id      text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  person_id            text NOT NULL,
  camera_id            text NOT NULL,
  -- Kilde-proveniens (samme nøkkel som vision_event_observations sin dedupe-nøkkel): ett bilde per kilde-hendelse.
  source_type          text NOT NULL,
  source_instance_id   text NOT NULL,
  source_event_id      text NOT NULL,
  storage_backend      text NOT NULL CHECK (storage_backend ~ '^[a-z0-9_]{1,32}$'),
  -- Nøkkelen bygges av Jarvis (aldri av kilden eller modellen); CHECK avviser stitraversering, absolutte stier og tomme segmenter.
  storage_key          text NOT NULL CHECK (storage_key ~ '^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$' AND storage_key !~ '\.\.' AND storage_key !~ '//'),
  media_type           text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  byte_length          integer NOT NULL CHECK (byte_length BETWEEN 1 AND 20971520),
  sha256               text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  state                text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','stored')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  stored_at            timestamptz,
  -- Anker på databasens EGEN mottakstid (now()), aldri på det ubetrodde kilde-tidsstempelet (samme prinsipp som 055).
  retention_expires_at timestamptz NOT NULL,
  task_id              text NOT NULL,
  session_id           text,
  CONSTRAINT vision_snapshots_stored_has_time CHECK (state <> 'stored' OR stored_at IS NOT NULL)
);
CREATE INDEX vision_snapshots_lookup_idx ON vision_snapshots (tenant_id, memory_space_id, person_id, created_at DESC);
CREATE INDEX vision_snapshots_retention_idx ON vision_snapshots (retention_expires_at);
CREATE INDEX vision_snapshots_pending_idx ON vision_snapshots (created_at) WHERE state = 'pending';
ALTER TABLE vision_snapshots ADD CONSTRAINT vision_snapshots_person_tenant_fkey
  FOREIGN KEY (person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id);
-- Fjernes kameraet (eier-handling med eksplisitt bekreftelse), følger bildene med; BEFORE DELETE-triggeren under gir gravsteiner.
ALTER TABLE vision_snapshots ADD CONSTRAINT vision_snapshots_camera_fkey
  FOREIGN KEY (tenant_id, memory_space_id, person_id, camera_id) REFERENCES vision_cameras (tenant_id, memory_space_id, person_id, camera_id) ON DELETE CASCADE;
ALTER TABLE vision_snapshots ADD CONSTRAINT vision_snapshots_scope_key UNIQUE (tenant_id, memory_space_id, person_id, snapshot_id);
ALTER TABLE vision_snapshots ADD CONSTRAINT vision_snapshots_source_event_key
  UNIQUE (tenant_id, memory_space_id, person_id, source_type, source_instance_id, source_event_id);
ALTER TABLE vision_snapshots ADD CONSTRAINT vision_snapshots_storage_key_key UNIQUE (tenant_id, storage_backend, storage_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON vision_snapshots TO jarvis_app;
ALTER TABLE vision_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_snapshots_tenant ON vision_snapshots
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_snapshots_space ON vision_snapshots AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Arbeidskø for sletting av bildeobjekter. Inneholder KUN lagringsnøkler (ingen person-, bilde- eller hendelsesdata) og er derfor
-- BEVISST ikke med i erasure-planen: å slette en gravstein før objektet er borte ville etterlatt et foreldreløst bilde.
CREATE TABLE vision_snapshot_tombstones (
  tombstone_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  storage_backend text NOT NULL CHECK (storage_backend ~ '^[a-z0-9_]{1,32}$'),
  storage_key     text NOT NULL CHECK (storage_key ~ '^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$' AND storage_key !~ '\.\.' AND storage_key !~ '//'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  -- Kun en kort feilkode (aldri leverandørtekst eller stier).
  last_error      text CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_:-]{1,80}$'),
  UNIQUE (tenant_id, storage_backend, storage_key)
);
CREATE INDEX vision_snapshot_tombstones_work_idx ON vision_snapshot_tombstones (tenant_id, memory_space_id, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON vision_snapshot_tombstones TO jarvis_app;
ALTER TABLE vision_snapshot_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_snapshot_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_snapshot_tombstones_tenant ON vision_snapshot_tombstones
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_snapshot_tombstones_space ON vision_snapshot_tombstones AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Ikke SECURITY DEFINER: triggerne kjører som kallerens rolle (jarvis_app) under kallerens RLS-kontekst, så de kan aldri nå
-- en annen tenants eller et annet rom sine rader enn kallerens egen transaksjon allerede kan.
CREATE FUNCTION vision_snapshot_tombstone() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO vision_snapshot_tombstones (tenant_id, memory_space_id, storage_backend, storage_key)
  VALUES (OLD.tenant_id, OLD.memory_space_id, OLD.storage_backend, OLD.storage_key)
  ON CONFLICT (tenant_id, storage_backend, storage_key) DO NOTHING;
  RETURN OLD;
END
$$;
CREATE TRIGGER vision_snapshots_tombstone BEFORE DELETE ON vision_snapshots
  FOR EACH ROW EXECUTE FUNCTION vision_snapshot_tombstone();

-- snapshot_ref: forbudet fra 055 erstattes av en sammensatt FK (D-129-lærdommen: tenant, space OG person i nøkkelen).
ALTER TABLE vision_event_observations DROP CONSTRAINT IF EXISTS vision_event_observations_snapshot_ref_check;
ALTER TABLE vision_event_observations ADD CONSTRAINT vision_event_observations_snapshot_fkey
  FOREIGN KEY (tenant_id, memory_space_id, person_id, snapshot_ref)
  REFERENCES vision_snapshots (tenant_id, memory_space_id, person_id, snapshot_id) ON DELETE SET NULL (snapshot_ref);
CREATE INDEX vision_event_observations_snapshot_idx ON vision_event_observations (tenant_id, memory_space_id, person_id, snapshot_ref) WHERE snapshot_ref IS NOT NULL;

CREATE FUNCTION vision_observation_release_snapshot() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.snapshot_ref IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM vision_event_observations o
     WHERE o.tenant_id = OLD.tenant_id AND o.memory_space_id = OLD.memory_space_id
       AND o.person_id = OLD.person_id AND o.snapshot_ref = OLD.snapshot_ref
  ) THEN
    DELETE FROM vision_snapshots
     WHERE tenant_id = OLD.tenant_id AND memory_space_id = OLD.memory_space_id
       AND person_id = OLD.person_id AND snapshot_id = OLD.snapshot_ref;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER vision_observations_release_snapshot AFTER DELETE ON vision_event_observations
  FOR EACH ROW EXECUTE FUNCTION vision_observation_release_snapshot();
