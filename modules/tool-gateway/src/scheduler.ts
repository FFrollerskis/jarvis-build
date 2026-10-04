import { randomUUID } from "node:crypto";
import type pg from "pg";
import { envHour } from "@jarvis/contracts";

/**
 * BO-05: reboot-durabel daglig scheduler. Tilstand i Postgres (scheduler_state):
 * PRIMARY KEY (job_name, run_date) gjoer claim atomisk - ved flere instanser
 * vinner nyaktig en (INSERT ON CONFLICT DO NOTHING). Missed-run-policy:
 * ved oppstart ETTER planlagt tid samme dag leveres dagens brief en gang
 * (catch-up); aldri duplikater, aldri gaarsdagens.
 */
/** D-393: maks forsoek per dag per jobb (foerste kjoering + retries). */
const MAX_ATTEMPTS = 4;

export class DailyScheduler {
  readonly instanceId = `sched-${randomUUID().slice(0, 8)}`;
  constructor(
    private readonly pool: pg.Pool,
    private readonly jobName = "daily-brief",
    private readonly hour = envHour("JARVIS_BRIEF_HOUR", 7),
    private readonly timeZone = "Europe/Oslo"
  ) {}

  private localNow(): { date: string; hour: number } {
    const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: this.timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
  }

  /**
   * true = denne instansen vant (eller overtok) dagens kjoering og skal levere.
   * D-393 (JARVIS-027): en feilet kjoering (`retry_after` passert) eller en hengt claim (krasj, ingen fullfoering innen lease) kan overtas,
   * opp til `MAX_ATTEMPTS` forsoek per dag - tidligere var ETT forbigaaende nettverks-/DB-feil nok til at dagens jobb gikk tapt.
   */
  async claimToday(): Promise<boolean> {
    const { date, hour } = this.localNow();
    if (hour < this.hour) return false; // foer planlagt tid
    const result = await this.pool.query(
      `INSERT INTO scheduler_state (job_name, run_date, claimed_by) VALUES ($1, $2, $3)
       ON CONFLICT (job_name, run_date) DO UPDATE
         SET claimed_by = EXCLUDED.claimed_by, claimed_at = now(), attempts = scheduler_state.attempts + 1, retry_after = NULL
       WHERE scheduler_state.completed_at IS NULL
         AND scheduler_state.attempts < $4
         AND (
           (scheduler_state.retry_after IS NOT NULL AND scheduler_state.retry_after <= now())
           OR (scheduler_state.retry_after IS NULL AND scheduler_state.claimed_at < now() - interval '15 minutes')
         )`,
      [this.jobName, date, this.instanceId, MAX_ATTEMPTS]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markCompleted(): Promise<void> {
    const { date } = this.localNow();
    await this.pool.query(
      "UPDATE scheduler_state SET completed_at = now(), retry_after = NULL WHERE job_name = $1 AND run_date = $2",
      [this.jobName, date]
    );
  }

  /** D-393: planlegg nytt forsoek med backoff (1, 5, 15 min) for DENNE instansens claim; gir opp (synlig i loggen) etter `MAX_ATTEMPTS`. */
  async markFailed(error: string): Promise<void> {
    const { date } = this.localNow();
    const { rows } = await this.pool.query<{ attempts: number }>(
      `UPDATE scheduler_state
          SET retry_after = now() + (LEAST(power(5, attempts - 1), 15) * interval '1 minute'), last_error = $4
        WHERE job_name = $1 AND run_date = $2 AND claimed_by = $3 AND completed_at IS NULL
        RETURNING attempts`,
      [this.jobName, date, this.instanceId, error.slice(0, 300)]
    );
    if ((rows[0]?.attempts ?? 0) >= MAX_ATTEMPTS) {
      console.error(JSON.stringify({ msg: "daily_scheduler_gave_up", job_name: this.jobName, instance_id: this.instanceId, attempts: rows[0]?.attempts, error: error.slice(0, 200) }));
    }
  }

  /** Kjoer i intervall: leverer maks en gang per dag, reboot-/multi-instans-trygt. */
  start(deliver: () => Promise<void>, intervalMs = 60_000): NodeJS.Timeout {
    const timer = setInterval(() => void (async () => {
      if (await this.claimToday()) {
        try {
          await deliver();
          await this.markCompleted();
        } catch (err) {
          // D-393 (JARVIS-027): planlegg retry foer feilen logges av sikkerhetsnettet under (feil i selve markFailed maa ikke skjule originalfeilen).
          await this.markFailed(err instanceof Error ? err.message : String(err)).catch(() => undefined);
          throw err;
        }
      }
    })().catch((err) => {
      // Uten denne logges INGENTING her - deliver()/claimToday()/markCompleted() sitt eget,
      // mer spesifikke feilhaandteringskode (hvis noen) faar likevel kjoere foerst, dette er
      // bare det siste sikkerhetsnettet slik at INGEN av de 17 schedulerte jobbene i
      // apps/api/src/main.ts kan feile helt sporlost.
      console.error(JSON.stringify({
        msg: "daily_scheduler_tick_failed",
        job_name: this.jobName,
        instance_id: this.instanceId,
        error: err instanceof Error ? err.message : String(err)
      }));
    }), intervalMs);
    timer.unref();
    return timer;
  }
}
