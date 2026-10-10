import type { EvChangeClass } from "../constitution.ts";

/**
 * EV-9 (Evolution Masterplan v1.2 kap. 16): Self-Healing & Incident Autopilot - tillatelsesmodellen og hendelsesløkken (rene funksjoner).
 * KONTINUITET: EV-9 erstatter ikke Fase 10-watchdogen; den deterministiske watchdog/restart-grunnmuren er laveste lag og røres ikke her.
 * DEFERRED: selve utførelsen (restart/failover/code-repair), korrelasjons-ID-lagring og postmortem-skriving. Dette er porten som sier hva som
 * FÅR skje automatisk, hva som krever eier, og hva som alltid er forbudt.
 */
export type HealLevel = "H0" | "H1" | "H2" | "H3" | "H4";

/** Handlinger per nivå (plan kap. 16). Ukjent handling er ikke automatisk - den behandles som H4. */
const LEVEL_OF_ACTION: Readonly<Record<string, HealLevel>> = {
  detect_unhealthy_container: "H0", detect_stuck_lease: "H0", detect_disk_pressure: "H0", detect_provider_down: "H0",
  restart_container: "H1", reconnect: "H1", refresh_short_lived_token: "H1", clear_bounded_cache: "H1",
  switch_provider: "H2", use_read_replica: "H2", pause_queue: "H2", enter_degraded_mode: "H2",
  code_repair: "H3",
  restore_db_over_prod: "H4", delete_data: "H4", rotate_root_credential: "H4", firewall_wide_change: "H4"
};

export function levelOfAction(action: string): HealLevel {
  return LEVEL_OF_ACTION[action] ?? "H4";
}

export interface HealContext {
  action: string;
  /** Forsøk allerede gjort på denne handlingen mot dette målet i denne hendelsen. */
  attempts: number;
  max_attempts: number;
  /** H2: er failover/degradert modus forhåndsgodkjent av eier? */
  preapproved_failover: boolean;
  /** H2: er den relevante UA-porten (kontinuitet/failover) live og verifisert? */
  ua_gate_live: boolean;
  /** H3: E-klassen for kodereparasjonen (bestemt av EV-0/EV-5). */
  repair_class: EvChangeClass | null;
  owner_approved: boolean;
  /** `null` = UKJENT (kunne ikke leses). Ukjent behandles som PÅ (fail-closed) med egen årsak - aldri som «av» (M2, gjennomgang av PR #313). */
  kill_switch_active: boolean | null;
}

export interface HealVerdict {
  level: HealLevel;
  allowed: boolean;
  /** `auto`: kan utføres uten eier. `owner`: krever eierens godkjenning. `none`: forbudt nå. */
  mode: "auto" | "owner" | "none";
  reasons: string[];
}

export function decideHeal(c: HealContext): HealVerdict {
  const level = levelOfAction(c.action);
  const reasons: string[] = [];
  if (c.kill_switch_active !== false && level !== "H0") return { level, allowed: false, mode: "none", reasons: [c.kill_switch_active === true ? "kill_switch_active" : "kill_switch_unknown"] };
  switch (level) {
    case "H0":
      return { level, allowed: true, mode: "auto", reasons };
    case "H1":
      if (c.attempts >= c.max_attempts) return { level, allowed: false, mode: "owner", reasons: ["attempt_limit_reached"] };
      return { level, allowed: true, mode: "auto", reasons };
    case "H2":
      if (!c.preapproved_failover) reasons.push("failover_not_preapproved");
      if (!c.ua_gate_live) reasons.push("ua_gate_not_live");
      return reasons.length === 0 ? { level, allowed: true, mode: "auto", reasons } : { level, allowed: false, mode: "owner", reasons };
    case "H3":
      // Auto-bygg, men utrulling følger E-klassen: E0/E1 kan gå via canary; E2 krever eier; E3 aldri.
      if (c.repair_class === null) return { level, allowed: false, mode: "none", reasons: ["repair_class_unknown"] };
      if (c.repair_class === "E3") return { level, allowed: false, mode: "none", reasons: ["e3_forbidden"] };
      if (c.repair_class === "E2") return { level, allowed: c.owner_approved, mode: "owner", reasons: c.owner_approved ? [] : ["owner_approval_missing"] };
      return { level, allowed: true, mode: "auto", reasons };
    case "H4":
      return { level, allowed: c.owner_approved, mode: "owner", reasons: c.owner_approved ? [] : ["owner_approval_required"] };
  }
}

/** Hendelsesløkken (plan kap. 16): rekkefølgen er bindende. */
export const INCIDENT_STEPS = ["detect", "stabilize", "diagnose", "repair", "verify", "postmortem"] as const;
export type IncidentStep = (typeof INCIDENT_STEPS)[number];

export interface IncidentState {
  correlation_id: string;
  completed: IncidentStep[];
  /** SLO og forretningsutfall faktisk tilbake? Kun fra måling, aldri «reparasjonen kjørte». */
  slo_recovered: boolean | null;
  business_outcome_recovered: boolean | null;
  regression_test_added: boolean;
}

export interface IncidentVerdict {
  next: IncidentStep | null;
  can_close: boolean;
  blockers: string[];
}

export function nextIncidentStep(s: IncidentState): IncidentVerdict {
  const blockers: string[] = [];
  if (s.correlation_id.trim().length === 0) blockers.push("correlation_id_missing");
  const next = INCIDENT_STEPS.find((step) => !s.completed.includes(step)) ?? null;
  // Rekkefølge: ingen steg kan være fullført uten at alle foran er det.
  for (let i = 0; i < INCIDENT_STEPS.length; i++) {
    if (s.completed.includes(INCIDENT_STEPS[i]!) && INCIDENT_STEPS.slice(0, i).some((p) => !s.completed.includes(p))) blockers.push(`out_of_order:${INCIDENT_STEPS[i]}`);
  }
  if (s.completed.includes("verify") && (s.slo_recovered !== true || s.business_outcome_recovered !== true)) blockers.push("verification_not_proven");
  if (s.completed.includes("postmortem") && !s.regression_test_added) blockers.push("regression_test_missing");
  const can_close = blockers.length === 0 && next === null;
  return { next, can_close, blockers };
}
