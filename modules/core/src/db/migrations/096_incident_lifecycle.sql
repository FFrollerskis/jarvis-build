-- WP-E1 (UA-5, JARVIS-068): incident-livssyklus med VARIG overgangshistorikk og deterministiske produsenter.
-- Forward-safe (expand-only): nye kolonner med trygge standarder, én ny tabell, ingen eksisterende kolonne fjernet/omdøpt.
--
-- Før dette fantes det ingen produsenter (kun manuell /incidents/create) og ingen varig historikk: `incidents.status` ble overskrevet uten spor av hvem, når og hvorfor.
-- Nå registreres HVER statusendring i `incident_transitions` (append-only: ingen UPDATE-grant, DELETE kun som erasure-kaskade), og en utsatt constraint-trigger gjør det UMULIG å
-- endre `incidents.status` uten at en overgangsrad (fra -> til, i SAMME transaksjon) er skrevet - heller ikke med rå SQL fra app-rollen. Overgangsraden selv kan bare være en LOVLIG
-- overgang (CHECK mot tilstandsmaskinens par), så en ulovlig statusendring kan ikke komme gjennom selv om TypeScript-sjekken omgås.
--
-- Tilstandsmaskinen beholder bevisst de eksisterende statusverdiene (open, diagnosing, repair_proposed, repair_in_progress, resolved, wont_fix): CHECK-begrensninger, lagrede data og
-- situasjonsmotorens infra-bro (`isActiveIncidentStatus`: alt annet enn resolved/wont_fix er aktivt) avhenger av dem. Mapping til livssyklus-begrepene:
-- open = åpen, diagnosing = anerkjent/triagert, repair_proposed/repair_in_progress = avbøtende tiltak, resolved = løst, wont_fix = lukket uten tiltak.

ALTER TABLE incidents ADD COLUMN source_kind text NOT NULL DEFAULT 'manual'
  CHECK (source_kind IN ('manual', 'watchdog', 'scheduler', 'deployment', 'sentry', 'slo', 'provider', 'infra_execution'));
-- Fingeravtrykk (stabil nøkkel for «samme fakta»): `<source_kind>:<emne>`. Aldri innhold - kun sanerte identifikatorer (jobbnavn, repo, SLO-id, connector-id).
ALTER TABLE incidents ADD COLUMN dedupe_key text
  CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200);
-- Korrelasjons-id: deterministisk avledet av fingeravtrykket (`corr-` + 16 hex) - binder alle hendelser, overganger, bevis og revisjonsrader for «samme underliggende fakta» sammen
-- over tid (også når en løst hendelse åpnes på nytt som en NY rad), uten å eksponere selve nøkkelen. Brukes som `trace_id` i revisjonssporet.
ALTER TABLE incidents ADD COLUMN correlation_id text
  CHECK (correlation_id IS NULL OR correlation_id ~ '^corr-[0-9a-f]{16}$');
ALTER TABLE incidents ADD COLUMN occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1);
ALTER TABLE incidents ADD COLUMN last_seen_at timestamptz;
-- En produsent-åpnet hendelse MÅ ha et fingeravtrykk og en korrelasjons-id (ellers kan den ikke dedupes), og fingeravtrykket MÅ starte med hendelsens egen kilde (en produsent kan ikke
-- stjele en annen produsents nøkkelrom). Manuelle hendelser har ingen av delene. (`starts_with`, ikke LIKE: `_` i kildenavn er et LIKE-jokertegn.)
ALTER TABLE incidents ADD CONSTRAINT incidents_producer_needs_dedupe_key
  CHECK (source_kind = 'manual' OR (dedupe_key IS NOT NULL AND correlation_id IS NOT NULL AND starts_with(dedupe_key, source_kind || ':')));
-- ÉN aktiv hendelse per fingeravtrykk: samme fakta gir aldri to åpne hendelser (race-fritt, også mellom api og worker).
CREATE UNIQUE INDEX incidents_active_dedupe_idx ON incidents (tenant_id, memory_space_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status NOT IN ('resolved', 'wont_fix');
-- Gjenåpning/demping: nyeste TERMINALE hendelse med samme fingeravtrykk (regresjon gjenåpnes, «ikke fiks» demper).
CREATE INDEX incidents_dedupe_lookup_idx ON incidents (tenant_id, memory_space_id, dedupe_key, updated_at DESC) WHERE dedupe_key IS NOT NULL;
CREATE INDEX incidents_correlation_idx ON incidents (tenant_id, correlation_id) WHERE correlation_id IS NOT NULL;

-- Varig overgangshistorikk. `reason` er kort fritekst (≤ 500) og redigeres for hemmeligheter før lagring; `evidence_ref` er en PEKER (evidens-/diagnose-/eksekusjons-/jobb-id), aldri innhold.
-- `from_status IS NULL` = opprettelsesraden. `txid` binder raden til transaksjonen som endret statusen (se constraint-triggeren under).
-- `actor_kind`: owner = eieren (actor_person_id satt), producer = en deterministisk produsent, repair = reparasjonsflyten (kodejobb), system = bakfyll/øvrig systemhandling.
CREATE TABLE incident_transitions (
  transition_id    text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id  text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  incident_id      text NOT NULL REFERENCES incidents (incident_id) ON DELETE CASCADE,
  from_status      text CHECK (from_status IS NULL OR from_status IN ('open', 'diagnosing', 'repair_proposed', 'repair_in_progress', 'resolved', 'wont_fix')),
  to_status        text NOT NULL CHECK (to_status IN ('open', 'diagnosing', 'repair_proposed', 'repair_in_progress', 'resolved', 'wont_fix')),
  actor_kind       text NOT NULL CHECK (actor_kind IN ('owner', 'producer', 'repair', 'system')),
  actor_person_id  text REFERENCES people (person_id),
  reason           text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  evidence_ref     text CHECK (evidence_ref IS NULL OR char_length(evidence_ref) <= 200),
  txid             bigint NOT NULL DEFAULT txid_current(),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_status IS NULL OR from_status <> to_status),
  -- Eier-handlinger bærer alltid hvem; øvrige aktører bærer aldri en person (en produsent kan ikke utgi seg for å være eieren).
  CHECK ((actor_kind = 'owner') = (actor_person_id IS NOT NULL)),
  -- Kun LOVLIGE par (speiler `INCIDENT_TRANSITIONS` i modules/incidents/src/state-machine.ts - en test holder de to i takt).
  CHECK (
    from_status IS NULL
    OR (from_status || '>' || to_status) = ANY (ARRAY[
      'open>diagnosing', 'open>repair_proposed', 'open>resolved', 'open>wont_fix',
      'diagnosing>open', 'diagnosing>repair_proposed', 'diagnosing>resolved', 'diagnosing>wont_fix',
      'repair_proposed>diagnosing', 'repair_proposed>repair_in_progress', 'repair_proposed>resolved', 'repair_proposed>wont_fix',
      'repair_in_progress>repair_proposed', 'repair_in_progress>resolved', 'repair_in_progress>wont_fix',
      'resolved>open', 'wont_fix>open'
    ])
  ),
  -- Opprettelsesraden (fra-status = null) er alltid til `open` - bortsett fra bakfyllet under (`system`, til-status = dagens status).
  CHECK (from_status IS NOT NULL OR to_status = 'open' OR actor_kind = 'system')
);
CREATE INDEX incident_transitions_timeline_idx ON incident_transitions (tenant_id, incident_id, occurred_at, transition_id);
-- Komposittnøkkel (tenant_id, incident_id): en overgang kan aldri peke på en annen tenants hendelse (jf. 078-081).
SELECT jarvis_scope_fk('incident_transitions', 'incident_id', 'incidents', 'incident_id');

-- Bakfyll: eksisterende hendelser får én ærlig «historikk starter her»-rad (til-status = dagens status). Dette er IKKE en rekonstruksjon av tidligere overganger.
INSERT INTO incident_transitions (transition_id, tenant_id, memory_space_id, incident_id, from_status, to_status, actor_kind, reason, occurred_at, txid)
SELECT 'inc-tr-backfill-' || i.incident_id, i.tenant_id, i.memory_space_id, i.incident_id, NULL, i.status, 'system',
       'bakfylt ved migrasjon 096: historikk fra før livssyklussporingen finnes ikke; dette er dagens status', i.updated_at, 0
  FROM incidents i;

-- Det er umulig å endre incidents.status uten en overgangsrad (fra -> til) skrevet i SAMME transaksjon. Utsatt til commit, så rekkefølgen UPDATE/INSERT er likegyldig.
-- (Opprettelse håndheves ikke her: rå INSERT uten overgangsrad finnes i eldre tester og bakfylles ikke; tjenesten skriver alltid opprettelsesraden.)
CREATE FUNCTION incidents_status_requires_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM incident_transitions t
     WHERE t.tenant_id = NEW.tenant_id AND t.incident_id = NEW.incident_id AND t.from_status = OLD.status AND t.to_status = NEW.status AND t.txid = txid_current()
  ) THEN
    RAISE EXCEPTION 'incident_status_change_without_transition' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER incidents_status_requires_transition_trg
  AFTER UPDATE OF status ON incidents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION incidents_status_requires_transition();

-- Historikken er varig: en overgangsrad kan bare forsvinne sammen med hendelsen den tilhører (Q-20-erasure kaskaderer fra `incidents`; da er hendelsesraden allerede slettet når kaskaden
-- kjører). Direkte DELETE mot en overgang hvis hendelse fortsatt finnes avvises.
CREATE FUNCTION incident_transitions_guard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM incidents i WHERE i.tenant_id = OLD.tenant_id AND i.incident_id = OLD.incident_id) THEN
    RAISE EXCEPTION 'incident_transitions_append_only' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER incident_transitions_guard_delete_trg BEFORE DELETE ON incident_transitions FOR EACH ROW EXECUTE FUNCTION incident_transitions_guard_delete();

-- Append-only: ingen UPDATE-grant. DELETE trengs kun for Q-20-erasure (kaskaden fra incidents krever DELETE-privilegium på barnetabellen).
GRANT SELECT, INSERT, DELETE ON incident_transitions TO jarvis_app;

ALTER TABLE incident_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_transitions_tenant ON incident_transitions
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY incident_transitions_space ON incident_transitions AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
