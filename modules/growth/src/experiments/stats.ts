/**
 * WP-D3 (UA-4 Growth, D-459): eksperimentregisterets STATISTIKK - rene, deterministiske funksjoner uten I/O, uten klokke, uten tilfeldighet og uten modell (Q-26-grensen:
 * registeret «mener» aldri noe en regel ikke kan reprodusere). Samme input gir BIT-FOR-BIT samme output (tall avrundes til fast presisjon, slik at `evaluation_digest` er stabil).
 *
 * Hva som er støttet (og hva ikke - ærlig):
 *  - ctr (klikk/visninger) og cvr (konverteringer/klikk): toutvalgs z-test for andeler (samlet varians), tosidig.
 *  - cpc (utgift/klikk) og cpa (utgift/konvertering): sammenligning av Poisson-rater med utgift som eksponering (betinget binomial-test) - «koster én variant mindre per enhet?».
 *  - roas (omsetning/utgift): punktestimat rapporteres, men en test krever ordrenivå-varians som registeret ikke har -> `testable: false`, aldri en vinner (`DEFERRED`).
 *  - Flere varianter: Bonferroni-justert signifikansnivå (konservativt) mot kontrollen. Uten kontroll avgjøres aldri en vinner.
 *  - Normalapproksimasjon: gyldig for «nok data»-tersklene planen setter; under dem er svaret alltid `inconclusive`, uansett p-verdi.
 */

export const METRICS = ["ctr", "cvr", "cpc", "cpa", "roas"] as const;
export type Metric = (typeof METRICS)[number];
export type MetricDirection = "higher_is_better" | "lower_is_better";

export const METRIC_DIRECTION: Readonly<Record<Metric, MetricDirection>> = {
  ctr: "higher_is_better", cvr: "higher_is_better", roas: "higher_is_better", cpc: "lower_is_better", cpa: "lower_is_better"
};

export interface VariantTotals {
  impressions: number;
  clicks: number;
  conversions: number;
  spend_ore: number;
  revenue_ore: number;
}

/** Avrunder til fast antall desimaler (stabil serialisering/digest). `null`/NaN/Infinity -> `null`. */
export function round(value: number | null | undefined, decimals = 6): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Verdien av en metrikk for en variant, eller `null` når nevneren er 0 (udefinert er udefinert - aldri 0 og aldri en gjettet verdi). */
export function metricValue(metric: Metric, t: VariantTotals): number | null {
  switch (metric) {
    case "ctr": return t.impressions > 0 ? t.clicks / t.impressions : null;
    case "cvr": return t.clicks > 0 ? t.conversions / t.clicks : null;
    case "cpc": return t.clicks > 0 ? t.spend_ore / t.clicks : null;
    case "cpa": return t.conversions > 0 ? t.spend_ore / t.conversions : null;
    case "roas": return t.spend_ore > 0 ? t.revenue_ore / t.spend_ore : null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Normalfordelingen. Egen implementasjon (ingen avhengighet): erf via Taylor-rekke for |x| < 3 og kjedebrøk for større argument. Verifisert mot kjente verdier i testene.
// ---------------------------------------------------------------------------------------------------------------------

/** Komplementær feilfunksjon erfc(x) for x >= 0. */
function erfcNonNegative(x: number): number {
  if (x === 0) return 1;
  if (x < 3) {
    // erf(x) = 2/sqrt(pi) * sum_{n>=0} (-1)^n x^(2n+1) / (n! (2n+1))
    let term = x;
    let sum = x;
    for (let n = 1; n < 120; n++) {
      term *= (-x * x) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return 1 - (2 / Math.sqrt(Math.PI)) * sum;
  }
  // Kjedebrøk (Lentz): erfc(x) = exp(-x^2)/(x sqrt(pi)) * 1/(1+ a1/(1+ a2/(1+ ...))) med a_k = k/(2 x^2)
  const x2 = x * x;
  let f = 1;
  for (let k = 80; k >= 1; k--) f = 1 + (k / (2 * x2)) / f;
  return Math.exp(-x2) / (x * Math.sqrt(Math.PI)) / f;
}

export function erfc(x: number): number {
  return x >= 0 ? erfcNonNegative(x) : 2 - erfcNonNegative(-x);
}

/** Standard normal CDF Φ(z). */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** Invers standard normal CDF (kvantilfunksjon) ved bisection - deterministisk og robust; presisjon ~1e-12. `p` må ligge i (0, 1). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error("normal_quantile_out_of_range");
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Tosidig p-verdi for en z-skår. */
export function twoSidedP(z: number): number {
  return Math.min(1, erfc(Math.abs(z) / Math.SQRT2));
}

// ---------------------------------------------------------------------------------------------------------------------
// Tester
// ---------------------------------------------------------------------------------------------------------------------

export interface ProportionTest {
  p1: number;
  p2: number;
  z: number;
  p_value: number;
  diff: number;
  /** Wald-konfidensintervall for forskjellen p1 - p2 på det oppgitte nivået. */
  diff_ci: [number, number];
}

/** Toutvalgs z-test for andeler (samlet varians). `null` når et utvalg er tomt. */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number, confidence = 0.95): ProportionTest | null {
  if (!(n1 > 0 && n2 > 0) || x1 < 0 || x2 < 0 || x1 > n1 || x2 > n2) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p1 - p2) / se;
  const zCrit = normalQuantile(1 - (1 - confidence) / 2);
  const seDiff = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return { p1, p2, z, p_value: twoSidedP(z), diff: p1 - p2, diff_ci: [p1 - p2 - zCrit * seDiff, p1 - p2 + zCrit * seDiff] };
}

export interface RateTest {
  rate1: number;
  rate2: number;
  z: number;
  p_value: number;
}

/**
 * Sammenligning av to Poisson-rater (antall per eksponeringsenhet): c1/e1 mot c2/e2. Under H0 (lik rate) er c1 binomial(N = c1 + c2, p0 = e1/(e1 + e2)) - en betinget test som
 * ikke trenger noen modell for hvor utgiften kom fra. `null` når ingen tellinger finnes eller en eksponering er 0.
 */
export function poissonRateTest(c1: number, e1: number, c2: number, e2: number): RateTest | null {
  if (!(e1 > 0 && e2 > 0) || c1 < 0 || c2 < 0) return null;
  const n = c1 + c2;
  if (n === 0) return null;
  const p0 = e1 / (e1 + e2);
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  const z = se === 0 ? 0 : (c1 / n - p0) / se;
  return { rate1: c1 / e1, rate2: c2 / e2, z, p_value: twoSidedP(z) };
}

/** Wilson-konfidensintervall for en andel (stabilt for små utvalg og ekstreme andeler). */
export function wilsonInterval(x: number, n: number, confidence = 0.95): [number, number] | null {
  if (!(n > 0) || x < 0 || x > n) return null;
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = x / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  // Grensene er eksakte ved 0 og n (flyttallsstøy gir ellers 3,5e-18 i stedet for 0).
  return [x === 0 ? 0 : Math.max(0, center - half), x === n ? 1 : Math.min(1, center + half)];
}

/**
 * Nødvendig utvalg PER VARIANT for å oppdage en relativ forbedring (`relativeMde`, f.eks. 0.2 = +20 %) av en baseline-andel, tosidig test.
 * Standardformelen n = (z_{α/2}·sqrt(2·p̄·q̄) + z_β·sqrt(p1·q1 + p2·q2))² / (p1 - p2)². `null` når inndata er ugyldig.
 */
export function sampleSizePerVariant(baselineRate: number, relativeMde: number, alpha = 0.05, power = 0.8): number | null {
  if (!(baselineRate > 0 && baselineRate < 1) || !(relativeMde > 0)) return null;
  const p1 = baselineRate;
  const p2 = Math.min(0.999999, baselineRate * (1 + relativeMde));
  if (p2 === p1 || p2 <= 0) return null;
  const pBar = (p1 + p2) / 2;
  const zA = normalQuantile(1 - alpha / 2);
  const zB = normalQuantile(power);
  const numerator = zA * Math.sqrt(2 * pBar * (1 - pBar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator * numerator) / ((p1 - p2) * (p1 - p2)));
}

/**
 * Sannsynlighet for at hver variant er BEST gitt normalapproksimerte estimater N(μ_i, σ_i²) (høyere er bedre) - deterministisk numerisk integrasjon (Simpson), ingen
 * Monte Carlo. Summerer til 1. `σ = 0` (ingen usikkerhet) behandles som en meget smal fordeling.
 */
export function probabilityBest(means: readonly number[], sds: readonly number[]): number[] {
  const k = means.length;
  if (k === 0) return [];
  if (k === 1) return [1];
  const scale = Math.max(1e-12, ...means.map((m) => Math.abs(m)));
  const sd = sds.map((s) => (Number.isFinite(s) && s > 1e-12 * scale ? s : 1e-12 * scale));
  const lo = Math.min(...means.map((m, i) => m - 8 * sd[i]!));
  const hi = Math.max(...means.map((m, i) => m + 8 * sd[i]!));
  const steps = 4000; // partall
  const h = (hi - lo) / steps;
  const out = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) {
    let sum = 0;
    for (let s = 0; s <= steps; s++) {
      const x = lo + s * h;
      const zi = (x - means[i]!) / sd[i]!;
      let integrand = Math.exp(-0.5 * zi * zi) / (sd[i]! * Math.sqrt(2 * Math.PI));
      for (let j = 0; j < k && integrand > 0; j++) {
        if (j !== i) integrand *= normalCdf((x - means[j]!) / sd[j]!);
      }
      const weight = s === 0 || s === steps ? 1 : s % 2 === 1 ? 4 : 2;
      sum += weight * integrand;
    }
    out[i] = (sum * h) / 3;
  }
  const total = out.reduce((a, b) => a + b, 0);
  return total > 0 ? out.map((v) => v / total) : out.map(() => 1 / k);
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluering
// ---------------------------------------------------------------------------------------------------------------------

export interface PlanInput {
  primary_metric: Metric;
  min_impressions_per_variant: number;
  min_conversions_per_variant: number;
  confidence_level: number;
  min_effect_pct: number;
}

export interface VariantInput {
  variant_id: string;
  variant_key: string;
  is_control: boolean;
  totals: VariantTotals;
}

export type Verdict = "winner" | "no_winner" | "inconclusive";

export interface VariantEvaluation {
  variant_id: string;
  variant_key: string;
  is_control: boolean;
  totals: VariantTotals;
  metrics: Record<Metric, number | null>;
  primary_value: number | null;
  sample: { impressions_ok: boolean; conversions_ok: boolean; shortfall_impressions: number; shortfall_conversions: number };
  /** Forskjell mot kontrollen (kun for ikke-kontroll-varianter og testbare metrikker). */
  vs_control: { improvement_pct: number | null; z: number | null; p_value: number | null; significant: boolean; practical: boolean; diff_ci: [number, number] | null } | null;
  probability_best: number | null;
}

export interface ExperimentEvaluation {
  v: 1;
  metric: Metric;
  direction: MetricDirection;
  confidence_level: number;
  alpha: number;
  alpha_adjusted: number;
  comparisons: number;
  min_effect_pct: number;
  control_variant_id: string | null;
  testable: boolean;
  variants: VariantEvaluation[];
  verdict: Verdict;
  winner_variant_id: string | null;
  /** Stabile årsakskoder (ingen fritekst) som forklarer utfallet. */
  reasons: string[];
  data_quality: string[];
}

const METRIC_KEYS: readonly Metric[] = METRICS;

function metricsOf(t: VariantTotals): Record<Metric, number | null> {
  const out = {} as Record<Metric, number | null>;
  for (const m of METRIC_KEYS) out[m] = round(metricValue(m, t));
  return out;
}

function improvementPct(direction: MetricDirection, control: number, variant: number): number | null {
  if (!(control > 0)) return null;
  return direction === "higher_is_better" ? ((variant - control) / control) * 100 : ((control - variant) / control) * 100;
}

/**
 * Deterministisk evaluering av et eksperiment. Reglene (konservative, i denne rekkefølgen):
 *  1. færre enn to varianter, ingen kontroll eller en ikke-testbar metrikk (roas) -> `inconclusive`;
 *  2. en variant under planens minimumsutvalg (visninger/konverteringer) -> `inconclusive` (aldri en vinner på for lite data);
 *  3. hver ikke-kontroll-variant testes mot kontrollen med Bonferroni-justert nivå; VINNER = signifikant bedre OG minst `min_effect_pct` bedre; best forbedring vinner
 *     (tie: lavest p-verdi, så variant_key); ellers `no_winner` (kontrollen beholdes).
 * Rekkefølgen på `variants` påvirker ikke resultatet (sortert på variant_key).
 */
export function evaluateExperiment(plan: PlanInput, variantsIn: readonly VariantInput[]): ExperimentEvaluation {
  const direction = METRIC_DIRECTION[plan.primary_metric];
  const alpha = round(1 - plan.confidence_level, 6) ?? 0.05;
  const variants = [...variantsIn].sort((a, b) => (a.variant_key < b.variant_key ? -1 : a.variant_key > b.variant_key ? 1 : 0));
  const control = variants.find((v) => v.is_control) ?? null;
  const reasons: string[] = [];
  const dataQuality: string[] = [];
  const testable = plan.primary_metric !== "roas";

  const evals: VariantEvaluation[] = variants.map((v) => {
    const t = v.totals;
    if (t.clicks > t.impressions && t.impressions > 0) dataQuality.push(`clicks_exceed_impressions:${v.variant_key}`);
    if (t.impressions === 0 && t.clicks > 0) dataQuality.push(`clicks_without_impressions:${v.variant_key}`);
    return {
      variant_id: v.variant_id, variant_key: v.variant_key, is_control: v.is_control,
      totals: { ...t }, metrics: metricsOf(t), primary_value: round(metricValue(plan.primary_metric, t)),
      sample: {
        impressions_ok: t.impressions >= plan.min_impressions_per_variant,
        conversions_ok: t.conversions >= plan.min_conversions_per_variant,
        shortfall_impressions: Math.max(0, plan.min_impressions_per_variant - t.impressions),
        shortfall_conversions: Math.max(0, plan.min_conversions_per_variant - t.conversions)
      },
      vs_control: null, probability_best: null
    };
  });

  const finish = (verdict: Verdict, winner: string | null): ExperimentEvaluation => ({
    v: 1, metric: plan.primary_metric, direction, confidence_level: plan.confidence_level, alpha, alpha_adjusted: round(alpha / Math.max(1, variants.length - 1), 8) ?? alpha,
    comparisons: Math.max(0, variants.length - 1), min_effect_pct: plan.min_effect_pct, control_variant_id: control?.variant_id ?? null, testable,
    variants: evals, verdict, winner_variant_id: winner, reasons, data_quality: dataQuality
  });

  if (variants.length < 2) { reasons.push("too_few_variants"); return finish("inconclusive", null); }
  if (control === null) reasons.push("no_control_variant");
  if (!testable) reasons.push(`metric_not_testable:${plan.primary_metric}`);
  const lacking = evals.filter((e) => !e.sample.impressions_ok || !e.sample.conversions_ok);
  if (lacking.length > 0) reasons.push(`insufficient_data:${lacking.map((e) => e.variant_key).join(",")}`);

  const controlEval = evals.find((e) => e.is_control) ?? null;
  const metric = plan.primary_metric;
  const alphaAdj = alpha / Math.max(1, variants.length - 1);

  // Beregn statistikken også når utfallet blir `inconclusive` (eieren skal se tallene), men aldri uten kontroll/testbar metrikk.
  if (controlEval !== null && testable) {
    for (const e of evals) {
      if (e.is_control) continue;
      const c = controlEval.totals;
      const v = e.totals;
      let z: number | null = null;
      let p: number | null = null;
      let ci: [number, number] | null = null;
      if (metric === "ctr" || metric === "cvr") {
        const test = metric === "ctr" ? twoProportionTest(v.clicks, v.impressions, c.clicks, c.impressions, plan.confidence_level) : twoProportionTest(v.conversions, v.clicks, c.conversions, c.clicks, plan.confidence_level);
        if (test) { z = test.z; p = test.p_value; ci = [round(test.diff_ci[0], 8) as number, round(test.diff_ci[1], 8) as number]; }
      } else {
        // cpc: klikk per utgiftsenhet; cpa: konverteringer per utgiftsenhet (høyere rate = lavere kostnad per enhet).
        const test = metric === "cpc" ? poissonRateTest(v.clicks, v.spend_ore, c.clicks, c.spend_ore) : poissonRateTest(v.conversions, v.spend_ore, c.conversions, c.spend_ore);
        if (test) { z = test.z; p = test.p_value; }
      }
      const cv = controlEval.primary_value;
      const vv = e.primary_value;
      const imp = cv !== null && vv !== null ? improvementPct(direction, cv, vv) : null;
      e.vs_control = {
        improvement_pct: round(imp, 4), z: round(z, 6), p_value: p === null ? null : round(p, 10),
        significant: p !== null && p <= alphaAdj, practical: imp !== null && imp >= plan.min_effect_pct, diff_ci: ci
      };
    }
    // Sannsynlighet for best (normalapproksimasjon) - kun for andels- og ratemetrikker.
    const means: number[] = [];
    const sds: number[] = [];
    let usable = true;
    for (const e of evals) {
      const t = e.totals;
      if (metric === "ctr" || metric === "cvr") {
        const n = metric === "ctr" ? t.impressions : t.clicks;
        const x = metric === "ctr" ? t.clicks : t.conversions;
        if (n <= 0) { usable = false; break; }
        const p = x / n;
        means.push(p); sds.push(Math.sqrt((p * (1 - p)) / n));
      } else {
        const count = metric === "cpc" ? t.clicks : t.conversions;
        if (t.spend_ore <= 0 || count <= 0) { usable = false; break; }
        means.push(count / t.spend_ore); sds.push(Math.sqrt(count) / t.spend_ore);
      }
    }
    if (usable) {
      const probs = probabilityBest(means, sds);
      evals.forEach((e, i) => { e.probability_best = round(probs[i] ?? null, 6); });
    }
  }

  if (control === null || !testable || lacking.length > 0) return finish("inconclusive", null);

  const improving = evals.filter((e) => !e.is_control && e.vs_control && e.vs_control.significant && (e.vs_control.improvement_pct ?? 0) > 0);
  const winners = improving.filter((e) => e.vs_control!.practical);
  if (winners.length > 0) {
    winners.sort((a, b) =>
      (b.vs_control!.improvement_pct ?? 0) - (a.vs_control!.improvement_pct ?? 0) || (a.vs_control!.p_value ?? 1) - (b.vs_control!.p_value ?? 1) || (a.variant_key < b.variant_key ? -1 : 1));
    reasons.push("significant_and_practical_improvement");
    return finish("winner", winners[0]!.variant_id);
  }
  reasons.push(improving.length > 0 ? "significant_but_below_practical_threshold" : "no_significant_improvement");
  return finish("no_winner", null);
}

/** Kort, deterministisk norsk oppsummering av en evaluering (til `marketing_experiments.result_summary`) - tall og nøkler, aldri kausalt språk. */
export function summarizeEvaluation(e: ExperimentEvaluation): string {
  const winner = e.variants.find((v) => v.variant_id === e.winner_variant_id);
  const base = `Metrikk ${e.metric}, ${e.variants.length} varianter, konfidensnivå ${e.confidence_level}.`;
  if (e.verdict === "winner" && winner) {
    return `${base} Vinner: ${winner.variant_key} (${winner.vs_control?.improvement_pct ?? "?"} % bedre enn kontrollen, p = ${winner.vs_control?.p_value ?? "?"}).`;
  }
  if (e.verdict === "no_winner") return `${base} Ingen vinner: kontrollen beholdes (${e.reasons.join(", ")}).`;
  return `${base} Ikke avgjort (${e.reasons.join(", ")}).`;
}
