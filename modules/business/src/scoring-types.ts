/**
 * UA-3 profiling/scoring slice (D-61, akseptansekriterium 4: "Profiling/
 * scoring used with documented legal/human controls where required").
 *
 * Dette er BUSINESS-OPERASJONELL prioritering/risiko-scoring over
 * business_leads/business_opportunities - IKKE generalisert profilering av
 * enkeltmennesker. Scoring-motoren leser ALDRI kontakt-/person-felter (navn,
 * e-post, tittel, demografi) - kun lead-/opportunity-tilstand og tellinger
 * fra aktiviteter/oppfoelginger/open loops Business OS allerede eier (se
 * scoring-rules.ts for den fullstendige, transparente faktor-whitelisten).
 */

export type ScoreEntityType = "lead" | "opportunity";
export type ScoreType = "lead_priority" | "opportunity_risk";
export type ScoreDetectionMethod = "deterministic" | "ai_assisted";
export type EvidenceRefType = "activity" | "followup" | "open_loop";

export interface ScoreFactor {
  code: string;
  label: string;
  weight: number;
  contribution: number;
}

export interface EvidenceRef {
  type: EvidenceRefType;
  id: string;
}

/** Rent, DB-uavhengig beregningsresultat - se scoring-rules.ts. */
export interface ScoreCalculation {
  score: number;
  factors: ScoreFactor[];
  evidence: EvidenceRef[];
}

export interface BusinessScore {
  score_id: string;
  tenant_id: string;
  memory_space_id: string;
  entity_type: ScoreEntityType;
  entity_id: string;
  score_type: ScoreType;
  rule_version: string;
  detection_method: ScoreDetectionMethod;
  score: number;
  factor_summary: ScoreFactor[];
  evidence: EvidenceRef[];
  manual_override: boolean;
  override_score: number | null;
  override_reason: string | null;
  override_by: string | null;
  override_at: string | null;
  calculated_at: string;
  created_at: string;
  updated_at: string;
}

/** effective_score = manual_override ? override_score : score - aldri lagret dobbelt, alltid utledet. */
export interface ScoreExplanation extends BusinessScore {
  effective_score: number;
}

export interface RankedEntity {
  entity_id: string;
  title: string;
  score: number;
  effective_score: number;
  manual_override: boolean;
  top_factors: ScoreFactor[];
}

export interface LeadScoringSignals {
  lead_id: string;
  status: "new" | "contacted" | "qualified" | "disqualified" | "converted";
  has_active_opportunity: boolean;
  has_recent_activity_7d: boolean;
  is_stale_30d: boolean;
  has_open_followup: boolean;
  has_overdue_followup: boolean;
  recent_activity_ids: string[];
  open_followup_ids: string[];
}

export interface OpportunityScoringSignals {
  opportunity_id: string;
  stage: "new" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
  is_stale_14d: boolean;
  has_open_followup: boolean;
  has_overdue_followup: boolean;
  has_stalled_open_loop: boolean;
  overdue_followup_ids: string[];
  stalled_open_loop_ids: string[];
}

export interface ManualOverrideInput {
  override_score: number;
  reason: string;
  actor_person_id?: string;
}
