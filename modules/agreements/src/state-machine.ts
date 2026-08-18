import type { ContractStatus, ObligationStatus } from "./types.ts";

/**
 * Deterministisk kontrakt-lifecycle. INGEN LLM avgjør om en juridisk
 * overgang er gyldig ("Do not let an LLM decide legal lifecycle validity" i
 * byggeordren) - rent oppslag i et statisk kart. Ugyldige overganger feiler
 * trygt (kaster `InvalidContractTransitionError`), aldri en stille
 * ignorering eller en tvunget overgang.
 *
 * `terminated`/`cancelled` er praktisk talt terminale - den ENESTE veien
 * videre er en eksplisitt administrativ korreksjon tilbake til `draft`
 * (ALDRI direkte til `active` - en korrigert kontrakt må gjennom HELE
 * lifecyclen på nytt, aldri "gjenåpnes" som om den fortsatt var i kraft).
 */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  draft: ["review", "cancelled"],
  review: ["draft", "approved", "cancelled"],
  approved: ["active", "cancelled"],
  active: ["expiring", "terminated", "cancelled"],
  expiring: ["active", "expired", "terminated"],
  expired: ["active"],
  terminated: ["draft"],
  cancelled: ["draft"]
} as const;

export class InvalidContractTransitionError extends Error {
  constructor(
    public readonly from: ContractStatus,
    public readonly to: ContractStatus
  ) {
    super(`invalid_contract_transition:${from}->${to}`);
    this.name = "InvalidContractTransitionError";
  }
}

export function canTransitionContract(from: ContractStatus, to: ContractStatus): boolean {
  if (from === to) return true;
  return CONTRACT_TRANSITIONS[from].includes(to);
}

export function assertValidContractTransition(from: ContractStatus, to: ContractStatus): void {
  if (!canTransitionContract(from, to)) {
    throw new InvalidContractTransitionError(from, to);
  }
}

export function isTerminalContractStatus(status: ContractStatus): boolean {
  return status === "terminated" || status === "cancelled";
}

/** En kontrakt trenger periodisk gjennomgang (contract_review_required) kun i disse statusene - draft/review er allerede under aktiv behandling. */
export function needsPeriodicReview(status: ContractStatus): boolean {
  return status === "active" || status === "expiring";
}

const OBLIGATION_TRANSITIONS: Readonly<Record<ObligationStatus, readonly ObligationStatus[]>> = {
  open: ["completed", "waived"],
  completed: ["open"],
  waived: ["open"]
} as const;

export class InvalidObligationTransitionError extends Error {
  constructor(
    public readonly from: ObligationStatus,
    public readonly to: ObligationStatus
  ) {
    super(`invalid_obligation_transition:${from}->${to}`);
    this.name = "InvalidObligationTransitionError";
  }
}

export function canTransitionObligation(from: ObligationStatus, to: ObligationStatus): boolean {
  if (from === to) return true;
  return OBLIGATION_TRANSITIONS[from].includes(to);
}

export function assertValidObligationTransition(from: ObligationStatus, to: ObligationStatus): void {
  if (!canTransitionObligation(from, to)) {
    throw new InvalidObligationTransitionError(from, to);
  }
}
