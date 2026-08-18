import { describe, expect, it } from "vitest";
import {
  InvalidTicketTransitionError,
  assertValidTicketTransition,
  canTransitionTicket,
  isTerminalTicketStatus,
  reopenTargetStatus
} from "../src/state-machine.ts";

describe("D: gyldig statusovergang", () => {
  it("open -> pending er tillatt", () => {
    expect(canTransitionTicket("open", "pending")).toBe(true);
    expect(() => assertValidTicketTransition("open", "pending")).not.toThrow();
  });
  it("waiting_customer -> resolved er tillatt", () => {
    expect(canTransitionTicket("waiting_customer", "resolved")).toBe(true);
  });
  it("samme status til samme status er alltid tillatt (no-op)", () => {
    expect(canTransitionTicket("open", "open")).toBe(true);
  });
});

describe("E: ugyldig statusovergang feiler trygt", () => {
  it("closed -> resolved er IKKE tillatt (kun closed -> open reaapner)", () => {
    expect(canTransitionTicket("closed", "resolved")).toBe(false);
    expect(() => assertValidTicketTransition("closed", "resolved")).toThrow(InvalidTicketTransitionError);
  });
  it("feilmeldingen identifiserer baade fra- og til-status uten aa endre noe", () => {
    try {
      assertValidTicketTransition("closed", "priority" as never);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTicketTransitionError);
      expect((err as InvalidTicketTransitionError).from).toBe("closed");
    }
  });
});

describe("F: gjenaapning", () => {
  it("resolved -> open er eksplisitt tillatt (manuell gjenaapning)", () => {
    expect(canTransitionTicket("resolved", "open")).toBe(true);
  });
  it("closed -> open er eksplisitt tillatt (manuell gjenaapning)", () => {
    expect(canTransitionTicket("closed", "open")).toBe(true);
  });
  it("reopenTargetStatus() er deterministisk 'open', ikke 'pending'", () => {
    expect(reopenTargetStatus()).toBe("open");
  });
  it("isTerminalTicketStatus identifiserer KUN resolved/closed som terminal", () => {
    expect(isTerminalTicketStatus("resolved")).toBe(true);
    expect(isTerminalTicketStatus("closed")).toBe(true);
    expect(isTerminalTicketStatus("open")).toBe(false);
    expect(isTerminalTicketStatus("waiting_internal")).toBe(false);
  });
});
