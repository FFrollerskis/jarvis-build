import { assertMinimalFacts, ruleFor, type BridgeContext, type BridgeResult, type HealthSignalMetric } from "./signal-types.ts";

/**
 * WP-G4 (D-466), UA-10 P1b: avvik fra EIERENS EGEN baseline (hvilepuls, søvn, aktivitet) - REN funksjon over en liten daglig serie. Ingen I/O, ingen klokke (`ctx.nowMs`), ingen modell.
 *
 * BEGRENSEDE data (SECRET_RESTRICTED, utførelsesvern): serien (dag + ett tall per dag) er det ENESTE rå som passerer porten, og den leses KUN i denne funksjonen i prosessen. Det som forlater funksjonen er
 * avledet og minimert: `direction` (over/under), `severity` (mild/moderat/sterk), antall dager på rad og når episoden startet. Ingen måleverdi, ingen baselineverdi og ingen z-verdi havner i `reason`,
 * `facts`, logg eller varsel. `reason` bærer kun den LUKKEDE kategorien (hvilepuls/søvn/aktivitet) og en fast tekst («Avvik fra din egen baseline ... ikke medisinsk rådgivning»). Motoren kan ikke utføre ACT i domenet (`NEVER_ACT_DOMAINS`), og konfidens utelates alltid
 * slik at stadiet aldri går forbi `inform`: Jarvis gir ikke medisinsk råd, den sier bare at noe avviker fra eierens vanlige mønster.
 *
 * Metode (deterministisk, robust): fullførte døgn (UTC, alle dager før i dag) deles i et `recent`-vindu (siste 3 dager) og en baseline (inntil 28 dager før det, minst 14). Baseline = median og MAD
 * (skalert 1,4826) - ikke gjennomsnitt, så et enkelt ekstremt døgn flytter ikke baselinen. Et avvik krever at ALLE de siste 3 dagene ligger |z| >= terskelen på SAMME side av baselinen (terskelen er tunbar
 * innenfor harde grenser, se `RULES`). Det gir ingen enkeltmåling-alarm og ingen varsel uten nok historikk (færre enn 14 baselinedager = ingen signal, aldri en gjetning).
 * `DEFERRED`: tidssone-bevisste døgn (UTC-døgn brukes), søvnstadier, trend over uker, og sammenligning mot alder/kjønn (ikke bygget og ikke ønsket: kun eierens egen baseline).
 */
export interface DailyPoint {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  /** Døgnets verdi (hvilepuls: gjennomsnitt, søvn: sum minutter, skritt: sum). */
  value: number;
  samples: number;
}

export interface HealthObservation {
  source: "health";
  metric: HealthSignalMetric;
  series: readonly DailyPoint[];
}

export const BASELINE_DAYS = 28;
export const MIN_BASELINE_DAYS = 14;
export const RECENT_DAYS = 3;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const METRIC_EVENT: Readonly<Record<HealthSignalMetric, string>> = {
  resting_heart_rate: "resting_heart_rate_deviation",
  sleep_duration_minutes: "sleep_duration_deviation",
  steps: "activity_deviation"
};
const METRIC_LABEL: Readonly<Record<HealthSignalMetric, string>> = { resting_heart_rate: "hvilepuls", sleep_duration_minutes: "søvn", steps: "aktivitet" };

export type DeviationSeverity = "mild" | "moderate" | "strong";
export interface Deviation {
  direction: "above" | "below";
  severity: DeviationSeverity;
  /** Antall dager på rad (maks 30) som avviker på samme side. */
  consecutive_days: number;
  /** Første dag i denne episoden (stabil så lenge episoden varer). */
  episode_start_day: string;
  baseline_days: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Ren avviksberegning. `null` = ikke nok data eller ikke noe avvik. Eksportert for direkte test. */
export function detectDeviation(series: readonly DailyPoint[], zThreshold: number, nowMs: number): Deviation | null {
  if (!Number.isFinite(zThreshold) || zThreshold <= 0) return null;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const byDay = new Map<string, number>();
  for (const p of series) {
    if (!DAY_RE.test(p.day) || !Number.isFinite(p.value) || !(p.samples > 0)) continue;
    if (p.day >= today) continue; // kun fullførte døgn
    byDay.set(p.day, p.value);
  }
  const days = [...byDay.keys()].sort();
  if (days.length < MIN_BASELINE_DAYS + RECENT_DAYS) return null;

  const recentDays = days.slice(-RECENT_DAYS);
  const lastDay = days[days.length - 1] as string;
  // Serien må være FERSK: siste fullførte døgn er i går eller i forgårs (ikke et gammelt utsnitt).
  if (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`) > 2 * DAY_MS) return null;

  const baselineValues = days.slice(0, -RECENT_DAYS).slice(-BASELINE_DAYS).map((d) => byDay.get(d) as number);
  if (baselineValues.length < MIN_BASELINE_DAYS) return null;
  const center = median(baselineValues);
  const mad = median(baselineValues.map((v) => Math.abs(v - center)));
  const sigma = Math.max(mad * 1.4826, Math.abs(center) * 0.03, 1e-6);
  const z = (v: number): number => (v - center) / sigma;

  // Løpet av avvikende døgn bakover fra siste dag, samme side.
  const lastZ = z(byDay.get(lastDay) as number);
  if (Math.abs(lastZ) < zThreshold) return null;
  const sign = Math.sign(lastZ);
  let run = 0;
  let startDay = lastDay;
  for (let i = days.length - 1; i >= 0 && run < 30; i -= 1) {
    const d = days[i] as string;
    const dz = z(byDay.get(d) as number);
    if (Math.sign(dz) !== sign || Math.abs(dz) < zThreshold) break;
    run += 1;
    startDay = d;
  }
  if (run < RECENT_DAYS) return null;
  const meanAbs = recentDays.reduce((acc, d) => acc + Math.abs(z(byDay.get(d) as number)), 0) / recentDays.length;
  const severity: DeviationSeverity = meanAbs >= 4 ? "strong" : meanAbs >= 3 ? "moderate" : "mild";
  return { direction: sign > 0 ? "above" : "below", severity, consecutive_days: run, episode_start_day: startDay, baseline_days: baselineValues.length };
}

export function bridgeHealthObservation(obs: HealthObservation, ctx: BridgeContext): BridgeResult | null {
  const eventType = METRIC_EVENT[obs.metric];
  const rule = eventType === undefined ? undefined : ruleFor("health", eventType);
  if (rule === undefined) return null;
  const deviation = detectDeviation(obs.series, ctx.threshold(rule) ?? 2, ctx.nowMs);
  if (deviation === null) return null;
  const key = `health:${obs.metric}:${deviation.direction}:${deviation.episode_start_day}`;
  const facts = { metric: obs.metric, direction: deviation.direction, severity: deviation.severity, days: deviation.consecutive_days, baseline_days: deviation.baseline_days };
  assertMinimalFacts(facts);
  return {
    rule_key: rule.rule_key, source: "health", event_type: eventType,
    candidate: {
      domain: rule.domain, detection_key: key,
      // Sterk avvik = høy prioritet (sortering), men ALDRI konfidens: stadiet blir `inform` (ingen forslag, ingen ACT).
      priority: deviation.severity === "strong" ? "high" : "normal",
      reason: `Avvik fra din egen baseline (${METRIC_LABEL[obs.metric]}) - åpne Jarvis for detaljer. Dette er ikke medisinsk rådgivning.`
    },
    source_ref: `${key}#${deviation.severity}`,
    facts, urgent: false, occurred_at: `${deviation.episode_start_day}T00:00:00.000Z`
  };
}
