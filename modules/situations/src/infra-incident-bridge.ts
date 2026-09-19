import type { Incident, IncidentStatus } from "@jarvis/incidents";
import type { SituationCandidateInput, SituationPriority } from "./types.ts";

/**
 * D-195 (UA-10 infra-slice): den ANDRE live kilden til
 * `SituationEngine.evaluateCandidate()` - en ren, deterministisk bro fra
 * `incidents` (D-104/D-105s allerede eksisterende Production Operations
 * Control Plane) til `situations`, nøyaktig samme mønster som
 * `open-loop-bridge.ts` sin business-bro (D-160). Design-notatets §5 var
 * eksplisitt: infra/home/health-broer var BEVISST utsatt til en EGEN slice
 * PER domene, i påvente av en faktisk signalkilde - `incidents` er nå den
 * kilden for infra (bygget senere under UA-5/D-104/D-105, uavhengig av
 * UA-10 P0/P1). INGEN ny anomali-detektor oppfinnes her: broen oversetter
 * en ALLEREDE eksisterende incident-rad til situasjonskontrakten.
 *
 * Ren funksjon, ingen I/O - `sweep.ts` er det som faktisk leser incidents
 * og kaller motoren.
 */
export const INFRA_INCIDENT_DETECTION_KEY_PREFIX = "infra_incident:";
export const INFRA_DOMAIN = "infra";

/** `wont_fix`/`resolved` er de to TERMINALE statusene - alt annet er en aktiv hendelse som skal ha en levende situasjon. */
export function isActiveIncidentStatus(status: IncidentStatus): boolean {
  return status !== "resolved" && status !== "wont_fix";
}

function priorityForSeverity(severity: Incident["severity"]): SituationPriority {
  switch (severity) {
    case "critical":
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "normal";
  }
}

/**
 * Én aktiv incident -> én situasjonskandidat. BEVISST, samme disiplin som
 * `mapOpenLoopToCandidate()`:
 *  - `detection_key` = prefiks + `incident_id` (idempotent: samme incident
 *    => samme situasjon, uansett hvor mange ganger sveipet kjører).
 *  - `owner_person_id` settes IKKE: en incident kan re-tildeles, og eieren
 *    er (samme begrunnelse som business-broen) IKKE en del av situasjonens
 *    identitet - `evaluateCandidate()` ville ellers avvise en lovlig
 *    re-tildeling som en identitetskonflikt.
 *  - `source_open_loop_id` settes IKKE (den FK-en er business-open-loop-
 *    spesifikk) - resolusjon for infra-situasjoner skjer i stedet via
 *    `SituationEngine.resolveStaleForDomain()` (domene+detection_key, se
 *    service.ts), ikke via `source_open_loop_id`-listen.
 *  - `reason` er en DETERMINISTISK sammensetting av allerede lagrede felter
 *    (tittel/status/alvorlighetsgrad) - INGEN modell-generert tekst.
 */
export function mapIncidentToCandidate(incident: Incident): SituationCandidateInput {
  return {
    domain: INFRA_DOMAIN,
    detection_key: `${INFRA_INCIDENT_DETECTION_KEY_PREFIX}${incident.incident_id}`,
    priority: priorityForSeverity(incident.severity),
    reason: `${incident.title} (status: ${incident.status}, alvorlighetsgrad: ${incident.severity})`
  };
}
