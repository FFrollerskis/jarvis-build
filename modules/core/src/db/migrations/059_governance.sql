-- UA-11 Executive Mode "K2" (D-64 Core-vs-Adapter-porten kjørt FØRST, se
-- docs/UA11_EXECUTIVE_MODE_DESIGN.md §7 sin deferred-liste: "Decision log,
-- scenarios, risk register, goals/OKRs, delegation board"): fire av disse
-- fem masterplan-bulletene er GENUINT NYE kanoniske entitetstyper uten
-- noen eksisterende kilde i repoet - JARVIS_CANONICAL, samme begrunnelse
-- som `situations`/`business_open_loops` allerede etablerte for sine egne
-- domener. De lever BEVISST i en egen `governance`-pakke, IKKE i
-- `@jarvis/executive` - `executive` har i dag NULL databasetilgang (ren
-- komposisjon over `situations`/`owner_controls`/`finance`, se
-- `ExecutiveService`), og å legge tabeller rett i den pakken ville brutt
-- det etablerte, bevisste arkitekturskillet mellom "komponerer eksisterende
-- tilstand" og "eier egen tilstand".
--
-- Den FEMTE bulleten, "delegation board", er BEVISST IKKE en ny tabell her:
-- masterplanens egen beskrivelse ("one source-backed prioritized view...
-- one-tap pause/override/revoke") beskriver en KOMPONERT visning av
-- autoritet som ALLEREDE finnes strukturelt (`situation_autonomy_policies`
-- for auto-ACT-delegering, `owner_control_authority`/`session_grants` for
-- enhets-/kill-switch-autoritet) - å bygge en SEPARAT
-- "delegerings-registrering"-tabell her ville vært nøyaktig den "to
-- parallelle autoritetsmodeller"-feilklassen D-64 forbyr. Et nytt,
-- SKRIVEBESKYTTET `governance.get_delegation_board`-verktøy (ren
-- komposisjon, INGEN ny tabell) legges derfor til i `@jarvis/executive`
-- sin egen fil, samme sted `get_control_surface_status` allerede
-- komponerer flere kilder.
--
-- Fire nye tabeller, alle samme (tenant_id, memory_space_id)-RLS-mønster
-- som `business_open_loops`/`situations`:
--   1. `decision_log`     - append-lignende, men IKKE strengt append-only
--                           (en beslutning kan reverseres/oppdateres eksplisitt,
--                           se `status`) logg over faktiske beslutninger tatt,
--                           med begrunnelse - eierens/Jarvis' EGEN
--                           "hvorfor gjorde vi dette"-historikk, ADSKILT fra
--                           `audit_events` (som logger SYSTEMHANDLINGER, ikke
--                           beslutnings-RESONNERING) og fra
--                           `DECISIONS_AND_ASSUMPTIONS.md` (som er
--                           KODEBASE-beslutninger, ikke forretnings-/
--                           livsbeslutninger).
--   2. `scenarios`        - "hva hvis"-planlegging: en navngitt antakelse +
--                           et projisert utfall, EKSPLISITT ikke koblet til
--                           noen modell-simulering i P0 (samme "ingen
--                           modell-assistert vurdering ennå"-avgrensning som
--                           `ranking.ts` sitt filhode).
--   3. `risks`            - risikoregister: alvorlighet × sannsynlighet,
--                           EKSPLISITT egne enum-verdier (IKKE gjenbruk av
--                           `situations.priority` sin 3-verdis skala - en
--                           risiko sin alvorlighet/sannsynlighet er
--                           konseptuelt distinkt fra en situasjons
--                           varslings-prioritet, selv om de begge er
--                           3-nivås).
--   4. `goals`             + `goal_key_results` (companion-tabell, samme
--                           mønster som `situation_notification_policies`
--                           er companion til `situations`): et mål
--                           (Objective) har null-til-mange målbare
--                           nøkkelresultater (Key Results), hver med egen
--                           fremdrift - EKTE OKR-struktur, ikke en enkelt
--                           flat fremdriftsprosent på målet alene.
--
-- INGEN av de fire tabellene har class D-handlings-claim-maskineri
-- (`act_idempotency_key`/`act_operation_fingerprint` osv., se
-- `situations`-migrasjonens filhode) - alle fire er RENE INTERNE
-- journalføringsposter (opprett/oppdater status/notat), ALDRI en
-- utløser for en ekstern mutasjon. Klasse A (lesing) / B (reversibel
-- intern skriving) dekker derfor hele denne sliceen - se
-- `docs/SECURITY_MODEL.md` §3 og `governance`-pakkens `transport.ts`.

CREATE TABLE decision_log (
  decision_id       text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  title             text NOT NULL CHECK (length(title) > 0),
  rationale         text NOT NULL,
  -- Hvem som FAKTISK tok beslutningen - IKKE hvem som ba om at den ble
  -- logget (det er `created_by` under). En Jarvis-autonom beslutning
  -- (innenfor en allerede delegert autoritet) og en eier-beslutning
  -- Jarvis kun REFERERER, er begge gyldige - EKSPLISITT skilt, aldri
  -- gjettet fra konteksten.
  decision_maker    text NOT NULL CHECK (decision_maker IN ('owner','jarvis')),
  status            text NOT NULL DEFAULT 'decided' CHECK (status IN ('proposed','decided','reversed')),
  -- Løs peker (ALDRI en kopi) til situasjonen/goal/risk beslutningen
  -- eventuelt sprang ut av - `NULL` er den normale, frittstående
  -- tilstanden. Scope-safe sammensatt FK legges til RETT ETTER
  -- `situations`-tabellen sine kolonner finnes (de gjør, migrasjon 056).
  related_situation_id text,
  owner_person_id   text REFERENCES people (person_id),
  decided_at        timestamptz NOT NULL DEFAULT now(),
  reversed_at       timestamptz,
  created_by        text REFERENCES people (person_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decision_log_list_idx ON decision_log (tenant_id, memory_space_id, decided_at DESC);

-- Scope-safe sammensatt FK, samme "en peker MÅ bevise samme tenant+space"-
-- disiplin som `situations_source_open_loop_scope_fk` (056_situations.sql):
-- en `related_situation_id` som ikke tilhører NØYAKTIG samme
-- (tenant_id, memory_space_id) avvises av databasen selv. `situations`
-- sin egen PK er global-unik, men den sammensatte UNIQUE-en
-- (tenant_id, memory_space_id, detection_key) dekker IKKE situation_id -
-- situations.situation_id ALENE er allerede PRIMARY KEY (dermed unik), så
-- denne FK-en bruker en direkte sammensatt referanse mot en NY, tynn
-- UNIQUE på (situation_id, tenant_id, memory_space_id).
ALTER TABLE situations ADD CONSTRAINT situations_scope_uq UNIQUE (situation_id, tenant_id, memory_space_id);
ALTER TABLE decision_log ADD CONSTRAINT decision_log_related_situation_scope_fk
  FOREIGN KEY (related_situation_id, tenant_id, memory_space_id)
  REFERENCES situations (situation_id, tenant_id, memory_space_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON decision_log TO jarvis_app;
ALTER TABLE decision_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_log FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_log_tenant ON decision_log
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY decision_log_space ON decision_log AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

CREATE TABLE scenarios (
  scenario_id       text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  title             text NOT NULL CHECK (length(title) > 0),
  assumptions       text NOT NULL,
  projected_outcome text NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  owner_person_id   text REFERENCES people (person_id),
  created_by        text REFERENCES people (person_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scenarios_list_idx ON scenarios (tenant_id, memory_space_id, status, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON scenarios TO jarvis_app;
ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios FORCE ROW LEVEL SECURITY;
CREATE POLICY scenarios_tenant ON scenarios
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY scenarios_space ON scenarios AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

CREATE TABLE risks (
  risk_id           text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  title             text NOT NULL CHECK (length(title) > 0),
  description       text NOT NULL,
  -- Bevisst EGNE enum-verdier, ikke gjenbruk av `situations.priority`
  -- (se filhode) - en risiko har to UAVHENGIGE akser (konsekvens OG
  -- sannsynlighet), en situasjon har kun én (varslings-prioritet).
  severity          text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  probability       text NOT NULL CHECK (probability IN ('low','medium','high')),
  mitigation_plan   text,
  status            text NOT NULL DEFAULT 'identified'
    CHECK (status IN ('identified','mitigating','accepted','resolved')),
  owner_person_id   text REFERENCES people (person_id),
  created_by        text REFERENCES people (person_id),
  identified_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risks_list_idx ON risks (tenant_id, memory_space_id, status, severity);

GRANT SELECT, INSERT, UPDATE, DELETE ON risks TO jarvis_app;
ALTER TABLE risks ENABLE ROW LEVEL SECURITY;
ALTER TABLE risks FORCE ROW LEVEL SECURITY;
CREATE POLICY risks_tenant ON risks
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY risks_space ON risks AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

CREATE TABLE goals (
  goal_id           text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  title             text NOT NULL CHECK (length(title) > 0),
  description       text,
  status            text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','at_risk','achieved','abandoned')),
  target_date       date,
  owner_person_id   text REFERENCES people (person_id),
  created_by        text REFERENCES people (person_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goals_list_idx ON goals (tenant_id, memory_space_id, status, target_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON goals TO jarvis_app;
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
CREATE POLICY goals_tenant ON goals
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY goals_space ON goals AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Companion-tabell til `goals`, samme "hovedtabell + eier-konfigurert
-- companion"-mønster som `situation_notification_policies` er til
-- `situations` (056_situations.sql): et Objective (goals-raden) har
-- null-til-mange målbare Key Results, hver med sin EGEN fremdrift -
-- ekte OKR-struktur (ikke en enkelt flat prosent på Objective-raden).
-- `progress_percent` er EKSPLISITT eier-/Jarvis-oppdatert (ingen
-- automatisk måling koblet til i P0 - samme "ingen live kilde ennå"-
-- avgrensning som resten av denne migrasjonen).
CREATE TABLE goal_key_results (
  key_result_id     text PRIMARY KEY,
  goal_id           text NOT NULL REFERENCES goals (goal_id) ON DELETE CASCADE,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  title             text NOT NULL CHECK (length(title) > 0),
  progress_percent  numeric NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goal_key_results_goal_idx ON goal_key_results (goal_id);

-- Scope-safe sammensatt FK, samme disiplin som `decision_log` sin over:
-- en `goal_key_results`-rad MÅ dele nøyaktig (tenant_id, memory_space_id)
-- med sin egen `goals`-forelder - `ON DELETE CASCADE` over håndterer
-- selve sletting-kaskaden, denne FK-en hindrer at en rad noensinne
-- SKAPES med et scope som avviker fra forelderen.
ALTER TABLE goals ADD CONSTRAINT goals_scope_uq UNIQUE (goal_id, tenant_id, memory_space_id);
ALTER TABLE goal_key_results ADD CONSTRAINT goal_key_results_goal_scope_fk
  FOREIGN KEY (goal_id, tenant_id, memory_space_id)
  REFERENCES goals (goal_id, tenant_id, memory_space_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON goal_key_results TO jarvis_app;
ALTER TABLE goal_key_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_key_results FORCE ROW LEVEL SECURITY;
CREATE POLICY goal_key_results_tenant ON goal_key_results
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY goal_key_results_space ON goal_key_results AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
