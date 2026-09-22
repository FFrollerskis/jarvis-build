import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-230 (K2-dashboardet for @jarvis/governance): strukturelle DB-uavhengige
 * tester for `apps/web/dashboard.html` sin nye "Styring (K2)"-seksjon.
 * Server-siden (allowlist/grant-avslag/tool_id/videreformidling) er dekket i
 * `governance-query-mutate-wiring.test.ts` - denne suiten beviser KUN at
 * klienten faktisk kaller de to NYE rutene korrekt, at delegeringstavlen
 * fortsatt går via `/executive/query` (ALDRI `/governance/query`), og at
 * skriveoperasjonene er event-delegert (ett lyttersett per container, ikke
 * ett per rad).
 */
function readDashboard(): string {
  return readFileSync(fileURLToPath(new URL("../../web/dashboard.html", import.meta.url)), "utf8");
}

describe("A: queryGovernance()/mutateGovernance() bruker de to nye, egne rutene", () => {
  const html = readDashboard();

  it('queryGovernance() POSTer til "/governance/query"', () => {
    const idx = html.indexOf("async function queryGovernance");
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 400);
    expect(block).toContain('fetch("/governance/query"');
  });

  it('mutateGovernance() POSTer til "/governance/mutate"', () => {
    const idx = html.indexOf("async function mutateGovernance");
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 400);
    expect(block).toContain('fetch("/governance/mutate"');
  });

  it("begge sender {grant_token, action, parameters} - samme kroppsform som mutateExecutive()/mutateOwnerControls()", () => {
    for (const fn of ["queryGovernance", "mutateGovernance"]) {
      const idx = html.indexOf("async function " + fn);
      const block = html.slice(idx, idx + 500);
      expect(block).toMatch(/JSON\.stringify\(\{\s*grant_token:\s*active\.grant_token,\s*action,\s*parameters:\s*parameters \|\| \{\}\s*\}\)/);
    }
  });
});

describe("B: skriveoperasjonene kaller mutateGovernance() med de forventede parametrene for alle ti handlingene", () => {
  const html = readDashboard();

  it("create_decision kalles med {title, rationale, decision_maker: decisionMaker}", () => {
    expect(html).toMatch(/mutateGovernance\("create_decision",\s*\{\s*title,\s*rationale,\s*decision_maker:\s*decisionMaker\s*\}\)/);
  });

  it("reverse_decision kalles med {decision_id: id}", () => {
    expect(html).toMatch(/mutateGovernance\("reverse_decision",\s*\{\s*decision_id:\s*id\s*\}\)/);
  });

  it("create_scenario kalles med {title, assumptions, projected_outcome: projectedOutcome}", () => {
    expect(html).toMatch(/mutateGovernance\("create_scenario",\s*\{\s*title,\s*assumptions,\s*projected_outcome:\s*projectedOutcome\s*\}\)/);
  });

  it("update_scenario_status kalles med {scenario_id: id, status: sel.value}", () => {
    expect(html).toMatch(/mutateGovernance\("update_scenario_status",\s*\{\s*scenario_id:\s*id,\s*status:\s*sel\.value\s*\}\)/);
  });

  it("create_risk kalles med {title, description, severity, probability}", () => {
    expect(html).toMatch(/mutateGovernance\("create_risk",\s*\{\s*title,\s*description,\s*severity,\s*probability\s*\}\)/);
  });

  it("update_risk kalles via et eksplisitt bygget parameters-objekt (risk_id påkrevd, resten valgfritt)", () => {
    expect(html).toMatch(/mutateGovernance\("update_risk",\s*parameters\)/);
    const idx = html.indexOf('document.getElementById("risk-update-form").addEventListener');
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 900);
    expect(block).toContain("risk_id: riskId");
  });

  it("create_goal kalles via et eksplisitt bygget parameters-objekt (title påkrevd, description/target_date valgfritt)", () => {
    const idx = html.indexOf('document.getElementById("goal-form").addEventListener');
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 900);
    expect(block).toMatch(/mutateGovernance\("create_goal",\s*parameters\)/);
    expect(block).toContain("const parameters = { title }");
  });

  it("update_goal_status kalles med {goal_id: id, status: sel.value}", () => {
    expect(html).toMatch(/mutateGovernance\("update_goal_status",\s*\{\s*goal_id:\s*id,\s*status:\s*sel\.value\s*\}\)/);
  });

  it("add_key_result kalles med {goal_id: goalId, title}", () => {
    expect(html).toMatch(/mutateGovernance\("add_key_result",\s*\{\s*goal_id:\s*goalId,\s*title\s*\}\)/);
  });

  it("update_key_result_progress kalles med {key_result_id: krId, progress_percent: progress}", () => {
    expect(html).toMatch(/mutateGovernance\("update_key_result_progress",\s*\{\s*key_result_id:\s*krId,\s*progress_percent:\s*progress\s*\}\)/);
  });
});

describe("C: skriveoperasjonene på ALLEREDE synlige rader er event-delegert, ALDRI ett listener per rad", () => {
  const html = readDashboard();

  it("reverse_decision er delegert på decisionsListEl.addEventListener", () => {
    const idx = html.indexOf("decisionsListEl.addEventListener");
    expect(idx).toBeGreaterThan(-1);
    expect(html.slice(idx, idx + 400)).toContain('mutateGovernance("reverse_decision"');
  });

  it("update_scenario_status er delegert på scenariosListEl.addEventListener(\"change\"", () => {
    const idx = html.indexOf('scenariosListEl.addEventListener("change"');
    expect(idx).toBeGreaterThan(-1);
    expect(html.slice(idx, idx + 400)).toContain('mutateGovernance("update_scenario_status"');
  });

  it("update_goal_status/add_key_result/update_key_result_progress er delegert på goalsListEl (change + click)", () => {
    const changeIdx = html.indexOf('goalsListEl.addEventListener("change"');
    const clickIdx = html.indexOf('goalsListEl.addEventListener("click"');
    expect(changeIdx).toBeGreaterThan(-1);
    expect(clickIdx).toBeGreaterThan(-1);
    expect(html.slice(changeIdx, changeIdx + 400)).toContain('mutateGovernance("update_goal_status"');
    const clickBlock = html.slice(clickIdx, clickIdx + 1200);
    expect(clickBlock).toContain('mutateGovernance("add_key_result"');
    expect(clickBlock).toContain('mutateGovernance("update_key_result_progress"');
  });

  it("'Bruk i oppdater'-knappen for risiko er delegert på risksListEl.addEventListener - den kaller ALDRI mutateGovernance selv (kun kopierer risk_id inn i det separate oppdater-skjemaet)", () => {
    const idx = html.indexOf("risksListEl.addEventListener");
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 400);
    expect(block).toContain("data-edit-risk");
    expect(block).not.toContain("mutateGovernance");
  });
});

describe("D: delegeringstavlen er RENT LESENDE og bruker /executive/query (executive.get_delegation_board), ALDRI /governance/query", () => {
  const html = readDashboard();

  it("get_delegation_board hentes via queryExecutive(), ikke queryGovernance()", () => {
    expect(html).toMatch(/queryExecutive\("get_delegation_board"\)/);
    expect(html).not.toMatch(/queryGovernance\("get_delegation_board"/);
  });

  it("renderDelegationBoard() inneholder ingen mutateGovernance()/mutateExecutive()-kall (ren visning)", () => {
    const idx = html.indexOf("function renderDelegationBoard(data)");
    expect(idx).toBeGreaterThan(-1);
    const end = html.indexOf("\n  }\n", idx);
    const block = html.slice(idx, end);
    expect(block).not.toContain("mutateGovernance");
    expect(block).not.toContain("mutateExecutive");
  });
});

describe("E: loadAll() henter alle fem K2-datasettene og render-funksjonene deres, i tillegg til de tre eksisterende", () => {
  const html = readDashboard();

  it("loadAll() kaller queryGovernance for list_decisions/list_scenarios/list_risks/list_goals og queryExecutive for get_delegation_board", () => {
    const idx = html.indexOf("async function loadAll()");
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, html.indexOf("refreshBtn.addEventListener", idx));
    for (const action of ["list_decisions", "list_scenarios", "list_risks", "list_goals"]) {
      expect(block).toContain('queryGovernance("' + action + '")');
    }
    expect(block).toContain('queryExecutive("get_delegation_board")');
    expect(block).toContain("renderDecisions(");
    expect(block).toContain("renderScenarios(");
    expect(block).toContain("renderRisks(");
    expect(block).toContain("renderGoals(");
    expect(block).toContain("renderDelegationBoard(");
  });
});

describe("F: /executive/query og /owner-controls/connector-credentials sin egen kroppsbygging forblir UBERØRT av D-230", () => {
  it("queryExecutive() sender fortsatt KUN {grant_token, action} - ingen 'parameters'", () => {
    const html = readDashboard();
    const idx = html.indexOf("async function queryExecutive");
    const block = html.slice(idx, idx + 500);
    expect(block).toMatch(/JSON\.stringify\(\{\s*grant_token:\s*active\.grant_token,\s*action\s*\}\)/);
    expect(block).not.toContain("parameters");
  });
});
