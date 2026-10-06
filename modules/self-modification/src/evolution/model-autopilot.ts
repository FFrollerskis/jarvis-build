/**
 * EV-12 (Evolution Masterplan v1.2 kap. 19): Model Autopilot - ruting innen en EIER-GODKJENT allowlist (ren funksjon). Registeret (provider, pris,
 * latens, kontekst, modalitet, verktøybruk, region/personvern, status) er UA-1 sin provider registry; denne koden eier ikke registeret, den
 * leser et utdrag av det. DEFERRED: periodisk benchmark mot representative oppgaver, faktisk fallback-test, kobling til `ModelGateway`.
 */
export type ModelStatus = "candidate" | "shadow" | "active" | "deprecated" | "disabled";
export type ProviderHealth = "ok" | "degraded" | "down";

export interface RegistryModel {
  provider: string;
  model_id: string;
  status: ModelStatus;
  locality: "local" | "cloud";
  price_ore_per_1k_tokens: number;
  latency_p95_ms: number;
  context_tokens: number;
  tool_use: boolean;
  vision: boolean;
  region: string;
}

export interface AutopilotPolicy {
  /** Eier-godkjent allowlist (provider:model_id). Alt utenfor er aldri valgbart, uansett score. */
  allowlist: ReadonlyArray<{ provider: string; model_id: string }>;
  /** Rom/sensitivitet som MÅ kjøre lokalt. */
  force_local_when: { sensitivities: readonly string[]; spaces: readonly string[] };
  /** Arbeidsflyter som ikke skal være låst til én leverandør. */
  critical_workflows: readonly string[];
}

export interface RouteTask {
  workflow: string;
  space: string;
  sensitivity: string;
  needs: { tool_use?: boolean; vision?: boolean; min_context_tokens?: number };
}

export interface RouteDecision {
  choice: { provider: string; model_id: string } | null;
  fallback: Array<{ provider: string; model_id: string }>;
  reasons: string[];
  /** Kandidater i shadow: observerer parallelt, aldri valgt for produksjonssvar. */
  shadow: Array<{ provider: string; model_id: string }>;
}

const key = (m: { provider: string; model_id: string }) => `${m.provider}:${m.model_id}`;

export function decideRoute(task: RouteTask, registry: readonly RegistryModel[], policy: AutopilotPolicy, health: Readonly<Record<string, ProviderHealth>>): RouteDecision {
  const allowed = new Set(policy.allowlist.map(key));
  const reasons: string[] = [];
  const forceLocal = policy.force_local_when.sensitivities.includes(task.sensitivity) || policy.force_local_when.spaces.includes(task.space);
  if (forceLocal) reasons.push("forced_local");
  const eligible = registry.filter((m) => {
    if (!allowed.has(key(m))) return false;
    if (m.status !== "active") return false;
    if (health[m.provider] === "down") return false;
    if (forceLocal && m.locality !== "local") return false;
    if (task.needs.tool_use && !m.tool_use) return false;
    if (task.needs.vision && !m.vision) return false;
    if (task.needs.min_context_tokens !== undefined && m.context_tokens < task.needs.min_context_tokens) return false;
    return true;
  });
  // Rangering: frisk foran svekket, deretter lav latens, deretter lav pris. Deterministisk (navn som siste tie-break).
  const rank = (m: RegistryModel) => (health[m.provider] === "degraded" ? 1 : 0);
  const sorted = [...eligible].sort((a, b) => rank(a) - rank(b) || a.latency_p95_ms - b.latency_p95_ms || a.price_ore_per_1k_tokens - b.price_ore_per_1k_tokens || key(a).localeCompare(key(b)));
  const shadow = registry.filter((m) => allowed.has(key(m)) && m.status === "shadow" && (!forceLocal || m.locality === "local")).map((m) => ({ provider: m.provider, model_id: m.model_id }));
  if (sorted.length === 0) {
    reasons.push("no_eligible_model");
    return { choice: null, fallback: [], reasons, shadow };
  }
  const [first, ...rest] = sorted;
  // Fallback-kjede: andre leverandører først (en nedetid hos samme leverandør hjelper ikke).
  const fallback = [...rest.filter((m) => m.provider !== first!.provider), ...rest.filter((m) => m.provider === first!.provider)].map((m) => ({ provider: m.provider, model_id: m.model_id }));
  if (!fallback.some((f) => f.provider !== first!.provider)) reasons.push("single_provider_available");
  return { choice: { provider: first!.provider, model_id: first!.model_id }, fallback, reasons, shadow };
}

export interface PromotionRequest {
  model: RegistryModel;
  to: ModelStatus;
  on_allowlist: boolean;
  eval_passed: boolean;
  shadow_days: number;
  /** Berører modellen atferdsrelevant produksjonsruting? Da er endringen minst E1. */
  behavior_relevant: boolean;
}

export interface PromotionVerdict {
  allowed: boolean;
  min_class: "E0" | "E1";
  reasons: string[];
}

/** En ny modell starter alltid candidate -> shadow -> active; hopp er forbudt, og aktivering krever allowlist, eval og shadow-tid. */
export function decidePromotion(r: PromotionRequest, minShadowDays = 3): PromotionVerdict {
  const reasons: string[] = [];
  const order: ModelStatus[] = ["candidate", "shadow", "active"];
  const from = order.indexOf(r.model.status);
  const to = order.indexOf(r.to);
  if (from === -1 || to === -1 || to !== from + 1) reasons.push(`illegal_transition:${r.model.status}->${r.to}`);
  if (r.to === "active") {
    if (!r.on_allowlist) reasons.push("not_on_owner_allowlist");
    if (!r.eval_passed) reasons.push("evals_not_passed");
    if (r.shadow_days < minShadowDays) reasons.push("shadow_period_too_short");
  }
  return { allowed: reasons.length === 0, min_class: r.behavior_relevant ? "E1" : "E0", reasons };
}

export interface FallbackTestState {
  workflow: string;
  chain: ReadonlyArray<{ provider: string }>;
  last_tested_at: string | null;
}

/** Konsentrasjonsrisiko og utestet fallback: kritiske arbeidsflyter trenger ≥2 leverandører og en nylig testet kjede. */
export function auditFallbackChains(states: readonly FallbackTestState[], policy: Pick<AutopilotPolicy, "critical_workflows">, now: Date, maxAgeDays = 30): Array<{ workflow: string; issue: "single_provider" | "never_tested" | "test_stale" }> {
  const out: Array<{ workflow: string; issue: "single_provider" | "never_tested" | "test_stale" }> = [];
  for (const s of states) {
    if (!policy.critical_workflows.includes(s.workflow)) continue;
    if (new Set(s.chain.map((c) => c.provider)).size < 2) out.push({ workflow: s.workflow, issue: "single_provider" });
    if (s.last_tested_at === null) out.push({ workflow: s.workflow, issue: "never_tested" });
    else if (now.getTime() - new Date(s.last_tested_at).getTime() > maxAgeDays * 86_400_000) out.push({ workflow: s.workflow, issue: "test_stale" });
  }
  return out;
}
