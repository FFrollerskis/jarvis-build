/**
 * WP-E1 (UA-5, JARVIS-068): ÉN lesbar driftsstatus for eieren - åpne hendelser (fase, alvorlighet, sannhetsmerking, siste endring), tilkoblede skymål (helse + siste journalførte endring) og
 * hendelsesprodusentenes egen helse. Kun lesing, ingen hemmeligheter, intet hendelsesinnhold (bevistekst og credential-verdier forlater aldri databasen/hvelvet). Det som ikke kan måles står som
 * `unknown`/`not_measured` - aldri som «frisk».
 */
export type InfraTargetId = "cloudflare" | "vercel" | "gcp" | "docker" | "langfuse" | "infisical" | "postgres";

export interface InfraTargetDef {
  id: InfraTargetId;
  label: string;
  /** Verktøy-id i registeret (nøkkel i `ToolGateway.health` og `infra_executions.tool_id`). */
  tool_id: string;
}

/** De kontrollerte skymålene i UA-5 (masterplan v4.0 linje 487-507). */
export const INFRA_TARGETS: readonly InfraTargetDef[] = [
  { id: "cloudflare", label: "Cloudflare (DNS/WAF)", tool_id: "cloudflare" },
  { id: "vercel", label: "Vercel", tool_id: "vercel" },
  { id: "gcp", label: "Google Cloud (Compute Engine)", tool_id: "gce" },
  { id: "docker", label: "Docker (NAS)", tool_id: "docker" },
  { id: "langfuse", label: "Langfuse (sporing)", tool_id: "langfuse" },
  { id: "infisical", label: "Infisical (hemmeligheter)", tool_id: "infisical" },
  { id: "postgres", label: "Postgres-drift", tool_id: "postgres_ops" }
];

export type InfraTargetState = "ok" | "degraded" | "down" | "dormant" | "unknown";

export interface InfraTargetStatus {
  id: InfraTargetId;
  label: string;
  state: InfraTargetState;
  /** Er verktøyet registrert i denne prosessen? */
  registered: boolean;
  /** Alle credential-referanser satt (presence, aldri verdi). `null` = kunne ikke avgjøres. */
  configured: boolean | null;
  health: { state: string; at: string } | null;
  /** Siste JOURNALFØRTE endring (`infra_executions`) mot målet. `null` = ingen funnet (eller ikke målt, se `not_measured`). */
  last_change: { at: string; action: string; outcome: "SUCCESS" | "PARTIAL" | "FAILED" | "UNKNOWN" } | null;
  note_no: string;
}

export interface InfraIncidentItem {
  incident_id: string;
  title: string;
  severity: "low" | "normal" | "high" | "critical";
  source_kind: string;
  phase: string;
  phase_no: string;
  opened_at: string;
  last_seen_at: string | null;
  occurrence_count: number;
  last_change: { at: string; actor_kind: string; to_phase_no: string } | null;
  /** Antall bevis per sannhetsgrad: bekreftet (VERIFIED) / observert, ikke bekreftet (PROVISIONAL) / påstått (UNVERIFIED). */
  evidence: { verified: number; observed: number; claimed: number };
}

export interface InfraProducerRun {
  producer: string;
  last_status: string;
  last_started_at: string;
  consecutive_failures: number;
  opened: number;
  updated: number;
  resolved: number;
  suppressed: number;
  last_error: string | null;
}

/** Det kilden (databasen) leverer. Hver del kan feile for seg: `null` + en grunn i `errors`. */
export interface InfraMeasurements {
  incidents: { active: InfraIncidentItem[]; active_total: number; by_phase: Record<string, number>; resolved_last_7d: number } | null;
  /** tool_id -> siste journalførte endring. */
  last_changes: Record<string, { at: string; action: string; outcome: "SUCCESS" | "PARTIAL" | "FAILED" | "UNKNOWN" }> | null;
  producer_runs: InfraProducerRun[] | null;
  errors: string[];
}

export interface InfraStatusSource {
  measure(tenantId: string): Promise<InfraMeasurements>;
}

export interface InfraProducerStatus {
  producer: string;
  state: "ok" | "failed" | "skipped" | "stale" | "never_ran" | "disabled";
  last_started_at: string | null;
  age_s: number | null;
  consecutive_failures: number;
  opened: number;
  resolved: number;
  last_error: string | null;
}

export interface InfraStatusReport {
  as_of: string;
  /** Kan systemet selv oppdage hendelser? `false` = produsentene er AV, og «ingen åpne hendelser» betyr kun «ingen manuelt registrert». */
  auto_detection: boolean;
  infra_mode: string | null;
  incidents: { active: InfraIncidentItem[]; active_total: number; truncated: boolean; by_phase: Record<string, number>; resolved_last_7d: number } | null;
  targets: InfraTargetStatus[];
  producers: InfraProducerStatus[];
  /** Hva som ikke er målt (aldri stille utelatt). */
  not_measured: string[];
  /** Deterministisk norsk oppsummering (ingen LLM). */
  summary_no: string;
}
