import type pg from "pg";
import type { KillSwitch } from "@jarvis/policy";

export type Severity = "info" | "warning" | "critical";

export interface Alert {
  check: string;
  severity: Severity;
  message: string;
  runbook: string;
  at: string;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}

/** Telegram-varsling kobles via Tool Gateway i drift; skallet er uverifisert uten token. */
export class TelegramAlertSink implements AlertSink {
  async send(): Promise<void> {
    throw new Error("telegram_alert_unverified: krever JARVIS_TELEGRAM_TOKEN");
  }
}

export interface HealthCheck {
  name: string;
  runbook: string;
  run(): Promise<{ ok: boolean; severity: Severity; message: string }>;
}

/**
 * Deterministisk watchdog (masterplan §11.2 / CANONICAL §11): oppdager feil,
 * varsler med alvorlighetsgrad + runbook, og utfører KUN eksplisitt
 * registrerte, reversible tiltak med maks antall forsøk. Ingen LLM, ingen
 * autonom reparasjon, ingen vei utenom Policy Gateway (watchdog har ingen
 * verktøytilgang - kun varsling, registrerte restart-hooks og kill switch).
 */
export class Watchdog {
  private readonly checks: HealthCheck[] = [];
  private readonly actions = new Map<string, { run: () => Promise<void>; maxAttempts: number; attempts: number }>();

  constructor(
    private readonly alerts: AlertSink,
    private readonly killSwitch: KillSwitch
  ) {}

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  /** Reversibelt tiltak (f.eks. restart av ÉN tjeneste), aldri destruktivt. */
  registerAction(checkName: string, run: () => Promise<void>, maxAttempts = 2): void {
    this.actions.set(checkName, { run, maxAttempts, attempts: 0 });
  }

  async tick(): Promise<Alert[]> {
    const fired: Alert[] = [];
    for (const check of this.checks) {
      let result: { ok: boolean; severity: Severity; message: string };
      try {
        result = await check.run();
      } catch (err) {
        result = { ok: false, severity: "critical", message: `sjekk feilet: ${(err as Error).message}` };
      }
      if (result.ok) {
        continue;
      }
      const alert: Alert = {
        check: check.name, severity: result.severity, message: result.message,
        runbook: check.runbook, at: new Date().toISOString()
      };
      fired.push(alert);
      await this.alerts.send(alert).catch(() => undefined);
      const action = this.actions.get(check.name);
      if (action && action.attempts < action.maxAttempts) {
        action.attempts += 1;
        await action.run().catch(() => undefined);
      }
    }
    return fired;
  }
}

/** Fastlåste jobber: running med utløpt lease = fastlåst worker (reclaim finnes, men varsle). */
export function stuckTasksCheck(pool: pg.Pool): HealthCheck {
  return {
    name: "stuck_tasks",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#worker",
    async run() {
      const result = await pool.query(
        `SELECT count(*)::int AS n FROM tasks WHERE status = 'running' AND lease_expires_at < now()`
      );
      const n = (result.rows[0] as { n: number }).n;
      return n === 0
        ? { ok: true, severity: "info", message: "" }
        : { ok: false, severity: "warning", message: `${n} jobber med utløpt lease` };
    }
  };
}

export function databaseCheck(pool: pg.Pool): HealthCheck {
  return {
    name: "database",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#postgres",
    async run() {
      await pool.query("SELECT 1");
      return { ok: true, severity: "info", message: "" };
    }
  };
}

/**
 * Kostnadseksplosjon (D-09-kriterium): over hardgrensen utløses kill switch -
 * deterministisk, reversibel (deaktiveres manuelt), og policyen nekter alt til
 * Tobias har vurdert situasjonen.
 */
export function costExplosionCheck(pool: pg.Pool, killSwitch: KillSwitch, hardLimitOre = 300_000): HealthCheck {
  return {
    name: "cost_explosion",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad",
    async run() {
      const result = await pool.query(
        `SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`
      );
      const spent = (result.rows[0] as { spent: number }).spent;
      if (spent >= hardLimitOre && !killSwitch.isActive()) {
        killSwitch.activate(`kostnadseksplosjon: ${spent} øre >= ${hardLimitOre}`);
        return { ok: false, severity: "critical", message: `kill switch aktivert (${(spent / 100).toFixed(0)} kr)` };
      }
      return spent >= hardLimitOre
        ? { ok: false, severity: "critical", message: "over hardgrense (kill switch allerede aktiv)" }
        : { ok: true, severity: "info", message: "" };
    }
  };
}
