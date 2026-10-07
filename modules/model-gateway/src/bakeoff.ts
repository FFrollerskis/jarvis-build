/**
 * Modellmåling (bake-off) - ren logikk uten nettverk/DB, så den kan enhetstestes. Selve kjøringen ligger i `model-bakeoff-live.ts`.
 * Prinsipp (Tobias, 2026-10-07): fart + tydelige svar + at alt virker er viktigst, deretter lavest mulig kostnad. Målingen skal derfor gi
 * (1) deterministiske tall (latens, tokens, kostnad, riktig verktøyvalg) og (2) BLINDE svar til manuell/LLM-vurdering - aldri et automatisk «vinner».
 */
export interface BakeoffPrompt {
  id: string;
  text: string;
  /** "none" = modellen skal IKKE kalle verktøy (småprat/kunnskap). Ellers verktøynavnet (`tool_id__action`) som er riktig førstevalg. */
  expect_tool: "none" | string;
  category?: string;
}

export interface CandidateSpec {
  provider: string;
  model: string;
  /** `provider:model` slik det ble oppgitt. */
  label: string;
}

export interface RunRecord {
  prompt_id: string;
  candidate: string;
  ok: boolean;
  error?: string;
  text: string;
  tool_call?: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_ore: number;
}

export function parseCandidates(raw: string): CandidateSpec[] {
  const out: CandidateSpec[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const provider = i === -1 ? part : part.slice(0, i);
    const model = i === -1 ? "" : part.slice(i + 1);
    if (!/^[a-z][a-z0-9_]*$/.test(provider)) throw new Error(`candidate_invalid:${part}`);
    out.push({ provider, model, label: part });
  }
  if (out.length === 0) throw new Error("no_candidates");
  if (new Set(out.map((c) => c.label)).size !== out.length) throw new Error("duplicate_candidates");
  return out;
}

export function parsePromptsJsonl(raw: string): BakeoffPrompt[] {
  const prompts: BakeoffPrompt[] = [];
  const seen = new Set<string>();
  raw.split("\n").forEach((line, idx) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    let obj: Partial<BakeoffPrompt>;
    try {
      obj = JSON.parse(t) as Partial<BakeoffPrompt>;
    } catch {
      throw new Error(`prompts_line_${idx + 1}_not_json`);
    }
    if (typeof obj.text !== "string" || obj.text.length === 0 || obj.text.length > 4_000) throw new Error(`prompts_line_${idx + 1}_text_invalid`);
    const id = typeof obj.id === "string" && obj.id ? obj.id : `p${prompts.length + 1}`;
    if (seen.has(id)) throw new Error(`prompts_duplicate_id:${id}`);
    seen.add(id);
    prompts.push({ id, text: obj.text, expect_tool: typeof obj.expect_tool === "string" && obj.expect_tool ? obj.expect_tool : "none", ...(obj.category ? { category: obj.category } : {}) });
  });
  if (prompts.length === 0) throw new Error("no_prompts");
  return prompts;
}

/** Riktig verktøyvalg: «none» krever INGEN verktøykall; ellers må første kall være det forventede. */
export function toolChoiceCorrect(expected: string, actual: string | undefined): boolean {
  return expected === "none" ? actual === undefined : actual === expected;
}

/** Deterministisk blanding (mulberry32) - samme seed gir samme rekkefølge, så en blind vurdering kan gjenskapes. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Blinde etiketter A, B, C… per prompt (ulik rekkefølge per prompt). Nøkkelen skrives separat, nederst i rapporten. */
export function blindLabels(candidates: readonly string[], promptIndex: number, seed: number): Map<string, string> {
  const order = seededShuffle(candidates, seed + promptIndex * 7919);
  return new Map(order.map((c, i) => [c, String.fromCharCode(65 + i)]));
}

const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = sorted(xs);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number;
}

export interface CandidateSummary {
  candidate: string;
  runs: number;
  failures: number;
  median_latency_ms: number;
  p95_latency_ms: number;
  avg_cost_ore: number;
  total_cost_ore: number;
  tool_choice_accuracy: number | null;
}

export function summarize(records: readonly RunRecord[], prompts: readonly BakeoffPrompt[]): CandidateSummary[] {
  const byPrompt = new Map(prompts.map((p) => [p.id, p]));
  const candidates = [...new Set(records.map((r) => r.candidate))];
  return candidates.map((candidate) => {
    const rs = records.filter((r) => r.candidate === candidate);
    const okRuns = rs.filter((r) => r.ok);
    const lat = okRuns.map((r) => r.latency_ms);
    const toolScored = okRuns.filter((r) => byPrompt.has(r.prompt_id));
    const correct = toolScored.filter((r) => toolChoiceCorrect(byPrompt.get(r.prompt_id)!.expect_tool, r.tool_call)).length;
    const total = rs.reduce((s, r) => s + r.cost_ore, 0);
    return {
      candidate,
      runs: rs.length,
      failures: rs.length - okRuns.length,
      median_latency_ms: percentile(lat, 50),
      p95_latency_ms: percentile(lat, 95),
      avg_cost_ore: rs.length === 0 ? 0 : total / rs.length,
      total_cost_ore: total,
      tool_choice_accuracy: toolScored.length === 0 ? null : correct / toolScored.length
    };
  });
}

/** Grov månedsprojeksjon fra målt snittkostnad: `turns_per_day` verktøy-/chat-turer × dager. Ærlig forenkling - ikke en prognose. */
export function projectMonthlyKr(avgCostOre: number, turnsPerDay: number, days = 30): number {
  return (avgCostOre * turnsPerDay * days) / 100;
}
