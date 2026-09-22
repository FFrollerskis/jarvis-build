import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-230 (K2-dashboardet for @jarvis/governance): strukturelle DB-uavhengige
 * tester for `POST /governance/query`/`POST /governance/mutate` i
 * `apps/api/src/server.ts` - SAMME "main.ts er et top-level side-effekt-
 * skript, kan ikke importeres direkte"-presedens som
 * `executive-query-wiring.test.ts`/`executive-mutate-wiring.test.ts`.
 * `@jarvis/governance` sitt EGET service-/transport-lag (handlingsliste/
 * risikoklasser/strict-skjema/identitetsavvisning) er allerede FULLT dekket
 * av `modules/governance/test/` (D-207) - denne suiten beviser KUN de to NYE
 * rutenes egen kildekode-struktur (allowlist/avslagsrekkefølge/identitet/
 * tool_id), ALDRI en duplisering av modulens egen dekning.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const serverSource = readSource("../src/server.ts");

describe("A: GOVERNANCE_QUERY_ACTIONS inneholder NØYAKTIG de fire lese-handlingene governanceToolDefinitions() selv definerer", () => {
  it("inneholder alle fire forventede handlinger, ingen flere, ingen færre", () => {
    const match = serverSource.match(/const GOVERNANCE_QUERY_ACTIONS = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const actions = (match?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(actions.sort()).toEqual(["list_decisions", "list_scenarios", "list_risks", "list_goals"].sort());
  });

  it("ingen skrivehandling (create_decision/reverse_decision/create_scenario/update_scenario_status/create_risk/update_risk/create_goal/update_goal_status/add_key_result/update_key_result_progress) forekommer i GOVERNANCE_QUERY_ACTIONS-blokken", () => {
    const match = serverSource.match(/const GOVERNANCE_QUERY_ACTIONS = \[[\s\S]*?\] as const;/);
    expect(match).not.toBeNull();
    const block = match?.[0] ?? "";
    for (const writeAction of [
      "create_decision", "reverse_decision", "create_scenario", "update_scenario_status",
      "create_risk", "update_risk", "create_goal", "update_goal_status",
      "add_key_result", "update_key_result_progress"
    ]) {
      expect(block).not.toContain(writeAction);
    }
  });
});

describe("B: GOVERNANCE_MUTATE_ACTIONS inneholder NØYAKTIG de ti skrivehandlingene governanceToolDefinitions() selv definerer", () => {
  it("inneholder alle ti forventede handlinger, ingen flere, ingen færre", () => {
    const match = serverSource.match(/const GOVERNANCE_MUTATE_ACTIONS = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const actions = (match?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(actions.sort()).toEqual(
      [
        "create_decision", "reverse_decision", "create_scenario", "update_scenario_status",
        "create_risk", "update_risk", "create_goal", "update_goal_status",
        "add_key_result", "update_key_result_progress"
      ].sort()
    );
  });

  it("ingen lese-handling (list_decisions/list_scenarios/list_risks/list_goals) forekommer i GOVERNANCE_MUTATE_ACTIONS-blokken", () => {
    const match = serverSource.match(/const GOVERNANCE_MUTATE_ACTIONS = \[[\s\S]*?\] as const;/);
    expect(match).not.toBeNull();
    const block = match?.[0] ?? "";
    for (const readAction of ["list_decisions", "list_scenarios", "list_risks", "list_goals"]) {
      expect(block).not.toContain(readAction);
    }
  });
});

describe("C: /governance/query-ruten - avslagsrekkefølge, identitet, tool_id", () => {
  it("ruten avslår en handling utenfor allowlistet FØR gateway.execute() nås", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/query"');
    expect(routeIdx).toBeGreaterThan(-1);
    const executeIdx = serverSource.indexOf("deps.executive.gateway.execute(", routeIdx);
    const allowlistCheckIdx = serverSource.indexOf("action_not_allowed", routeIdx);
    expect(allowlistCheckIdx).toBeGreaterThan(-1);
    expect(executeIdx).toBeGreaterThan(-1);
    expect(allowlistCheckIdx).toBeLessThan(executeIdx);
  });

  it("identiteten som sendes til gateway.execute() kommer fra resolveFromGrant(), ALDRI fra en kaller-oppgitt identitet i body", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/query"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("deps.executive.gateway.execute(", routeIdx) + 400);
    expect(block).toContain("resolveFromGrant(deps,");
    expect(block).toContain("identity: resolved.identity");
  });

  it("kaller gateway.execute() med tool_id='governance', ALDRI 'executive'/'owner_controls'/et annet tool_id", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/query"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("deps.executive.gateway.execute(", routeIdx) + 400);
    expect(block).toMatch(/tool_id:\s*"governance"/);
  });

  it("ruten krever deps.executive (samme valgfrie-avhengighet-mønster som /executive/query - helse-modus uten database gir 404, ikke en krasj)", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/query"');
    const lineStart = serverSource.lastIndexOf("if (", routeIdx);
    const line = serverSource.slice(lineStart, routeIdx + 40);
    expect(line).toContain("deps.executive &&");
  });

  it("et gateway.execute()-avslag (ok:false) videreformidles som 403 tool_denied", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/query"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf('url.pathname === "/governance/mutate"'));
    expect(block).toMatch(/if \(!result\.ok\) \{\s*return json\(res, 403, \{ error: "tool_denied", reason: result\.reason \}\);/);
  });
});

describe("D: /governance/mutate-ruten - EGEN rute, EGET hardkodet allowlist, ALDRI en utvidelse av /governance/query", () => {
  it("ruten avslår en handling utenfor allowlistet FØR gateway.execute() nås", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/mutate"');
    expect(routeIdx).toBeGreaterThan(-1);
    const executeIdx = serverSource.indexOf("deps.executive.gateway.execute(", routeIdx);
    const allowlistCheckIdx = serverSource.indexOf("action_not_allowed", routeIdx);
    expect(allowlistCheckIdx).toBeGreaterThan(-1);
    expect(executeIdx).toBeGreaterThan(-1);
    expect(allowlistCheckIdx).toBeLessThan(executeIdx);
  });

  it("identiteten som sendes til gateway.execute() kommer fra resolveFromGrant(), ALDRI fra en kaller-oppgitt identitet i body", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/mutate"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("deps.executive.gateway.execute(", routeIdx) + 400);
    expect(block).toContain("resolveFromGrant(deps,");
    expect(block).toContain("identity: resolved.identity");
  });

  it("kaller gateway.execute() med tool_id='governance', ALDRI 'executive'/'owner_controls'/et annet tool_id", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/mutate"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("deps.executive.gateway.execute(", routeIdx) + 400);
    expect(block).toMatch(/tool_id:\s*"governance"/);
  });

  it("ruten krever deps.executive (samme valgfrie-avhengighet-mønster som /governance/query)", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/mutate"');
    const lineStart = serverSource.lastIndexOf("if (", routeIdx);
    const line = serverSource.slice(lineStart, routeIdx + 40);
    expect(line).toContain("deps.executive &&");
  });

  it("et gateway.execute()-avslag (ok:false) videreformidles som 403 tool_denied", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/governance/mutate"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf('url.pathname === "/devices/register"'));
    expect(block).toMatch(/if \(!result\.ok\) \{\s*return json\(res, 403, \{ error: "tool_denied", reason: result\.reason \}\);/);
  });
});

describe("E: EXECUTIVE_QUERY_ACTIONS fikk get_delegation_board (D-230) - delegeringstavlen forblir en executive.*-lesing, ikke governance.*", () => {
  it("EXECUTIVE_QUERY_ACTIONS inneholder get_delegation_board", () => {
    const match = serverSource.match(/const EXECUTIVE_QUERY_ACTIONS = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const actions = (match?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(actions).toContain("get_delegation_board");
  });

  it("get_delegation_board forekommer IKKE i GOVERNANCE_QUERY_ACTIONS eller GOVERNANCE_MUTATE_ACTIONS", () => {
    const queryMatch = serverSource.match(/const GOVERNANCE_QUERY_ACTIONS = \[[\s\S]*?\] as const;/);
    const mutateMatch = serverSource.match(/const GOVERNANCE_MUTATE_ACTIONS = \[[\s\S]*?\] as const;/);
    expect(queryMatch?.[0] ?? "").not.toContain("get_delegation_board");
    expect(mutateMatch?.[0] ?? "").not.toContain("get_delegation_board");
  });
});
