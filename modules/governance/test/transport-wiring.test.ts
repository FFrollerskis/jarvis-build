import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { GovernanceTransport, governanceToolDefinitions } from "../src/transport.ts";
import type { GovernanceService } from "../src/service.ts";

/**
 * UA-11 Executive Mode "K2": rene wiring-/dispatch-/identitetsdisiplin-
 * tester (INGEN embedded Postgres - `GovernanceService` er en fake, SAMME
 * mønster som `modules/product/test/transport-wiring.test.ts`). Ekte
 * Postgres/RLS-bevis for selve tjenestelogikken ligger i
 * `service-rls.test.ts`.
 */

function identity(overrides: Partial<IdentityContext> = {}): IdentityContext {
  return {
    person_id: "person-gov-test", tenant_id: "tenant-gov-test", memory_space_id: "business",
    session_id: "sess-gov-test", device_id: "jarvis-core", channel: "api", auth_strength: "active",
    ...overrides
  };
}

function fakeService() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    createDecision: async (...args: unknown[]) => { calls.push({ method: "createDecision", args }); return { decision_id: "dec-1" }; },
    listDecisions: async (...args: unknown[]) => { calls.push({ method: "listDecisions", args }); return []; },
    reverseDecision: async (...args: unknown[]) => { calls.push({ method: "reverseDecision", args }); return { decision_id: "dec-1" }; },
    createScenario: async (...args: unknown[]) => { calls.push({ method: "createScenario", args }); return { scenario_id: "scn-1" }; },
    listScenarios: async (...args: unknown[]) => { calls.push({ method: "listScenarios", args }); return []; },
    updateScenarioStatus: async (...args: unknown[]) => { calls.push({ method: "updateScenarioStatus", args }); return { scenario_id: "scn-1" }; },
    createRisk: async (...args: unknown[]) => { calls.push({ method: "createRisk", args }); return { risk_id: "risk-1" }; },
    listRisks: async (...args: unknown[]) => { calls.push({ method: "listRisks", args }); return []; },
    updateRisk: async (...args: unknown[]) => { calls.push({ method: "updateRisk", args }); return { risk_id: "risk-1" }; },
    createGoal: async (...args: unknown[]) => { calls.push({ method: "createGoal", args }); return { goal_id: "goal-1" }; },
    listGoals: async (...args: unknown[]) => { calls.push({ method: "listGoals", args }); return []; },
    updateGoalStatus: async (...args: unknown[]) => { calls.push({ method: "updateGoalStatus", args }); return { goal_id: "goal-1" }; },
    addKeyResult: async (...args: unknown[]) => { calls.push({ method: "addKeyResult", args }); return { key_result_id: "kr-1" }; },
    updateKeyResultProgress: async (...args: unknown[]) => { calls.push({ method: "updateKeyResultProgress", args }); return { key_result_id: "kr-1" }; },
    _calls: calls
  } as unknown as GovernanceService & { _calls: Array<{ method: string; args: unknown[] }> };
}

describe("A: governance.*-handlinger er registrert med korrekt transport og full handlingsliste", () => {
  it("governanceToolDefinitions() returnerer alle 14 handlingene, alle peker til DENNE transporten", () => {
    const transport = new GovernanceTransport({} as unknown as GovernanceService);
    const tools = governanceToolDefinitions(transport);
    expect(tools).toHaveLength(14);
    expect(tools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_decision", "list_decisions", "reverse_decision",
        "create_scenario", "list_scenarios", "update_scenario_status",
        "create_risk", "list_risks", "update_risk",
        "create_goal", "list_goals", "update_goal_status", "add_key_result", "update_key_result_progress"
      ])
    );
    for (const tool of tools) {
      expect(tool.tool_id).toBe("governance");
      expect(tool.transport).toBe(transport);
    }
  });
});

describe("B: risikoklasser - lesing er klasse A, skriving er klasse B, ZERO klasse C/D (rene journalposter, ingen ekstern mutasjon)", () => {
  it("list_* er klasse A, create_*/update_*/reverse_* er klasse B, ingen unntak", () => {
    const tools = governanceToolDefinitions(new GovernanceTransport({} as unknown as GovernanceService));
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["list_decisions"]).toBe("A");
    expect(byAction["list_scenarios"]).toBe("A");
    expect(byAction["list_risks"]).toBe("A");
    expect(byAction["list_goals"]).toBe("A");
    expect(byAction["create_decision"]).toBe("B");
    expect(byAction["reverse_decision"]).toBe("B");
    expect(byAction["create_scenario"]).toBe("B");
    expect(byAction["update_scenario_status"]).toBe("B");
    expect(byAction["create_risk"]).toBe("B");
    expect(byAction["update_risk"]).toBe("B");
    expect(byAction["create_goal"]).toBe("B");
    expect(byAction["update_goal_status"]).toBe("B");
    expect(byAction["add_key_result"]).toBe("B");
    expect(byAction["update_key_result_progress"]).toBe("B");
    expect(tools.every((t) => t.capability_class === "A" || t.capability_class === "B")).toBe(true);
  });
});

describe("C: input_schema er strict() og bærer INGEN identitetsfelt - D-68-disiplin, samme som situations/executive", () => {
  it("et parameterobjekt som forsøker å oppgi tenant_id/actor_person_id/memory_space_id/person_id avvises av selve skjemaet", () => {
    const tools = governanceToolDefinitions(new GovernanceTransport({} as unknown as GovernanceService));
    const createDecisionSchema = tools.find((t) => t.action === "create_decision")!.input_schema;
    const attempt = {
      title: "x", rationale: "y", decision_maker: "owner",
      tenant_id: "tenant-attacker", actor_person_id: "person-attacker", memory_space_id: "business", person_id: "person-attacker"
    };
    const result = (createDecisionSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse(attempt);
    expect(result.success).toBe(false);
  });

  it("gyldige, kjente felt for hver handling aksepteres av eget skjema", () => {
    const tools = governanceToolDefinitions(new GovernanceTransport({} as unknown as GovernanceService));
    const listRisksSchema = tools.find((t) => t.action === "list_risks")!.input_schema;
    const ok = (listRisksSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse({ status: "identified" });
    expect(ok.success).toBe(true);
  });
});

describe("D: manglende invocation-context feiler lukket (transport kalt direkte uten context)", () => {
  it("governance_missing_invocation_context kastes naar context mangler", async () => {
    const transport = new GovernanceTransport(fakeService());
    await expect(transport.invoke("list_decisions", {}, "cred")).rejects.toThrow("governance_missing_invocation_context");
  });

  it("samme feil kastes naar identity finnes men mangler et paakrevd felt", async () => {
    const transport = new GovernanceTransport(fakeService());
    const badContext = { identity: { tenant_id: "t1" } } as unknown as { identity: IdentityContext };
    await expect(transport.invoke("list_decisions", {}, "cred", badContext)).rejects.toThrow("governance_missing_invocation_context");
  });
});

describe("E: transport-dispatch ruter til riktig service-metode med tenant/space/actor FRA context, ALDRI fra parametre", () => {
  it("create_decision kaller service.createDecision med tenant/space fra identity, actor=identity.person_id", async () => {
    const service = fakeService();
    const transport = new GovernanceTransport(service);
    const ctx = { identity: identity({ tenant_id: "tenant-x", memory_space_id: "personal", person_id: "person-actor" }) };
    await transport.invoke("create_decision", { title: "T", rationale: "R", decision_maker: "owner" }, "cred", ctx);
    const call = service._calls[0]!;
    expect(call.method).toBe("createDecision");
    expect(call.args[0]).toBe("tenant-x");
    expect(call.args[1]).toBe("personal");
    expect(call.args[3]).toBe("person-actor");
  });

  it("update_key_result_progress videresender et numerisk progress_percent til service.updateKeyResultProgress", async () => {
    const service = fakeService();
    const transport = new GovernanceTransport(service);
    const ctx = { identity: identity() };
    await transport.invoke("update_key_result_progress", { key_result_id: "kr-1", progress_percent: 42 }, "cred", ctx);
    expect(service._calls[0]!.method).toBe("updateKeyResultProgress");
    expect(service._calls[0]!.args[3]).toBe(42);
  });

  it("update_key_result_progress med et IKKE-numerisk progress_percent kaster missing_parameter:progress_percent", async () => {
    const transport = new GovernanceTransport(fakeService());
    const ctx = { identity: identity() };
    await expect(
      transport.invoke("update_key_result_progress", { key_result_id: "kr-1", progress_percent: "50" as unknown as JsonValue }, "cred", ctx)
    ).rejects.toThrow("missing_parameter:progress_percent");
  });

  it("manglende paakrevd strengparameter kaster missing_parameter:<felt>", async () => {
    const transport = new GovernanceTransport(fakeService());
    const ctx = { identity: identity() };
    await expect(
      transport.invoke("create_scenario", { title: "T" }, "cred", ctx)
    ).rejects.toThrow("missing_parameter:assumptions");
  });

  it("ukjent action kaster unknown_governance_action:<action>", async () => {
    const transport = new GovernanceTransport(fakeService());
    const ctx = { identity: identity() };
    await expect(transport.invoke("delete_everything", {}, "cred", ctx)).rejects.toThrow("unknown_governance_action:delete_everything");
  });
});
