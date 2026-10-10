import type { IncidentStatus } from "./types.ts";

/**
 * D-104: deterministisk incident-lifecycle. INGEN LLM avgjør om en overgang
 * er gyldig - rent oppslag i et statisk kart. Ugyldige overganger feiler
 * trygt (kaster `InvalidIncidentTransitionError`), aldri en stille
 * ignorering eller en tvunget overgang.
 */
export const INCIDENT_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  // "repair_proposed" er nåbar direkte fra "open" (en åpenbar fiks trenger
  // ikke en formell diagnosing-fase - se IncidentService.proposeRepairTask())
  // OG fra "diagnosing" (den vanlige, mer grundige veien).
  open: ["diagnosing", "repair_proposed", "resolved", "wont_fix"],
  diagnosing: ["open", "repair_proposed", "resolved", "wont_fix"],
  repair_proposed: ["diagnosing", "repair_in_progress", "resolved", "wont_fix"],
  repair_in_progress: ["repair_proposed", "resolved", "wont_fix"],
  // Terminal, men en feilaktig lukket/løst hendelse kan gjenåpnes eksplisitt.
  resolved: ["open"],
  wont_fix: ["open"]
} as const;

export class InvalidIncidentTransitionError extends Error {
  constructor(
    public readonly from: IncidentStatus,
    public readonly to: IncidentStatus
  ) {
    super(`invalid_incident_transition:${from}->${to}`);
    this.name = "InvalidIncidentTransitionError";
  }
}

export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  if (from === to) return true;
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export function assertValidIncidentTransition(from: IncidentStatus, to: IncidentStatus): void {
  if (!canTransitionIncident(from, to)) {
    throw new InvalidIncidentTransitionError(from, to);
  }
}

export function isTerminalIncidentStatus(status: IncidentStatus): boolean {
  return status === "resolved" || status === "wont_fix";
}

/**
 * WP-E1 (JARVIS-068): livssyklus-FASEN eieren ser. Statusverdiene i databasen er uendret (CHECK-begrensninger, lagrede data og situasjonsmotorens infra-bro avhenger av dem);
 * dette er kun den stabile, ene oversettelsen til begrepene åpen -> anerkjent -> avbøtende -> løst/lukket. Brukes av API-et, rapporten og postmortem-en, så ingen flate finner opp sitt eget ordvalg.
 */
export type IncidentPhase = "open" | "acknowledged" | "mitigating" | "resolved" | "closed";

export function incidentPhase(status: IncidentStatus): IncidentPhase {
  switch (status) {
    case "open": return "open";
    case "diagnosing": return "acknowledged";
    case "repair_proposed":
    case "repair_in_progress": return "mitigating";
    case "resolved": return "resolved";
    case "wont_fix": return "closed";
  }
}

export function incidentPhaseNo(status: IncidentStatus): string {
  switch (incidentPhase(status)) {
    case "open": return "åpen";
    case "acknowledged": return "anerkjent";
    case "mitigating": return status === "repair_in_progress" ? "avbøting pågår" : "avbøting foreslått";
    case "resolved": return "løst";
    case "closed": return "lukket uten tiltak";
  }
}

/**
 * Eier-handlingene på livssyklusen og hvilken status de gir. `mitigate` har to trinn (foreslått -> pågår) fordi kodejobben (`repair.ts`) ender i `repair_proposed` og eieren selv
 * markerer `repair_in_progress` når tiltaket faktisk er i gang. Selve lovligheten avgjøres fortsatt av `INCIDENT_TRANSITIONS`.
 */
export const OWNER_LIFECYCLE_ACTIONS: Readonly<Record<"acknowledge" | "mitigate" | "start_mitigation" | "resolve" | "close" | "reopen", IncidentStatus>> = {
  acknowledge: "diagnosing",
  mitigate: "repair_proposed",
  start_mitigation: "repair_in_progress",
  resolve: "resolved",
  close: "wont_fix",
  reopen: "open"
};
