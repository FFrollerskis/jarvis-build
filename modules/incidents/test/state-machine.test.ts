import { describe, expect, it } from "vitest";
import {
  INCIDENT_TRANSITIONS, InvalidIncidentTransitionError, assertValidIncidentTransition,
  canTransitionIncident, isTerminalIncidentStatus
} from "../src/state-machine.ts";

describe("D-104: incident state-machine - deterministisk, INGEN LLM", () => {
  it("A: gyldige overganger fra open - inkl. repair_proposed direkte (en åpenbar fiks trenger ikke en formell diagnosing-fase)", () => {
    expect(canTransitionIncident("open", "diagnosing")).toBe(true);
    expect(canTransitionIncident("open", "resolved")).toBe(true);
    expect(canTransitionIncident("open", "wont_fix")).toBe(true);
    expect(canTransitionIncident("open", "repair_proposed")).toBe(true);
    expect(canTransitionIncident("open", "repair_in_progress")).toBe(false);
  });

  it("B: full lifecycle-kjede er gyldig", () => {
    assertValidIncidentTransition("open", "diagnosing");
    assertValidIncidentTransition("diagnosing", "repair_proposed");
    assertValidIncidentTransition("repair_proposed", "repair_in_progress");
    assertValidIncidentTransition("repair_in_progress", "resolved");
  });

  it("C: ugyldig overgang kaster InvalidIncidentTransitionError, endrer INGENTING", () => {
    expect(() => assertValidIncidentTransition("resolved", "repair_in_progress")).toThrow(InvalidIncidentTransitionError);
    try {
      assertValidIncidentTransition("open", "repair_in_progress");
    } catch (err) {
      expect((err as InvalidIncidentTransitionError).from).toBe("open");
      expect((err as InvalidIncidentTransitionError).to).toBe("repair_in_progress");
    }
  });

  it("D: samme status til samme status er alltid gyldig (no-op)", () => {
    for (const status of Object.keys(INCIDENT_TRANSITIONS) as (keyof typeof INCIDENT_TRANSITIONS)[]) {
      expect(canTransitionIncident(status, status)).toBe(true);
    }
  });

  it("E: resolved/wont_fix kan gjenåpnes til open (feilaktig lukket hendelse)", () => {
    expect(canTransitionIncident("resolved", "open")).toBe(true);
    expect(canTransitionIncident("wont_fix", "open")).toBe(true);
  });

  it("F: isTerminalIncidentStatus - kun resolved/wont_fix er terminale", () => {
    expect(isTerminalIncidentStatus("resolved")).toBe(true);
    expect(isTerminalIncidentStatus("wont_fix")).toBe(true);
    expect(isTerminalIncidentStatus("open")).toBe(false);
    expect(isTerminalIncidentStatus("diagnosing")).toBe(false);
    expect(isTerminalIncidentStatus("repair_proposed")).toBe(false);
    expect(isTerminalIncidentStatus("repair_in_progress")).toBe(false);
  });
});
