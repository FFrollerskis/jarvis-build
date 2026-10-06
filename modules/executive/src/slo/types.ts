/**
 * EV-2 (D-417, Evolution Masterplan v1.2 kap. 9): telemetri, SLO-er og drift. Bruker den EKSISTERENDE observerbarheten som autoritativ kilde
 * (`cost_events`, `tool_executions`, `tasks`, `memory_items`) - det bygges INGEN parallell telemetri. Ingen LLM i målingen; ukjent er UNKNOWN,
 * aldri «bra» (samme disiplin som EV-1).
 */

/** En serie av målinger Jarvis allerede har. */
export type SeriesId = "model:CHAT" | "model:BACKGROUND" | "tools" | "jobs";

/** Aggregat for ett tidsvindu. `p*` er null når vinduet er tomt. */
export interface SeriesWindow {
  from: string;
  to: string;
  count: number;
  ok: number;
  p50_ms: number | null;
  p95_ms: number | null;
  ttft_p95_ms: number | null;
  /** Sum øre i vinduet (0 for serier uten kostnad). */
  cost_ore: number;
}

export interface SloSource {
  window(series: SeriesId, from: Date, to: Date): Promise<SeriesWindow>;
}

export type SloMetric = "success_rate" | "p95_ms" | "ttft_p95_ms";

export interface SloDefinition {
  id: string;
  label: string;
  series: SeriesId;
  metric: SloMetric;
  /** success_rate: minimum (0-1). p95_ms/ttft_p95_ms: maksimum i ms. */
  target: number;
  window_hours: number;
  /** Færre målinger enn dette gir UNKNOWN (aldri OK ut fra for lite data). */
  min_samples: number;
}

export type SloStatus = "OK" | "BREACH" | "UNKNOWN";

export interface SloResult {
  id: string;
  label: string;
  status: SloStatus;
  value: number | null;
  target: number;
  metric: SloMetric;
  samples: number;
  window_hours: number;
  source: string;
  observed_at: string;
  detail: string;
}

export interface DriftFinding {
  series: SeriesId;
  metric: "success_rate" | "p95_ms" | "ttft_p95_ms" | "cost_per_call_ore";
  baseline: number;
  recent: number;
  /** success_rate: absolutt fall (0-1). Øvrige: relativ økning (0.5 = +50 %). */
  change: number;
  baseline_samples: number;
  recent_samples: number;
  source: string;
  detail: string;
}

export interface DriftReport {
  findings: DriftFinding[];
  /** Serier der baseline eller siste vindu hadde for få målinger til å vurdere drift. */
  insufficient: SeriesId[];
  baseline_window: { from: string; to: string };
  recent_window: { from: string; to: string };
}

export type DataQualityKind = "contradictory" | "duplicate" | "expired_but_active" | "stale_quarantine" | "corrupted";

export interface DataQualityCheck {
  kind: DataQualityKind;
  label: string;
  /** null = ikke målt (feilet eller bevisst ikke bygget - se `deferred`). */
  count: number | null;
  deferred?: string;
  source: string;
}

export interface DataQualityReport {
  checks: DataQualityCheck[];
  observed_at: string;
}

export interface SloReport {
  as_of: string;
  slos: SloResult[];
  drift: DriftReport | null;
  data_quality: DataQualityReport | null;
  /** Hva som ikke er målt (aldri stille utelatt). */
  not_measured: string[];
  /** Deterministisk norsk oppsummering (ingen LLM). */
  summary_no?: string;
}
