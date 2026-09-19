-- K1 (Sovereign graduation, D-164): durable, delt eier-kontroll-autoritet.
-- Lukker UA-11 akseptansekriterium 3 sitt gjenstaende gap (D-163):
-- `KillSwitch`/`OwnerControls` (modules/policy/src) var, FOR denne
-- migrasjonen, rene in-memory-objekter konstruert SEPARAT i
-- apps/api/src/main.ts OG apps/api/src/worker-main.ts - en pause satt i
-- API-prosessen var USYNLIG for worker-prosessen (og omvendt), OG en
-- omstart glemte tilstanden stille (fail-OPEN). SAMME arkitektoniske
-- moenster som `situation_domain_pauses` (056_situations.sql) sin
-- `DomainPauseRegistry`, anvendt paa et STRENGERE, GLOBALT lag OVENPAA
-- (KillSwitch blokkerer ALT, uansett capability-klasse - domain-pause
-- gjelder KUN Situation Engine sin egen ACT-beslutning).
--
-- EN tabell, tre "kind"-er (kill_switch/connector_freeze/
-- credential_revocation) - IKKE tre separate tabeller, fordi alle tre er
-- semantisk identiske "denne eier-kontrollen er PAA akkurat naa"-fakta med
-- identisk skjema (target/reason/actor/tidspunkt) og identisk autoritets-
-- modell. Presens av en rad = kontrollen er AKTIV (samme "presens = paa"-
-- moenster som `situation_domain_pauses`, IKKE en separat boolean-kolonne)
-- - unpause/unfreeze/restore SLETTER raden.
--
-- `control_target = 'GLOBAL'` er en reservert sentinel for `kill_switch`
-- (som ALDRI har et naturlig mål-navn - den er alltid systemomfattende).
-- For `connector_freeze` er target = connector_id (samme fri-tekst-
-- fleksibilitet som situations.domain); for `credential_revocation` er
-- target = credential_ref.
--
-- INGEN RLS, INGEN tenant_id-kolonne (BEVISST, samme begrunnelse som
-- `situation_domain_pauses`): en kill-switch-/frys-/tilbakekallshandling
-- er en GLOBAL, SOVEREIGN eier-handling, ikke en tenant-partisjonert
-- ressurs - `KillSwitch` har ALLTID vaert global-kun (blokkerer ALT,
-- uansett tenant), og denne tabellen endrer ikke det omfanget, kun HVOR
-- tilstanden bor.
--
-- Q-20/erasure: IKKE registrert i modules/erasure/src/plan.ts - samme
-- presedens som `situation_domain_pauses`/`audit_events`/`tool_executions`:
-- dette er SYSTEM-AUTORITET-/revisjonstilstand, ikke person-eid data.
-- `actor_person_id` er en PEKER til HVEM som handlet (revisjonsformål),
-- ALDRI data som "tilhoerer" den personen i Q-20-forstand.
CREATE TABLE owner_control_state (
  control_kind      text NOT NULL CHECK (control_kind IN ('kill_switch', 'connector_freeze', 'credential_revocation')),
  control_target    text NOT NULL,
  reason             text NOT NULL,
  actor_person_id   text REFERENCES people (person_id),
  changed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (control_kind, control_target)
);

-- Sikrer at `kill_switch` KUN kan ha nøyaktig den ene, reserverte
-- GLOBAL-raden - en fremtidig kodefeil kan ikke ved et uhell opprette et
-- "delvis" kill-switch-mål (den er per definisjon udelelig).
ALTER TABLE owner_control_state
  ADD CONSTRAINT owner_control_state_kill_switch_target_ck
  CHECK (control_kind <> 'kill_switch' OR control_target = 'GLOBAL');

-- Samme grant-bredde-moenster som `situation_domain_pauses`/`tool_executions`/
-- `audit_events` (og repoets øvrige tabeller generelt): autorisasjon
-- håndheves i APPLIKASJONSKODEN (`OwnerControlAuthority.assertAuthorized()`,
-- samme mønster som `DomainPauseRegistry`), ALDRI via smale per-tabell
-- DB-grants - en egen DB-rolle KUN for denne tabellen ville vært et NYTT,
-- inkonsistent arkitekturmønster resten av repoet ikke bruker noe sted.
GRANT SELECT, INSERT, UPDATE, DELETE ON owner_control_state TO jarvis_app;
