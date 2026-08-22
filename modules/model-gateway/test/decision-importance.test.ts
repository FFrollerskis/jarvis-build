import { describe, expect, it } from "vitest";
import { classifyDecisionImportance, CLASSIFIER_VERSION, FINANCIAL_MATERIALITY_THRESHOLD } from "../src/index.ts";

/**
 * D-106 HOST-FIX (§"LARGE-DECISION TRIGGER"): beviser den deterministiske
 * høy-innvirkning-klassifisereren - HIGH_IMPACT-eksempler fra ordren,
 * ROUTINE-negativer, og determinisme. Ingen modellkall - ren funksjonstest.
 */
describe("D-106 HOST-FIX: classifyDecisionImportance() - HIGH_IMPACT_DECISION-eksempler fra ordren", () => {
  it("A: 'Should we replace Jarvis' canonical memory architecture?' -> HIGH_IMPACT_DECISION (architecture_core_dependency_impact)", () => {
    const result = classifyDecisionImportance("Should we replace Jarvis' canonical memory architecture?");
    expect(result.decision_importance).toBe("HIGH_IMPACT_DECISION");
    expect(result.trigger_reasons).toContain("architecture_core_dependency_impact");
  });

  it("B: 'Should we migrate production from Postgres to another database?' -> HIGH_IMPACT_DECISION (production_infrastructure_impact)", () => {
    const result = classifyDecisionImportance("Should we migrate production from Postgres to another database?");
    expect(result.decision_importance).toBe("HIGH_IMPACT_DECISION");
    expect(result.trigger_reasons).toContain("production_infrastructure_impact");
  });

  it("C: 'Should we spend 800,000 NOK on this business acquisition?' -> HIGH_IMPACT_DECISION (financial_magnitude + business_strategy_consequence)", () => {
    const result = classifyDecisionImportance("Should we spend 800,000 NOK on this business acquisition?");
    expect(result.decision_importance).toBe("HIGH_IMPACT_DECISION");
    expect(result.trigger_reasons).toContain("financial_magnitude");
    expect(result.trigger_reasons).toContain("business_strategy_consequence");
  });

  it("D: 'Should Jarvis rotate/revoke all production credentials?' -> HIGH_IMPACT_DECISION (security_credential_impact)", () => {
    const result = classifyDecisionImportance("Should Jarvis rotate/revoke all production credentials?");
    expect(result.decision_importance).toBe("HIGH_IMPACT_DECISION");
    expect(result.trigger_reasons).toContain("security_credential_impact");
  });

  it("E: 'Which recovery strategy should we use for a severe production incident?' -> HIGH_IMPACT_DECISION (major_incident_recovery_decision)", () => {
    const result = classifyDecisionImportance("Which recovery strategy should we use for a severe production incident?");
    expect(result.decision_importance).toBe("HIGH_IMPACT_DECISION");
    expect(result.trigger_reasons).toContain("major_incident_recovery_decision");
  });

  it("F: 'Should we make this provider a core dependency?' -> HIGH_IMPACT_DECISION (architecture_core_dependency_impact, samme terminologi som D-64)", () => {
    const result = classifyDecisionImportance("Should we make this provider a core dependency?");
    expect(result.decision_importance).toBe("HIGH_IMPACT_DECISION");
    expect(result.trigger_reasons).toContain("architecture_core_dependency_impact");
  });
});

describe("D-106 HOST-FIX: classifyDecisionImportance() - ROUTINE (falske positiver unngås)", () => {
  const routineExamples = [
    "What time is it?",
    "Can you brainstorm five taglines for our new product?",
    "Draft a quick email to John about lunch tomorrow",
    "List today's calendar events",
    "Fix the typo in this README line",
    "What's the status of task X?"
  ];

  for (const text of routineExamples) {
    it(`G: '${text}' -> ROUTINE (ingen Council-trigger)`, () => {
      const result = classifyDecisionImportance(text);
      expect(result.decision_importance).not.toBe("HIGH_IMPACT_DECISION");
    });
  }

  it("H: klasse D-flavored tekst UTEN høy-innvirkning-språk (sentinel, ikke produksjon) -> ROUTINE (risikoklasse og beslutnings-viktighet er DISTINKTE dimensjoner)", () => {
    const result = classifyDecisionImportance("Restart the jarvis-sentinel-test container");
    expect(result.decision_importance).toBe("ROUTINE");
  });

  it("I: normalt verktøykall-språk -> ROUTINE (impliserer ALDRI Council automatisk)", () => {
    const result = classifyDecisionImportance("Show me my calendar for tomorrow");
    expect(result.decision_importance).toBe("ROUTINE");
  });

  it("J: lavt beløp under materialitetsterskelen -> ROUTINE (financial_magnitude krever reell materialitet)", () => {
    const result = classifyDecisionImportance("Can you order 50 kr worth of office supplies?");
    expect(result.decision_importance).toBe("ROUTINE");
  });
});

describe("D-106 HOST-FIX: classifyDecisionImportance() - determinisme og auditerbarhet", () => {
  it("K: identisk input gir IDENTISK output (rene funksjoner, ingen modellkall/tilstand)", () => {
    const text = "Should we spend 800,000 NOK on this business acquisition?";
    const first = classifyDecisionImportance(text);
    const second = classifyDecisionImportance(text);
    expect(first).toEqual(second);
  });

  it("L: classifier_version er alltid satt (auditerbar versjonering)", () => {
    expect(classifyDecisionImportance("hello").classifier_version).toBe(CLASSIFIER_VERSION);
    expect(classifyDecisionImportance("Should we make this provider a core dependency?").classifier_version).toBe(CLASSIFIER_VERSION);
  });

  it("M: matched_signals inneholder faktisk uthentet tekst fra INPUT, aldri fabrikkert", () => {
    const result = classifyDecisionImportance("Should we make this provider a core dependency?");
    const signal = result.matched_signals.find((s) => s.name === "architecture_core_dependency_impact");
    expect(signal?.matched_text.toLowerCase()).toContain("core dependency");
  });

  it("N: beløp over materialitetsterskelen (konstant, dokumentert) trigger financial_magnitude", () => {
    const result = classifyDecisionImportance(`We should approve a $${FINANCIAL_MATERIALITY_THRESHOLD} contract`);
    expect(result.trigger_reasons).toContain("financial_magnitude");
  });

  it("O: SIGNIFICANT-tier for svake signaler uten et hardt høy-innvirkning-signal", () => {
    const result = classifyDecisionImportance("We should review the budget next week");
    expect(result.decision_importance).toBe("SIGNIFICANT");
  });
});
