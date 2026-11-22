import { z } from "zod";

/**
 * UA-11 Executive Mode "K2" (D-64): provider-nøytral, JARVIS_CANONICAL
 * kontrakt for de fire genuint nye masterplan-entitetstypene - se
 * `modules/core/src/db/migrations/059_governance.sql` sitt filhode for
 * full begrunnelsen (inkl. hvorfor "delegation board" BEVISST IKKE er en
 * femte tabell her). Ren journalførings-/tilstandspakke - INGEN klasse D-
 * handlings-claim-maskineri (se `service.ts`), INGEN modell-assistert
 * vurdering (samme "ingen ModelGateway-avhengighet ennå"-avgrensning som
 * `@jarvis/situations`/`@jarvis/executive` sine egne P0-slicer).
 */

// ---------------------------------------------------------------------
// WP-H1 (JARVIS-087 del 2): proveniens på journalradene (migrasjon 102)
// ---------------------------------------------------------------------

/**
 * Hvem som skrev INNHOLDET i et journalkall: `owner_direct` = trusted kode attesterer at parameterne er eierens egne ord ordrett (hurtigbanen/dashbord-ruten),
 * `model` = en modell formulerte kallet (servingModel satt), `unspecified` = trusted kode uten modell, eller ukjent. `unspecified` er aldri det samme som `owner_direct`.
 */
export type GovernanceProvenanceOrigin = "owner_direct" | "model" | "unspecified";

/** Proveniensen som skrives sammen med journalraden (kun metadata - aldri innhold). Kommer fra den betrodde `ToolInvocationContext`, ALDRI fra parametre. */
export interface GovernanceProvenance {
  channel: string;
  session_id: string;
  /** Jobb-id når sesjonen er en jobbsesjon (`job:<task_id>`), ellers null. */
  task_id: string | null;
  origin: GovernanceProvenanceOrigin;
}

/** Feltene `prov_*` på en journalrad. Alle er null for rader skrevet før migrasjon 102 (eller mens `JARVIS_GOVERNANCE_PROVENANCE` var av). */
export interface GovernanceProvenanceColumns {
  prov_channel?: string | null;
  prov_session_id?: string | null;
  prov_task_id?: string | null;
  prov_origin?: GovernanceProvenanceOrigin | null;
  prov_recorded_at?: string | null;
}

// ---------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------

export const DecisionMakerSchema = z.enum(["owner", "jarvis"]);
export type DecisionMaker = z.infer<typeof DecisionMakerSchema>;

export type DecisionStatus = "proposed" | "decided" | "reversed";

export interface DecisionLogEntry extends GovernanceProvenanceColumns {
  decision_id: string;
  tenant_id: string;
  memory_space_id: string;
  title: string;
  rationale: string;
  decision_maker: DecisionMaker;
  status: DecisionStatus;
  related_situation_id: string | null;
  owner_person_id: string | null;
  decided_at: string;
  reversed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const CreateDecisionInputSchema = z
  .object({
    title: z.string().min(1),
    rationale: z.string().min(1),
    decision_maker: DecisionMakerSchema,
    status: z.enum(["proposed", "decided"]).optional(),
    related_situation_id: z.string().min(1).optional(),
    owner_person_id: z.string().min(1).optional()
  })
  .strict();
export type CreateDecisionInput = z.infer<typeof CreateDecisionInputSchema>;

// ---------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------

export type ScenarioStatus = "draft" | "active" | "archived";

export interface Scenario extends GovernanceProvenanceColumns {
  scenario_id: string;
  tenant_id: string;
  memory_space_id: string;
  title: string;
  assumptions: string;
  projected_outcome: string;
  status: ScenarioStatus;
  owner_person_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const CreateScenarioInputSchema = z
  .object({
    title: z.string().min(1),
    assumptions: z.string().min(1),
    projected_outcome: z.string().min(1),
    owner_person_id: z.string().min(1).optional()
  })
  .strict();
export type CreateScenarioInput = z.infer<typeof CreateScenarioInputSchema>;

export const ScenarioStatusSchema = z.enum(["draft", "active", "archived"]);

// ---------------------------------------------------------------------
// Risk register
// ---------------------------------------------------------------------

export const RiskSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;

export const RiskProbabilitySchema = z.enum(["low", "medium", "high"]);
export type RiskProbability = z.infer<typeof RiskProbabilitySchema>;

export type RiskStatus = "identified" | "mitigating" | "accepted" | "resolved";

export interface Risk extends GovernanceProvenanceColumns {
  risk_id: string;
  tenant_id: string;
  memory_space_id: string;
  title: string;
  description: string;
  severity: RiskSeverity;
  probability: RiskProbability;
  mitigation_plan: string | null;
  status: RiskStatus;
  owner_person_id: string | null;
  created_by: string | null;
  identified_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export const CreateRiskInputSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    severity: RiskSeveritySchema,
    probability: RiskProbabilitySchema,
    mitigation_plan: z.string().min(1).optional(),
    owner_person_id: z.string().min(1).optional()
  })
  .strict();
export type CreateRiskInput = z.infer<typeof CreateRiskInputSchema>;

export const UpdateRiskInputSchema = z
  .object({
    risk_id: z.string().min(1),
    severity: RiskSeveritySchema.optional(),
    probability: RiskProbabilitySchema.optional(),
    mitigation_plan: z.string().min(1).optional(),
    status: z.enum(["identified", "mitigating", "accepted", "resolved"]).optional()
  })
  .strict();
export type UpdateRiskInput = z.infer<typeof UpdateRiskInputSchema>;

// ---------------------------------------------------------------------
// Goals / OKRs
// ---------------------------------------------------------------------

export type GoalStatus = "not_started" | "in_progress" | "at_risk" | "achieved" | "abandoned";

export interface GoalKeyResult extends GovernanceProvenanceColumns {
  key_result_id: string;
  goal_id: string;
  tenant_id: string;
  memory_space_id: string;
  title: string;
  progress_percent: number;
  created_at: string;
  updated_at: string;
}

/** Ett Objective + sine Key Results - ekte OKR-struktur (se 059_governance.sql sitt filhode). */
export interface GoalWithKeyResults extends GovernanceProvenanceColumns {
  goal_id: string;
  tenant_id: string;
  memory_space_id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  target_date: string | null;
  owner_person_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  key_results: GoalKeyResult[];
}

export const CreateGoalInputSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    target_date: z.string().min(1).optional(),
    owner_person_id: z.string().min(1).optional()
  })
  .strict();
export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;

export const GoalStatusSchema = z.enum(["not_started", "in_progress", "at_risk", "achieved", "abandoned"]);

export const AddKeyResultInputSchema = z
  .object({
    goal_id: z.string().min(1),
    title: z.string().min(1)
  })
  .strict();
export type AddKeyResultInput = z.infer<typeof AddKeyResultInputSchema>;
