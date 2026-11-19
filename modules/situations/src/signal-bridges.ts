import type { Incident } from "@jarvis/incidents";
import { bridgeHomeObservation, type HomeObservation } from "./home-bridge.ts";
import { bridgeHealthObservation, type HealthObservation } from "./health-bridge.ts";
import { INFRA_DOMAIN, isActiveIncidentStatus, mapIncidentToCandidate } from "./infra-incident-bridge.ts";
import {
  assertMinimalFacts, FILTER_SCHEMAS, ruleFor, type BridgeContext, type BridgeResult, type HealthFilter, type HomeFilter, type SignalSource, type VisionFilter
} from "./signal-types.ts";
import { bridgeVisionObservation, visionEventTypeOf, type VisionObservation } from "./vision-bridge.ts";

/**
 * WP-G4 (D-466): ÉN samlet, REN inngang for alle kilder. En observasjon (minimert, bak kildens port) -> hendelsestype (lukket sett) -> bro -> `BridgeResult`. Ingen I/O. Inntaksbussen (`signal-bus.ts`)
 * kaller denne ETTER abonnementskontrollen og FØR pause-/motorkallene. En NY kilde = en ny observasjonstype her + en bro + regler i `RULES` + en filterform - aldri en ny sti inn i motoren.
 */
export interface IncidentObservation {
  source: "incident";
  incident: Pick<Incident, "incident_id" | "title" | "status" | "severity" | "opened_at">;
}

export type SignalObservation = HomeObservation | VisionObservation | HealthObservation | IncidentObservation;

const HOME_ROLE_EVENT: Readonly<Record<string, string>> = {
  door: "door_open_too_long", window: "door_open_too_long", garage_door: "door_open_too_long", gate: "door_open_too_long", opening: "door_open_too_long",
  leak: "water_leak", alarm: "alarm_triggered", power: "power_over_limit"
};
const HEALTH_EVENT: Readonly<Record<string, string>> = {
  resting_heart_rate: "resting_heart_rate_deviation", sleep_duration_minutes: "sleep_duration_deviation", steps: "activity_deviation"
};

/** Hendelsestypen (lukket sett) en observasjon kan gi, eller `null` når den ikke hører til noen regel. Ren funksjon: abonnementet slås opp på (kilde, denne typen). */
export function deriveEventType(obs: SignalObservation): string | null {
  switch (obs.source) {
    case "home_assistant": return HOME_ROLE_EVENT[obs.role] ?? null;
    case "vision": return visionEventTypeOf(obs);
    case "health": return HEALTH_EVENT[obs.metric] ?? null;
    case "incident": return "incident_active";
    default: return null;
  }
}

export function bridgeIncidentObservation(obs: IncidentObservation): BridgeResult | null {
  if (!isActiveIncidentStatus(obs.incident.status)) return null;
  const rule = ruleFor("incident", "incident_active");
  if (rule === undefined) return null;
  const candidate = mapIncidentToCandidate(obs.incident as Incident);
  const facts = { severity: obs.incident.severity, status: obs.incident.status };
  assertMinimalFacts(facts);
  return {
    rule_key: rule.rule_key, source: "incident", event_type: rule.event_type,
    // Domenet og nøkkelen er EKSAKT det den eksisterende broen (D-195) gir: samme incident via sveipet og via bussen = samme situasjon.
    candidate: { ...candidate, domain: INFRA_DOMAIN },
    // Nivå = alvorlighet + status: en endring (eskalering, ny status) gir en ny evaluering; ellers maks én per tilstand.
    source_ref: `${candidate.detection_key}#${obs.incident.severity}:${obs.incident.status}`,
    facts, urgent: false, occurred_at: obs.incident.opened_at
  };
}

/** Parser et lagret filter mot kildens LUKKEDE form (en korrupt rad gir `null`: signalet forkastes, aldri en løs tolkning). */
export function parseFilter(source: SignalSource, raw: unknown): HomeFilter | VisionFilter | HealthFilter | Record<string, never> | null {
  const parsed = FILTER_SCHEMAS[source].safeParse(raw);
  return parsed.success ? (parsed.data as HomeFilter | VisionFilter | HealthFilter | Record<string, never>) : null;
}

/** Slår observasjonen gjennom riktig bro med abonnementets filter. `null` = intet signal (under terskel, utenfor filter, ukjent tilstand). */
export function bridgeObservation(obs: SignalObservation, filter: unknown, ctx: BridgeContext): BridgeResult | null {
  switch (obs.source) {
    case "home_assistant": {
      const f = parseFilter("home_assistant", filter) as HomeFilter | null;
      // Entiteten MÅ stå i abonnementets liste MED samme rolle (eieren navngir hver entitet og rolle selv).
      if (f === null || !f.entities.some((e) => e.entity_id === obs.entity_id && e.role === obs.role)) return null;
      const entry = f.entities.find((e) => e.entity_id === obs.entity_id && e.role === obs.role);
      // Eierens egen effektgrense hentes fra filteret, aldri fra observasjonen.
      return bridgeHomeObservation(entry?.limit_w !== undefined ? { ...obs, limit_w: entry.limit_w } : obs, ctx);
    }
    case "vision": {
      const f = parseFilter("vision", filter) as VisionFilter | null;
      return f === null ? null : bridgeVisionObservation(obs, f, ctx);
    }
    case "health": {
      const f = parseFilter("health", filter) as HealthFilter | null;
      return f === null ? null : bridgeHealthObservation(obs, ctx);
    }
    case "incident":
      return parseFilter("incident", filter) === null ? null : bridgeIncidentObservation(obs);
    default:
      return null;
  }
}
