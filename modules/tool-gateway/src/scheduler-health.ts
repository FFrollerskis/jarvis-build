import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import type { BriefItem, BriefSource } from "./daily-brief.ts";
import { DAILY_SCHEDULER_CLAIM_LEASE_MINUTES, DAILY_SCHEDULER_MAX_ATTEMPTS } from "./scheduler.ts";

/**
 * D-443 (JARVIS-027, rest av D-442): `DailyScheduler` skriver tilstanden til `scheduler_state` (forsøk, `retry_after`, `last_error`), og D-442 sørger for at
 * en tenant-feil i et sveip faktisk ender der. Men uten en leser ser eieren fortsatt ingenting uten å lese containerloggen. Denne filen er den ENE leseren
 * (selvdiagnosen og morgenbriefen bruker den samme klassifiseringen, så de aldri er uenige).
 *
 * Tilstanden leses fra siste rad per jobb i dag og i går (Europe/Oslo-dato, samme som scheduleren). Klassifisering av en IKKE fullført rad:
 *  - `lost_previous_day`: raden er fra en tidligere dato - scheduleren prøver aldri en gammel dato på nytt, dagens kjøring ble tapt.
 *  - `gave_up`: siste forsøk feilet og alle forsøk er brukt opp - ingen flere forsøk i dag.
 *  - `retry_pending`: et forsøk feilet og et nytt er planlagt (`retry_after`).
 *  - `stalled`: claimet er eldre enn lease uten fullføring (krasj/hengt prosess) - overtas av neste tick.
 * En rad som er claimet nylig uten feil er en jobb som KJØRER og regnes ikke som problem. Jobber uten rad (planlagt klokkeslett ikke nådd) er ikke kjent og
 * telles ikke - «ingen problemer» betyr «ingen kjente problemer», ikke «alle jobber har kjørt».
 */
export type SchedulerProblemKind = "lost_previous_day" | "gave_up" | "retry_pending" | "stalled";

/**
 * D-445: jobber som avhenger av eierens PC (lokal modell/embedding via Ollama) og derfor legitimt feiler de nettene PC-en er av. De prøves på nytt som alle andre, men et tap her er
 * aldri «tapt arbeid»: det vises som DEGRADED i selvdiagnosen (med forklaring) og kommer aldri i morgenbriefen - neste kjøring tar igjen det som ble utsatt, og vektorer/sammendrag
 * skrives uansett ved bruk mens PC-en er på. Alle andre jobber er kritiske og gir DOWN / morgenbrief-varsel når arbeidet er tapt.
 */
export const BEST_EFFORT_JOBS: ReadonlySet<string> = new Set(["memory-reembed-sweep", "memory-retention-sweep"]);

export interface SchedulerJobProblem {
  job_name: string;
  /** `YYYY-MM-DD` (Europe/Oslo). */
  run_date: string;
  kind: SchedulerProblemKind;
  attempts: number;
  max_attempts: number;
  /** D-445: jobben avhenger av eierens PC (`BEST_EFFORT_JOBS`) - tap er DEGRADED, aldri DOWN/morgenbrief. */
  best_effort: boolean;
  /** Avkortet (120 tegn, uten den ledende `<jobb>: `-prefiksen scheduleren selv skriver); `null` når raden ikke har noen registrert feil (for eksempel hengt claim). */
  last_error: string | null;
}

export interface SchedulerHealth {
  /** Antall jobber med en rad i dag/i går. */
  jobs_seen: number;
  completed: number;
  problems: SchedulerJobProblem[];
}

interface Row {
  job_name: string;
  run_date: string;
  attempts: number;
  completed_at: Date | string | null;
  retry_after: Date | string | null;
  last_error: string | null;
  past_day: boolean;
  claim_stale: boolean;
}

const MAX_ERROR_CHARS = 120;
const TIME_ZONE = "Europe/Oslo";

/** D-442-meldingene starter med `<jobb>: N tenant-feil (`; jobbnavnet vises allerede ved siden av, så prefikset spiser bare av de tegnene årsaken trenger. */
function trimError(jobName: string, error: string | null): string | null {
  if (error === null) return null;
  const prefix = `${jobName}: `;
  return (error.startsWith(prefix) ? error.slice(prefix.length) : error).slice(0, MAX_ERROR_CHARS);
}

export function classifySchedulerRow(row: Row): SchedulerProblemKind | null {
  if (row.completed_at !== null) return null;
  if (row.past_day) return "lost_previous_day";
  if (row.retry_after !== null) return row.attempts >= DAILY_SCHEDULER_MAX_ATTEMPTS ? "gave_up" : "retry_pending";
  if (row.claim_stale) return row.attempts >= DAILY_SCHEDULER_MAX_ATTEMPTS ? "gave_up" : "stalled";
  return null; // kjører nå (nylig claim, ingen registrert feil i dette forsøket)
}

export async function readSchedulerHealth(pool: Pick<pg.Pool, "query">): Promise<SchedulerHealth> {
  const { rows } = await pool.query<Row>(
    `SELECT DISTINCT ON (job_name)
            job_name, to_char(run_date, 'YYYY-MM-DD') AS run_date, attempts, completed_at, retry_after, last_error,
            run_date < (now() AT TIME ZONE $1)::date AS past_day,
            claimed_at < now() - make_interval(mins => $2::int) AS claim_stale
       FROM scheduler_state
      WHERE run_date >= (now() AT TIME ZONE $1)::date - 1
      ORDER BY job_name, run_date DESC`,
    [TIME_ZONE, DAILY_SCHEDULER_CLAIM_LEASE_MINUTES]
  );
  const problems: SchedulerJobProblem[] = [];
  let completed = 0;
  for (const row of rows) {
    const kind = classifySchedulerRow(row);
    if (kind === null) {
      if (row.completed_at !== null) completed += 1;
      continue;
    }
    problems.push({
      job_name: row.job_name,
      run_date: row.run_date,
      kind,
      attempts: row.attempts,
      max_attempts: DAILY_SCHEDULER_MAX_ATTEMPTS,
      best_effort: BEST_EFFORT_JOBS.has(row.job_name),
      last_error: trimError(row.job_name, row.last_error)
    });
  }
  const order: Record<SchedulerProblemKind, number> = { gave_up: 0, lost_previous_day: 1, stalled: 2, retry_pending: 3 };
  problems.sort((a, b) => order[a.kind] - order[b.kind] || a.job_name.localeCompare(b.job_name));
  return { jobs_seen: rows.length, completed, problems };
}

/** Kort norsk beskrivelse av ett problem (selvdiagnose og brief bruker samme tekst). */
export function describeSchedulerProblem(p: SchedulerJobProblem): string {
  const why = p.last_error === null ? "" : `: ${p.last_error}`;
  const pcNote = p.best_effort ? " (avhenger av PC-en; tas igjen neste kjøring)" : "";
  switch (p.kind) {
    case "gave_up":
      return `${p.job_name} ga opp etter ${p.attempts}/${p.max_attempts} forsøk${why}${pcNote}`;
    case "lost_previous_day":
      return `${p.job_name} ble ikke fullført ${p.run_date} (${p.attempts} forsøk)${why}${pcNote}`;
    case "retry_pending":
      return `${p.job_name} feilet (forsøk ${p.attempts}/${p.max_attempts}), nytt forsøk er planlagt${why}`;
    case "stalled":
      return `${p.job_name} står fast uten fullføring (forsøk ${p.attempts}/${p.max_attempts})`;
  }
}

/**
 * Morgenbriefen: kun KRITISKE jobber der dagens arbeid er TAPT (`gave_up`/`lost_previous_day`; ikke `BEST_EFFORT_JOBS`, D-445). En jobb som bare venter på et nytt forsøk (`retry_pending`/`stalled`)
 * er forbigående og ville bare vært støy kl. 07 - den vises i selvdiagnosen. `scheduler_state` er global (ingen tenant-RLS), så kilden bruker poolen direkte og
 * leverer KUN til eieren (`isOwner`).
 */
export function schedulerSource(pool: Pick<pg.Pool, "query">, isOwner: (identity: IdentityContext) => boolean): BriefSource {
  return {
    name: "jarvis-scheduler",
    async collect(identity: IdentityContext): Promise<BriefItem[]> {
      // `scheduler_state` er global (ingen tenant-RLS) og feilteksten kan nevne andre tenants - driftsstatus er kun for eieren, aldri for en annen tilgangsinnehaver (`/brief`).
      if (!isOwner(identity)) return [];
      const health = await readSchedulerHealth(pool);
      return health.problems
        .filter((p) => !p.best_effort && (p.kind === "gave_up" || p.kind === "lost_previous_day"))
        .map((p): BriefItem => ({
          source: "jarvis-scheduler",
          ref: `${p.job_name}:${p.run_date}`,
          title: `Bakgrunnsjobb uten resultat: ${p.job_name}`,
          detail: describeSchedulerProblem(p),
          score: 75,
          why: "daglig bakgrunnsjobb ble ikke fullført",
          action: `sjekk loggen (daily_scheduler_gave_up) for ${p.job_name}`
        }));
    }
  };
}
