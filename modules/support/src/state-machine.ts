import type { TicketStatus } from "./types.ts";

/**
 * §5 i byggeordren: deterministisk ticket-lifecycle. INGEN LLM avgjør om en
 * overgang er gyldig - rent oppslag i et statisk kart. Ugyldige overganger
 * feiler trygt (kaster `InvalidTicketTransitionError`), aldri en stille
 * ignorering eller en tvunget overgang.
 */
export const TICKET_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  open: ["pending", "waiting_customer", "waiting_internal", "resolved", "closed"],
  pending: ["open", "waiting_customer", "waiting_internal", "resolved", "closed"],
  waiting_customer: ["open", "pending", "waiting_internal", "resolved", "closed"],
  waiting_internal: ["open", "pending", "waiting_customer", "resolved", "closed"],
  // Støtte for gjenåpning (§5): en kundes svar etter resolved/closed kan flytte
  // tilbake til open/pending via den eksplisitte reopen-veien i service.ts -
  // dette kartet beskriver kun MANUELLE/eksplisitte statusoverganger.
  resolved: ["open", "pending", "closed"],
  closed: ["open"]
} as const;

export class InvalidTicketTransitionError extends Error {
  constructor(
    public readonly from: TicketStatus,
    public readonly to: TicketStatus
  ) {
    super(`invalid_ticket_transition:${from}->${to}`);
    this.name = "InvalidTicketTransitionError";
  }
}

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return true;
  return TICKET_TRANSITIONS[from].includes(to);
}

export function assertValidTicketTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransitionTicket(from, to)) {
    throw new InvalidTicketTransitionError(from, to);
  }
}

/** §16: en kunde-melding etter resolved/closed skal reåpne til `open` (deterministisk, ikke `pending`). */
export function reopenTargetStatus(): TicketStatus {
  return "open";
}

export function isTerminalTicketStatus(status: TicketStatus): boolean {
  return status === "resolved" || status === "closed";
}
