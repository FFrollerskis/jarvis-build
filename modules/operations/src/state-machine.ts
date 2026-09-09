import type { OperationsTaskStatus } from "./types.ts";

/**
 * Deterministisk driftsoppgave-lifecycle. INGEN LLM avgjør om en overgang
 * er gyldig - rent oppslag i et statisk kart. Ugyldige overganger feiler
 * trygt (kaster `InvalidOperationsTaskTransitionError`), aldri en stille
 * ignorering eller en tvunget overgang. Samme prinsipp som
 * `product/src/state-machine.ts`/`agreements/src/state-machine.ts`.
 *
 * `done`/`cancelled` er praktisk talt terminale - den ENESTE veien videre
 * er en eksplisitt administrativ gjenåpning tilbake til `open` (samme
 * "korrigert punkt går gjennom hele lifecyclen på nytt"-prinsipp som
 * kontrakter/produktpunkter).
 */
export const OPERATIONS_TASK_TRANSITIONS: Readonly<Record<OperationsTaskStatus, readonly OperationsTaskStatus[]>> = {
  open: ["in_progress", "blocked", "cancelled", "done"],
  in_progress: ["blocked", "done", "cancelled", "open"],
  blocked: ["in_progress", "cancelled", "open"],
  done: ["open"],
  cancelled: ["open"]
} as const;

export class InvalidOperationsTaskTransitionError extends Error {
  constructor(
    public readonly from: OperationsTaskStatus,
    public readonly to: OperationsTaskStatus
  ) {
    super(`invalid_operations_task_transition:${from}->${to}`);
    this.name = "InvalidOperationsTaskTransitionError";
  }
}

export function canTransitionOperationsTask(from: OperationsTaskStatus, to: OperationsTaskStatus): boolean {
  if (from === to) return true;
  return OPERATIONS_TASK_TRANSITIONS[from].includes(to);
}

export function assertValidOperationsTaskTransition(from: OperationsTaskStatus, to: OperationsTaskStatus): void {
  if (!canTransitionOperationsTask(from, to)) {
    throw new InvalidOperationsTaskTransitionError(from, to);
  }
}

export function isTerminalOperationsTaskStatus(status: OperationsTaskStatus): boolean {
  return status === "done" || status === "cancelled";
}
