import type { SelfStatus } from "./types.ts";

/**
 * EV-1: metrikk-avledet confidence gate (Evolution Masterplan v1.2 kap. 8). Confidence som brukes til gating er et RESULTAT av målbare signaler -
 * modellens verbale «jeg er 95 % sikker» kan logges som metadata, men får ALDRI bestemme tillatelse, risikoklasse eller release.
 * Derfor har `ConfidenceSignals` bevisst INGEN felt for selvrapportert sikkerhet, og funksjonen avviser input som likevel bærer et slikt felt.
 * Mangler et signal, er det et funn (`missing`) og gir et lavere bånd - ukjent er aldri bra.
 */
export interface ConfidenceSignals {
  /** Evalresultat (0..1) og endring mot forrige baseline. Lav score/negativ delta eskalerer/stopper. */
  eval?: { score: number; delta?: number };
  /** Kildekvalitet: uavhengige kilder og om en primærkilde finnes. */
  evidence?: { independent_sources: number; primary_source: boolean };
  /** Datakvalitet: ferskhet og motsigelser. */
  data?: { fresh: boolean; contradictory: boolean };
  /** Historisk utfall for samme endringstype. */
  history?: { successes: number; failures: number };
  /** Verktøy-/kjøretidssignaler: tester, helse, delvis utførelse. */
  runtime?: { tests_passed: boolean | null; health: SelfStatus; partial_execution: boolean };
  /** Uavklarte krav / manglende observerbarhet. */
  ambiguity?: { unresolved_requirements: number };
}

export type GateBand = "auto" | "canary" | "owner" | "blocked";

export interface GatePolicy {
  /** Minste score for `auto` / `canary`; under `canary` -> `owner`. */
  min_auto: number;
  min_canary: number;
  /** Minste evalscore før noe annet enn `owner`/`blocked` er mulig. */
  min_eval: number;
  /** Minste antall historiske utfall før historikk teller som evidens. */
  min_history_samples: number;
}

export const DEFAULT_GATE_POLICY: Readonly<GatePolicy> = Object.freeze({ min_auto: 0.85, min_canary: 0.65, min_eval: 0.8, min_history_samples: 5 });

export interface GateResult {
  /** 0..1, eller null når for få signaler til å regne en score. */
  score: number | null;
  band: GateBand;
  reasons: string[];
  /** Signaler som mangler (hvert gir lavere bånd). */
  missing: string[];
}

const SELF_REPORT_KEY = /confidence|self.?report|self.?assess|model.?(sure|certain|belief)|verbal/i;

function assertNoSelfReport(value: unknown, path = "signals"): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SELF_REPORT_KEY.test(key)) throw new Error(`self_reported_confidence_not_allowed:${path}.${key}`);
    assertNoSelfReport(inner, `${path}.${key}`);
  }
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function computeConfidenceGate(signals: ConfidenceSignals, policy: Readonly<GatePolicy> = DEFAULT_GATE_POLICY): GateResult {
  assertNoSelfReport(signals);
  const reasons: string[] = [];
  const missing: string[] = [];
  const parts: Array<{ weight: number; value: number }> = [];
  let block = false;
  let escalate = false;

  if (signals.eval === undefined) missing.push("eval");
  else {
    parts.push({ weight: 0.35, value: clamp01(signals.eval.score) });
    if (signals.eval.score < policy.min_eval) { escalate = true; reasons.push(`evalscore ${signals.eval.score} under ${policy.min_eval}`); }
    if ((signals.eval.delta ?? 0) < 0) { escalate = true; reasons.push("negativ eval-delta mot baseline"); }
  }

  if (signals.evidence === undefined) missing.push("evidence");
  else {
    const e = signals.evidence;
    parts.push({ weight: 0.2, value: clamp01((e.primary_source ? 0.5 : 0) + Math.min(e.independent_sources, 2) * 0.25) });
    if (!e.primary_source && e.independent_sources < 2) reasons.push("svak kildedekning (ingen primærkilde, under to uavhengige kilder)");
  }

  if (signals.data === undefined) missing.push("data");
  else {
    parts.push({ weight: 0.15, value: signals.data.fresh && !signals.data.contradictory ? 1 : 0 });
    if (signals.data.contradictory) { escalate = true; reasons.push("motstridende data"); }
    if (!signals.data.fresh) reasons.push("foreldede data");
  }

  if (signals.history === undefined) missing.push("history");
  else {
    const n = signals.history.successes + signals.history.failures;
    if (n < policy.min_history_samples) { missing.push("history_samples"); reasons.push(`for få historiske utfall (${n} < ${policy.min_history_samples})`); }
    else parts.push({ weight: 0.1, value: signals.history.successes / n });
  }

  if (signals.runtime === undefined) missing.push("runtime");
  else {
    const r = signals.runtime;
    const healthValue = r.health === "OK" ? 1 : r.health === "DEGRADED" ? 0.4 : 0;
    parts.push({ weight: 0.2, value: (r.tests_passed === true ? 1 : 0) * 0.6 + healthValue * 0.4 });
    if (r.partial_execution) { block = true; reasons.push("ufullstendig verifikasjon = ikke release"); }
    if (r.tests_passed === null) reasons.push("tester ikke kjørt");
    else if (!r.tests_passed) { block = true; reasons.push("tester feilet"); }
    if (r.health === "DOWN") { block = true; reasons.push("system nede"); }
    else if (r.health === "UNKNOWN") reasons.push("systemhelse ukjent");
  }

  if (signals.ambiguity === undefined) missing.push("ambiguity");
  else if (signals.ambiguity.unresolved_requirements > 0) {
    escalate = true;
    reasons.push(`${signals.ambiguity.unresolved_requirements} uavklarte krav - ukjent risiko går til eier`);
  }

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  // Score regnes kun når minst halvparten av vektene har målinger; ellers er den null (ukjent), og båndet blir `owner` (aldri `auto`).
  const score = totalWeight >= 0.5 ? parts.reduce((s, p) => s + p.weight * p.value, 0) / totalWeight : null;

  let band: GateBand;
  if (block) band = "blocked";
  else if (score === null) { band = "owner"; reasons.push("for få målte signaler til å regne en score"); }
  else if (escalate) band = "owner";
  else if (missing.length > 0) band = score >= policy.min_canary ? "canary" : "owner";
  else band = score >= policy.min_auto ? "auto" : score >= policy.min_canary ? "canary" : "owner";

  return { score: score === null ? null : Math.round(score * 1000) / 1000, band, reasons, missing };
}
