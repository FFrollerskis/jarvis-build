import { describe, expect, it } from "vitest";
import {
  PRODUCT_ITEM_TRANSITIONS,
  InvalidProductItemTransitionError,
  assertValidProductItemTransition,
  canTransitionProductItem,
  isTerminalProductItemStatus,
  needsTriage
} from "../src/state-machine.ts";

describe("A: deterministisk produkt-punkt-lifecycle", () => {
  it("new -> triaged -> planned -> in_progress -> shipped er en gyldig kjede", () => {
    expect(canTransitionProductItem("new", "triaged")).toBe(true);
    expect(canTransitionProductItem("triaged", "planned")).toBe(true);
    expect(canTransitionProductItem("planned", "in_progress")).toBe(true);
    expect(canTransitionProductItem("in_progress", "shipped")).toBe(true);
  });
  it("samme status til samme status er alltid tillatt (no-op)", () => {
    expect(canTransitionProductItem("planned", "planned")).toBe(true);
  });
});

describe("B: ugyldig overgang feiler trygt, endrer ingenting", () => {
  it("new -> in_progress er IKKE tillatt (maa gjennom triaged/planned)", () => {
    expect(canTransitionProductItem("new", "in_progress")).toBe(false);
    expect(() => assertValidProductItemTransition("new", "in_progress")).toThrow(InvalidProductItemTransitionError);
  });
  it("shipped -> in_progress er IKKE tillatt (kun shipped -> new)", () => {
    expect(canTransitionProductItem("shipped", "in_progress")).toBe(false);
  });
  it("feilmeldingen identifiserer baade fra- og til-status", () => {
    try {
      assertValidProductItemTransition("new", "shipped");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProductItemTransitionError);
      expect((err as InvalidProductItemTransitionError).from).toBe("new");
      expect((err as InvalidProductItemTransitionError).to).toBe("shipped");
    }
  });
});

describe("C: shipped/declined/closed er praktisk talt terminale", () => {
  it("shipped -> new ER tillatt (KUN administrativ gjenaapning, maa gjennom hele lifecyclen paa nytt)", () => {
    expect(canTransitionProductItem("shipped", "new")).toBe(true);
  });
  it("declined -> new ER tillatt (samme gjenaapningsvei)", () => {
    expect(canTransitionProductItem("declined", "new")).toBe(true);
  });
  it("closed -> new ER tillatt (samme gjenaapningsvei)", () => {
    expect(canTransitionProductItem("closed", "new")).toBe(true);
  });
  it("isTerminalProductItemStatus identifiserer KUN shipped/declined/closed", () => {
    expect(isTerminalProductItemStatus("shipped")).toBe(true);
    expect(isTerminalProductItemStatus("declined")).toBe(true);
    expect(isTerminalProductItemStatus("closed")).toBe(true);
    expect(isTerminalProductItemStatus("new")).toBe(false);
    expect(isTerminalProductItemStatus("in_progress")).toBe(false);
  });
  it("transisjonskartet dekker ALLE 7 statuser eksplisitt (ingen implisitt fallback)", () => {
    expect(Object.keys(PRODUCT_ITEM_TRANSITIONS).sort()).toEqual(
      ["closed", "declined", "in_progress", "new", "planned", "shipped", "triaged"].sort()
    );
  });
});

describe("D: triage-behov", () => {
  it("needsTriage er sann KUN for 'new'", () => {
    expect(needsTriage("new")).toBe(true);
    expect(needsTriage("triaged")).toBe(false);
    expect(needsTriage("planned")).toBe(false);
    expect(needsTriage("shipped")).toBe(false);
  });
});
