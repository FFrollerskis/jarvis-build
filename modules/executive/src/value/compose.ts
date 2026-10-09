import { VALUE_METRIC_CATALOG, VALUE_NOT_MEASURED_STATIC } from "./catalog.ts";
import { renderValueReportNo } from "./render.ts";
import { cleanReason } from "./text.ts";
import type {
  BuilderLoopVerdict, OpsProposalReport, ValueLoopStatus, ValueMeasurement, ValueMetric, ValueMetricDef, ValueReport, ValueWindows
} from "./types.ts";

export interface ComposeValueInput {
  as_of: string;
  windows: ValueWindows | null;
  measurements: readonly ValueMeasurement[];
  /** Hele kilden feilet eller mangler: alle metrikker blir `not_measurable` med denne årsaken (aldri 0). */
  source_error_no?: string;
  loops: readonly ValueLoopStatus[];
  builder_loop: BuilderLoopVerdict;
  ops_proposals: OpsProposalReport;
}

type Slot = "last_7d" | "last_30d";
const SLOTS: readonly Slot[] = ["last_7d", "last_30d"];

function notMeasurable(def: ValueMetricDef, reason: string): ValueMetric {
  return {
    id: def.id, group: def.group, label_no: def.label_no, unit: def.unit, shape: def.shape, state: "not_measurable",
    now: null, last_7d: null, last_30d: null, source: def.source, ...(def.note_no !== undefined ? { note_no: def.note_no } : {}), reason_no: cleanReason(reason)
  };
}

/** Et tall fra en kilde er gyldig når det er endelig og ikke-negativt. undefined/null er «ingen grunnlag». */
function slotValue(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return { ok: true, value: v };
  return { ok: false };
}

function baseMetric(def: ValueMetricDef, measurement: ValueMeasurement | undefined, sourceError: string | undefined): ValueMetric {
  if (def.never_measurable_reason_no !== undefined) return notMeasurable(def, def.never_measurable_reason_no);
  if (sourceError !== undefined) return notMeasurable(def, `kilden er utilgjengelig: ${sourceError}`);
  if (measurement === undefined) return notMeasurable(def, "kilden leverte ingen måling");
  if (measurement.state === "not_measurable") return notMeasurable(def, measurement.reason_no);
  const now = slotValue(measurement.now);
  const d7 = slotValue(measurement.last_7d);
  const d30 = slotValue(measurement.last_30d);
  if (!now.ok || !d7.ok || !d30.ok) return notMeasurable(def, "ugyldig måling (ikke et endelig, ikke-negativt tall)");
  // Kun tallene formen har mening for beholdes: en vindusmetrikk har ikke «nå», et øyeblikksbilde har ikke vinduer.
  const isWindow = def.shape === "window";
  return {
    id: def.id, group: def.group, label_no: def.label_no, unit: def.unit, shape: def.shape, state: "measured",
    now: isWindow ? null : now.value, last_7d: isWindow ? d7.value : null, last_30d: isWindow ? d30.value : null,
    source: def.source, ...(def.note_no !== undefined ? { note_no: def.note_no } : {})
  };
}

function round(unit: ValueMetricDef["unit"], v: number): number {
  if (unit === "ratio") return Math.round(v * 1000) / 1000;
  if (unit === "ore" || unit === "seconds") return Math.round(v);
  return Math.round(v * 10) / 10;
}

/** Avledet metrikk: sum(num) / sum(den) per vindu. Manglende eller ikke-målbar inngang gir `not_measurable`; nevner 0 gir «ingen grunnlag» (null), aldri 0. */
function derivedMetric(def: ValueMetricDef, done: ReadonlyMap<string, ValueMetric>): ValueMetric {
  const derive = def.derive;
  if (derive === undefined) return notMeasurable(def, "ingen avledning definert");
  const num = done.get(derive.num);
  const dens = derive.den.map((id) => done.get(id));
  if (num === undefined || dens.some((d) => d === undefined)) return notMeasurable(def, "avhengige målinger mangler");
  if (num.state !== "measured" || dens.some((d) => d?.state !== "measured")) return notMeasurable(def, "en avhengig måling er ikke målbar");
  const out: Record<Slot, number | null> = { last_7d: null, last_30d: null };
  for (const slot of SLOTS) {
    const n = num[slot];
    const ds = dens.map((d) => d?.[slot] ?? null);
    if (n === null || ds.some((x) => x === null)) continue;
    const den = ds.reduce<number>((a, x) => a + (x ?? 0), 0);
    if (den <= 0) continue;
    out[slot] = round(def.unit, n / den);
  }
  return {
    id: def.id, group: def.group, label_no: def.label_no, unit: def.unit, shape: "window", state: "measured",
    now: null, last_7d: out.last_7d, last_30d: out.last_30d, source: def.source, ...(def.note_no !== undefined ? { note_no: def.note_no } : {})
  };
}

/**
 * Setter sammen Value Center-rapporten av målinger fra en kilde. Strukturelt ærlig: HVER katalog-metrikk er med i rapporten, og en metrikk uten gyldig måling er `not_measurable` med årsak - aldri 0. Kildens egne
 * tekster (årsaker) vaskes (`cleanReason`) før de vises. Rapporten bærer ingen annen tekst enn faste etiketter og tall.
 */
export function composeValueReport(input: ComposeValueInput): ValueReport {
  const byId = new Map<string, ValueMeasurement>();
  for (const m of input.measurements) if (typeof m?.id === "string" && !byId.has(m.id)) byId.set(m.id, m);
  const sourceError = input.source_error_no === undefined ? undefined : cleanReason(input.source_error_no);

  const done = new Map<string, ValueMetric>();
  const metrics: ValueMetric[] = [];
  for (const def of VALUE_METRIC_CATALOG) {
    const metric = def.derive !== undefined && def.never_measurable_reason_no === undefined && sourceError === undefined
      ? derivedMetric(def, done)
      : baseMetric(def, byId.get(def.id), sourceError);
    done.set(def.id, metric);
    metrics.push(metric);
  }

  const dynamic = metrics
    .filter((m) => m.state === "not_measurable" && VALUE_METRIC_CATALOG.find((d) => d.id === m.id)?.never_measurable_reason_no === undefined)
    .map((m) => `${m.label_no}: ${m.reason_no ?? "ukjent årsak"}`);
  const base = {
    as_of: input.as_of,
    time_zone: "Europe/Oslo" as const,
    windows: input.windows,
    metrics,
    loops: [...input.loops],
    builder_loop: input.builder_loop,
    ops_proposals: input.ops_proposals,
    not_measured: [...new Set([...VALUE_NOT_MEASURED_STATIC, ...dynamic])]
  };
  return { ...base, summary_no: renderValueReportNo(base) };
}
