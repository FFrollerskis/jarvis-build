-- UA-5 Production Operations Control Plane v2 (D-105): lukker D-104 sine
-- kjente hull for kriterium 1 (deploy/log/DB-korrelasjon) og kriterium 3
-- (kritisk infra før/etter + testet recovery). D-64-porten kjørt FØRST
-- (se D-105 i DECISIONS_AND_ASSUMPTIONS.md): Docker Engine er valgt som DEN
-- ENE, sammenhengende overflaten for BÅDE observability OG kritisk infra-
-- mutasjon (HYBRID_WITH_CLEAR_AUTHORITY - Docker-daemonen er autoritativ for
-- "hva kjører nå faktisk", Jarvis forblir kanonisk for hendelse/diagnose/
-- eksekusjonsjournal/recovery-orkestrering/policy/audit). INGEN nytt SDK -
-- samme `docker`-CLI-subprosess-mønster som `DockerSandboxRunner` allerede
-- bruker (modules/tasks/src/sandbox.ts). Forward-safe: KUN nye tabeller +
-- additive CHECK-utvidelser, INGEN eksisterende kolonne fjernet/omdøpt.

-- Del G: diagnose-modell - EVIDENS og DIAGNOSE er BEVISST atskilte typer
-- (D-104-audit fant ingen egen diagnose-tabell). `conclusion` er KORT og
-- allerede strukturert (samme lengdebegrensning som `incident_evidence.
-- summary`) - ALDRI rå chain-of-thought. `supersedes_diagnosis_id` bevarer
-- en MOTSAGT diagnose UENDRET (aldri overskrevet/slettet) - en ny rad
-- opprettes og peker BAKOVER, samme prinsipp som `contradicts_evidence_id`.
CREATE TABLE incident_diagnoses (
  diagnosis_id           text PRIMARY KEY,
  tenant_id               text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id         text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  incident_id             text NOT NULL REFERENCES incidents (incident_id),
  conclusion              text NOT NULL CHECK (char_length(conclusion) <= 2000),
  status                  text NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED', 'PROVISIONAL', 'VERIFIED')),
  source                  text NOT NULL CHECK (source IN ('deterministic', 'model_assisted', 'owner')),
  supersedes_diagnosis_id text REFERENCES incident_diagnoses (diagnosis_id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_diagnoses_lookup_idx ON incident_diagnoses (tenant_id, incident_id, created_at DESC);

-- Bevis-lenker per diagnose (støttende/motstridende) - relasjonell, ALDRI
-- en array-kolonne (samme "spørrbar lenketabell"-prinsipp som
-- `incident_repair_tasks`). `ON DELETE CASCADE` fra diagnosen: en lenkerad
-- bærer intet eget innhold (kun to id-er), samme begrunnelse som
-- `incident_repair_tasks` sin CASCADE.
CREATE TABLE incident_diagnosis_evidence (
  diagnosis_id text NOT NULL REFERENCES incident_diagnoses (diagnosis_id) ON DELETE CASCADE,
  evidence_id  text NOT NULL REFERENCES incident_evidence (evidence_id),
  relation     text NOT NULL CHECK (relation IN ('supports', 'contradicts')),
  PRIMARY KEY (diagnosis_id, evidence_id)
);

-- Del F: docker-redeploy er nå en gyldig deploy-KILDE (utvider EKSISTERENDE
-- `deployments`-tabell fra 036 - samme korrelasjonsmotor, `findSuspect
-- Deployment()`/`correlateIncident()`, ZERO ny korrelasjonslogikk trengs for
-- å få docker-baserte deploys inn i eksisterende deploy-korrelasjon).
ALTER TABLE deployments DROP CONSTRAINT deployments_source_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_source_check
  CHECK (source IN ('github_actions', 'manual', 'docker_redeploy'));

-- Del H: kritisk infra-eksekusjonsjournal v2 - APPEND-ONLY (ALDRI en UPDATE
-- etter innsetting: hele BEFORE->MUTASJON->AFTER->DIFF->UTFALL-sekvensen
-- fullføres FØR raden skrives, se executeInfraMutation()). Sitter VED SIDEN
-- AV `tool_executions` (som forblir 100% uendret - ZERO regresjonsrisiko for
-- D-102/D-103/D-104), IKKE en erstatning - denne raden gir den SAMMENHENGENDE
-- konteksten (aktør/enhet/risikoklasse/myndighetsmodus/recovery-plan/diff)
-- som `tool_executions` alene aldri representerte samlet, uten å måtte
-- rekonstruere den fra løst koblet fritekst-audit (byggeordrens §H-krav).
CREATE TABLE infra_executions (
  execution_id         text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  person_id            text REFERENCES people (person_id),
  device_id            text,
  target               text NOT NULL,
  provider             text NOT NULL DEFAULT 'docker',
  tool_id              text NOT NULL,
  action               text NOT NULL,
  risk_class           text NOT NULL CHECK (risk_class IN ('A', 'B', 'C', 'D')),
  authority_mode       text,
  incident_id          text REFERENCES incidents (incident_id) ON DELETE SET NULL,
  idempotency_key      text NOT NULL,
  requested_operation  text NOT NULL,
  requested_state      jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_state         jsonb,
  recovery_plan        text NOT NULL,
  provider_receipt     jsonb,
  after_state          jsonb,
  state_diff           jsonb,
  verification_outcome text NOT NULL CHECK (verification_outcome IN ('SUCCESS', 'PARTIAL', 'FAILED', 'UNKNOWN')),
  recovery_available   boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX infra_executions_lookup_idx ON infra_executions (tenant_id, target, created_at DESC);
CREATE UNIQUE INDEX infra_executions_idempotency_idx ON infra_executions (tenant_id, idempotency_key);

-- Recovery peker nå TILBAKE til den opprinnelige mutasjonen den gjenoppretter
-- (byggeordrens §K: "recovery references original execution") - additiv,
-- nullable (eksisterende github.delete_branch-recovery-rader fra D-104
-- forblir NULL her, uendret oppførsel).
ALTER TABLE infra_recovery_actions ADD COLUMN recovery_of_execution_id text REFERENCES infra_executions (execution_id) ON DELETE SET NULL;

GRANT SELECT, INSERT, UPDATE ON incident_diagnoses TO jarvis_app;
GRANT SELECT, INSERT, DELETE ON incident_diagnosis_evidence TO jarvis_app;
-- Q-20 (samme begrunnelse som incidents/incident_evidence i 036): diagnose er
-- hendelsesinnhold i en memory space, IKKE append-only systemrevisjon.
GRANT DELETE ON incident_diagnoses TO jarvis_app;
-- Ren infra-audit (samme klasse som deployments/infra_recovery_actions/
-- tool_executions) - IKKE del av Q-20-erasure-planen, INGEN DELETE-grant.
GRANT SELECT, INSERT ON infra_executions TO jarvis_app;
-- Del F (DB-korrelasjon): `schema_migrations` opprettes av admin-rollen
-- (migrator.ts, uendret) - `jarvis_app` mangler ellers SELECT-privilegium
-- (Postgres-standard: kun eier/superbruker). Systemskjema, INGEN tenant_id,
-- INGEN RLS - kun migrasjonsnavn/tidspunkt, aldri forretningsdata.
GRANT SELECT ON schema_migrations TO jarvis_app;

ALTER TABLE incident_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_diagnoses FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_diagnoses_tenant ON incident_diagnoses
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY incident_diagnoses_space ON incident_diagnoses AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Lenketabellen har INGEN egen tenant_id (samme mønster som
-- incident_repair_tasks ville hatt uten sin egen - her arves isolasjon via
-- JOIN mot incident_diagnoses/incident_evidence i ALL applikasjonskode, men
-- vi legger likevel RLS på for defense-in-depth mot en fremtidig rå spørring).
ALTER TABLE incident_diagnosis_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_diagnosis_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_diagnosis_evidence_tenant ON incident_diagnosis_evidence
  USING (diagnosis_id IN (SELECT diagnosis_id FROM incident_diagnoses WHERE tenant_id = current_setting('jarvis.tenant_id', true)))
  WITH CHECK (diagnosis_id IN (SELECT diagnosis_id FROM incident_diagnoses WHERE tenant_id = current_setting('jarvis.tenant_id', true)));

ALTER TABLE infra_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY infra_executions_tenant ON infra_executions
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
