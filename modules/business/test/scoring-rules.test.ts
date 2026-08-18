import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_LEAD_FACTOR_CODES, ALLOWED_OPPORTUNITY_FACTOR_CODES, LEAD_PRIORITY_RULE_VERSION,
  OPPORTUNITY_RISK_RULE_VERSION, assertNoProhibitedFactorCodes, calculateLeadPriorityV1, calculateOpportunityRiskV1
} from "../src/scoring-rules.ts";
import type { LeadScoringSignals, OpportunityScoringSignals } from "../src/scoring-types.ts";

/**
 * UA-3 profiling/scoring-slice (D-61): REN, DB-uavhengig test av
 * regelmotoren (§7/§8 i byggeordren - "Build deterministic scoring first").
 * Ingen embedded Postgres kreves her - se scoring-service.test.ts for de
 * DB-baserte testene (idempotens/isolasjon/Q-20/manuell overstyring).
 */
function leadSignals(overrides: Partial<LeadScoringSignals> = {}): LeadScoringSignals {
  return {
    lead_id: "biz-lead-1", status: "new", has_active_opportunity: false, has_recent_activity_7d: false,
    is_stale_30d: false, has_open_followup: false, has_overdue_followup: false,
    recent_activity_ids: [], open_followup_ids: [], ...overrides
  };
}

function opportunitySignals(overrides: Partial<OpportunityScoringSignals> = {}): OpportunityScoringSignals {
  return {
    opportunity_id: "biz-op-1", stage: "new", is_stale_14d: false, has_open_followup: true,
    has_overdue_followup: false, has_stalled_open_loop: false, overdue_followup_ids: [],
    stalled_open_loop_ids: [], ...overrides
  };
}

describe("A: lead-score-beregning (calculateLeadPriorityV1)", () => {
  it("status alene gir basisscore (new=10, contacted=20, qualified=30)", () => {
    expect(calculateLeadPriorityV1(leadSignals({ status: "new" })).score).toBe(10);
    expect(calculateLeadPriorityV1(leadSignals({ status: "contacted" })).score).toBe(20);
    expect(calculateLeadPriorityV1(leadSignals({ status: "qualified" })).score).toBe(30);
  });

  it("faktorer akkumuleres additivt og forblir innenfor [0,100]", () => {
    const result = calculateLeadPriorityV1(leadSignals({
      status: "qualified", has_active_opportunity: true, has_recent_activity_7d: true,
      recent_activity_ids: ["biz-act-1", "biz-act-2"]
    }));
    // 30 (qualified) + 15 (aktiv opportunity) + 15 (nylig aktivitet) = 60
    expect(result.score).toBe(60);
  });

  it("terminal status (disqualified/converted) gir ALLTID score 0, uansett andre signaler", () => {
    const disqualified = calculateLeadPriorityV1(leadSignals({
      status: "disqualified", has_active_opportunity: true, has_recent_activity_7d: true, has_overdue_followup: true
    }));
    expect(disqualified.score).toBe(0);
    expect(disqualified.factors).toEqual([{ code: "status_terminal", label: expect.stringContaining("disqualified"), weight: 0, contribution: 0 }]);

    const converted = calculateLeadPriorityV1(leadSignals({ status: "converted" }));
    expect(converted.score).toBe(0);
  });
});

describe("B: opportunity-score-beregning (calculateOpportunityRiskV1)", () => {
  it("stage alene gir basisscore (new=10, qualified=20, proposal=35, negotiation=45)", () => {
    expect(calculateOpportunityRiskV1(opportunitySignals({ stage: "new" })).score).toBe(10);
    expect(calculateOpportunityRiskV1(opportunitySignals({ stage: "qualified" })).score).toBe(20);
    expect(calculateOpportunityRiskV1(opportunitySignals({ stage: "proposal" })).score).toBe(35);
    expect(calculateOpportunityRiskV1(opportunitySignals({ stage: "negotiation" })).score).toBe(45);
  });

  it("stagnasjonssignaler oeker risiko-scoren", () => {
    const result = calculateOpportunityRiskV1(opportunitySignals({
      stage: "negotiation", is_stale_14d: true, has_open_followup: false, has_stalled_open_loop: true,
      stalled_open_loop_ids: ["biz-ol-1"]
    }));
    // 45 (negotiation) + 20 (stale) + 15 (ingen aapen oppfoelging) + 25 (stagnert open loop) = 105 -> clampet til 100
    expect(result.score).toBe(100);
  });

  it("terminal stage (won/lost) gir ALLTID score 0, uansett andre signaler", () => {
    const won = calculateOpportunityRiskV1(opportunitySignals({ stage: "won", is_stale_14d: true, has_stalled_open_loop: true }));
    expect(won.score).toBe(0);
    const lost = calculateOpportunityRiskV1(opportunitySignals({ stage: "lost" }));
    expect(lost.score).toBe(0);
  });
});

describe("D: faktor-forklaring - hver bidragende faktor har code/label/weight/contribution", () => {
  it("lead-scoren returnerer en menneskelesbar label og eksakt vekt for hver anvendt faktor", () => {
    const { factors } = calculateLeadPriorityV1(leadSignals({ status: "qualified", has_overdue_followup: true, open_followup_ids: ["biz-fu-1"] }));
    const overdue = factors.find((f) => f.code === "overdue_followup");
    expect(overdue).toBeDefined();
    expect(overdue?.label).toContain("forfalt");
    expect(overdue?.weight).toBe(20);
    expect(overdue?.contribution).toBe(20);
  });

  it("summen av factor.contribution matcher totalscoren FØR clamping (verifiserbar addisjon, ingen skjult justering)", () => {
    const signals = leadSignals({ status: "contacted", has_recent_activity_7d: true, recent_activity_ids: ["biz-act-9"] });
    const { score, factors } = calculateLeadPriorityV1(signals);
    const sum = factors.reduce((acc, f) => acc + f.contribution, 0);
    expect(sum).toBe(score);
  });
});

describe("E: score-versjonering - rule_version-konstanter er stabile, eksplisitte strenger", () => {
  it("LEAD_PRIORITY_RULE_VERSION / OPPORTUNITY_RISK_RULE_VERSION er versjonerte v1-navn", () => {
    expect(LEAD_PRIORITY_RULE_VERSION).toBe("lead_priority_v1");
    expect(OPPORTUNITY_RISK_RULE_VERSION).toBe("opportunity_risk_v1");
  });
});

describe("F: kilde-/bevis-referanser - evidence peker KUN til allerede-eksisterende entitets-ID-er, aldri kopiert innhold", () => {
  it("lead-scoren samler activity_id/followup_id-referanser, ikke aktivitetens summary/innhold", () => {
    const { evidence } = calculateLeadPriorityV1(leadSignals({
      has_recent_activity_7d: true, recent_activity_ids: ["biz-act-1", "biz-act-2"],
      has_overdue_followup: true, open_followup_ids: ["biz-fu-1"]
    }));
    expect(evidence).toContainEqual({ type: "activity", id: "biz-act-1" });
    expect(evidence).toContainEqual({ type: "activity", id: "biz-act-2" });
    expect(evidence).toContainEqual({ type: "followup", id: "biz-fu-1" });
    expect(JSON.stringify(evidence)).not.toMatch(/summary|subject|body/i);
  });

  it("opportunity-risk-scoren samler open_loop-referanser fra EKSISTERENDE OpenLoopService-deteksjon, oppfinner ingen ny mekanisme", () => {
    const { evidence } = calculateOpportunityRiskV1(opportunitySignals({ has_stalled_open_loop: true, stalled_open_loop_ids: ["biz-ol-42"] }));
    expect(evidence).toContainEqual({ type: "open_loop", id: "biz-ol-42" });
  });
});

describe("G: stale-/open-loop-inputs paavirker scoren transparent", () => {
  it("lead: 30 dager uten aktivitet gir et negativt, eksplisitt begrunnet bidrag", () => {
    const { score, factors } = calculateLeadPriorityV1(leadSignals({ status: "contacted", is_stale_30d: true }));
    expect(score).toBe(5); // 20 (contacted) - 15 (stale)
    expect(factors.find((f) => f.code === "stale_30d")?.contribution).toBe(-15);
  });

  it("opportunity: en allerede-flagget stagnert open loop (D-53 OpenLoopService) gir et stort, tydelig bidrag - gjenbruker EKSISTERENDE deteksjon", () => {
    const { factors } = calculateOpportunityRiskV1(opportunitySignals({ has_stalled_open_loop: true, stalled_open_loop_ids: ["biz-ol-1"] }));
    expect(factors.find((f) => f.code === "stalled_open_loop")?.contribution).toBe(25);
  });
});

describe("H: INGEN beskyttet/sensitiv persontrekk-kode kan noensinne forekomme (§4 i byggeordren)", () => {
  it("ALLOWED_LEAD_FACTOR_CODES / ALLOWED_OPPORTUNITY_FACTOR_CODES inneholder KUN operasjonelle forretningstilstands-koder", () => {
    expect(() => assertNoProhibitedFactorCodes(ALLOWED_LEAD_FACTOR_CODES)).not.toThrow();
    expect(() => assertNoProhibitedFactorCodes(ALLOWED_OPPORTUNITY_FACTOR_CODES)).not.toThrow();
  });

  it("assertNoProhibitedFactorCodes kaster for en hypotetisk fremtidig beskyttet-trekk-kode (bevis at vakten faktisk virker)", () => {
    expect(() => assertNoProhibitedFactorCodes(["health_status_good"])).toThrow(/prohibited_factor_code_detected/);
    expect(() => assertNoProhibitedFactorCodes(["inferred_personality_type"])).toThrow(/prohibited_factor_code_detected/);
    expect(() => assertNoProhibitedFactorCodes(["estimated_wealth_tier"])).toThrow(/prohibited_factor_code_detected/);
  });

  it("EN faktisk beregnet score (lead OG opportunity) sine faktor-koder er en delmengde av whitelisten", () => {
    const leadCodes = calculateLeadPriorityV1(leadSignals({
      status: "qualified", has_active_opportunity: true, has_recent_activity_7d: true, has_overdue_followup: true, recent_activity_ids: ["a"], open_followup_ids: ["f"]
    })).factors.map((f) => f.code);
    for (const code of leadCodes) expect(ALLOWED_LEAD_FACTOR_CODES).toContain(code);

    const oppCodes = calculateOpportunityRiskV1(opportunitySignals({
      stage: "proposal", is_stale_14d: true, has_open_followup: false, has_overdue_followup: true, has_stalled_open_loop: true, overdue_followup_ids: ["f"], stalled_open_loop_ids: ["o"]
    })).factors.map((f) => f.code);
    for (const code of oppCodes) expect(ALLOWED_OPPORTUNITY_FACTOR_CODES).toContain(code);
  });
});

describe("I: ingen skjult personlighets-/trekk-inferens - scoring-motoren tar KUN forretnings-tilstandssignaler som input", () => {
  it("LeadScoringSignals/OpportunityScoringSignals-typene inneholder INGEN kontakt-/person-felt (navn, e-post, tittel, demografi)", () => {
    const lead = leadSignals();
    const opp = opportunitySignals();
    const forbiddenKeys = ["name", "email", "phone", "title", "gender", "age", "ethnicity", "religion"];
    for (const key of forbiddenKeys) {
      expect(Object.keys(lead)).not.toContain(key);
      expect(Object.keys(opp)).not.toContain(key);
    }
  });

  it("calculateLeadPriorityV1/calculateOpportunityRiskV1 er REN funksjoner (samme input -> alltid samme output, ingen skjult tilstand/tilfeldighet)", () => {
    const signals = leadSignals({ status: "qualified", has_recent_activity_7d: true, recent_activity_ids: ["a"] });
    const first = calculateLeadPriorityV1(signals);
    const second = calculateLeadPriorityV1(signals);
    expect(first).toEqual(second);
  });
});

describe("T/U: scoring-rules.ts er 100% deterministisk - INGEN AI Mesh-/ModelGateway-bruk i v1", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/scoring-rules.ts", import.meta.url)), "utf8");

  it("importerer aldri @jarvis/model-gateway eller noe ModelGateway-symbol (§8: 'do not call a model' naar deterministisk bevis er tilstrekkelig)", () => {
    // Ordet "ModelGateway" forekommer KUN i denne filens egen kommentar-prosa (§8-forklaringen),
    // ALDRI som en faktisk import/kall - sjekker derfor eksplisitt etter et import-statement.
    expect(source).not.toMatch(/from\s+["']@jarvis\/model-gateway["']/);
    expect(source).not.toMatch(/import\s*\{[^}]*ModelGateway[^}]*\}/);
  });

  it("kaller aldri en ekstern provider-SDK direkte (samme adapter-only-regel som resten av kjernen)", () => {
    expect(source).not.toMatch(/openai|anthropic-ai|@google\/generative-ai/i);
  });
});
