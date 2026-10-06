import { SLO_CATALOG } from "./definitions.ts";
import type { SeriesWindow, SloDefinition, SloResult, SloSource } from "./types.ts";

const SOURCE: Record<string, string> = {
  "model:CHAT": "cost_events (purpose=CHAT)",
  "model:BACKGROUND": "cost_events (bakgrunnsformål)",
  tools: "tool_executions",
  jobs: "tasks"
};

function valueOf(def: SloDefinition, w: SeriesWindow): number | null {
  if (def.metric === "success_rate") return w.count === 0 ? null : w.ok / w.count;
  if (def.metric === "p95_ms") return w.p95_ms;
  return w.ttft_p95_ms;
}

const fmt = (def: SloDefinition, v: number): string =>
  def.metric === "success_rate" ? `${Math.round(v * 1000) / 10} %` : `${Math.round(v / 100) / 10} s`;

/** Ren evaluering av én SLO mot et målt vindu. For få målinger eller manglende verdi gir UNKNOWN - aldri OK. */
export function evaluateSlo(def: SloDefinition, w: SeriesWindow, nowIso: string): SloResult {
  const base = { id: def.id, label: def.label, target: def.target, metric: def.metric, samples: w.count, window_hours: def.window_hours, source: SOURCE[def.series] ?? def.series, observed_at: nowIso };
  const value = valueOf(def, w);
  if (w.count < def.min_samples || value === null) {
    return { ...base, status: "UNKNOWN", value, detail: `For få målinger siste ${def.window_hours} t (${w.count} av minst ${def.min_samples}) - kan ikke vurdere.` };
  }
  const ok = def.metric === "success_rate" ? value >= def.target : value <= def.target;
  const goal = def.metric === "success_rate" ? `mål minst ${fmt(def, def.target)}` : `mål høyst ${fmt(def, def.target)}`;
  return {
    ...base,
    status: ok ? "OK" : "BREACH",
    value,
    detail: `${fmt(def, value)} siste ${def.window_hours} t (${w.count} målinger, ${goal}).`
  };
}

export async function evaluateAllSlos(source: SloSource, now: Date, catalog: readonly SloDefinition[] = SLO_CATALOG): Promise<SloResult[]> {
  const nowIso = now.toISOString();
  return Promise.all(
    catalog.map(async (def) => {
      try {
        const from = new Date(now.getTime() - def.window_hours * 3_600_000);
        return evaluateSlo(def, await source.window(def.series, from, now), nowIso);
      } catch (err) {
        return {
          id: def.id, label: def.label, status: "UNKNOWN" as const, value: null, target: def.target, metric: def.metric, samples: 0,
          window_hours: def.window_hours, source: SOURCE[def.series] ?? def.series, observed_at: nowIso,
          detail: `måling feilet: ${(err as Error).message.slice(0, 100)}`
        };
      }
    })
  );
}
