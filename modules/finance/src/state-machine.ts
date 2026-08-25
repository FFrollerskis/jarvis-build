import type { PaymentIntentState } from "./types.ts";

/**
 * Deterministisk Payment Intent-lifecycle. INGEN LLM avgjør om en
 * overgang er gyldig (samme prinsipp som `agreements`/`growth` sin
 * state-machine.ts) - rent oppslag i et statisk kart. Ugyldige overganger
 * feiler trygt (kaster den typede feilen under), aldri en stille
 * ignorering eller en tvunget overgang.
 *
 * `settled`/`failed`/`cancelled` er terminale - INGEN vei videre (i
 * motsetning til kampanje/kontrakt-lifecyclene finnes det INGEN
 * administrativ "korriger tilbake til draft" for en pengehandling som
 * faktisk har rørt en ekstern leverandør - en feilaktig postering
 * korrigeres ved en NY, separat intent, aldri ved å gjenåpne den gamle).
 *
 * `provider_acknowledged -> cancelled` lagt til for D-109 (UA-6 Slice 3,
 * Stripe): Stripe sin egen `canceled`-status representerer en BEVISST
 * avbrutt intensjon (ikke et mislykket forsøk) og kan inntreffe ETTER at
 * Stripe allerede har anerkjent intensjonen - noe Fiken sin synkrone
 * postering aldri produserer (Fiken-flyten trigger derfor ALDRI denne
 * grenen, byte-for-byte uendret oppførsel for `provider='fiken'`, bevist i
 * regresjonstest).
 */
export const PAYMENT_INTENT_TRANSITIONS: Readonly<Record<PaymentIntentState, readonly PaymentIntentState[]>> = {
  draft: ["submitted", "cancelled"],
  submitted: ["provider_acknowledged", "failed"],
  provider_acknowledged: ["settled", "failed", "cancelled"],
  settled: [],
  failed: [],
  cancelled: []
} as const;

export class InvalidPaymentIntentTransitionError extends Error {
  constructor(
    public readonly from: PaymentIntentState,
    public readonly to: PaymentIntentState
  ) {
    super(`invalid_payment_intent_transition:${from}->${to}`);
    this.name = "InvalidPaymentIntentTransitionError";
  }
}

export function canTransitionPaymentIntent(from: PaymentIntentState, to: PaymentIntentState): boolean {
  if (from === to) return true;
  return PAYMENT_INTENT_TRANSITIONS[from].includes(to);
}

export function assertValidPaymentIntentTransition(from: PaymentIntentState, to: PaymentIntentState): void {
  if (!canTransitionPaymentIntent(from, to)) {
    throw new InvalidPaymentIntentTransitionError(from, to);
  }
}

export function isTerminalPaymentIntentState(state: PaymentIntentState): boolean {
  return state === "settled" || state === "failed" || state === "cancelled";
}
