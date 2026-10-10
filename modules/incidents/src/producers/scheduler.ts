import type pg from "pg";
import { describeSchedulerProblem, readSchedulerHealth } from "@jarvis/tool-gateway";
import type { IncidentFact } from "../types.ts";
import { subjectOf, type IncidentProducer, type ProducerClearing } from "./types.ts";

/**
 * WP-E1 (JARVIS-068): bakgrunnsjobber som har GITT OPP eller gikk TAPT (`scheduler_state`, D-393/D-442/D-443) blir hendelser. Samme klassifisering som selvdiagnosen og morgenbriefen
 * (`readSchedulerHealth`), så de tre aldri er uenige. Bevisst IKKE hendelser: `retry_pending`/`stalled` (scheduleren prøver selv igjen) og PC-avhengige jobber (D-445: tap der er DEGRADED
 * med forklaring, aldri «tapt arbeid»).
 *
 * Løsning kun når jobbens SISTE rad er fullført (re-målt i `scheduler_state`), aldri fordi problemet «ikke er sett».
 */
export function schedulerProducer(deps: { pool: Pick<pg.Pool, "query"> }): IncidentProducer {
  return {
    name: "scheduler",
    async observe(ctx, active) {
      const health = await readSchedulerHealth(deps.pool);
      const present: IncidentFact[] = [];
      const presentJobs = new Set<string>();
      for (const problem of health.problems) {
        if (problem.best_effort) continue;
        if (problem.kind !== "gave_up" && problem.kind !== "lost_previous_day") continue;
        presentJobs.add(problem.job_name);
        present.push({
          source_kind: "scheduler",
          subject: problem.job_name,
          title: problem.kind === "gave_up" ? `Bakgrunnsjobben ${problem.job_name} ga opp` : `Bakgrunnsjobben ${problem.job_name} ble ikke fullført`,
          severity: problem.kind === "gave_up" ? "high" : "normal",
          observed_at: ctx.now.toISOString(),
          evidence: { source_type: "scheduler_job", source_ref: `${problem.job_name}@${problem.run_date}`, summary: describeSchedulerProblem(problem) }
        });
      }
      const cleared: ProducerClearing[] = [];
      for (const incident of active) {
        const subject = subjectOf("scheduler", incident.dedupe_key);
        if (subject === null || presentJobs.has(subject)) continue;
        const { rows } = await deps.pool.query(
          `SELECT to_char(run_date, 'YYYY-MM-DD') AS run_date, completed_at FROM scheduler_state WHERE job_name = $1 ORDER BY run_date DESC LIMIT 1`,
          [subject]
        );
        const latest = rows[0] as { run_date: string; completed_at: Date | string | null } | undefined;
        if (!latest || latest.completed_at === null) continue; // ingen rad, eller siste kjøring er ikke fullført: ikke bekreftet borte
        cleared.push({
          subject,
          check: {
            source_type: "scheduler_job", source_ref: `${subject}@${latest.run_date}`, summary: `${subject}: siste kjøring (${latest.run_date}) er fullført`,
            observed_at: ctx.now.toISOString(), verified_by: "source_recheck", basis: `scheduler_state: siste rad for ${subject} (${latest.run_date}) har completed_at`
          }
        });
      }
      return { present, cleared };
    }
  };
}
