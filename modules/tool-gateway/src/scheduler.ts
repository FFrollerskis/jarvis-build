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

  /** true = denne instansen vant dagens kjoering og skal levere. */
  async claimToday(): Promise<boolean> {
    const { date, hour } = this.localNow();
    if (hour < this.hour) return false; // foer planlagt tid
    const result = await this.pool.query(
      `INSERT INTO scheduler_state (job_name, run_date, claimed_by) VALUES ($1, $2, $3)
       ON CONFLICT (job_name, run_date) DO NOTHING`,
      [this.jobName, date, this.instanceId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markCompleted(): Promise<void> {
    const { date } = this.localNow();
    await this.pool.query(
      "UPDATE scheduler_state SET completed_at = now() WHERE job_name = $1 AND run_date = $2",
      [this.jobName, date]
    );
  }

  /** Kjoer i intervall: leverer maks en gang per dag, reboot-/multi-instans-trygt. */
  start(deliver: () => Promise<void>, intervalMs = 60_000): NodeJS.Timeout {
    const timer = setInterval(() => void (async () => {
      if (await this.claimToday()) {
        await deliver();
        await this.markCompleted();
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
