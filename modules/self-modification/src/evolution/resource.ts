/**
 * EV-16 (Evolution Masterplan v1.2 kap. 23): Resource & Cost Self-Management - prognose, anomali og forslag (rene funksjoner). Ingen ny hardware
 * eller utgift bare fordi Evolution foreslår det: ethvert kapasitetsforslag er eier-/Finance-gatet. LLM får aldri betalingsdata; auto-recharge
 * er kun en BESLUTNING her (Finance Gateway utfører). DEFERRED: innsamling av disk/RAM/GPU-målinger, faktisk opprydding og billing-API-integrasjon.
 */
export interface Sample {
  /** ISO-tid. */
  at: string;
  value: number;
}

export interface BreachForecast {
  /** null = ingen brudd innenfor horisonten (eller for lite data). */
  days_to_breach: number | null;
  slope_per_day: number;
  samples: number;
  confidence: "low" | "ok";
}

/** Lineær regresjon (minste kvadrater). Krever minst `minSamples` over minst 2 dager, ellers lav tillit og ingen påstand. */
export function forecastBreach(samples: readonly Sample[], limit: number, horizonDays = 90, minSamples = 7): BreachForecast {
  const pts = samples.map((s) => ({ t: new Date(s.at).getTime() / 86_400_000, v: s.value })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (pts.length < minSamples || pts[pts.length - 1]!.t - pts[0]!.t < 2) return { days_to_breach: null, slope_per_day: 0, samples: pts.length, confidence: "low" };
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n;
  const mv = pts.reduce((a, p) => a + p.v, 0) / n;
  const sxx = pts.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  const slope = sxx === 0 ? 0 : pts.reduce((a, p) => a + (p.t - mt) * (p.v - mv), 0) / sxx;
  const last = pts[n - 1]!;
  const current = mv + slope * (last.t - mt);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  if (current >= limit) return { days_to_breach: 0, slope_per_day: round(slope), samples: n, confidence: "ok" };
  if (slope <= 0) return { days_to_breach: null, slope_per_day: round(slope), samples: n, confidence: "ok" };
  const days = (limit - current) / slope;
  return { days_to_breach: days <= horizonDays ? Math.round(days * 10) / 10 : null, slope_per_day: round(slope), samples: n, confidence: "ok" };
}

export interface CostPoint {
  key: string;
  day: string;
  ore: number;
}

export interface CostAnomaly {
  key: string;
  today_ore: number;
  baseline_mean_ore: number;
  z: number;
}

/** Kostanomali per nøkkel (provider/agent/oppgave/tenant): i dag mot gjennomsnitt av baseline-dagene (z-score). Krever nok dager og en minste absolutt økning. */
export function detectCostAnomalies(points: readonly CostPoint[], today: string, options: { min_baseline_days?: number; z_threshold?: number; min_delta_ore?: number } = {}): CostAnomaly[] {
  const minDays = options.min_baseline_days ?? 5;
  const zT = options.z_threshold ?? 3;
  const minDelta = options.min_delta_ore ?? 5;
  const byKey = new Map<string, CostPoint[]>();
  for (const p of points) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  const out: CostAnomaly[] = [];
  for (const [key, list] of byKey) {
    const baseline = list.filter((p) => p.day < today);
    const todayOre = list.filter((p) => p.day === today).reduce((a, p) => a + p.ore, 0);
    if (new Set(baseline.map((p) => p.day)).size < minDays) continue;
    const perDay = new Map<string, number>();
    for (const p of baseline) perDay.set(p.day, (perDay.get(p.day) ?? 0) + p.ore);
    const vals = [...perDay.values()];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    const z = sd === 0 ? (todayOre > mean ? Infinity : 0) : (todayOre - mean) / sd;
    if (z >= zT && todayOre - mean >= minDelta) out.push({ key, today_ore: todayOre, baseline_mean_ore: Math.round(mean * 10) / 10, z: Number.isFinite(z) ? Math.round(z * 10) / 10 : 999 });
  }
  return out.sort((a, b) => b.z - a.z || a.key.localeCompare(b.key));
}

export interface CapacityProposal {
  resource: string;
  evidence: { forecast: BreachForecast; limit: number; unit: string };
  recommendation: string;
  /** Alltid true: ny maskinvare/utgift krever eier og Finance-port. */
  requires_owner: true;
  involves_spend: boolean;
}

export function capacityProposal(resource: string, forecast: BreachForecast, limit: number, unit: string, recommendation: string, involvesSpend: boolean): CapacityProposal | null {
  if (forecast.confidence === "low" || forecast.days_to_breach === null) return null;
  return { resource, evidence: { forecast, limit, unit }, recommendation, requires_owner: true, involves_spend: involvesSpend };
}

export interface Artifact {
  path: string;
  age_days: number;
  bytes: number;
}

export interface CleanupRule {
  /** Presis katalog-prefiks (aldri bredere enn eksplisitt oppgitt). */
  prefix: string;
  max_age_days: number;
}

/** Opprydding kun innen eksplisitte regler: bare filer under et regelprefiks OG eldre enn regelens grense. Alt annet røres aldri. */
export function planCleanup(artifacts: readonly Artifact[], rules: readonly CleanupRule[]): Artifact[] {
  const valid = rules.filter((r) => r.prefix.length >= 4 && r.prefix.endsWith("/") && !r.prefix.includes("..") && r.max_age_days >= 1);
  return artifacts.filter((a) => !a.path.includes("..") && valid.some((r) => a.path.startsWith(r.prefix) && a.age_days > r.max_age_days));
}

export interface CreditStatus {
  balance_ore: number;
  burn_ore_per_day: number;
  warn_days: number;
}

export function creditRunway(c: CreditStatus): { days_left: number | null; warn: boolean } {
  if (c.burn_ore_per_day <= 0) return { days_left: null, warn: false };
  const days = c.balance_ore / c.burn_ore_per_day;
  return { days_left: Math.round(days * 10) / 10, warn: days <= c.warn_days };
}

export interface RechargeRequest {
  provider_supports_auto_recharge: boolean;
  finance_policy_allows: boolean;
  amount_ore: number;
  finance_remaining_limit_ore: number;
}

/** Beslutning om auto-recharge (utføres av Finance Gateway, aldri av LLM). Krever leverandørstøtte, policy og at beløpet er innenfor gjenstående grense. */
export function decideAutoRecharge(r: RechargeRequest): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!r.provider_supports_auto_recharge) reasons.push("provider_does_not_support_auto_recharge");
  if (!r.finance_policy_allows) reasons.push("finance_policy_denies");
  if (r.amount_ore <= 0) reasons.push("invalid_amount");
  if (r.amount_ore > r.finance_remaining_limit_ore) reasons.push("exceeds_finance_limit");
  return { allowed: reasons.length === 0, reasons };
}
