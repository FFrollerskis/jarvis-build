import { deterministicLoopConfidence, HEURISTIC_LOOP_TYPES } from "./open-loop-types.ts";

/**
 * WP-D2 (JARVIS-045): `business_open_loops.confidence` skrevet fra FLERE signaler i stedet for en konstant per regeltype, og en kalibreringsrapport som sammenligner forutsagt
 * confidence mot faktisk utfall. REN logikk uten I/O (samme stil som scoring-rules.ts/churn-rules.ts): versjonert, forklarbar (hver justering lister kode, delta og begrunnelse)
 * og deterministisk. Ingen modellkall.
 *
 * HVORFOR (D-396 / JARVIS-045): konstantene 0.9 (hardt faktum: frist passert, ticket uten svar ...) / 0.7 (heuristikk: dager uten aktivitet, utgiftsavvik mot snitt)
 * er KALIBRERINGSFORSLAG. Situasjonsmotoren gir `suggest` kun ved høy prioritet og confidence >= 0.75 (`computeTargetStage`), og auto-ACT er kun mulig for `suggest` med
 * en eier-bundet autonomi-policy. Denne modulen gjør confidence EVIDENSBASERT uten å gjøre SUGGEST lettere å nå enn eieren har grunnlag for:
 *   - justeringene legger KUN til (persistens, forfall-størrelse, uavhengig bekreftelse fra andre domener hos samme kunde, flere uavhengige signalfamilier i regelen selv);
 *   - en HEURISTIKK kan ikke nå `suggest`-terskelen på justeringer alene: taket er `heuristic_ceiling` (0.74) inntil KALIBRERINGEN viser at loop-typen faktisk treffer
 *     (nok merkede utfall og observert treffrate >= 0.75). Retten til å foreslå må fortjenes av data, ikke av antakelser;
 *   - kalibreringen kan også SENKE confidence (observert treffrate lavere enn forutsagt).
 * Verdiene er forslag (NEEDS_TOBIAS); kalibreringsrapporten er verktøyet for å justere dem (ny regelversjon, aldri en stille mutasjon).
 */
export const CONFIDENCE_RULE_VERSION = "loop_confidence_v1";

export const CONFIDENCE_V1 = {
  floor: 0.1,
  hard_ceiling: 0.97,
  /** Under situasjonsmotorens `suggest`-terskel (0.75): en ukalibrert heuristikk gir aldri SUGGEST. */
  heuristic_ceiling: 0.74,
  suggest_threshold: 0.75,
  /** Dager loopen har vært åpen sammenhengende (vilkåret har holdt over flere sveip - ikke en forbigående glitch). Beste treff gjelder. */
  persistence: [{ min_days: 7, bonus: 0.03 }, { min_days: 3, bonus: 0.02 }],
  /** Dager forfalt (kun frist-baserte regler). Beste treff gjelder. */
  overdue_magnitude: [{ min_days: 14, bonus: 0.02 }, { min_days: 7, bonus: 0.01 }],
  /** Antall DISTINKTE andre domenefamilier med en åpen loop hos samme kunde (uavhengig bekreftelse - to loops i samme domene teller som ett). Beste treff gjelder. */
  corroboration: [{ min_domains: 2, bonus: 0.05 }, { min_domains: 1, bonus: 0.03 }],
  /** Ekstra uavhengige signalfamilier regelen selv fant (f.eks. bruk + support + fakturering): bonus per familie utover den første, maks to. */
  intrinsic_signal_bonus: 0.03,
  intrinsic_signal_max: 2,
  calibration: {
    /** Minst så mange MERKEDE utfall (acted/dismissed) før kalibreringen får påvirke confidence eller løfte taket. */
    min_samples: 20,
    /** Vekt på observert treffrate = n / (n + half_weight_samples), maks `max_weight`. */
    half_weight_samples: 50,
    max_weight: 0.5,
    /** Observert treffrate som kreves for å løfte heuristikk-taket. */
    lift_ceiling_hit_rate: 0.75,
    /** Avviket (forutsagt - observert) som regnes som tydelig feilkalibrert. */
    tolerance: 0.1
  }
} as const;

export interface LoopTypeCalibration {
  /** Antall MERKEDE utfall (acted + dismissed) for loop-typen. */
  n_labelled: number;
  /** Andel av de merkede utfallene som var `acted` (0-1). */
  hit_rate: number;
}

export interface LoopConfidenceInput {
  loop_type: string;
  /** Dager siden loopen ble åpnet (0 = første deteksjon). */
  persisted_days: number;
  /** Dager forfalt for frist-baserte regler, ellers `null`. */
  overdue_days: number | null;
  /** Antall distinkte andre domenefamilier med en åpen loop hos samme kunde (se `corroboratesEachOther`). */
  corroborating_domains: number;
  /** Ekstra uavhengige signalfamilier regelen selv fant (0 = én familie / ikke relevant). */
  intrinsic_signals: number;
  calibration: LoopTypeCalibration | null;
}

export interface ConfidenceAdjustment {
  code: string;
  delta: number;
  note: string;
}

/** Hvorfor confidence ble som den ble - lagres i `business_open_loops.confidence_basis` (forklarbart, ingen persondata). */
export interface ConfidenceBasis {
  rule_version: string;
  base: number;
  adjustments: ConfidenceAdjustment[];
  /** Ble justert opp mot et tak? */
  capped: "heuristic_ceiling" | "hard_ceiling" | "floor" | null;
  calibrated: boolean;
  calibration_n: number | null;
  observed_hit_rate: number | null;
  /** Antall uavhengige signalfamilier regelen selv fant ut over den første (leses tilbake av neste sveip). */
  intrinsic_signals: number;
}

export interface LoopConfidenceResult {
  confidence: number;
  basis: ConfidenceBasis;
}

const round2 = (n: number): number => Math.round(n * 100) / 100 + 0; // + 0: aldri -0 (Math.round(-0.001) er -0)
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

function bestTier<T extends { bonus: number }>(tiers: readonly T[], matches: (t: T) => boolean): T | undefined {
  return tiers.filter(matches).sort((a, b) => b.bonus - a.bonus)[0];
}

export function isHeuristicLoopType(loopType: string): boolean {
  return (HEURISTIC_LOOP_TYPES as ReadonlySet<string>).has(loopType);
}

/** Confidence for én åpen loop fra flere signaler. Ren funksjon - samme input gir alltid samme resultat. */
export function computeLoopConfidence(input: LoopConfidenceInput): LoopConfidenceResult {
  const base = deterministicLoopConfidence(input.loop_type);
  const heuristic = isHeuristicLoopType(input.loop_type);
  const adjustments: ConfidenceAdjustment[] = [];
  const add = (code: string, delta: number, note: string): void => { adjustments.push({ code, delta: round2(delta), note }); };

  const persistence = bestTier(CONFIDENCE_V1.persistence, (t) => input.persisted_days >= t.min_days);
  if (persistence) add("persistence", persistence.bonus, `Vilkåret har holdt i ${Math.floor(input.persisted_days)} dager (ikke en forbigående glitch)`);

  if (input.overdue_days !== null) {
    const overdue = bestTier(CONFIDENCE_V1.overdue_magnitude, (t) => (input.overdue_days as number) >= t.min_days);
    if (overdue) add("overdue_magnitude", overdue.bonus, `Fristen er passert med ${Math.floor(input.overdue_days)} dager`);
  }

  const corroboration = bestTier(CONFIDENCE_V1.corroboration, (t) => input.corroborating_domains >= t.min_domains);
  if (corroboration) add("corroboration", corroboration.bonus, `${input.corroborating_domains} andre ${input.corroborating_domains === 1 ? "domene" : "domener"} har åpne saker hos samme kunde og bekrefter bildet`);

  const intrinsic = clamp(Math.trunc(input.intrinsic_signals), 0, CONFIDENCE_V1.intrinsic_signal_max);
  if (intrinsic > 0) add("independent_signals", intrinsic * CONFIDENCE_V1.intrinsic_signal_bonus, `${intrinsic + 1} uavhengige signalfamilier slo ut samtidig`);

  let value = base + adjustments.reduce((s, a) => s + a.delta, 0);

  const cal = input.calibration;
  const calibrated = cal !== null && cal.n_labelled >= CONFIDENCE_V1.calibration.min_samples;
  let observed: number | null = null;
  if (calibrated && cal !== null) {
    observed = clamp(cal.hit_rate, 0, 1);
    const w = Math.min(CONFIDENCE_V1.calibration.max_weight, cal.n_labelled / (cal.n_labelled + CONFIDENCE_V1.calibration.half_weight_samples));
    const mixed = (1 - w) * value + w * observed;
    add("calibration", mixed - value, `Observert treffrate ${Math.round(observed * 100)} % over ${cal.n_labelled} merkede utfall (vekt ${Math.round(w * 100)} %)`);
    value = mixed;
  }

  // Tak: hardt faktum 0.97. Heuristikk 0.74 (under SUGGEST) inntil kalibreringen viser at loop-typen treffer.
  const liftedCeiling = calibrated && observed !== null && observed >= CONFIDENCE_V1.calibration.lift_ceiling_hit_rate;
  const ceiling = heuristic && !liftedCeiling ? CONFIDENCE_V1.heuristic_ceiling : CONFIDENCE_V1.hard_ceiling;
  let capped: ConfidenceBasis["capped"] = null;
  if (value > ceiling) { value = ceiling; capped = heuristic && !liftedCeiling ? "heuristic_ceiling" : "hard_ceiling"; }
  if (value < CONFIDENCE_V1.floor) { value = CONFIDENCE_V1.floor; capped = "floor"; }

  return {
    confidence: round2(value),
    basis: {
      rule_version: CONFIDENCE_RULE_VERSION, base, adjustments, capped, calibrated,
      calibration_n: cal?.n_labelled ?? null, observed_hit_rate: observed === null ? null : round2(observed), intrinsic_signals: intrinsic
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Kalibreringsrapport: forutsagt confidence mot faktisk utfall
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * `acted`: eieren/operatøren handlet på loopen (treff). `dismissed`: eieren avviste den som irrelevant (bom). `condition_cleared`: vilkåret forsvant av seg selv - UMERKET (kan være
 * både «noen fikset det» og «forbigående støy»). `unlabelled`: lukket av en operatør uten å oppgi utfall. `open`: ikke avgjort ennå.
 */
export type LoopOutcome = "acted" | "dismissed" | "condition_cleared" | "unlabelled" | "open";

export interface CalibrationObservation {
  loop_type: string;
  confidence: number | null;
  outcome: LoopOutcome;
}

export type CalibrationVerdict = "insufficient_data" | "well_calibrated" | "overconfident" | "underconfident";

export interface ReliabilityBucket {
  lower: number;
  upper: number;
  n: number;
  mean_confidence: number | null;
  hit_rate: number | null;
}

export interface CalibrationGroup {
  n_total: number;
  n_labelled: number;
  n_acted: number;
  n_dismissed: number;
  n_condition_cleared: number;
  n_unlabelled: number;
  n_open: number;
  /** Snitt av forutsagt confidence over de MERKEDE utfallene. */
  mean_confidence: number | null;
  /** acted / (acted + dismissed). */
  hit_rate: number | null;
  /** Brier-score over de merkede utfallene (0 = perfekt, 0.25 = tilfeldig ved 0.5). */
  brier: number | null;
  /** Forutsagt - observert (positivt = overkonfident). */
  gap: number | null;
  verdict: CalibrationVerdict;
  buckets: ReliabilityBucket[];
}

export interface CalibrationReport {
  rule_version: string;
  min_samples: number;
  overall: CalibrationGroup;
  by_type: Array<{ loop_type: string; heuristic: boolean } & CalibrationGroup>;
  notes: string[];
}

const BUCKET_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001] as const;

function emptyGroup(): CalibrationGroup {
  return {
    n_total: 0, n_labelled: 0, n_acted: 0, n_dismissed: 0, n_condition_cleared: 0, n_unlabelled: 0, n_open: 0,
    mean_confidence: null, hit_rate: null, brier: null, gap: null, verdict: "insufficient_data", buckets: []
  };
}

export function summarizeCalibration(observations: readonly CalibrationObservation[], minSamples: number = CONFIDENCE_V1.calibration.min_samples): CalibrationGroup {
  const g = emptyGroup();
  const labelled: Array<{ c: number; y: number }> = [];
  for (const o of observations) {
    g.n_total += 1;
    if (o.outcome === "acted" || o.outcome === "dismissed") {
      if (o.confidence === null || !Number.isFinite(o.confidence)) { g.n_unlabelled += 1; continue; } // uten forutsagt verdi finnes ingenting å sammenligne
      g.n_labelled += 1;
      if (o.outcome === "acted") g.n_acted += 1; else g.n_dismissed += 1;
      labelled.push({ c: clamp(o.confidence, 0, 1), y: o.outcome === "acted" ? 1 : 0 });
    } else if (o.outcome === "condition_cleared") g.n_condition_cleared += 1;
    else if (o.outcome === "open") g.n_open += 1;
    else g.n_unlabelled += 1;
  }
  g.buckets = BUCKET_EDGES.slice(0, -1).map((lower, i): ReliabilityBucket => {
    const upper = BUCKET_EDGES[i + 1] as number;
    const inBucket = labelled.filter((x) => x.c >= lower && x.c < upper);
    return {
      lower, upper: Math.min(upper, 1), n: inBucket.length,
      mean_confidence: inBucket.length ? round2(inBucket.reduce((s, x) => s + x.c, 0) / inBucket.length) : null,
      hit_rate: inBucket.length ? round2(inBucket.reduce((s, x) => s + x.y, 0) / inBucket.length) : null
    };
  });
  if (labelled.length === 0) return g;
  const mean = labelled.reduce((s, x) => s + x.c, 0) / labelled.length;
  const hit = labelled.reduce((s, x) => s + x.y, 0) / labelled.length;
  g.mean_confidence = round2(mean);
  g.hit_rate = round2(hit);
  g.brier = Math.round((labelled.reduce((s, x) => s + (x.c - x.y) ** 2, 0) / labelled.length) * 1000) / 1000;
  g.gap = round2(mean - hit);
  if (labelled.length >= minSamples) {
    g.verdict = (g.gap as number) > CONFIDENCE_V1.calibration.tolerance ? "overconfident" : (g.gap as number) < -CONFIDENCE_V1.calibration.tolerance ? "underconfident" : "well_calibrated";
  }
  return g;
}

/** Kalibreringsrapport over alle loops (åpne og lukkede) - samlet og per loop-type. Ren funksjon; `options.min_samples` kun for tester. */
export function buildCalibrationReport(observations: readonly CalibrationObservation[], options: { min_samples?: number } = {}): CalibrationReport {
  const minSamples = options.min_samples ?? CONFIDENCE_V1.calibration.min_samples;
  const types = [...new Set(observations.map((o) => o.loop_type))].sort();
  const overall = summarizeCalibration(observations, minSamples);
  const by_type = types.map((t) => ({
    loop_type: t, heuristic: isHeuristicLoopType(t), ...summarizeCalibration(observations.filter((o) => o.loop_type === t), minSamples)
  }));
  const notes: string[] = [];
  const closed = overall.n_total - overall.n_open;
  if (overall.n_total === 0) notes.push("Ingen loops å vurdere ennå.");
  else if (overall.n_labelled === 0) notes.push(`Ingen av ${closed} lukkede loops har et merket utfall (acted/dismissed) - oppgi utfall når du lukker en loop for å kunne kalibrere.`);
  else if (closed > 0) notes.push(`${overall.n_labelled} av ${closed} lukkede loops har et merket utfall; ${overall.n_condition_cleared} forsvant av seg selv (umerket) og ${overall.n_unlabelled} ble lukket uten utfall.`);
  for (const t of by_type) {
    if (t.verdict === "overconfident") notes.push(`${t.loop_type}: forutsagt ${t.mean_confidence} mot observert ${t.hit_rate} (n=${t.n_labelled}) - overkonfident; vurder lavere basisverdi.`);
    else if (t.verdict === "underconfident") notes.push(`${t.loop_type}: forutsagt ${t.mean_confidence} mot observert ${t.hit_rate} (n=${t.n_labelled}) - underkonfident; vurder høyere basisverdi.`);
    else if (t.verdict === "insufficient_data" && t.n_total > 0) notes.push(`${t.loop_type}: for få merkede utfall (${t.n_labelled} av ${minSamples} som kreves) til å konkludere.`);
  }
  notes.push("Rapporten endrer ingenting av seg selv: justering av terskler/vekter skjer som en ny regelversjon etter eierens vurdering (NEEDS_TOBIAS).");
  return { rule_version: CONFIDENCE_RULE_VERSION, min_samples: minSamples, overall, by_type, notes };
}

/** Kalibreringsdata per loop-type (til `computeLoopConfidence`) utledet fra en rapport. Typer uten nok merkede utfall utelates. */
export function calibrationByType(report: CalibrationReport): Map<string, LoopTypeCalibration> {
  const out = new Map<string, LoopTypeCalibration>();
  for (const t of report.by_type) {
    if (t.hit_rate !== null && t.n_labelled >= report.min_samples) out.set(t.loop_type, { n_labelled: t.n_labelled, hit_rate: t.hit_rate });
  }
  return out;
}

/**
 * To loops korroborerer hverandre bare når de kommer fra FORSKJELLIGE domenefamilier - og churn (retention) og support teller ikke som uavhengige: churn-regelen
 * bruker allerede åpne supportsaker som ett av sine egne signaler, så en supportloop som «bekrefter» churn ville telle samme fakta to ganger.
 */
export function corroboratesEachOther(familyA: string, familyB: string): boolean {
  if (familyA === familyB) return false;
  const pair = [familyA, familyB].sort().join("+");
  return pair !== "retention+support";
}

/** Domenefamilie for uavhengig bekreftelse (se `corroboratesEachOther`). */
export function loopFamily(loopType: string): string {
  if (loopType === "overdue_followup" || loopType === "stalled_opportunity") return "pipeline";
  if (loopType.startsWith("support_ticket_")) return "support";
  if (loopType.startsWith("contract_")) return "contract";
  if (loopType.startsWith("product_item_")) return "product";
  if (loopType.startsWith("operations_task_")) return "operations";
  if (loopType === "customer_churn_risk") return "retention";
  if (loopType === "marketing_spend_anomaly") return "growth";
  return "finance";
}
