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
