import { randomUUID } from "node:crypto";
import type pg from "pg";
import { envHour, scheduledRunCorrelation, type RunCorrelation } from "@jarvis/contracts";

import { clipRedacted, redactForLog } from "@jarvis/core";
/**
 * BO-05: reboot-durabel daglig scheduler. Tilstand i Postgres (scheduler_state):
 * PRIMARY KEY (job_name, run_date) gjoer claim atomisk - ved flere instanser
 * vinner nyaktig en (INSERT ON CONFLICT DO NOTHING). Missed-run-policy:
 * ved oppstart ETTER planlagt tid samme dag leveres dagens brief en gang
 * (catch-up); aldri duplikater, aldri gaarsdagens.
 */
/** D-393: maks forsoek per dag per jobb (foerste kjoering + retries). Eksportert for D-443 (`scheduler-health.ts` maa bruke SAMME tall). */
export const DAILY_SCHEDULER_MAX_ATTEMPTS = 4;
const MAX_ATTEMPTS = DAILY_SCHEDULER_MAX_ATTEMPTS;
/** D-393: en claim uten fullfoering er overtakbar etter dette (krasj/hengt prosess). Eksportert for D-443 (samme tall i helse-leseren). */
export const DAILY_SCHEDULER_CLAIM_LEASE_MINUTES = 15;

/** WP-C4: jobbnavnet for den daglige morgenbriefen (standard for `DailyScheduler`) - delt med Value Center-kilden som leser løperens helse i `scheduler_state`. */
export const DAILY_BRIEF_JOB_NAME = "daily-brief";

/**
 * WP-K (D-471, JARVIS-054): det en planlagt kjøring bærer inn i jobben. `task_id`/`trace_id` (se `RunCorrelation`) sendes videre til `ToolGateway.execute()` av jobber som kaller verktøy som
 * `person_id: "system"`, slik at revisjonsrader og policy-avgjørelser fra samme kjøring kan knyttes til jobben og forsøket som skrev dem. `deliver()` kan fortsatt deklareres uten parameter.
 */
export interface ScheduledRun extends RunCorrelation {
  job_name: string;
  /** Dagen (Europe/Oslo) claimet gjelder, `YYYY-MM-DD`. */
  run_date: string;
  /** Forsøksnummer for dagen (1 = første kjøring; øker når en feilet/hengt claim overtas). */
  attempt: number;
  instance_id: string;
}

export class DailyScheduler {
  readonly instanceId = `sched-${randomUUID().slice(0, 8)}`;
  constructor(
    private readonly pool: pg.Pool,
    private readonly jobName = DAILY_BRIEF_JOB_NAME,
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
    return (await this.claimTodayRun()) !== null;
  }

  /** Som `claimToday()`, men returnerer kjøringens identitet og korrelasjon (`null` = ikke vår kjøring nå). `claimToday()` er uendret for eksisterende kallere. */
  async claimTodayRun(): Promise<ScheduledRun | null> {
    const { date, hour } = this.localNow();
    if (hour < this.hour) return null; // foer planlagt tid
    const result = await this.pool.query<{ attempts: number | string }>(
      `INSERT INTO scheduler_state (job_name, run_date, claimed_by) VALUES ($1, $2, $3)
       ON CONFLICT (job_name, run_date) DO UPDATE
         SET claimed_by = EXCLUDED.claimed_by, claimed_at = now(), attempts = scheduler_state.attempts + 1, retry_after = NULL
       WHERE scheduler_state.completed_at IS NULL
         AND scheduler_state.attempts < $4
         AND (
           (scheduler_state.retry_after IS NOT NULL AND scheduler_state.retry_after <= now())
           OR (scheduler_state.retry_after IS NULL AND scheduler_state.claimed_at < now() - make_interval(mins => $5::int))
         )
       RETURNING attempts`,
      [this.jobName, date, this.instanceId, MAX_ATTEMPTS, DAILY_SCHEDULER_CLAIM_LEASE_MINUTES]
    );
    if ((result.rowCount ?? 0) === 0) return null;
    const attempt = Number(result.rows?.[0]?.attempts);
    const run = Number.isFinite(attempt) && attempt >= 1 ? Math.trunc(attempt) : 1;
    return { job_name: this.jobName, run_date: date, attempt: run, instance_id: this.instanceId, ...scheduledRunCorrelation(this.jobName, date, run) };
  }

  async markCompleted(): Promise<void> {
    const { date } = this.localNow();
    await this.pool.query(
      "UPDATE scheduler_state SET completed_at = now(), retry_after = NULL WHERE job_name = $1 AND run_date = $2",
      [this.jobName, date]
    );
  }

  /**
   * D-442: forny claimet mens jobben kjorer. Uten dette regnes en legitimt lang kjoering (reembed etter modellbytte, LLM-retensjon, mange bank-sider) som hengt naar claimet er
   * eldre enn lease: neste tick starter da en SAMTIDIG kjoering av samme jobb, og helse-leseren (D-443) viser den som `stalled`/`gave_up` mens den fortsatt jobber.
   */
  async heartbeat(): Promise<void> {
    const { date } = this.localNow();
    await this.pool.query(
      "UPDATE scheduler_state SET claimed_at = now() WHERE job_name = $1 AND run_date = $2 AND claimed_by = $3 AND completed_at IS NULL",
      [this.jobName, date, this.instanceId]
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
      [this.jobName, date, this.instanceId, clipRedacted(error, 300)]
    );
    if ((rows[0]?.attempts ?? 0) >= MAX_ATTEMPTS) {
      console.error(JSON.stringify({ msg: "daily_scheduler_gave_up", job_name: this.jobName, instance_id: this.instanceId, attempts: rows[0]?.attempts, error: redactForLog(error, 200) }));
    }
  }

  /**
   * Kjoer i intervall: leverer maks en gang per dag, reboot-/multi-instans-trygt. `heartbeatMs` (D-442) styrer hvor ofte claimet fornyes mens `deliver()` kjorer.
   * WP-K (JARVIS-054): `deliver` får kjøringens `ScheduledRun` (oppgave-/spor-ID) - en jobb som ikke trenger den kan fortsatt deklareres uten parameter.
   */
  start(deliver: (run: ScheduledRun) => Promise<void>, intervalMs = 60_000, heartbeatMs = 60_000): NodeJS.Timeout {
    const timer = setInterval(() => void (async () => {
      const run = await this.claimTodayRun();
      if (run !== null) {
        const heartbeat = setInterval(() => void this.heartbeat().catch(() => undefined), heartbeatMs);
        heartbeat.unref();
        try {
          await deliver(run);
          await this.markCompleted();
        } catch (err) {
          // D-393 (JARVIS-027): planlegg retry foer feilen logges av sikkerhetsnettet under (feil i selve markFailed maa ikke skjule originalfeilen).
          await this.markFailed(err instanceof Error ? err.message : String(err)).catch(() => undefined);
          throw err;
        } finally {
          clearInterval(heartbeat);
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
        error: redactForLog(err instanceof Error ? err.message : String(err), 300)
      }));
    }), intervalMs);
    timer.unref();
    return timer;
  }
}
