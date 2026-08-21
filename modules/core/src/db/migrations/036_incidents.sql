-- UA-5 Production Operations Control Plane v1 (D-104): JARVIS_CANONICAL
-- hendelses-/driftsmodell (D-64-porten kjørt FØRST - se DECISIONS_AND_
-- ASSUMPTIONS.md D-104). Jarvis EIER selv incident-domenemodellen,
-- korrelasjonslogikken, before/after/recovery-evidensen og audit-linkingen;
-- eksterne leverandører (GitHub - den ENESTE med en ekte transport i dag)
-- forblir rene kilder/utførelsesleverandører (EXTERNAL_CANONICAL, Jarvis-
-- normaliserte pekere - ALDRI rå payload lagret her, kun `source_ref`/
-- `summary`, samme pointer-not-payload-prinsipp som `support`/`business`).
-- Samme RLS-/GRANT-/idempotens-mønster som `019_business.sql`/
-- `024_support.sql` - ingen ny sikkerhetsmodell.

-- Kanonisk "hva er live i produksjon"-tilstand (D-64: eksisterer IKKE i
-- repoet fra før - GCP/Cloudflare/Sentry/Vercel-deploy-sporing er ALLE
-- fraværende, se D-104-audit). Ingested fra EKSISTERENDE `github.
-- get_workflow_run`/`get_commit` (ToolGateway, allerede live) - denne
-- tabellen NORMALISERER kun, gjør ALDRI et eget HTTP-kall selv.
CREATE TABLE deployments (
  deployment_id     text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  source            text NOT NULL DEFAULT 'github_actions' CHECK (source IN ('github_actions', 'manual')),
  repo              text NOT NULL,
  commit_sha        text NOT NULL,
  ref               text,
  workflow_run_id   text,
  status            text NOT NULL CHECK (status IN ('success', 'failure', 'in_progress', 'cancelled')),
  deployed_at       timestamptz NOT NULL,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  -- Idempotent ingestion (samme mønster som business_activities): gjentatt
  -- ingestion av SAMME workflow_run gir INGEN duplikat. NULL workflow_run_id
  -- (manuelle deploy-registreringer) deltar ALDRI i denne unikheten.
  UNIQUE (tenant_id, source, repo, workflow_run_id)
);
CREATE INDEX deployments_lookup_idx ON deployments (tenant_id, repo, deployed_at DESC);

CREATE TABLE incidents (
  incident_id       text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  title             text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'diagnosing', 'repair_proposed', 'repair_in_progress', 'resolved', 'wont_fix')),
  severity          text NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high', 'critical')),
  owner_person_id   text REFERENCES people (person_id),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_lookup_idx ON incidents (tenant_id, memory_space_id, status);

-- Q-26-stil bevis-status (UNVERIFIED/PROVISIONAL/VERIFIED) - INGEN LLM-
-- gjetning noensinne etablert som VERIFIED stille. `source_ref` er en
-- POINTER (deployment_id/commit sha/ekstern feil-id/...), ALDRI rå
-- payload/full loggtekst - `summary` er BEVISST lengdebegrenset (samme
-- "kort, allerede strukturert" prinsipp som support_ticket_events).
-- `contradicts_evidence_id` bevarer motstridende bevis EKSPLISITT i stedet
-- for å stille overskrive - se IncidentService.addEvidence().
CREATE TABLE incident_evidence (
  evidence_id             text PRIMARY KEY,
  tenant_id               text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id         text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  incident_id             text NOT NULL REFERENCES incidents (incident_id),
  source_type             text NOT NULL CHECK (source_type IN ('uptime', 'application_error', 'deployment', 'commit', 'infra_change', 'database_state', 'log', 'manual')),
  status                  text NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED', 'PROVISIONAL', 'VERIFIED')),
  source_ref              text,
  summary                 text NOT NULL CHECK (char_length(summary) <= 2000),
  observed_at             timestamptz NOT NULL,
  captured_at             timestamptz NOT NULL DEFAULT now(),
  contradicts_evidence_id text REFERENCES incident_evidence (evidence_id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_evidence_timeline_idx ON incident_evidence (tenant_id, incident_id, observed_at DESC);

-- Ren lenke-tabell: hendelse -> jobb sendt inn via DEN EKSISTERENDE
-- `TaskService.submit()` (D-102/D-103-pipelinen, 100% uendret - se
-- IncidentService.proposeRepairTask()). `ON DELETE CASCADE`: en lenkerad
-- bærer INGEN eget innhold (kun to id-er) - når foreldre-hendelsen erases
-- (Q-20) forsvinner lenken naturlig med den, selve `tasks`-raden/
-- artefaktene styres av tasks sin EGEN, atskilte levetid.
CREATE TABLE incident_repair_tasks (
  incident_id  text NOT NULL REFERENCES incidents (incident_id) ON DELETE CASCADE,
  task_id      text NOT NULL REFERENCES tasks (task_id),
  tenant_id    text NOT NULL REFERENCES tenants (tenant_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, task_id)
);
CREATE INDEX incident_repair_tasks_task_idx ON incident_repair_tasks (task_id);

-- Recovery-utfall for en tidligere UTFØRT ToolGateway-mutasjon (identifisert
-- via SAMME (tenant_id, idempotency_key) som `tool_executions` - IKKE en ny
-- before/after-mekanisme, kun det EKSPLISITTE recovery-FORSØKETS resultat.
-- Ren infra-audit (samme klasse som `tool_executions`/`audit_events`) -
-- IKKE del av Q-20 memory-space-erasure-planen (INGEN memory_space_id,
-- INGEN DELETE-grant under) - overlever bevisst en incident-erasure, derfor
-- `ON DELETE SET NULL` på den valgfrie incident_id-referansen (aldri
-- RESTRICT, som ville blokkert en ellers gyldig incident-erasure).
CREATE TABLE infra_recovery_actions (
  recovery_id        text PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants (tenant_id),
  tool_id            text NOT NULL,
  action             text NOT NULL,
  idempotency_key    text NOT NULL,
  incident_id        text REFERENCES incidents (incident_id) ON DELETE SET NULL,
  recovery_strategy  text NOT NULL,
  status             text NOT NULL CHECK (status IN ('SUCCESS', 'PARTIAL', 'FAILED', 'UNKNOWN')),
  recovery_result    jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempted_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX infra_recovery_actions_lookup_idx ON infra_recovery_actions (tenant_id, tool_id, action, idempotency_key);

GRANT SELECT, INSERT, UPDATE ON deployments TO jarvis_app;
GRANT SELECT, INSERT, UPDATE ON incidents, incident_evidence TO jarvis_app;
-- `incident_repair_tasks` trenger DELETE (ikke bare SELECT/INSERT) selv om
-- applikasjonskoden ALDRI sletter direkte fra den - `ON DELETE CASCADE`
-- fra `incidents` KREVER at rollen som utfører foreldre-DELETE-en også har
-- DELETE-privilegium på child-tabellen, ellers feiler cascaden.
GRANT SELECT, INSERT, DELETE ON incident_repair_tasks TO jarvis_app;
GRANT SELECT, INSERT ON infra_recovery_actions TO jarvis_app;
-- Q-20 (samme begrunnelse som `024_support.sql`): incidents/incident_evidence
-- er hendelses-/bevisinnhold i en memory space, IKKE append-only
-- systemrevisjon - registrert i `modules/erasure/src/plan.ts`. Uten denne
-- GRANTen ville ErasureService sin faktiske `DELETE FROM incidents/...`
-- feile med permission denied for HELE tenant-/space-erasure-operasjonen.
GRANT DELETE ON incidents, incident_evidence TO jarvis_app;

ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments FORCE ROW LEVEL SECURITY;
CREATE POLICY deployments_tenant ON deployments
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_tenant ON incidents
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY incidents_space ON incidents AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE incident_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_evidence_tenant ON incident_evidence
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY incident_evidence_space ON incident_evidence AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE incident_repair_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_repair_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_repair_tasks_tenant ON incident_repair_tasks
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));

ALTER TABLE infra_recovery_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra_recovery_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY infra_recovery_actions_tenant ON infra_recovery_actions
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
