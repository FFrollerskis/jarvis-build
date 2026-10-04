import type { ModelPurpose } from "@jarvis/contracts";
import { textOnly, type ModelRequest } from "@jarvis/provider-adapters";
import { isModelSelectable, tierIndex, TIER_ORDER, type CatalogModel, type ModelTier } from "./model-catalog.ts";
import type { PricingTable } from "./pricing.ts";

/**
 * D-399 (modellrådgiver): «riktig MODELL, ikke bare riktig AI». Rådgiveren ser en kort, strukturert beskrivelse av oppgaven og anbefaler et TRINN (fast/standard/heavy/frontier);
 * `selectModelForTier()` oversetter det til billigste valgbare katalogmodell som holder. Rådgiveren er RÅDGIVENDE - ruteren har allerede filtrert leverandører på sensitivitet/
 * betalte modeller/helse, og dette velger bare modell INNENFOR de kvalifiserte leverandørene. En modell kan aldri velge seg selv (§35); rådgiveren er Jarvis-kode (eller en
 * ekstern, Jev-lignende beslutningsmodell bak samme grensesnitt - aldri kjernen, regel 12).
 */
export type TaskKind = "code" | "research" | "writing" | "analysis" | "planning" | "extraction" | "chat";
export type TaskComplexity = "low" | "medium" | "high";

export interface TaskDescriptor {
  kind: TaskKind;
  complexity: TaskComplexity;
  /** Grovt tegnantall i prompten (ikke innholdet - rådgiveren får aldri mer enn dette og typen). */
  size_chars: number;
  needs_tools: boolean;
  /** Antall verktøyrunder så langt i en agent-løkke (0 = første kall). */
  tool_rounds: number;
  purpose?: ModelPurpose;
}

export interface RoutingAdvice {
  tier: ModelTier;
  reason: string;
  /** 0-1: hvor sikker rådgiveren er. Lav sikkerhet => eskalér ikke automatisk, men heller ikke nedgrader. */
  confidence: number;
  advisor: string;
}

export interface RoutingAdvisor {
  readonly name: string;
  advise(task: TaskDescriptor): RoutingAdvice | Promise<RoutingAdvice>;
}

const KIND_PATTERNS: Array<[TaskKind, RegExp]> = [
  ["code", /(```|\b(kode|funksjon|metode|bug|feilsøk|refaktor\w*|implementer\w*|enhetstest\w*|typescript|javascript|python|\bsql\b|pull request|commit|stack ?trace|kompiler\w*|compile|function|refactor|debug)\b)/i],
  ["planning", /\b(plan\w*|arkitektur|strategi|design av|roadmap|veikart|prioriter\w*)\b/i],
  ["analysis", /\b(analyser\w*|vurder\w*|evaluer\w*|risiko\w*|konsekvens\w*|sammenlign\w*|årsak\w*)\b/i],
  ["research", /\b(undersøk\w*|research|finn ut|kilder|litteratur|markedet)\b/i],
  ["extraction", /\b(trekk ut|ekstraher\w*|klassifiser\w*|kategoriser\w*|parse|json)\b/i],
  ["writing", /\b(skriv|formuler\w*|utkast|oppsummer\w*|e-?post|brev|tekst)\b/i]
];
const HARD_SIGNALS = /\b(steg for steg|flere filer|hele (kode|prosjekt|systemet)|arkitektur\w*|sikkerhet\w*|migrer\w*|refaktor\w*|end-to-end|ytelse|race condition|samtidighet)\b/i;

/** Ren, deterministisk avledning av en oppgavebeskrivelse fra et modellkall (ingen modell involvert). */
export function describeTask(request: ModelRequest, purpose?: ModelPurpose): TaskDescriptor {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  const userText = last ? textOnly(last.content) : "";
  const text = `${request.system ?? ""}\n${userText}`;
  const size = text.length;
  let kind: TaskKind = "chat";
  for (const [k, re] of KIND_PATTERNS) if (re.test(userText)) { kind = k; break; }
  if (purpose === "CODE") kind = "code";
  else if (purpose === "PLAN") kind = "planning";
  else if (purpose === "RESEARCH") kind = "research";
  else if (purpose === "EXTRACT" || purpose === "QUICK_CLASSIFICATION") kind = "extraction";
  else if (purpose === "SUMMARIZE") kind = "writing";

  const tool_rounds = request.tool_exchanges?.length ?? 0;
  const needs_tools = (request.tools?.length ?? 0) > 0;
  let score = 0;
  if (userText.length > 6000) score += 2;
  else if (userText.length > 1500) score += 1;
  if (needs_tools) score += 1;
  if (tool_rounds >= 3) score += 1;
  if (HARD_SIGNALS.test(userText)) score += 1;
  if (kind === "planning" || kind === "analysis") score += 1;
  if (kind === "code" && userText.length > 800) score += 1;
  if (purpose === "REASON" || purpose === "CRITIQUE") score += 1;
  const simple = userText.length < 280 && (kind === "chat" || kind === "extraction" || kind === "writing") && !needs_tools;
  const complexity: TaskComplexity = simple && score <= 1 ? "low" : score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  return { kind, complexity, size_chars: size, needs_tools, tool_rounds, ...(purpose !== undefined ? { purpose } : {}) };
}

/**
 * Standardrådgiver (deterministisk, ingen modellkall). Bevisst forsiktig OPPOVER: `frontier` anbefales ALDRI av heuristikken - det trinnet nås kun ved eksplisitt
 * eskalering (oppgave feilet på `heavy`) eller eier-ønske. low => fast, medium => standard (Sonnet-klassen), high => heavy.
 */
export class HeuristicRoutingAdvisor implements RoutingAdvisor {
  readonly name = "heuristic-v1";
  advise(task: TaskDescriptor): RoutingAdvice {
    const tier: ModelTier = task.complexity === "high" ? "heavy" : task.complexity === "medium" ? "standard" : "fast";
    // Kode og agent-løkker mister mest på for svak modell - løft `fast` til `standard` der det er verktøy/kode.
    const lifted: ModelTier = tier === "fast" && (task.kind === "code" || task.needs_tools) ? "standard" : tier;
    const confidence = task.complexity === "medium" ? 0.6 : 0.75;
    return { tier: lifted, reason: `${task.kind}/${task.complexity}${lifted !== tier ? " (løftet: kode/verktøy)" : ""}`, confidence, advisor: this.name };
  }
}

export interface ModelSelection {
  provider: string;
  model: string;
  tier: ModelTier;
  /** Ingen valgbar modell nådde det anbefalte trinnet - valgt nærmeste NEDOVER (flagget) i stedet for å la oppgaven gå til en feil dyr modell. */
  downgraded: boolean;
}

export interface SelectionContext {
  /** Leverandører ruteren allerede har kvalifisert (sensitivitet/paid/helse/capabilities) - rådgiveren kan aldri gå utenfor dem. */
  eligibleProviders: readonly string[];
  providerDefaultModel: (provider: string) => string | undefined;
  pricing: PricingTable;
  catalog: readonly CatalogModel[];
  /** Hardt tak (budsjett: `warn` => `standard`). Anbefalt trinn klemmes ned til taket. */
  maxTier?: ModelTier;
}

/**
 * BILLIGST SOM HOLDER: blant valgbare modeller hos kvalifiserte leverandører, velg laveste trinn som er >= anbefalt trinn (innen taket), deretter laveste kostklasse.
 * Faller tilbake nedover bare hvis ingenting holder; returnerer `null` hvis ingenting er valgbart (kalleren beholder da ruterens standardmodell).
 * Leverandørrekkefølgen i `eligibleProviders` (ruterens rangering) bryter uavgjort.
 */
export function selectModelForTier(advisedTier: ModelTier, ctx: SelectionContext): ModelSelection | null {
  const cap = ctx.maxTier !== undefined ? Math.min(tierIndex(ctx.maxTier), TIER_ORDER.length - 1) : TIER_ORDER.length - 1;
  const want = Math.min(tierIndex(advisedTier), cap);
  const pool = ctx.catalog
    .filter((m) => ctx.eligibleProviders.includes(m.provider))
    .filter((m) => isModelSelectable(m, ctx.pricing, ctx.providerDefaultModel(m.provider)))
    .filter((m) => tierIndex(m.tier) <= cap);
  if (pool.length === 0) return null;
  const rank = (m: CatalogModel) => ctx.eligibleProviders.indexOf(m.provider);
  const up = pool.filter((m) => tierIndex(m.tier) >= want)
    .sort((a, b) => tierIndex(a.tier) - tierIndex(b.tier) || a.cost_class - b.cost_class || rank(a) - rank(b));
  if (up.length > 0) {
    const m = up[0] as CatalogModel;
    return { provider: m.provider, model: m.model, tier: m.tier, downgraded: false };
  }
  const down = pool.sort((a, b) => tierIndex(b.tier) - tierIndex(a.tier) || a.cost_class - b.cost_class || rank(a) - rank(b));
  const m = down[0] as CatalogModel;
  return { provider: m.provider, model: m.model, tier: m.tier, downgraded: true };
}
