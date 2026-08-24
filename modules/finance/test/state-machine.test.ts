import { describe, expect, it } from "vitest";
import {
  assertValidPaymentIntentTransition,
  canTransitionPaymentIntent,
  InvalidPaymentIntentTransitionError,
  isTerminalPaymentIntentState
} from "../src/state-machine.ts";
import type { PaymentIntentState } from "../src/types.ts";

const ALL_STATES: readonly PaymentIntentState[] = ["draft", "submitted", "provider_acknowledged", "settled", "failed", "cancelled"];

describe("A: gyldige overganger", () => {
  it("draft -> submitted, draft -> cancelled er gyldige", () => {
    expect(canTransitionPaymentIntent("draft", "submitted")).toBe(true);
    expect(canTransitionPaymentIntent("draft", "cancelled")).toBe(true);
  });
  it("submitted -> provider_acknowledged, submitted -> failed er gyldige", () => {
    expect(canTransitionPaymentIntent("submitted", "provider_acknowledged")).toBe(true);
    expect(canTransitionPaymentIntent("submitted", "failed")).toBe(true);
  });
  it("provider_acknowledged -> settled, provider_acknowledged -> failed er gyldige", () => {
    expect(canTransitionPaymentIntent("provider_acknowledged", "settled")).toBe(true);
    expect(canTransitionPaymentIntent("provider_acknowledged", "failed")).toBe(true);
  });
  it("samme-til-samme er alltid gyldig (no-op)", () => {
    for (const s of ALL_STATES) expect(canTransitionPaymentIntent(s, s)).toBe(true);
  });
});

describe("B: terminale tilstander har INGEN vei videre", () => {
  it("settled/failed/cancelled har tomme overgangslister", () => {
    expect(canTransitionPaymentIntent("settled", "draft")).toBe(false);
    expect(canTransitionPaymentIntent("failed", "draft")).toBe(false);
    expect(canTransitionPaymentIntent("cancelled", "draft")).toBe(false);
    expect(canTransitionPaymentIntent("settled", "submitted")).toBe(false);
  });
  it("isTerminalPaymentIntentState klassifiserer korrekt", () => {
    expect(isTerminalPaymentIntentState("settled")).toBe(true);
    expect(isTerminalPaymentIntentState("failed")).toBe(true);
    expect(isTerminalPaymentIntentState("cancelled")).toBe(true);
    expect(isTerminalPaymentIntentState("draft")).toBe(false);
    expect(isTerminalPaymentIntentState("submitted")).toBe(false);
    expect(isTerminalPaymentIntentState("provider_acknowledged")).toBe(false);
  });
});

describe("C: ugyldige overganger kaster typed error", () => {
  it("draft -> settled er ugyldig (må gjennom submitted/provider_acknowledged)", () => {
    expect(canTransitionPaymentIntent("draft", "settled")).toBe(false);
    expect(() => assertValidPaymentIntentTransition("draft", "settled")).toThrow(InvalidPaymentIntentTransitionError);
  });
  it("submitted -> cancelled er ugyldig (kun draft kan kanselleres)", () => {
    expect(canTransitionPaymentIntent("submitted", "cancelled")).toBe(false);
  });
  it("feilen bærer from/to for presis diagnostikk", () => {
    try {
      assertValidPaymentIntentTransition("failed", "settled");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPaymentIntentTransitionError);
      expect((err as InvalidPaymentIntentTransitionError).from).toBe("failed");
      expect((err as InvalidPaymentIntentTransitionError).to).toBe("settled");
    }
  });
});
