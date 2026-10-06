import { z } from "zod";
import type { Constitution, EvChangeClass } from "../constitution.ts";
import { EvChangeClassSchema } from "../constitution.ts";
import type { ChangeLedgerInput } from "../change-ledger.ts";
import { FORBIDDEN_CONFIDENCE_BASES, atLeast, classRank, maxClass, sensitiveTouches } from "./common.ts";

/**
 * EV-5 (Evolution Masterplan v1.2 kap. 12): Change Proposal Engine. Jarvis hopper aldri fra «jeg fant noe» til «jeg endret production»; hver
 * endring er et maskinlesbart forslag som Authority Plane kan validere. `validateProposal` er ren og deterministisk: risikoklassen utledes av
 * KODE (konstitusjonen + sensitive stier) og kan aldri være svakere enn det forslagsstilleren hevder; E3 avvises alltid.
 */
export const EvidenceItemSchema = z
  .object({
    kind: z.enum(["log", "eval", "changelog", "issue", "cve", "outcome", "metric"]),
    ref: z.string().min(1).max(500),
    trust: z.enum(["trusted", "untrusted", "quarantined"]),
    /** Kilde-proveniens (URL/tabell/issue-id) - aldri et resonnement fra modellen. */
    provenance: z.string().min(1).max(500)
  })
  .strict();

export const ChangeProposalSchema = z
  .object({
    proposal_id: z.string().min(1).max(200),
    problem: z.object({ statement: z.string().min(10).max(1000), baseline: z.record(z.union([z.string(), z.number()])).refine((b) => Object.keys(b).length > 0, "baseline_required") }).strict(),
    evidence: z.array(EvidenceItemSchema).min(1).max(50),
    primary_source_verified: z.object({ verified: z.boolean(), source_ref: z.string().max(500).optional() }).strict(),
    proposed_change: z
      .object({
        component: z.string().min(1).max(200),
        paths: z.array(z.string().min(1).max(500)).min(1).max(500),
        summary: z.string().min(10).max(1000)
      })
      .strict(),
    /** Forslagsstillerens påstand. Utledet klasse kan heve den, aldri senke den. */
    claimed_class: EvChangeClassSchema,
    confidence_basis: z.array(z.string().min(1).max(100)).min(1).max(10),
    data_impact: z.object({ schema: z.boolean(), retention: z.boolean(), delete: z.boolean(), rls_or_tenant: z.boolean(), migration_plan: z.string().max(1000).optional() }).strict(),
    test_plan: z.array(z.enum(["unit", "integration", "security", "eval", "load", "voice", "physical"])).min(1),
    rollback: z.object({ point: z.string().min(3).max(300), trigger: z.string().min(3).max(300), data_recovery: z.string().min(3).max(300) }).strict(),
    owner_impact: z.object({ credentials: z.boolean(), money: z.boolean(), legal: z.boolean(), physical: z.boolean(), approval: z.boolean() }).strict()
  })
  .strict();
export type ChangeProposal = z.infer<typeof ChangeProposalSchema>;

export type ProposalDecision = "rejected" | "needs_owner" | "accepted_for_review";

export interface ProposalVerdict {
  decision: ProposalDecision;
  effective_class: EvChangeClass;
  derived_class: EvChangeClass;
  reasons: string[];
}

const SENSITIVE_PRIMARY_REQUIRED = (p: ChangeProposal): boolean => {
  const t = sensitiveTouches(p.proposed_change.paths);
  return t.dependencies || t.credentials || t.network || p.evidence.some((e) => e.kind === "cve" || e.kind === "changelog");
};

/**
 * Validerer et forslag. `constitution` leverer klassifiseringen (strengeste av hardkodet policy og signert manifest).
 * Avvist (`rejected`): ugyldig skjema, E3, forbudt confidence-grunnlag, mangler primærkilde for sensitivt forslag, kun karantene-evidens.
 * `needs_owner`: E2 eller eier-påvirkning (credentials/penger/juridisk/fysisk/approval). Ellers `accepted_for_review` (E0/E1): går videre
 * til uavhengig review + CI/evals - aldri direkte til production.
 */
export function validateProposal(raw: unknown, constitution: Pick<Constitution, "classify">): ProposalVerdict | { decision: "rejected"; effective_class: "E3"; derived_class: "E3"; reasons: string[] } {
  const parsed = ChangeProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return { decision: "rejected", effective_class: "E3", derived_class: "E3", reasons: [`invalid_proposal:${parsed.error.issues[0]?.path.join(".") ?? "schema"}:${parsed.error.issues[0]?.message ?? ""}`] };
  }
  const p = parsed.data;
  const reasons: string[] = [];

  let derived = constitution.classify(p.proposed_change.paths);
  const touches = sensitiveTouches(p.proposed_change.paths);
  if (touches.any) derived = atLeast(derived, "E2");
  // Radar-/ekstern evidens er aldri trusted som standard; schema-/retention-/slette-/RLS-påvirkning er minst E2 (migrering).
  if (p.data_impact.schema || p.data_impact.retention || p.data_impact.delete || p.data_impact.rls_or_tenant || touches.migrations) derived = atLeast(derived, "E2");
  const effective = maxClass(derived, p.claimed_class);
  if (classRank(derived) > classRank(p.claimed_class)) reasons.push(`class_raised_by_rules:${p.claimed_class}->${derived}`);

  if (effective === "E3") reasons.push("e3_forbidden_for_evolution_engine");
  const badBasis = p.confidence_basis.filter((b) => FORBIDDEN_CONFIDENCE_BASES.has(b));
  if (badBasis.length > 0) reasons.push(`forbidden_confidence_basis:${badBasis.join(",")}`);
  if (p.evidence.every((e) => e.trust === "quarantined")) reasons.push("evidence_only_quarantined");
  if (SENSITIVE_PRIMARY_REQUIRED(p) && !(p.primary_source_verified.verified && (p.primary_source_verified.source_ref ?? "").length > 0)) reasons.push("primary_source_not_verified");
  if ((p.data_impact.schema || touches.migrations) && (p.data_impact.migration_plan ?? "").trim().length === 0) reasons.push("migration_plan_required");
  if (effective !== "E0" && !p.test_plan.includes("unit") && !p.test_plan.includes("integration")) reasons.push("test_plan_needs_unit_or_integration");
  if (touches.any && !p.test_plan.includes("security")) reasons.push("test_plan_needs_security");

  if (reasons.some((r) => !r.startsWith("class_raised_by_rules"))) {
    return { decision: "rejected", effective_class: effective, derived_class: derived, reasons };
  }
  const ownerTouch = Object.entries(p.owner_impact).filter(([, v]) => v).map(([k]) => k);
  if (effective === "E2" || ownerTouch.length > 0) {
    if (ownerTouch.length > 0) reasons.push(`owner_impact:${ownerTouch.join(",")}`);
    return { decision: "needs_owner", effective_class: effective === "E0" || effective === "E1" ? "E2" : effective, derived_class: derived, reasons };
  }
  return { decision: "accepted_for_review", effective_class: effective, derived_class: derived, reasons };
}

/** Forslaget som en rad i endringsregisteret (`proposed`, eller `blocked` når det avvises). Ingen hemmeligheter; kun metadata. */
export function proposalToLedgerEntry(p: ChangeProposal, verdict: Pick<ProposalVerdict, "decision" | "effective_class" | "reasons">, constitutionDigest: string, recordedBy: string): ChangeLedgerInput {
  return {
    change_id: p.proposal_id,
    change_class: verdict.effective_class,
    decision: verdict.decision === "rejected" ? "blocked" : "proposed",
    constitution_digest: constitutionDigest,
    subject: p.proposed_change.summary.slice(0, 500),
    paths: p.proposed_change.paths,
    branch: "",
    head_sha: null,
    evidence: { verdict: verdict.decision, reasons: verdict.reasons, evidence_refs: p.evidence.map((e) => ({ kind: e.kind, ref: e.ref, trust: e.trust })), confidence_basis: p.confidence_basis },
    recorded_by: recordedBy
  };
}
