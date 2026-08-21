/**
 * UA-5 Production Operations Control Plane v1 (D-104). Jarvis EIER selv
 * incident-domenemodellen (JARVIS_CANONICAL, D-64) - ZERO leverandør-
 * spesifikke felter her (kun generiske `source_type`/`source_ref`-pekere,
 * samme pointer-not-payload-prinsipp som `support`/`business`).
 */

export type IncidentStatus = "open" | "diagnosing" | "repair_proposed" | "repair_in_progress" | "resolved" | "wont_fix";
export type IncidentSeverity = "low" | "normal" | "high" | "critical";

/** Q-26-stil bevis-status - INGEN LLM-gjetning noensinne etablert som VERIFIED stille. */
export type EvidenceStatus = "UNVERIFIED" | "PROVISIONAL" | "VERIFIED";

export type EvidenceSourceType =
  | "uptime"
  | "application_error"
  | "deployment"
  | "commit"
  | "infra_change"
  | "database_state"
  | "log"
  | "manual";

export interface Incident {
  incident_id: string;
  tenant_id: string;
  memory_space_id: string;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  owner_person_id: string | null;
  opened_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateIncidentInput {
  title: string;
  severity?: IncidentSeverity;
  owner_person_id?: string;
}

export interface IncidentEvidence {
  evidence_id: string;
  tenant_id: string;
  memory_space_id: string;
  incident_id: string;
  source_type: EvidenceSourceType;
  status: EvidenceStatus;
  source_ref: string | null;
  /** Kort, allerede strukturert sammendrag - ALDRI full loggtekst/payload (pointer-not-payload). */
  summary: string;
  observed_at: string;
  captured_at: string;
  contradicts_evidence_id: string | null;
  created_at: string;
}

export interface AddEvidenceInput {
  source_type: EvidenceSourceType;
  status?: EvidenceStatus;
  source_ref?: string;
  summary: string;
  observed_at: string;
  /** Sett eksplisitt når dette beviset motsier et TIDLIGERE bevis - ALDRI stille overskrevet. */
  contradicts_evidence_id?: string;
}

export type DeploymentStatus = "success" | "failure" | "in_progress" | "cancelled";
export type DeploymentSource = "github_actions" | "manual";

export interface Deployment {
  deployment_id: string;
  tenant_id: string;
  source: DeploymentSource;
  repo: string;
  commit_sha: string;
  ref: string | null;
  workflow_run_id: string | null;
  status: DeploymentStatus;
  deployed_at: string;
  ingested_at: string;
}

/**
 * Normalisert deploy-registrering - INPUT er data allerede hentet via den
 * EKSISTERENDE `github.get_workflow_run`/`get_commit`-ToolGateway-veien
 * (denne modulen gjør ALDRI et eget HTTP-kall selv - se D-104-audit).
 */
export interface RecordDeploymentInput {
  source: DeploymentSource;
  repo: string;
  commit_sha: string;
  ref?: string;
  workflow_run_id?: string;
  status: DeploymentStatus;
  deployed_at: string;
}

export interface CorrelationResult {
  incident: Incident;
  evidence: IncidentEvidence[];
  /** Alle evidence-rader som EKSPLISITT motsier en annen rad (contradicts_evidence_id-kjeder), aldri skjult. */
  contradictions: IncidentEvidence[];
  /** Nyeste deploy for repoet FØR hendelsens første observerte bevis-tidspunkt - mistenkt utløsende deploy, eller null hvis ingen finnes i vinduet. */
  suspect_deployment: Deployment | null;
  /** Nyeste deploy for repoet uavhengig av tidsvindu - "hva er live nå", eller null hvis ingen registrert. */
  active_deployment: Deployment | null;
}

export type RecoveryStatus = "SUCCESS" | "PARTIAL" | "FAILED" | "UNKNOWN";

export interface InfraRecoveryAction {
  recovery_id: string;
  tenant_id: string;
  tool_id: string;
  action: string;
  idempotency_key: string;
  incident_id: string | null;
  recovery_strategy: string;
  status: RecoveryStatus;
  recovery_result: Record<string, unknown>;
  attempted_at: string;
  created_at: string;
}
