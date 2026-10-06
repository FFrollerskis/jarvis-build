import type { BudgetCaps, EvChangeClass } from "../constitution.ts";
import { classRank } from "./common.ts";

/**
 * EV-8 (Evolution Masterplan v1.2 kap. 15): Shadow, Canary, Deploy & Rollback - BESLUTNINGSREGLENE (rene funksjoner). Selve
 * shadow-/staging-/canary-infrastrukturen og last-known-good-lagring er DEFERRED (krever staging og offsite). Denne porten avgjør KUN om en
 * utrulling får gå videre, må vente, eller må rulles tilbake - og kan aldri løsne eierens signerte budsjett.
 */
export type ReleaseStage = "shadow" | "staging" | "canary" | "full";
export type ChangeKind = "code" | "prompt" | "personality" | "routing" | "config";

export interface SystemSignals {
  incident_open: boolean;
  /** Observerbarhet (SLO-/drift-måling) tilgjengelig? Uten den fryses endringer. */
  observability_ok: boolean;
  /** Antall SLO-brudd akkurat nå. */
  slo_breaches: number;
  kill_switch_active: boolean;
}

export interface DeployUsage {
  deploys_today: number;
  auto_merges_today: number;
}

export interface FreezeVerdict {
  frozen: boolean;
  reasons: string[];
}

/** Change freeze: ustabilt system, hendelse, mangler observerbarhet eller kill switch. */
export function changeFreeze(s: SystemSignals): FreezeVerdict {
  const reasons: string[] = [];
  if (s.kill_switch_active) reasons.push("kill_switch_active");
  if (s.incident_open) reasons.push("incident_open");
  if (!s.observability_ok) reasons.push("observability_missing");
  if (s.slo_breaches > 0) reasons.push("slo_breached");
  return { frozen: reasons.length > 0, reasons };
}

export interface ReleaseRequest {
  change_class: EvChangeClass;
  kind: ChangeKind;
  stage: ReleaseStage;
  owner_approved: boolean;
  /** Er en last-known-good (image/config) lagret lokalt (og off-site der det finnes)? */
  last_known_good_stored: boolean;
  signals: SystemSignals;
  usage: DeployUsage;
  budget: Pick<BudgetCaps, "max_deploys_per_day" | "max_auto_merges_per_day">;
  /** Har kandidaten bestått eval-porten (EV-4) og uavhengig review? */
  evals_passed: boolean;
  independent_review: boolean;
}

export interface ReleaseVerdict {
  allowed: boolean;
  /** Neste lovlige trinn (shadow -> staging -> canary -> full). */
  next_stage: ReleaseStage | null;
  needs_canary: boolean;
  reasons: string[];
}

const NEXT: Record<ReleaseStage, ReleaseStage | null> = { shadow: "staging", staging: "canary", canary: "full", full: null };

export function decideRelease(r: ReleaseRequest): ReleaseVerdict {
  const reasons: string[] = [];
  if (r.change_class === "E3") reasons.push("e3_forbidden");
  const freeze = changeFreeze(r.signals);
  if (freeze.frozen) reasons.push(...freeze.reasons.map((x) => `freeze:${x}`));
  if (r.usage.deploys_today >= r.budget.max_deploys_per_day) reasons.push("deploy_budget_exhausted");
  if (r.change_class === "E1" && r.usage.auto_merges_today >= r.budget.max_auto_merges_per_day) reasons.push("auto_merge_budget_exhausted");
  if (!r.evals_passed) reasons.push("evals_not_passed");
  if (r.change_class !== "E0" && !r.independent_review) reasons.push("independent_review_missing");
  if (classRank(r.change_class) >= classRank("E2") && !r.owner_approved) reasons.push("owner_approval_missing");
  if (!r.last_known_good_stored) reasons.push("last_known_good_missing");
  // Prompt-, personlighets- og ruting-endringer er minst E1 og MÅ gjennom canary før full utrulling.
  const needs_canary = r.kind === "prompt" || r.kind === "personality" || r.kind === "routing" || r.change_class !== "E0";
  if (r.kind !== "code" && r.kind !== "config" && r.change_class === "E0") reasons.push("kind_requires_at_least_e1");
  const next = NEXT[r.stage];
  return { allowed: reasons.length === 0, next_stage: reasons.length === 0 ? next : null, needs_canary, reasons };
}

export interface RollbackSignals {
  eval_regression: boolean;
  error_rate: number;
  baseline_error_rate: number;
  latency_p95_ms: number;
  baseline_latency_p95_ms: number;
  cost_per_task_ore: number;
  baseline_cost_per_task_ore: number;
  data_quality_breach: boolean;
  security_alarm: boolean;
}

export interface RollbackVerdict {
  rollback: boolean;
  reasons: string[];
}

/** Automatisk tilbakerulling: eval-regresjon, feilspike, latens-brudd, kostspike, dataskvalitetsbrudd eller sikkerhetsalarm. */
export function shouldRollback(s: RollbackSignals): RollbackVerdict {
  const reasons: string[] = [];
  if (s.eval_regression) reasons.push("eval_regression");
  if (s.error_rate > Math.max(0.05, s.baseline_error_rate * 2)) reasons.push("error_spike");
  if (s.baseline_latency_p95_ms > 0 && s.latency_p95_ms > s.baseline_latency_p95_ms * 1.5) reasons.push("latency_breach");
  if (s.baseline_cost_per_task_ore > 0 && s.cost_per_task_ore > s.baseline_cost_per_task_ore * 2) reasons.push("cost_spike");
  if (s.data_quality_breach) reasons.push("data_quality_breach");
  if (s.security_alarm) reasons.push("security_alarm");
  return { rollback: reasons.length > 0, reasons };
}
