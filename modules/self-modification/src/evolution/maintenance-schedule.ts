/**
 * EV-19 (Evolution Masterplan v1.2 kap. 26): Proactive Maintenance & Upgrade Scheduler - forfallslogikk (ren funksjon). Respekterer månedlige tak for
 * radar/eval/red-team/shadow og change freeze (muterende vedlikehold stopper; ren deteksjon kjører videre). DEFERRED: faktisk kjøring av oppgavene,
 * lagring av `last_run`, og varsling.
 */
export type Cadence = "daily" | "weekly" | "monthly" | "quarterly" | "event";
export type CapKey = "radar" | "eval" | "red_team" | "shadow";

export interface MaintenanceTask {
  id: string;
  cadence: Cadence;
  /** Endrer tilstand (opprydding, restore-test, deploy)? Da stoppes den av change freeze. */
  mutating: boolean;
  /** Teller mot et månedlig tak. */
  cap?: CapKey;
  /** Hendelser som utløser den (kun `event`). */
  triggers?: readonly string[];
}

export const MAINTENANCE_CATALOG: readonly MaintenanceTask[] = [
  { id: "health_check", cadence: "daily", mutating: false },
  { id: "failed_jobs_review", cadence: "daily", mutating: false },
  { id: "expired_credentials", cadence: "daily", mutating: false },
  { id: "pending_security_issues", cadence: "daily", mutating: false },
  { id: "backup_status", cadence: "daily", mutating: false },
  { id: "model_candidates", cadence: "weekly", mutating: false, cap: "radar" },
  { id: "dependency_review", cadence: "weekly", mutating: false, cap: "radar" },
  { id: "api_deprecations", cadence: "weekly", mutating: false, cap: "radar" },
  { id: "cost_optimization", cadence: "weekly", mutating: false },
  { id: "eval_drift", cadence: "weekly", mutating: false, cap: "eval" },
  { id: "architecture_debt", cadence: "monthly", mutating: false },
  { id: "unused_integrations", cadence: "monthly", mutating: false },
  { id: "permission_review", cadence: "monthly", mutating: false },
  { id: "disaster_recovery_sample_restore", cadence: "monthly", mutating: true },
  { id: "full_provider_failover", cadence: "quarterly", mutating: true, cap: "shadow" },
  { id: "cold_start_drill", cadence: "quarterly", mutating: true },
  { id: "owner_review_autonomy_and_personality", cadence: "quarterly", mutating: false },
  { id: "red_team_run", cadence: "monthly", mutating: false, cap: "red_team" },
  { id: "cve_response", cadence: "event", mutating: false, triggers: ["cve"] },
  { id: "provider_deprecation_response", cadence: "event", mutating: false, triggers: ["provider_deprecation"] },
  { id: "incident_followup", cadence: "event", mutating: false, triggers: ["repeated_incident"] },
  { id: "cost_spike_review", cadence: "event", mutating: false, triggers: ["cost_spike"] },
  { id: "storage_forecast_review", cadence: "event", mutating: false, triggers: ["storage_forecast_breach"] }
];

const PERIOD_DAYS: Record<Exclude<Cadence, "event">, number> = { daily: 1, weekly: 7, monthly: 30, quarterly: 90 };

export interface ScheduleInput {
  now: Date;
  last_run: Readonly<Record<string, string | undefined>>;
  change_freeze: boolean;
  /** Brukt hittil denne måneden per tak, og takene. */
  cap_usage: Readonly<Partial<Record<CapKey, number>>>;
  caps: Readonly<Record<CapKey, number>>;
  /** Hendelser som har inntruffet siden sist (event-oppgaver). */
  events?: readonly string[];
}

export interface ScheduleDecision {
  run: string[];
  blocked: Array<{ id: string; reason: "change_freeze" | "monthly_cap_reached" }>;
}

export function dueMaintenance(input: ScheduleInput, catalog: readonly MaintenanceTask[] = MAINTENANCE_CATALOG): ScheduleDecision {
  const run: string[] = [];
  const blocked: ScheduleDecision["blocked"] = [];
  for (const t of catalog) {
    let due = false;
    if (t.cadence === "event") due = (input.events ?? []).some((e) => t.triggers?.includes(e));
    else {
      const last = input.last_run[t.id];
      due = last === undefined || input.now.getTime() - new Date(last).getTime() >= PERIOD_DAYS[t.cadence] * 86_400_000;
    }
    if (!due) continue;
    if (t.mutating && input.change_freeze) { blocked.push({ id: t.id, reason: "change_freeze" }); continue; }
    if (t.cap !== undefined && (input.cap_usage[t.cap] ?? 0) >= input.caps[t.cap]) { blocked.push({ id: t.id, reason: "monthly_cap_reached" }); continue; }
    run.push(t.id);
  }
  return { run, blocked };
}
