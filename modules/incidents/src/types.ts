/**
 * UA-5 Production Operations Control Plane v1 (D-104). Jarvis EIER selv
 * incident-domenemodellen (JARVIS_CANONICAL, D-64) - ZERO leverandør-
 * spesifikke felter her (kun generiske `source_type`/`source_ref`-pekere,
 * samme pointer-not-payload-prinsipp som `support`/`business`).
 */
import type { JsonValue } from "@jarvis/contracts";

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
  | "manual"
  // WP-E1 (JARVIS-068): kilder for de deterministiske produsentene.
  | "health_check"
  | "scheduler_job"
  | "slo_breach"
  | "infra_execution";

/**
 * WP-E1 (JARVIS-068): SANNHETSTYPE-REGIME. `asserted_by` sier HVEM som la fram beviset (eier/produsent/kontroll/modell); `verified_by` + `verification_basis` + `verified_at` sier HVA som gjorde det
 * VERIFIED. Avsenderen kan aldri selv sette VERIFIED - se `truth.ts` (tjeneste) og migrasjon 097 (CHECK/trigger).
 */
export type EvidenceAssertedBy = "owner" | "producer" | "check" | "model";
export type EvidenceVerifiedBy = "correlation_deployment_match" | "source_recheck" | "independent_probe";

/** WP-E1: hvem/hva som åpnet hendelsen. `manual` = eieren (`/incidents/create`); øvrige er deterministiske produsenter (se `producers/`). */
export type IncidentSourceKind = "manual" | "watchdog" | "scheduler" | "deployment" | "sentry" | "slo" | "provider" | "infra_execution";

/** De deterministiske produsentene (= alle kilder unntatt `manual`). Samme mengde som CHECK på `incident_producer_runs.producer` (migrasjon 098). */
export type IncidentProducerName = Exclude<IncidentSourceKind, "manual">;
export const INCIDENT_PRODUCER_NAMES: readonly IncidentProducerName[] = ["scheduler", "deployment", "sentry", "slo", "provider", "infra_execution", "watchdog"];

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

/**
 * WP-E1: hendelsen slik den ligger i databasen etter migrasjon 096. `Incident` er den smale, stabile kontrakten (situasjonsmotorens infra-bro og dens tester avhenger av den og er uendret);
 * `IncidentRecord` legger til produsent-/dedupe-/korrelasjonsfeltene.
 */
export interface IncidentRecord extends Incident {
  source_kind: IncidentSourceKind;
  dedupe_key: string | null;
  correlation_id: string | null;
  occurrence_count: number;
  last_seen_at: string | null;
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
  /** WP-E1: hvem la fram beviset (eier/produsent/kontroll/modell). */
  asserted_by: EvidenceAssertedBy;
  /** WP-E1: hva som gjorde beviset VERIFIED (kun satt når `status === "VERIFIED"`). */
  verified_by: EvidenceVerifiedBy | null;
  verification_basis: string | null;
  verified_at: string | null;
}

export interface AddEvidenceInput {
  source_type: EvidenceSourceType;
  /** WP-E1: kun `UNVERIFIED`/`PROVISIONAL` kan oppgis (og modellskrevet bevis kun `UNVERIFIED`) - `VERIFIED` kastes (`TruthRegimeError`); bruk `verifyEvidence()` med et deterministisk grunnlag. */
  status?: EvidenceStatus;
  /** WP-E1: standard `owner`. Produsentene bruker `producer`/`check`; `model` låser beviset til `UNVERIFIED`. */
  asserted_by?: EvidenceAssertedBy;
  source_ref?: string;
  summary: string;
  observed_at: string;
  /** Sett eksplisitt når dette beviset motsier et TIDLIGERE bevis - ALDRI stille overskrevet. */
  contradicts_evidence_id?: string;
}

export type DeploymentStatus = "success" | "failure" | "in_progress" | "cancelled";
/** D-105: `docker_redeploy` lagt til - se `executeInfraMutation()`/037-migrasjonen. */
export type DeploymentSource = "github_actions" | "manual" | "docker_redeploy";

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
  incident: IncidentRecord;
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
  /** D-105: peker TILBAKE til den opprinnelige mutasjonen denne raden forsøker å gjenopprette - null for D-104-æra recovery-rader (github.delete_branch har ingen forutgående executeInfraMutation()-rad). */
  recovery_of_execution_id: string | null;
  attempted_at: string;
  created_at: string;
}

/**
 * D-105 Part G: diagnose er en KONKLUSJON, ATSKILT fra rå `IncidentEvidence`.
 * `source` skiller MELLOM en deterministisk (kode-utledet), modell-assistert
 * (LLM-hypotese - status starter ALLTID UNVERIFIED, ALDRI auto-forfremmet),
 * eller eier-satt konklusjon. `supersedes_diagnosis_id` bevarer en motsagt
 * diagnose UENDRET (se incident_diagnoses-tabellen i 037-migrasjonen).
 */
export type DiagnosisSource = "deterministic" | "model_assisted" | "owner";

export interface IncidentDiagnosis {
  diagnosis_id: string;
  tenant_id: string;
  memory_space_id: string;
  incident_id: string;
  conclusion: string;
  status: EvidenceStatus;
  source: DiagnosisSource;
  supersedes_diagnosis_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDiagnosisInput {
  conclusion: string;
  status?: EvidenceStatus;
  source: DiagnosisSource;
  supersedes_diagnosis_id?: string;
  supporting_evidence_ids?: string[];
  contradicting_evidence_ids?: string[];
}

export type InfraRiskClass = "A" | "B" | "C" | "D";
export type InfraOperationalOutcome = "SUCCESS" | "PARTIAL" | "FAILED" | "UNKNOWN";

/**
 * D-105 Part H: sammenhengende kritisk infra-eksekusjonsjournal - APPEND-ONLY
 * (hele BEFORE->MUTASJON->AFTER->DIFF->UTFALL-sekvensen fullføres FØR
 * innsetting, se `executeInfraMutation()`). Sitter VED SIDEN AV den
 * eksisterende, uendrede `tool_executions` (D-104-pipelinen) - IKKE en
 * erstatning.
 */
export interface InfraExecution {
  execution_id: string;
  tenant_id: string;
  person_id: string | null;
  device_id: string | null;
  target: string;
  provider: string;
  tool_id: string;
  action: string;
  risk_class: InfraRiskClass;
  authority_mode: string | null;
  incident_id: string | null;
  idempotency_key: string;
  requested_operation: string;
  requested_state: Record<string, unknown>;
  before_state: JsonValue | null;
  recovery_plan: string;
  provider_receipt: JsonValue | null;
  after_state: JsonValue | null;
  state_diff: JsonValue | null;
  verification_outcome: InfraOperationalOutcome;
  recovery_available: boolean;
  created_at: string;
}

/**
 * WP-E1 (JARVIS-068): hvem som utførte en statusovergang. `owner` bærer alltid personen; `producer`/`repair`/`system` bærer aldri en person (en produsent kan ikke utgi seg for å være eieren -
 * håndheves både her og av CHECK i migrasjon 096).
 */
export type IncidentActor =
  | { kind: "owner"; person_id: string }
  | { kind: "producer" }
  | { kind: "repair" }
  | { kind: "system" };

export interface IncidentTransition {
  transition_id: string;
  tenant_id: string;
  memory_space_id: string;
  incident_id: string;
  /** `null` = opprettelsesraden. */
  from_status: IncidentStatus | null;
  to_status: IncidentStatus;
  actor_kind: IncidentActor["kind"];
  actor_person_id: string | null;
  reason: string;
  /** Peker (evidens-/diagnose-/eksekusjons-/jobb-id) - aldri innhold. */
  evidence_ref: string | null;
  occurred_at: string;
}

export interface TransitionOptions {
  /** Kort, menneskelig årsak (1-500 tegn, redigert for hemmeligheter før lagring). PÅKREVD - en overgang uten årsak er ikke etterprøvbar. */
  reason: string;
  /** Peker til beviset/jobben overgangen bygger på. En PRODUSENT som løser en hendelse MÅ peke på et VERIFIED bevis for samme hendelse. */
  evidence_ref?: string;
}

/**
 * WP-E1 (JARVIS-068): ET deterministisk faktum en produsent har OBSERVERT (aldri en modellpåstand). `subject` er en SANERT identifikator (jobbnavn, repo@gren, SLO-id, connector-id,
 * sjekknavn, eksekusjons-id) - aldri innhold. Fingeravtrykket blir `<source_kind>:<subject>`; samme faktum gir derfor aldri to aktive hendelser.
 */
export interface IncidentFact {
  source_kind: IncidentProducerName;
  subject: string;
  /** Kort, MALBASERT tittel (aldri rå tekst fra en ekstern kilde). */
  title: string;
  severity: IncidentSeverity;
  observed_at: string;
  evidence: {
    source_type: EvidenceSourceType;
    source_ref?: string;
    summary: string;
    /** `PROVISIONAL` (standard) = observert av deterministisk kode fra en Jarvis-intern kilde; `UNVERIFIED` for alt som er en ekstern kildes påstand (Sentry). Aldri `VERIFIED`. */
    status?: "UNVERIFIED" | "PROVISIONAL";
  };
}

export type OpenFromFactResult =
  | { action: "opened"; incident: IncidentRecord }
  /** Det finnes allerede en aktiv hendelse for fingeravtrykket: antall/sist sett/evt. alvorlighet er oppdatert, nytt bevis lagt til hvis det er nytt. */
  | { action: "updated"; incident: IncidentRecord }
  /** Nylig LØST hendelse med samme fingeravtrykk: regresjon, gjenåpnet (ny overgangsrad). */
  | { action: "reopened"; incident: IncidentRecord }
  /** Ingenting registrert: eieren har lukket hendelsen uten tiltak nylig (demping), eller taket for aktive produsent-hendelser er nådd. */
  | { action: "suppressed"; reason: "owner_wont_fix_mute" | "active_cap_reached" };

/** Dokumentert tak og vinduer for produsentene (konstanter, ikke miljøvariabler: de er sikkerhetsgrenser, ikke tuning). */
export const PRODUCER_LIMITS = {
  /** Maks AKTIVE hendelser per produsent og tenant - en støyende/kompromittert kilde kan ikke fylle tabellen. */
  max_active_per_producer: 25,
  /** Maks bevisrader en produsent legger til per hendelse (gjentatte målinger øker `occurrence_count`, ikke bevismengden). */
  max_evidence_per_incident: 50,
  /** En LØST hendelse gjenåpnes (regresjon) hvis samme faktum observeres innen dette vinduet - ellers åpnes en ny hendelse. */
  reopen_window_hours: 24,
  /** En hendelse eieren har lukket uten tiltak (`wont_fix`) demper samme faktum så lenge. */
  owner_mute_days: 7
} as const;
