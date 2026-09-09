-- UA-8 Personal Digital Twin - Personal Context Engine v1.
--
-- Masterplan-krav: ÉN kanonisk, kildeforankret kontekstmodell for sted,
-- tidspunkt/tidssone, aktiv enhet, møte-/kalenderkontekst og aktivitetsstate
-- - person-/tenant-/space-skopet, ferskhetsbevisst, og som ALLTID foretrekker
-- en deterministisk kilde fremfor en AI-gjetning når én finnes (D-41-prinsippet
-- anvendt internt, ikke bare på eier-connectorer).
--
-- DESIGNVALG (upsert-per-dimensjon, IKKE append-only): sammenlignet de to
-- EKSISTERENDE mønstrene i denne migrasjonskatalogen -
-- `marketing_campaign_observations` (031, upsert-per-type via
-- `UNIQUE (tenant_id, campaign_id, observation_type)`) vs `consent_decisions`
-- (032, BEVISST append-only fordi HISTORIKKEN selv har juridisk betydning -
-- "hva ble besluttet når" er selve poenget). "Gjeldende, ferskhetsbevisst
-- kontekst" har IKKE samme egenskap: ingen senere leser trenger noensinne
-- "hvilket sted trodde vi personen var i for tre observasjoner siden" - kun
-- "hva er sant NÅ, og hvor ferskt er det". Én rad per
-- (tenant, person, space, dimension) som oppdateres in-place er derfor riktig
-- form (samme UNIQUE-per-dimensjon-idé som marketing_campaign_observations),
-- IKKE et append-only-mønster som ville tvunget hver leser til å selv
-- resonnere "siste rad vinner" per dimensjon uten noen presedens-regel i
-- databasen selv.
--
-- `dimension` er BEVISST begrenset til de fire kontekst-typene masterplanen
-- selv nevner utover tidsstempel (som ALLTID er kjent via `observed_at`/
-- systemklokken og derfor ikke trenger en egen dimensjonsrad):
-- 'place' (sted), 'device' (aktiv enhet/kanal), 'meeting' (møte-/kalender-
-- kontekst) og 'activity' (aktivitetsstate). `place` sin `value`-form holdes
-- BEVISST generisk her (se @jarvis/context/src/types.ts) - denne migrasjonen
-- eier KUN lagringsformen, ALDRI stedslogikk (et fremtidig `modules/location/`
-- skriver gjennom SAMME `recordObservation()`-API, ingen egen stedstabell her).
--
-- `basis` ('deterministic' | 'inferred') er den AUTORITATIVE presedens-
-- kolonnen (D-41-prinsippet: en deterministisk kilde skal ALDRI stille
-- overskrives av en gjetning) - håndheves i `ContextEngine`
-- (`modules/context/src/service.ts`), ikke bare i denne migrasjonen.
-- `confidence` er en VALGFRI, ikke-autoritativ numerisk finjustering for en
-- FREMTIDIG utvidelse (f.eks. rangering blant flere samtidige inferred-
-- observasjoner) - `basis` alene avgjør presedens i v1, `confidence` brukes
-- IKKE til noe i denne sliceen (bevisst, ikke stille utelatt).
--
-- `source_type`/`source_instance_id` er en POINTER til opphavet (enhet-id,
-- sesjons-id, kalender-aktivitet-id) - ALDRI en kopi av fullt eksternt
-- innhold (samme pointer-not-payload-prinsipp som
-- `operations_tasks.source_instance_id`/`business_activities.canonical_uri`).
--
-- Ingen sammensatt FK trengs her (D-129-lærdommen gjelder FK-SHAPED
-- relasjoner MELLOM to tenant/space-skopede tabeller): `person_id` er en
-- ENKEL FK mot den globale, ikke-tenant-skopede `people`-tabellen (SAMME
-- mønster som `devices.person_id`/`operations_tasks.owner_person_id`), og
-- `source_instance_id` er en LØS tekst-pekerkolonne, IKKE en ekte
-- fremmednøkkel mot noen annen kanonisk tabell (samme mønster som
-- `business_activities.external_id`).
CREATE TABLE context_observations (
  observation_id      text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  person_id            text NOT NULL REFERENCES people (person_id),
  memory_space_id      text NOT NULL CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  dimension            text NOT NULL CHECK (dimension IN ('place','device','meeting','activity')),
  value                jsonb NOT NULL,
  basis                text NOT NULL DEFAULT 'inferred' CHECK (basis IN ('deterministic','inferred')),
  -- Pointer, aldri innhold - se filhode.
  source_type          text NOT NULL,
  source_instance_id   text,
  -- Valgfri, IKKE-autoritativ finjustering (se filhode) - ubrukt i v1-logikken.
  confidence           real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  observed_at          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Ferskhetsbevisst "gjeldende tilstand"-modell (se filhode): ÉN rad per
  -- (tenant, person, space, dimensjon) - `ContextEngine.recordObservation()`
  -- skriver via `ON CONFLICT ... DO UPDATE` mot nettopp denne nøkkelen.
  UNIQUE (tenant_id, person_id, memory_space_id, dimension)
);

GRANT SELECT, INSERT, UPDATE ON context_observations TO jarvis_app;
-- Q-20: person-/space-skopet kontekstdata - samme kundedata-/persondata-
-- klassifisering som marketing_campaign_observations/operations_* over
-- (IKKE append-only systemrevisjon). Registreres i modules/erasure/src/plan.ts
-- (se ContextEngine-byggeordrens rapport for de eksakte predikatene).
GRANT DELETE ON context_observations TO jarvis_app;

ALTER TABLE context_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY context_observations_tenant ON context_observations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY context_observations_space ON context_observations AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
