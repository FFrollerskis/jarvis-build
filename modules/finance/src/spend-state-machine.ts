import type { CommitmentState, ProcurementStatus } from "./spend-types.ts";

/**
 * Deterministisk lifecycle for forpliktelser/anskaffelser (UA-6 Slice 2,
 * §6/§7 i byggeordren: "State transitions must be deterministic and
 * tested"). SAMME rene oppslags-i-statisk-kart-prinsipp som
 * `PAYMENT_INTENT_TRANSITIONS` (state-machine.ts) - INGEN LLM avgjør en
 * overgang.
 */
export const COMMITMENT_TRANSITIONS: Readonly<Record<CommitmentState, readonly CommitmentState[]>> = {
  active: ["paused", "cancelled"],
  paused: ["active", "cancelled"],
  cancelled: []
} as const;

export const PROCUREMENT_TRANSITIONS: Readonly<Record<ProcurementStatus, readonly ProcurementStatus[]>> = {
  expected: ["fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: []
} as const;

export class InvalidCommitmentTransitionError extends Error {
  constructor(
    public readonly from: CommitmentState,
    public readonly to: CommitmentState
  ) {
    super(`invalid_commitment_transition:${from}->${to}`);
    this.name = "InvalidCommitmentTransitionError";
  }
}

export class InvalidProcurementTransitionError extends Error {
  constructor(
    public readonly from: ProcurementStatus,
    public readonly to: ProcurementStatus
  ) {
    super(`invalid_procurement_transition:${from}->${to}`);
    this.name = "InvalidProcurementTransitionError";
  }
}

export function canTransitionCommitment(from: CommitmentState, to: CommitmentState): boolean {
  if (from === to) return true;
  return COMMITMENT_TRANSITIONS[from].includes(to);
}

export function assertValidCommitmentTransition(from: CommitmentState, to: CommitmentState): void {
  if (!canTransitionCommitment(from, to)) throw new InvalidCommitmentTransitionError(from, to);
}

export function canTransitionProcurement(from: ProcurementStatus, to: ProcurementStatus): boolean {
  if (from === to) return true;
  return PROCUREMENT_TRANSITIONS[from].includes(to);
}

export function assertValidProcurementTransition(from: ProcurementStatus, to: ProcurementStatus): void {
  if (!canTransitionProcurement(from, to)) throw new InvalidProcurementTransitionError(from, to);
}
