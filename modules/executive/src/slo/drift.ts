import { DRIFT_THRESHOLDS as T } from "./definitions.ts";
import type { DriftFinding, DriftReport, SeriesId, SeriesWindow, SloSource } from "./types.ts";

const SERIES: readonly SeriesId[] = ["model:CHAT", "model:BACKGROUND", "tools", "jobs"];
const SRC: Record<SeriesId, string> = { "model:CHAT": "cost_events (CHAT)", "model:BACKGROUND": "cost_events (bakgrunn)", tools: "tool_executions", jobs: "tasks" };

const pct = (x: number) => `${Math.round(x * 100)} %`;
const sec = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * Ren driftdeteksjon: sammenligner siste vindu mot en baseline (uken før). Krever nok data i BEGGE vinduer, ellers `insufficient` (ingen
 * påstand om verken drift eller stabilitet). Terskler er konservative og krever også en minste absolutt endring.
 */
export function detectDrift(series: SeriesId, baseline: SeriesWindow, recent: SeriesWindow): { findings: DriftFinding[]; sufficient: boolean } {
  if (recent.count < T.min_recent_samples || baseline.count < T.min_baseline_samples) return { findings: [], sufficient: false };
  const findings: DriftFinding[] = [];
  const common = { series, baseline_samples: baseline.count, recent_samples: recent.count, source: SRC[series] };

  const bRate = baseline.ok / baseline.count;
  const rRate = recent.ok / recent.count;
  if (bRate - rRate >= T.success_drop) {
    findings.push({ ...common, metric: "success_rate", baseline: bRate, recent: rRate, change: bRate - rRate, detail: `Suksessraten falt fra ${pct(bRate)} til ${pct(rRate)}.` });
  }
  const latency = (metric: "p95_ms" | "ttft_p95_ms", label: string) => {
    const b = baseline[metric];
    const r = recent[metric];
    if (b === null || r === null || b <= 0) return;
    const rel = (r - b) / b;
    if (rel >= T.latency_increase && r - b >= T.min_latency_delta_ms) {
      findings.push({ ...common, metric, baseline: b, recent: r, change: rel, detail: `${label} økte fra ${sec(b)} til ${sec(r)} (+${pct(rel)}).` });
    }
  };
  latency("p95_ms", "Total svartid (p95)");
  latency("ttft_p95_ms", "Tid til første token (p95)");
  if (baseline.cost_ore > 0 || recent.cost_ore > 0) {
    const bCost = baseline.cost_ore / baseline.count;
    const rCost = recent.cost_ore / recent.count;
    if (bCost > 0 && (rCost - bCost) / bCost >= T.cost_increase && rCost - bCost >= T.min_cost_delta_ore) {
      findings.push({ ...common, metric: "cost_per_call_ore", baseline: bCost, recent: rCost, change: (rCost - bCost) / bCost, detail: `Kostnad per kall økte fra ${Math.round(bCost * 10) / 10} til ${Math.round(rCost * 10) / 10} øre (+${pct((rCost - bCost) / bCost)}).` });
    }
  }
  return { findings, sufficient: true };
}

export async function computeDrift(source: SloSource, now: Date): Promise<DriftReport> {
  const recentFrom = new Date(now.getTime() - T.recent_hours * 3_600_000);
  const baselineFrom = new Date(recentFrom.getTime() - T.baseline_days * 86_400_000);
  const findings: DriftFinding[] = [];
  const insufficient: SeriesId[] = [];
  await Promise.all(
    SERIES.map(async (series) => {
      try {
        const [baseline, recent] = await Promise.all([source.window(series, baselineFrom, recentFrom), source.window(series, recentFrom, now)]);
        const res = detectDrift(series, baseline, recent);
        if (!res.sufficient) insufficient.push(series);
        findings.push(...res.findings);
      } catch {
        insufficient.push(series);
      }
    })
  );
  return {
    findings,
    insufficient: insufficient.sort(),
    baseline_window: { from: baselineFrom.toISOString(), to: recentFrom.toISOString() },
    recent_window: { from: recentFrom.toISOString(), to: now.toISOString() }
  };
}
