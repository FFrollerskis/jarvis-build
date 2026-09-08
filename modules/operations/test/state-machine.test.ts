import { describe, expect, it } from "vitest";
import {
  OPERATIONS_TASK_TRANSITIONS,
  InvalidOperationsTaskTransitionError,
  assertValidOperationsTaskTransition,
  canTransitionOperationsTask,
  isTerminalOperationsTaskStatus
} from "../src/state-machine.ts";

describe("A: deterministisk driftsoppgave-lifecycle", () => {
  it("open -> in_progress -> done er en gyldig kjede", () => {
    expect(canTransitionOperationsTask("open", "in_progress")).toBe(true);
    expect(canTransitionOperationsTask("in_progress", "done")).toBe(true);
  });
  it("open -> blocked -> in_progress -> done er en gyldig kjede", () => {
    expect(canTransitionOperationsTask("open", "blocked")).toBe(true);
    expect(canTransitionOperationsTask("blocked", "in_progress")).toBe(true);
  });
  it("samme status til samme status er alltid tillatt (no-op)", () => {
    expect(canTransitionOperationsTask("in_progress", "in_progress")).toBe(true);
  });
});

describe("B: ugyldig overgang feiler trygt, endrer ingenting", () => {
  it("open -> done ER tillatt (direkte fullføring uten mellomtrinn er en legitim driftsoppgave-vei)", () => {
    expect(canTransitionOperationsTask("open", "done")).toBe(true);
  });
  it("done -> in_progress er IKKE tillatt (kun done -> open)", () => {
    expect(canTransitionOperationsTask("done", "in_progress")).toBe(false);
    expect(() => assertValidOperationsTaskTransition("done", "in_progress")).toThrow(InvalidOperationsTaskTransitionError);
  });
  it("cancelled -> blocked er IKKE tillatt (kun cancelled -> open)", () => {
    expect(canTransitionOperationsTask("cancelled", "blocked")).toBe(false);
  });
  it("feilmeldingen identifiserer baade fra- og til-status", () => {
    try {
      assertValidOperationsTaskTransition("done", "blocked");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidOperationsTaskTransitionError);
      expect((err as InvalidOperationsTaskTransitionError).from).toBe("done");
      expect((err as InvalidOperationsTaskTransitionError).to).toBe("blocked");
    }
  });
});

describe("C: done/cancelled er praktisk talt terminale", () => {
  it("done -> open ER tillatt (KUN administrativ gjenaapning, maa gjennom hele lifecyclen paa nytt)", () => {
    expect(canTransitionOperationsTask("done", "open")).toBe(true);
  });
  it("cancelled -> open ER tillatt (samme gjenaapningsvei)", () => {
    expect(canTransitionOperationsTask("cancelled", "open")).toBe(true);
  });
  it("isTerminalOperationsTaskStatus identifiserer KUN done/cancelled", () => {
    expect(isTerminalOperationsTaskStatus("done")).toBe(true);
    expect(isTerminalOperationsTaskStatus("cancelled")).toBe(true);
    expect(isTerminalOperationsTaskStatus("open")).toBe(false);
    expect(isTerminalOperationsTaskStatus("in_progress")).toBe(false);
    expect(isTerminalOperationsTaskStatus("blocked")).toBe(false);
  });
  it("transisjonskartet dekker ALLE 5 statuser eksplisitt (ingen implisitt fallback)", () => {
    expect(Object.keys(OPERATIONS_TASK_TRANSITIONS).sort()).toEqual(
      ["blocked", "cancelled", "done", "in_progress", "open"].sort()
    );
  });
});
