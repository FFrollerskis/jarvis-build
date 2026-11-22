import type { SituationCandidateInput } from "./types.ts";

/**
 * WP-G4 (D-466), UA-10 P2e: de MANGLENDE rene anomali-detektorene etter revisjonen av hva som finnes (se runbook `WPG4_SITUATION_BRIDGES.md`, «P2e revisjon»). Spend/pipeline/frister er DEKKET av de 26 open-loop-typene
 * (`open-loop-bridge.ts`, uttømmende kartlagt) og infra av incidents (`infra-incident-bridge.ts`, D-195) - ingen av dem gjenbygges. To hull gjensto, begge uten noen situasjonskilde i dag:
 *
 *  1. AI-/tjenestekostnad som sprenger eierens egen vanlige dag (`detectSpendSpike`): hardgrensen (budsjettvakten) og SLO-driften (`cost_per_call`) finnes, men ingen av dem er en SITUASJON eieren blir varslet om FØR grensen nås.
 *  2. En planlagt jobb som ikke har fullført på et rimelig tidsrom (`detectStaleJobs`): `scheduler_state` vises i kontrollsenteret, men ingenting varsler når en jobb stilnet.
 *
 * Begge er REN: ingen I/O, ingen klokke (`nowMs` injiseres), ingen modell. Resultatet er en INFORM-kandidat (ALDRI konfidens => stadiet går aldri forbi `inform`, og et autonomt ACT-løp (`suggest`) berøres ikke) med en deterministisk,
 * innholdsfattig årsakstekst (forholdstall og jobbnavn, aldri beløp). Terskler har HARDE grenser i kode (som tunbare regler, D-397: ingen selvmodifikasjon); en ugyldig verdi klemmes, aldri avvises stille.
 *
 * STATUS: `BUILT_UNWIRED` - detektorene er bygget og testet, men INGEN leser mater dem ennå (en leser mot `cost_events`/`scheduler_state` og et abonnementsfilter krever en egen eierbeslutning om hvilke tenants/jobber og
 * forventede kadenser, se runbook). Å koble dem til er `DEFERRED`; inntil da kjører de aldri i drift. Et nytt `infra`-domene-signal MÅ gjenbruke incident-nøklene, fordi den daglige sveipen løser alle åpne `infra`-situasjoner som
 * ikke er aktive incidents (`resolveStaleForDomain`) - derfor bruker stale-jobb-kandidaten domenet `operations`.
 */
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const ANOMALY_BASELINE_DAYS = 28;
export const ANOMALY_MIN_BASELINE_DAYS = 14;

const clamp = (value: number | undefined, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

// ---------------------------------------------------------------------
// 1) Kostnadssprang
// ---------------------------------------------------------------------

export interface DailyAmount {
  /** `YYYY-MM-DD` (UTC). Dager mellom første og siste punkt som mangler i serien regnes som 0 (en dag uten kostnad trenger ikke en egen rad). */
  day: string;
  /** Ikke-negativt beløp i én fast enhet (øre). */
  amount: number;
}

export interface SpendSpikeOptions {
  /** Robust z-grense (standard 3,5; klemt [3, 8]). */
  zThreshold?: number;
  /** Minste forholdstall mot vanlig dag (standard 2; klemt [1,5, 20]). */
  minRatio?: number;
  /** Minste absolutte økning (standard 5000 = 50 kr; klemt [100, 10 000 000]). Hindrer varsel for småbeløp. */
  minDelta?: number;
}

export const SPEND_SPIKE_DEFAULTS = { zThreshold: 3.5, minRatio: 2, minDelta: 5_000 } as const;

export interface SpendSpike {
  /** Siste fullførte døgn som sprakk. */
  day: string;
  /** Forholdstall mot vanlig dag (avrundet til én desimal). */
  ratio: number;
  severity: "moderate" | "strong";
  baseline_days: number;
}

/**
 * Siste FULLFØRTE døgn mot eierens egen baseline (median og MAD over inntil 28 døgn før det, minst 14 døgn historikk). Kun OPPOVER (en billig dag er ikke en situasjon). Serien må være fersk (siste døgn er i går eller i forgårs).
 * Både robust z, forholdstall OG absolutt økning må overskrides: ingen varsel for småbeløp, ingen varsel uten historikk, ingen gjetning. En vanlig dag på 0 (median 0: sjelden eller periodisk kostnad) gir INGEN påstand - uten
 * en etablert vanlig dag finnes det ikke noe «vanlig» å avvike fra (`DEFERRED`: første betydelige kostnad etter en lang rolig periode).
 */
export function detectSpendSpike(series: readonly DailyAmount[], nowMs: number, options: SpendSpikeOptions = {}): SpendSpike | null {
  const zThreshold = clamp(options.zThreshold, SPEND_SPIKE_DEFAULTS.zThreshold, 3, 8);
  const minRatio = clamp(options.minRatio, SPEND_SPIKE_DEFAULTS.minRatio, 1.5, 20);
  const minDelta = clamp(options.minDelta, SPEND_SPIKE_DEFAULTS.minDelta, 100, 10_000_000);
  if (!Number.isFinite(nowMs)) return null;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const byDay = new Map<string, number>();
  for (const p of series) {
    if (typeof p !== "object" || p === null || !DAY_RE.test(p.day) || Number.isNaN(Date.parse(`${p.day}T00:00:00Z`)) || !Number.isFinite(p.amount) || p.amount < 0 || p.day >= today) continue;
    byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.amount);
  }
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return null;
  const lastDay = days[days.length - 1] as string;
  const firstDay = days[0] as string;
  const lastMs = Date.parse(`${lastDay}T00:00:00Z`);
  if (Date.parse(`${today}T00:00:00Z`) - lastMs > 2 * DAY_MS) return null;
  const historyDays = Math.round((lastMs - Date.parse(`${firstDay}T00:00:00Z`)) / DAY_MS);
  if (historyDays < ANOMALY_MIN_BASELINE_DAYS) return null;

  // Baseline: kalenderdøgnene før siste døgn (maks 28), manglende døgn = 0.
  const window = Math.min(ANOMALY_BASELINE_DAYS, historyDays);
  const baseline: number[] = [];
  for (let i = 1; i <= window; i += 1) baseline.push(byDay.get(new Date(lastMs - i * DAY_MS).toISOString().slice(0, 10)) ?? 0);
  const center = median(baseline);
  if (!(center > 0)) return null;
  const mad = median(baseline.map((v) => Math.abs(v - center)));
  const sigma = Math.max(mad * 1.4826, center * 0.05, 1);
  const latest = byDay.get(lastDay) as number;
  const delta = latest - center;
  const ratio = latest / center;
  if (delta / sigma < zThreshold || delta < minDelta || ratio < minRatio) return null;
  return { day: lastDay, ratio: Math.round(ratio * 10) / 10, severity: ratio >= 5 ? "strong" : "moderate", baseline_days: window };
}

/** Lukket sett av kostnadsserier som kan gi en kandidat (en ny serie krever en eksplisitt avgjørelse her, aldri en streng fra en leser). */
export const SPEND_SPIKE_SERIES = ["ai_cost"] as const;
export type SpendSpikeSeries = (typeof SPEND_SPIKE_SERIES)[number];
const SPEND_SERIES_LABEL: Readonly<Record<SpendSpikeSeries, string>> = { ai_cost: "AI-bruken" };

export function mapSpendSpikeToCandidate(spike: SpendSpike, series: SpendSpikeSeries): SituationCandidateInput {
  const label = SPEND_SERIES_LABEL[series];
  return {
    domain: "spend",
    detection_key: `spend_anomaly:${series}:${spike.day}`,
    priority: spike.severity === "strong" ? "high" : "normal",
    // Ingen konfidens: INFORM, aldri forslag/handling. Ingen beløp i teksten (kun forholdstallet).
    reason: `Kostnaden for ${label} ${spike.day} var ca. ${String(spike.ratio).replace(".", ",")} ganger høyere enn din vanlige dag`
  };
}

// ---------------------------------------------------------------------
// 2) Stilnet planlagt jobb
// ---------------------------------------------------------------------

export interface JobCadence {
  /** Kodenavn på jobben (f.eks. `situation-sweep`). */
  job_name: string;
  /** Siste fullføring (ISO). `null` = har aldri fullført: ingen baseline, ingen påstand (`DEFERRED`: krever vedlikeholdskatalogen). */
  last_completed_at: string | null;
  /** Eierens/katalogens FORVENTEDE intervall i timer (1..744). Detektoren gjetter aldri en kadens. */
  expected_interval_hours: number;
}

export interface StaleJobOptions {
  /** Hvor mange forventede intervaller som kan passere før jobben regnes som stilnet (standard 2; klemt [1,5, 10]). */
  graceFactor?: number;
}

export interface StaleJob {
  job_name: string;
  last_completed_at: string;
  hours_since: number;
  /** Antall forventede intervaller som har passert (avrundet til én desimal). */
  overdue_factor: number;
  expected_interval_hours: number;
}

const JOB_NAME = /^[a-z0-9][a-z0-9_.:-]{1,60}$/;
const MAX_JOBS = 50;

export function detectStaleJobs(jobs: readonly JobCadence[], nowMs: number, options: StaleJobOptions = {}): StaleJob[] {
  if (!Number.isFinite(nowMs)) return [];
  const grace = clamp(options.graceFactor, 2, 1.5, 10);
  const out: StaleJob[] = [];
  for (const job of jobs.slice(0, MAX_JOBS)) {
    if (typeof job !== "object" || job === null || typeof job.job_name !== "string" || !JOB_NAME.test(job.job_name)) continue;
    if (!Number.isFinite(job.expected_interval_hours) || job.expected_interval_hours < 1 || job.expected_interval_hours > 744) continue;
    if (job.last_completed_at === null || typeof job.last_completed_at !== "string") continue;
    const lastMs = Date.parse(job.last_completed_at);
    // En fullføring i fremtiden (klokkeavvik) er ingen baseline: ignoreres i stedet for å gi en falsk «ikke stilnet».
    if (!Number.isFinite(lastMs) || lastMs > nowMs + 5 * 60_000) continue;
    const hours = (nowMs - lastMs) / 3_600_000;
    const factor = hours / job.expected_interval_hours;
    if (factor <= grace) continue;
    out.push({
      job_name: job.job_name, last_completed_at: new Date(lastMs).toISOString(), hours_since: Math.floor(hours),
      overdue_factor: Math.round(factor * 10) / 10, expected_interval_hours: job.expected_interval_hours
    });
  }
  return out.sort((a, b) => b.overdue_factor - a.overdue_factor || a.job_name.localeCompare(b.job_name));
}

export function mapStaleJobToCandidate(job: StaleJob): SituationCandidateInput {
  return {
    // `operations`, ikke `infra`: den daglige sveipen løser alle åpne `infra`-situasjoner som ikke er aktive incidents (`resolveStaleForDomain`).
    domain: "operations",
    // Episoden er identifisert av siste fullføring: når jobben fullfører igjen, er det en NY episode hvis den stilner igjen.
    detection_key: `job_stale:${job.job_name}@${job.last_completed_at}`,
    priority: job.overdue_factor >= 4 ? "high" : "normal",
    reason: `Planlagt jobb «${job.job_name}» har ikke fullført på ${job.hours_since} timer (forventet hvert ${job.expected_interval_hours}. time)`
  };
}
