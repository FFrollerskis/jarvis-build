import { openingDetectionKey } from "./home-bridge.ts";
import { assertMinimalFacts, parseIsoMs, ruleFor, type BridgeContext, type BridgeResult, type VisionFilter } from "./signal-types.ts";

/**
 * WP-G4 (D-466), UA-10 P1b: den REN broen fra en MINIMERT kamerahendelse (rad fra `vision_event_observations`, WP-G3) til en situasjonskandidat. Ingen I/O, ingen klokke (`ctx.nowMs`), ingen modell.
 *
 * BEGRENSEDE data (SECRET_RESTRICTED, kjent hull N1): observasjonen som kommer inn er allerede en strukturert, lokalt klassifisert hendelse - aldri et bilde. Broen gjør tre ting for å holde det minimalt:
 *  1. Objektetiketten (ÅPENT ordforråd fra en lokal modell, ubetrodd) brukes KUN til å avgjøre om den tilhører et LUKKET sett («pakke»-ord, `PACKAGE_WORDS`); selve etiketten lagres og gis ALDRI videre
 *     (ikke i `reason`, ikke i `facts`, ikke i logg).
 *  2. `reason` (som også er varselteksten) er INNHOLDSFRI for alt som er utledet av bildeinnhold (person, pakke): «Kamerahendelse registrert - åpne Jarvis for detaljer». Sensor-utløste hendelser
 *     (dørklokke, bevegelse, sikkerhetsvarsel) har en kort fast tekst. Ingen identiteter, ingen etiketter, ingen tall.
 *  3. INGEN ansiktsidentifikasjon, ingen personnavn: hendelsessettet er lukket og kategoriene er fast kodet. Motoren kan ikke utføre ACT i domenet (`NEVER_ACT_DOMAINS`), og konfidens utelates alltid slik at
 *     stadiet aldri går forbi `inform` (`computeTargetStage` gir `suggest` kun med oppgitt konfidens >= 0,75).
 *
 * Idempotens/dedupe: hendelser av samme type fra samme kilde slås sammen i et tidsvindu (`cooldown_minutes`, tunbar innenfor harde grenser): nøkkelen er `vision:<type>:<kilde>:<vindu>` - en flom av bevegelse gir
 * ÉN situasjon, ikke ett varsel per hendelse. `opening_detected` bruker SAMME nøkkel som Home Assistant-broen (`openingDetectionKey`): samme åpning via to kilder er én situasjon og ett varsel.
 */
export interface VisionObservation {
  source: "vision";
  observation_id: string;
  /** Hendelsestype fra `vision_event_observations` (lukket sett). */
  event_type: string;
  source_instance_id: string;
  /** `<entitet>@<ISO>` fra kamerakilden (WP-G3); brukes til å gjenkjenne en åpning som allerede er sett av Home Assistant-broen. */
  source_event_id: string;
  observed_at: string;
  /** Kun for å avgjøre kategorien «pakke»; lagres og gis aldri videre. */
  object_label: string | null;
  classification_status: string;
}

const PACKAGE_WORDS: ReadonlySet<string> = new Set(["package", "packages", "parcel", "parcels", "pakke", "pakker", "pakken", "postpakke"]);
const SOURCE_EVENT = /^([a-z_]+\.[a-z0-9_]+)@(.+)$/;
const NOTHING_TO_SAY = "Kamerahendelse registrert - åpne Jarvis for detaljer";

function isPackageLabel(label: string | null): boolean {
  if (label === null) return false;
  const words = label.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  return words.some((w) => PACKAGE_WORDS.has(w));
}

/** Hendelsestypen i VÅRT lukkede sett (`SIGNAL_EVENT_TYPES.vision`), eller `null` hvis hendelsen ikke har noen regel (f.eks. en vanlig gjenstand). */
export function visionEventTypeOf(obs: Pick<VisionObservation, "event_type" | "object_label">): string | null {
  switch (obs.event_type) {
    case "object_detected": return isPackageLabel(obs.object_label) ? "package_detected" : null;
    case "person_present":
    case "motion_detected":
    case "doorbell_event":
    case "security_alert":
    case "opening_detected":
      return obs.event_type;
    default:
      return null;
  }
}

function inNightWindow(ms: number, filter: VisionFilter): boolean {
  const w = filter.night_hours_utc;
  if (w === undefined || w.start === w.end) return false;
  const hour = new Date(ms).getUTCHours();
  return w.start < w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end;
}

export function bridgeVisionObservation(obs: VisionObservation, filter: VisionFilter, ctx: BridgeContext): BridgeResult | null {
  if (filter.source_instance_ids !== undefined && !filter.source_instance_ids.includes(obs.source_instance_id)) return null;
  const eventType = visionEventTypeOf(obs);
  if (eventType === null) return null;
  const rule = ruleFor("vision", eventType);
  const observedMs = parseIsoMs(obs.observed_at);
  if (rule === undefined || observedMs === null) return null;
  // En hendelse fra framtiden (klokkefeil) er ikke et gyldig signal.
  if (observedMs > ctx.nowMs + 5 * 60_000) return null;

  const night = inNightWindow(observedMs, filter);
  const base = { rule_key: rule.rule_key, source: "vision" as const, event_type: eventType, urgent: rule.urgent, occurred_at: new Date(observedMs).toISOString() };
  const classified = obs.classification_status === "classified";

  if (eventType === "opening_detected") {
    // Samme fysiske åpning som Home Assistant-broen ser (`home:opening:<entitet>@<ISO>`): én nøkkel, ett varsel. Uten et gjenkjennelig `<entitet>@<ISO>` faller vi tilbake til en egen nøkkel.
    const m = SOURCE_EVENT.exec(obs.source_event_id);
    const changedMs = m === null ? null : parseIsoMs(m[2]);
    const key = m !== null && changedMs !== null ? openingDetectionKey(m[1] as string, changedMs) : `home:opening:vision:${obs.source_instance_id}:${obs.observation_id}`;
    const facts = { event_type: eventType, night };
    assertMinimalFacts(facts);
    return { ...base, candidate: { domain: rule.domain, detection_key: key, priority: "low", reason: "Åpning registrert av en sensor" }, source_ref: `${key}#vision`, facts };
  }

  const cooldown = Math.max(1, ctx.threshold(rule) ?? 10);
  const bucket = Math.floor(observedMs / (cooldown * 60_000));
  const key = `vision:${eventType}:${obs.source_instance_id}:${bucket}`;
  const facts = { event_type: eventType, night, classified, ...(eventType === "package_detected" || eventType === "person_present" ? { category: eventType === "package_detected" ? "package" : "person" } : {}) };
  assertMinimalFacts(facts);
  const common = { domain: rule.domain, detection_key: key };
  const ref = `vision:${obs.source_instance_id}:${obs.observation_id}`;
  switch (eventType) {
    case "doorbell_event":
      return { ...base, candidate: { ...common, priority: "normal", reason: "Dørklokkehendelse registrert" }, source_ref: ref, facts };
    case "security_alert":
      // Høy prioritet, men aldri konfidens: stadiet blir `inform` (ingen forslag/ACT i dette domenet).
      return { ...base, candidate: { ...common, priority: "high", reason: "Sikkerhetsvarsel fra en sensor" }, source_ref: ref, facts };
    case "motion_detected":
      return { ...base, candidate: { ...common, priority: night ? "normal" : "low", reason: night ? "Bevegelse registrert utenfor forventet tid" : "Bevegelse registrert" }, source_ref: ref, facts };
    case "person_present":
      return { ...base, candidate: { ...common, priority: night ? "normal" : "low", reason: NOTHING_TO_SAY }, source_ref: ref, facts };
    case "package_detected":
      return { ...base, candidate: { ...common, priority: "normal", reason: NOTHING_TO_SAY }, source_ref: ref, facts };
    default:
      return null;
  }
}
