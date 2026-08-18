import { describe, expect, it } from "vitest";
import {
  CONTRACT_TRANSITIONS,
  InvalidContractTransitionError,
  InvalidObligationTransitionError,
  assertValidContractTransition,
  assertValidObligationTransition,
  canTransitionContract,
  canTransitionObligation,
  isTerminalContractStatus,
  needsPeriodicReview
} from "../src/state-machine.ts";

describe("A: deterministisk kontrakt-lifecycle", () => {
  it("draft -> review -> approved -> active er en gyldig kjede", () => {
    expect(canTransitionContract("draft", "review")).toBe(true);
    expect(canTransitionContract("review", "approved")).toBe(true);
    expect(canTransitionContract("approved", "active")).toBe(true);
  });
  it("active -> expiring -> expired er en gyldig kjede", () => {
    expect(canTransitionContract("active", "expiring")).toBe(true);
    expect(canTransitionContract("expiring", "expired")).toBe(true);
  });
  it("samme status til samme status er alltid tillatt (no-op)", () => {
    expect(canTransitionContract("active", "active")).toBe(true);
  });
});

describe("B: ugyldig kontrakt-overgang feiler trygt, endrer ingenting", () => {
  it("draft -> active er IKKE tillatt (maa gjennom review/approved)", () => {
    expect(canTransitionContract("draft", "active")).toBe(false);
    expect(() => assertValidContractTransition("draft", "active")).toThrow(InvalidContractTransitionError);
  });
  it("expired -> terminated er IKKE tillatt (kun expired -> active)", () => {
    expect(canTransitionContract("expired", "terminated")).toBe(false);
  });
  it("feilmeldingen identifiserer baade fra- og til-status", () => {
    try {
      assertValidContractTransition("draft", "expired");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidContractTransitionError);
      expect((err as InvalidContractTransitionError).from).toBe("draft");
      expect((err as InvalidContractTransitionError).to).toBe("expired");
    }
  });
});

describe("C: terminated/cancelled er praktisk talt terminale - INGEN LLM avgjør juridisk gyldighet", () => {
  it("terminated -> active er IKKE tillatt (ingen gjenaapning som om fortsatt i kraft)", () => {
    expect(canTransitionContract("terminated", "active")).toBe(false);
  });
  it("cancelled -> active er IKKE tillatt", () => {
    expect(canTransitionContract("cancelled", "active")).toBe(false);
  });
  it("terminated -> draft ER tillatt (KUN administrativ korreksjon, maa gjennom hele lifecyclen paa nytt)", () => {
    expect(canTransitionContract("terminated", "draft")).toBe(true);
  });
  it("cancelled -> draft ER tillatt (samme korreksjonsvei)", () => {
    expect(canTransitionContract("cancelled", "draft")).toBe(true);
  });
  it("isTerminalContractStatus identifiserer KUN terminated/cancelled", () => {
    expect(isTerminalContractStatus("terminated")).toBe(true);
    expect(isTerminalContractStatus("cancelled")).toBe(true);
    expect(isTerminalContractStatus("active")).toBe(false);
    expect(isTerminalContractStatus("expiring")).toBe(false);
  });
  it("transisjonskartet dekker ALLE 8 statuser eksplisitt (ingen implisitt fallback)", () => {
    expect(Object.keys(CONTRACT_TRANSITIONS).sort()).toEqual(
      ["active", "approved", "cancelled", "draft", "expired", "expiring", "review", "terminated"].sort()
    );
  });
});

describe("D: periodisk gjennomgang", () => {
  it("needsPeriodicReview er sann for active/expiring, usann for draft/review/approved/expired/terminated/cancelled", () => {
    expect(needsPeriodicReview("active")).toBe(true);
    expect(needsPeriodicReview("expiring")).toBe(true);
    expect(needsPeriodicReview("draft")).toBe(false);
    expect(needsPeriodicReview("terminated")).toBe(false);
  });
});

describe("E: deterministisk forpliktelses-lifecycle", () => {
  it("open -> completed og open -> waived er begge tillatt", () => {
    expect(canTransitionObligation("open", "completed")).toBe(true);
    expect(canTransitionObligation("open", "waived")).toBe(true);
  });
  it("completed -> open og waived -> open (korreksjon/gjenaapning) er tillatt", () => {
    expect(canTransitionObligation("completed", "open")).toBe(true);
    expect(canTransitionObligation("waived", "open")).toBe(true);
  });
  it("completed -> waived er IKKE en direkte tillatt overgang (maa via open)", () => {
    expect(canTransitionObligation("completed", "waived")).toBe(false);
    expect(() => assertValidObligationTransition("completed", "waived")).toThrow(InvalidObligationTransitionError);
  });
});
