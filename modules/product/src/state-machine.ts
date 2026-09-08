import type { ProductItemStatus } from "./types.ts";

/**
 * Deterministisk produkt-punkt-lifecycle. INGEN LLM avgjør om en overgang
 * er gyldig - rent oppslag i et statisk kart. Ugyldige overganger feiler
 * trygt (kaster `InvalidProductItemTransitionError`), aldri en stille
 * ignorering eller en tvunget overgang. Samme prinsipp som
 * `agreements/src/state-machine.ts`.
 *
 * `shipped`/`declined`/`closed` er praktisk talt terminale - den ENESTE
 * veien videre er en eksplisitt administrativ gjenåpning tilbake til `new`
 * (samme "korrigert punkt går gjennom hele lifecyclen på nytt"-prinsipp som
 * kontrakter).
 */
export const PRODUCT_ITEM_TRANSITIONS: Readonly<Record<ProductItemStatus, readonly ProductItemStatus[]>> = {
  new: ["triaged", "declined", "closed"],
  triaged: ["planned", "declined", "closed"],
  planned: ["in_progress", "triaged", "declined", "closed"],
  in_progress: ["shipped", "planned", "declined", "closed"],
  shipped: ["new"],
  declined: ["new"],
  closed: ["new"]
} as const;

export class InvalidProductItemTransitionError extends Error {
  constructor(
    public readonly from: ProductItemStatus,
    public readonly to: ProductItemStatus
  ) {
    super(`invalid_product_item_transition:${from}->${to}`);
    this.name = "InvalidProductItemTransitionError";
  }
}

export function canTransitionProductItem(from: ProductItemStatus, to: ProductItemStatus): boolean {
  if (from === to) return true;
  return PRODUCT_ITEM_TRANSITIONS[from].includes(to);
}

export function assertValidProductItemTransition(from: ProductItemStatus, to: ProductItemStatus): void {
  if (!canTransitionProductItem(from, to)) {
    throw new InvalidProductItemTransitionError(from, to);
  }
}

export function isTerminalProductItemStatus(status: ProductItemStatus): boolean {
  return status === "shipped" || status === "declined" || status === "closed";
}

/** Et punkt trenger triage kun i `new` - allerede triagerte/planlagte/pågående punkter er under aktiv behandling. */
export function needsTriage(status: ProductItemStatus): boolean {
  return status === "new";
}
