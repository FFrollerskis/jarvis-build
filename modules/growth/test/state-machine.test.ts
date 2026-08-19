import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_TRANSITIONS,
  EXPERIMENT_TRANSITIONS,
  InvalidCampaignTransitionError,
  InvalidExperimentTransitionError,
  assertValidCampaignTransition,
  assertValidExperimentTransition,
  canTransitionCampaign,
  canTransitionExperiment,
  isTerminalCampaignStatus,
  isTerminalExperimentStatus
} from "../src/state-machine.ts";

describe("A: deterministisk kampanje-lifecycle", () => {
  it("draft -> active -> paused -> active er en gyldig kjede", () => {
    expect(canTransitionCampaign("draft", "active")).toBe(true);
    expect(canTransitionCampaign("active", "paused")).toBe(true);
    expect(canTransitionCampaign("paused", "active")).toBe(true);
  });
  it("samme status til samme status er alltid tillatt (no-op)", () => {
    expect(canTransitionCampaign("active", "active")).toBe(true);
  });
});

describe("B: ugyldig kampanje-overgang feiler trygt, endrer ingenting", () => {
  it("draft -> paused er IKKE tillatt (maa via active)", () => {
    expect(canTransitionCampaign("draft", "paused")).toBe(false);
    expect(() => assertValidCampaignTransition("draft", "paused")).toThrow(InvalidCampaignTransitionError);
  });
  it("ended -> active er IKKE tillatt direkte (kun via draft)", () => {
    expect(canTransitionCampaign("ended", "active")).toBe(false);
  });
  it("feilmeldingen identifiserer baade fra- og til-status", () => {
    try {
      assertValidCampaignTransition("draft", "paused");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCampaignTransitionError);
      expect((err as InvalidCampaignTransitionError).from).toBe("draft");
      expect((err as InvalidCampaignTransitionError).to).toBe("paused");
    }
  });
});

describe("C: 'ended' er praktisk talt terminal - INGEN LLM avgjør gyldighet", () => {
  it("ended -> draft ER tillatt (KUN administrativ korreksjon, maa gjennom hele lifecyclen paa nytt)", () => {
    expect(canTransitionCampaign("ended", "draft")).toBe(true);
  });
  it("isTerminalCampaignStatus identifiserer KUN 'ended'", () => {
    expect(isTerminalCampaignStatus("ended")).toBe(true);
    expect(isTerminalCampaignStatus("active")).toBe(false);
    expect(isTerminalCampaignStatus("paused")).toBe(false);
    expect(isTerminalCampaignStatus("draft")).toBe(false);
  });
  it("transisjonskartet dekker ALLE 4 statuser eksplisitt (ingen implisitt fallback)", () => {
    expect(Object.keys(CAMPAIGN_TRANSITIONS).sort()).toEqual(["active", "draft", "ended", "paused"].sort());
  });
});

describe("D: deterministisk eksperiment-lifecycle", () => {
  it("draft -> running -> concluded er en gyldig kjede", () => {
    expect(canTransitionExperiment("draft", "running")).toBe(true);
    expect(canTransitionExperiment("running", "concluded")).toBe(true);
  });
  it("draft -> running -> abandoned er ogsaa en gyldig kjede", () => {
    expect(canTransitionExperiment("running", "abandoned")).toBe(true);
  });
  it("concluded -> running er IKKE tillatt (kun korreksjon tilbake til draft)", () => {
    expect(canTransitionExperiment("concluded", "running")).toBe(false);
    expect(canTransitionExperiment("concluded", "draft")).toBe(true);
    expect(() => assertValidExperimentTransition("concluded", "running")).toThrow(InvalidExperimentTransitionError);
  });
  it("isTerminalExperimentStatus identifiserer concluded/abandoned", () => {
    expect(isTerminalExperimentStatus("concluded")).toBe(true);
    expect(isTerminalExperimentStatus("abandoned")).toBe(true);
    expect(isTerminalExperimentStatus("running")).toBe(false);
    expect(isTerminalExperimentStatus("draft")).toBe(false);
  });
  it("transisjonskartet dekker ALLE 4 statuser eksplisitt", () => {
    expect(Object.keys(EXPERIMENT_TRANSITIONS).sort()).toEqual(["abandoned", "concluded", "draft", "running"].sort());
  });
});
