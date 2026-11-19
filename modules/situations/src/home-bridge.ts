import { assertMinimalFacts, parseIsoMs, ruleFor, type BridgeContext, type BridgeResult, type HomeRole } from "./signal-types.ts";

/**
 * WP-G4 (D-466), UA-10 P1b: den REN broen fra en MINIMERT Home Assistant-observasjon til en situasjonskandidat (samme mønster som `infra-incident-bridge.ts`). Ingen I/O og ingen klokke (`ctx.nowMs`).
 *
 * LUKKET hendelsessett (`SIGNAL_EVENT_TYPES.home_assistant`): `door_open_too_long`, `water_leak`, `alarm_triggered`, `power_over_limit`. Alt annet gir `null` (ingen signal), aldri en gjetning.
 * Eieren navngir selv hvert objekt og dets ROLLE i abonnementsfilteret (`HomeFilterSchema`): broen utleder aldri en rolle fra en entitets-id. HA-tilstandene som tolkes (`on`/`open`/`opening` = åpen, `on` på en
 * fuktsensor = våt, `triggered` på et alarmpanel) er Home Assistants egne, dokumenterte tilstandsverdier (se runbook for verifiseringsstatus).
 *
 * ACT: broen setter KUN prioritet/konfidens. `suggest` (høy prioritet + konfidens >= 0,75) gis bare for deterministiske sikkerhetssignaler (lekkasje, utløst alarm) og for en lukkbar port/garasjeport som har stått åpen
 * lenge - og ACT skjer først når eieren selv har bundet en autonomi-handling for domenet `home` (`situation_autonomy_policies`) OG den kritiske kjeden (G2: mål-allowlist, step-up, readback) godtar kallet. En autonom
 * sveipe-identitet har ikke en enhetssignert økt, så kritiske HA-handlinger nektes av step-up (Q-55/D-468) og situasjonen blir `escalate` med den ærlige årsaken - fail-closed, aldri en stille omgåelse.
 */
export interface HomeObservation {
  source: "home_assistant";
  entity_id: string;
  role: HomeRole;
  /** Rå HA-tilstandsstreng (`on`, `off`, `open`, `closed`, `triggered`, `unavailable` ...). Ukjent = ingen signal. */
  state: string;
  /** HAs `last_changed` (ISO), ordrett som HA leverte den (inngår i hendelsesnøkkelen). */
  last_changed: string;
  /** Kun for `power`: antall tikk på rad over eierens grense, når det begynte (ISO) og eierens egen grense. */
  over_limit_ticks?: number;
  over_limit_since?: string;
  limit_w?: number;
}

const OPEN_STATES: ReadonlySet<string> = new Set(["on", "open", "opening"]);
const CLOSABLE: ReadonlySet<HomeRole> = new Set(["garage_door", "gate"]);
const ROLE_LABEL: Readonly<Record<string, string>> = { door: "Dør", window: "Vindu", garage_door: "Garasjeport", gate: "Port", opening: "Åpning" };

/**
 * Hendelsesnøkkelen for en åpnings-episode. DEN SAMME nøkkelen brukes av kamerabroen for `opening_detected` (samme fysiske hendelse via to kilder = én situasjon).
 * Tidspunktet normaliseres til `toISOString()` (millisekunder, UTC) - nøyaktig formen som `source_event_id = <entitet>@<ISO>` har i hendelsene fra kamerakilden (WP-G3).
 */
export function openingDetectionKey(entityId: string, lastChangedMs: number): string {
  return `home:opening:${entityId}@${new Date(lastChangedMs).toISOString()}`;
}

const CLOSED_STATES: ReadonlySet<string> = new Set(["off", "closed"]);
const ALARM_NOT_TRIGGERED: ReadonlySet<string> = new Set(["disarmed", "armed_home", "armed_away", "armed_night", "armed_vacation", "armed_custom_bypass"]);

/**
 * A-MEDIUM-4/B-MEDIUM-3: er tilstanden NORMAL (lukket/tørr/avarmert/under grensen)? Kun da er en åpen situasjon for entiteten løst - ukjent (`unavailable`, `unknown`), overgang (`closing`, `pending`) og en tilstand under terskelen
 * er IKKE normal (null løsing på gjetning). Ren funksjon over HAs egne tilstandsverdier.
 */
export function homeStateIsNormal(obs: HomeObservation): boolean {
  switch (obs.role) {
    case "door":
    case "window":
    case "garage_door":
    case "gate":
    case "opening":
      return CLOSED_STATES.has(obs.state);
    case "leak":
      return obs.state === "off";
    case "alarm":
      return ALARM_NOT_TRIGGERED.has(obs.state);
    case "power":
      return obs.limit_w !== undefined && obs.over_limit_ticks === 0;
    default:
      return false;
  }
}

/** Nøkkelprefikset (`home:<art>:<entitet>@`) for ALLE episoder av denne entiteten og rollen - brukes til å løse åpne situasjoner når tilstanden er normal. Samme form som nøklene broen lager. */
export function homeKeyPrefix(obs: Pick<HomeObservation, "role" | "entity_id">): string | null {
  switch (obs.role) {
    case "door":
    case "window":
    case "garage_door":
    case "gate":
    case "opening":
      return `home:opening:${obs.entity_id}@`;
    case "leak":
      return `home:leak:${obs.entity_id}@`;
    case "alarm":
      return `home:alarm:${obs.entity_id}@`;
    case "power":
      return `home:power:${obs.entity_id}@`;
    default:
      return null;
  }
}

function factsOf(entries: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  assertMinimalFacts(entries);
  return entries;
}

export function bridgeHomeObservation(obs: HomeObservation, ctx: BridgeContext): BridgeResult | null {
  const changedMs = parseIsoMs(obs.last_changed);
  if (changedMs === null) return null;
  const entity = obs.entity_id.slice(0, 80);

  switch (obs.role) {
    case "door":
    case "window":
    case "garage_door":
    case "gate":
    case "opening": {
      const rule = ruleFor("home_assistant", "door_open_too_long");
      if (rule === undefined || !OPEN_STATES.has(obs.state)) return null;
      const threshold = ctx.threshold(rule) ?? 15;
      const openMinutes = Math.floor((ctx.nowMs - changedMs) / 60_000);
      if (openMinutes < threshold) return null;
      const longOpen = openMinutes >= threshold * 4;
      const closable = CLOSABLE.has(obs.role);
      const level = longOpen ? 2 : 1;
      const label = ROLE_LABEL[obs.role] ?? "Åpning";
      const key = openingDetectionKey(obs.entity_id, changedMs);
      const reason = `${label} (${entity}) har stått åpen i ${Math.min(openMinutes, 100_000)} min` + (longOpen && closable ? " - foreslått handling: lukk den" : "");
      return {
        rule_key: rule.rule_key, source: "home_assistant", event_type: rule.event_type,
        candidate: {
          domain: rule.domain, detection_key: key, priority: longOpen ? "high" : "normal",
          // Konfidens (=> `suggest`) KUN for en lukkbar port/garasjeport som har stått åpen lenge; dør/vindu har ingen automatisk handling.
          ...(longOpen && closable ? { confidence: 0.9 } : {}), reason
        },
        source_ref: `${key}#L${level}`,
        facts: factsOf({ role: obs.role, entity_id: entity, open_minutes: Math.min(openMinutes, 100_000), level }),
        urgent: false, occurred_at: obs.last_changed
      };
    }
    case "leak": {
      const rule = ruleFor("home_assistant", "water_leak");
      // HA binary_sensor (device_class moisture): `on` = våt, `off` = tørr.
      if (rule === undefined || obs.state !== "on") return null;
      const key = `home:leak:${obs.entity_id}@${new Date(changedMs).toISOString()}`;
      return {
        rule_key: rule.rule_key, source: "home_assistant", event_type: rule.event_type,
        candidate: { domain: rule.domain, detection_key: key, priority: "high", confidence: 0.95, reason: `Vannlekkasje registrert av sensor ${entity} - sjekk stedet og steng vannet om mulig` },
        source_ref: `${key}#L1`, facts: factsOf({ role: "leak", entity_id: entity, level: 1 }), urgent: true, occurred_at: obs.last_changed
      };
    }
    case "alarm": {
      const rule = ruleFor("home_assistant", "alarm_triggered");
      // HA alarm_control_panel: `triggered` = alarmen har gått.
      if (rule === undefined || obs.state !== "triggered") return null;
      const key = `home:alarm:${obs.entity_id}@${new Date(changedMs).toISOString()}`;
      return {
        rule_key: rule.rule_key, source: "home_assistant", event_type: rule.event_type,
        candidate: { domain: rule.domain, detection_key: key, priority: "high", confidence: 0.95, reason: `Alarmen er utløst (${entity})` },
        source_ref: `${key}#L1`, facts: factsOf({ role: "alarm", entity_id: entity, level: 1 }), urgent: true, occurred_at: obs.last_changed
      };
    }
    case "power": {
      const rule = ruleFor("home_assistant", "power_over_limit");
      if (rule === undefined || obs.limit_w === undefined || obs.over_limit_ticks === undefined || obs.over_limit_since === undefined) return null;
      const since = parseIsoMs(obs.over_limit_since);
      if (since === null) return null;
      const ticks = Math.floor(ctx.threshold(rule) ?? 3);
      if (!Number.isFinite(obs.over_limit_ticks) || obs.over_limit_ticks < ticks) return null;
      const key = `home:power:${obs.entity_id}@${new Date(since).toISOString()}`;
      return {
        rule_key: rule.rule_key, source: "home_assistant", event_type: rule.event_type,
        candidate: { domain: rule.domain, detection_key: key, priority: "normal", reason: `Strømforbruket (${entity}) har ligget over din grense på ${Math.round(obs.limit_w)} W over tid` },
        source_ref: `${key}#L1`, facts: factsOf({ role: "power", entity_id: entity, limit_w: Math.round(obs.limit_w), ticks: Math.min(obs.over_limit_ticks, 10_000) }),
        urgent: false, occurred_at: obs.over_limit_since
      };
    }
    default:
      return null;
  }
}
