import { normalQuantile, poissonRateTest, round, twoProportionTest, wilsonInterval, type Metric } from "./stats.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): «kreativ-intelligens» som RENE beslutningsfunksjoner over data Jarvis ALLEREDE har (eksperimentregisterets varianter og observasjoner, kampanjenes
 * utgiftsrader og skrive-journalen). Ingen modell, ingen klokke, ingen tilfeldighet og INGEN nye eksterne kall (D-64: plattformen er en kilde Jarvis allerede har hentet fra - denne
 * filen leser aldri noe selv). Alle funksjoner returnerer stabile årsakskoder, aldri fritekst fra kreativene (ubetrodd innhold er data, ikke noe som gjentas i en melding).
 *
 *  - `rankCreatives`: rangerer varianter etter en SHRUNKET rate (empirisk Bayes mot samlet gjennomsnitt) så en variant med 3 klikk på 5 visninger ikke slår en med 400 på 10 000.
 *  - `detectCreativeFatigue`: sammenligner siste vindu mot forrige (z-test) - «CTR har falt signifikant».
 *  - `lintCreative`: deterministiske, rådgivende sjekker av annonsetekst mot plattformens kjente grenser (harde grenser håndheves separat i skrive-validatorene).
 *  - `budgetAdherence`: avstemmingsvisning (IKKE et beløpstak): deklarert budsjett (fra skrive-journalen) mot faktisk utgift (fra utgiftsradene).
 */

export interface CreativeStat {
  variant_id: string;
  variant_key: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spend_ore: number;
}

export interface RankedCreative {
  variant_id: string;
  variant_key: string;
  rank: number;
  /** Shrunket rate (høyere er bedre). For cpc/cpa er raten «enheter per utgift»; `cost_per_unit` viser den omvendte, lesbare verdien. */
  score: number | null;
  raw_rate: number | null;
  cost_per_unit: number | null;
  interval: [number, number] | null;
  trials: number;
  insufficient_data: boolean;
}

export interface RankOptions {
  metric: Exclude<Metric, "roas">;
  /** «Pseudo-observasjoner» prioren teller. Standard per metrikk: ctr 1000 visninger, cvr 100 klikk, cpc 100 klikk, cpa 10 konverteringer. Større = sterkere trekk mot gjennomsnittet. */
  prior_strength?: number;
  /** Under dette antall forsøk (visninger/klikk) merkes varianten `insufficient_data`. */
  min_trials?: number;
}

function binomialParts(metric: "ctr" | "cvr", s: CreativeStat): { x: number; n: number } {
  return metric === "ctr" ? { x: s.clicks, n: s.impressions } : { x: s.conversions, n: s.clicks };
}

/** Rangering av kreativer. `roas` kan ikke rangeres statistisk (ingen ordrenivå-varians) og støttes ikke her. */
export function rankCreatives(stats: readonly CreativeStat[], options: RankOptions): RankedCreative[] {
  const prior = options.prior_strength ?? (options.metric === "ctr" ? 1000 : options.metric === "cpa" ? 10 : 100);
  const minTrials = options.min_trials ?? (options.metric === "ctr" ? 1000 : 100);
  const rows: Omit<RankedCreative, "rank">[] = [];
  if (options.metric === "ctr" || options.metric === "cvr") {
    const parts = stats.map((s) => binomialParts(options.metric as "ctr" | "cvr", s));
    const totalX = parts.reduce((a, p) => a + p.x, 0);
    const totalN = parts.reduce((a, p) => a + p.n, 0);
    const p0 = totalN > 0 ? totalX / totalN : 0;
    stats.forEach((s, i) => {
      const { x, n } = parts[i]!;
      rows.push({
        variant_id: s.variant_id, variant_key: s.variant_key,
        score: n > 0 || prior > 0 ? round((x + prior * p0) / (n + prior)) : null,
        raw_rate: n > 0 ? round(x / n) : null, cost_per_unit: null,
        interval: ((): [number, number] | null => { const w = wilsonInterval(x, n); return w ? [round(w[0]) as number, round(w[1]) as number] : null; })(),
        trials: n, insufficient_data: n < minTrials
      });
    });
  } else {
    // cpc / cpa: «enheter (klikk/konverteringer) per utgiftsøre» - høyere rate = lavere kostnad per enhet.
    const counts = stats.map((s) => (options.metric === "cpc" ? s.clicks : s.conversions));
    const spends = stats.map((s) => s.spend_ore);
    const totalC = counts.reduce((a, b) => a + b, 0);
    const totalE = spends.reduce((a, b) => a + b, 0);
    const r0 = totalE > 0 ? totalC / totalE : 0;
    // Gamma-Poisson-trekk: prior_strength er «pseudo-utgift» i øre-ekvivalenter (skalert så den er sammenlignbar med minst ~100 enheter).
    const priorExposure = totalC > 0 ? (prior / Math.max(1, totalC)) * totalE : 0;
    stats.forEach((s, i) => {
      const c = counts[i]!;
      const e = spends[i]!;
      const shrunk = e + priorExposure > 0 ? (c + r0 * priorExposure) / (e + priorExposure) : null;
      rows.push({
        variant_id: s.variant_id, variant_key: s.variant_key, score: round(shrunk, 8),
        raw_rate: e > 0 ? round(c / e, 8) : null, cost_per_unit: c > 0 ? round(e / c, 2) : null, interval: null,
        trials: c, insufficient_data: c < Math.max(30, Math.floor(minTrials / 10))
      });
    });
  }
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (a.variant_key < b.variant_key ? -1 : 1));
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface DailyCtr {
  date: string; // YYYY-MM-DD
  impressions: number;
  clicks: number;
}

export interface FatigueOptions {
  /** Antall dager i hvert vindu (standard 7). */
  window_days?: number;
  min_impressions_per_window?: number;
  /** Minste relative fall i CTR (prosent) for å regnes som slitasje (standard 15). */
  min_drop_pct?: number;
  alpha?: number;
}

export interface FatigueResult {
  status: "fatigued" | "healthy" | "insufficient_data";
  recent_ctr: number | null;
  previous_ctr: number | null;
  drop_pct: number | null;
  p_value: number | null;
  reasons: string[];
}

/** Siste `window_days` datoer mot de `window_days` før (kun datoer som FINNES i serien teller - hull fylles aldri). */
export function detectCreativeFatigue(series: readonly DailyCtr[], options: FatigueOptions = {}): FatigueResult {
  const w = options.window_days ?? 7;
  const minImp = options.min_impressions_per_window ?? 1000;
  const minDrop = options.min_drop_pct ?? 15;
  const alpha = options.alpha ?? 0.05;
  const byDate = new Map<string, DailyCtr>();
  for (const d of series) {
    const prev = byDate.get(d.date);
    byDate.set(d.date, prev ? { date: d.date, impressions: prev.impressions + d.impressions, clicks: prev.clicks + d.clicks } : { ...d });
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (days.length < 2 * w) return { status: "insufficient_data", recent_ctr: null, previous_ctr: null, drop_pct: null, p_value: null, reasons: [`need_${2 * w}_days_have_${days.length}`] };
  const recent = days.slice(-w);
  const previous = days.slice(-2 * w, -w);
  const sum = (xs: DailyCtr[]) => ({ n: xs.reduce((a, d) => a + d.impressions, 0), x: xs.reduce((a, d) => a + d.clicks, 0) });
  const r = sum(recent);
  const p = sum(previous);
  if (r.n < minImp || p.n < minImp) return { status: "insufficient_data", recent_ctr: null, previous_ctr: null, drop_pct: null, p_value: null, reasons: ["window_below_min_impressions"] };
  const test = twoProportionTest(r.x, r.n, p.x, p.n);
  const recentCtr = r.x / r.n;
  const previousCtr = p.x / p.n;
  const drop = previousCtr > 0 ? ((previousCtr - recentCtr) / previousCtr) * 100 : null;
  const fatigued = test !== null && drop !== null && drop >= minDrop && test.z < 0 && test.p_value <= alpha;
  return {
    status: fatigued ? "fatigued" : "healthy", recent_ctr: round(recentCtr), previous_ctr: round(previousCtr), drop_pct: round(drop, 4),
    p_value: test ? round(test.p_value, 10) : null, reasons: fatigued ? ["ctr_dropped_significantly"] : drop !== null && drop >= minDrop ? ["drop_not_significant"] : ["no_material_drop"]
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rådgivende kreativ-lint
// ---------------------------------------------------------------------------------------------------------------------

export type CreativePlatform = "google_ads" | "meta_ads";

export interface CreativeInput {
  headlines?: readonly string[];
  descriptions?: readonly string[];
  primary_text?: string;
  final_url?: string;
}

export interface LintIssue {
  code: string;
  severity: "error" | "warn";
  /** Sti til feltet (`headlines[2]`) - aldri teksten selv. */
  path: string;
}

/** Plattformgrenser. Google RSA: 3-15 overskrifter (≤30) og 2-4 beskrivelser (≤90) - UVERIFISERT tegngrenser (søkeutdraget oppga kun antallene), derfor rådgivende her. */
export const CREATIVE_LIMITS: Readonly<Record<CreativePlatform, { headlines: [number, number, number]; descriptions: [number, number, number]; primary_text: number }>> = {
  google_ads: { headlines: [3, 15, 30], descriptions: [2, 4, 90], primary_text: 0 },
  meta_ads: { headlines: [1, 1, 40], descriptions: [0, 1, 30], primary_text: 125 }
};

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const URL_IN_TEXT = /\bhttps?:\/\/|\bwww\./i;

function lintTexts(path: string, texts: readonly string[], max: number, issues: LintIssue[]): void {
  const seen = new Set<string>();
  texts.forEach((text, i) => {
    const p = `${path}[${i}]`;
    if (typeof text !== "string" || text.trim().length === 0) { issues.push({ code: "empty_text", severity: "error", path: p }); return; }
    if (CONTROL.test(text)) issues.push({ code: "control_characters", severity: "error", path: p });
    if (Array.from(text).length > max) issues.push({ code: "too_long", severity: "error", path: p });
    const key = text.trim().toLowerCase();
    if (seen.has(key)) issues.push({ code: "duplicate_text", severity: "warn", path: p });
    seen.add(key);
    const letters = text.replace(/[^\p{L}]/gu, "");
    if (letters.length >= 8 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) issues.push({ code: "all_caps", severity: "warn", path: p });
    if ((text.match(/!/g) ?? []).length > 1) issues.push({ code: "excessive_exclamation", severity: "warn", path: p });
    if (URL_IN_TEXT.test(text)) issues.push({ code: "url_in_text", severity: "warn", path: p });
  });
}

export function lintCreative(creative: CreativeInput, platform: CreativePlatform): LintIssue[] {
  const limits = CREATIVE_LIMITS[platform];
  const issues: LintIssue[] = [];
  const headlines = creative.headlines ?? [];
  const descriptions = creative.descriptions ?? [];
  if (headlines.length < limits.headlines[0]) issues.push({ code: "too_few_headlines", severity: "error", path: "headlines" });
  if (headlines.length > limits.headlines[1]) issues.push({ code: "too_many_headlines", severity: "error", path: "headlines" });
  if (descriptions.length < limits.descriptions[0]) issues.push({ code: "too_few_descriptions", severity: "error", path: "descriptions" });
  if (descriptions.length > limits.descriptions[1]) issues.push({ code: "too_many_descriptions", severity: "error", path: "descriptions" });
  lintTexts("headlines", headlines, limits.headlines[2], issues);
  lintTexts("descriptions", descriptions, limits.descriptions[2], issues);
  if (creative.primary_text !== undefined) {
    if (limits.primary_text > 0 && Array.from(creative.primary_text).length > limits.primary_text) issues.push({ code: "primary_text_long", severity: "warn", path: "primary_text" });
    if (CONTROL.test(creative.primary_text)) issues.push({ code: "control_characters", severity: "error", path: "primary_text" });
  }
  if (creative.final_url !== undefined) {
    try {
      const u = new URL(creative.final_url);
      if (u.protocol !== "https:") issues.push({ code: "final_url_not_https", severity: "error", path: "final_url" });
      if (u.username !== "" || u.password !== "") issues.push({ code: "final_url_has_credentials", severity: "error", path: "final_url" });
    } catch {
      issues.push({ code: "final_url_invalid", severity: "error", path: "final_url" });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------------
// Budsjett-avstemming (audit/avstemming, IKKE et beløpstak)
// ---------------------------------------------------------------------------------------------------------------------

export interface BudgetChange {
  /** Fra og med denne datoen (YYYY-MM-DD) gjelder det daglige budsjettet. */
  effective_date: string;
  daily_budget_ore: number;
}

export interface DailySpend {
  date: string;
  spend_ore: number;
}

export interface AdherenceRow {
  date: string;
  budget_ore: number | null;
  spend_ore: number;
  ratio: number | null;
  over_tolerance: boolean;
}

export interface AdherenceReport {
  rows: AdherenceRow[];
  days: number;
  days_without_declared_budget: number;
  days_over_tolerance: number;
  max_ratio: number | null;
  total_budget_ore: number;
  total_spend_ore: number;
  /** Utgift over summen av deklarerte daglige budsjetter (periodens samlede overskridelse, 0 hvis ingen). */
  period_overspend_ore: number;
}

/**
 * Avstemming mellom DEKLARERT daglig budsjett (skrive-journalens `applied` budsjettendringer) og FAKTISK utgift (`marketing_spend_events`). Plattformene bruker «gjennomsnittlig dagsbudsjett»
 * (en enkeltdag kan overstige det), derfor er `tolerance` (standard 2,0 = opptil dobbelt) et observasjonsterskel - ikke en grense Jarvis håndhever. Tom budsjetthistorikk gir `budget_ore: null`.
 */
export function budgetAdherence(changes: readonly BudgetChange[], spend: readonly DailySpend[], tolerance = 2): AdherenceReport {
  const sortedChanges = [...changes].sort((a, b) => (a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : 0));
  const sortedSpend = [...spend].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rows: AdherenceRow[] = [];
  let totalBudget = 0;
  let totalSpend = 0;
  let withoutBudget = 0;
  let over = 0;
  let maxRatio: number | null = null;
  for (const day of sortedSpend) {
    let budget: number | null = null;
    for (const c of sortedChanges) if (c.effective_date <= day.date) budget = c.daily_budget_ore; else break;
    const ratio = budget !== null && budget > 0 ? day.spend_ore / budget : null;
    const isOver = ratio !== null && ratio > tolerance;
    if (budget === null) withoutBudget++;
    else totalBudget += budget;
    totalSpend += day.spend_ore;
    if (isOver) over++;
    if (ratio !== null && (maxRatio === null || ratio > maxRatio)) maxRatio = ratio;
    rows.push({ date: day.date, budget_ore: budget, spend_ore: day.spend_ore, ratio: round(ratio, 4), over_tolerance: isOver });
  }
  return {
    rows, days: rows.length, days_without_declared_budget: withoutBudget, days_over_tolerance: over, max_ratio: round(maxRatio, 4),
    total_budget_ore: totalBudget, total_spend_ore: totalSpend, period_overspend_ore: Math.max(0, totalSpend - totalBudget)
  };
}

/** Konfidensnivå -> z (hjelpefunksjon for rapporter). */
export function zForConfidence(confidence: number): number {
  return normalQuantile(1 - (1 - confidence) / 2);
}

export { poissonRateTest };
