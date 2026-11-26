import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "@jarvis/tool-gateway";
import { SimulationService, simulateCounterfactual, simulationToolInfoFrom, type SimulationBinding, type SimulationInput } from "../src/simulation.ts";
import { NOW, OWNER, TENANT_A, record, startG4Db, type G4Db } from "./support/wpg4-db.ts";
import { TEST_BINDABLE } from "./support/bindable.ts";

/**
 * WP-G4b fiks-runde 1: simuleringens bindingsavgjoerelse.
 *  - FIX-4 / X-16: den EFFEKTIVE bindingen er maalt av DATABASEKLOKKEN: en utloept rad (bred eller smal) er ikke `bound` (tak/unntak), akkurat som i motoren.
 *  - FIX-10 (review A LOW-3): en binding til en handling UTEN kjent definisjon (ikke registrert) gir `action_not_bindable` i simuleringen (fail-closed, samme som motoren), ikke «ingen blokkering».
 */
const DOOR = "home_assistant:door_open_too_long";

describe("FIX-10 (rent): ukjent definisjon er ikke bindbar; kjent bindbar/ikke-bindbar uendret", () => {
  const situation = { situation_id: "s1", tenant_id: "t", memory_space_id: "home", domain: "home", stage: "suggest", status: "open", opened_at: new Date(NOW - 3_600_000).toISOString(), resolved_at: null } as unknown as SimulationInput["situation"];
  const run = (binding: SimulationBinding) => simulateCounterfactual({ situation, rule_key: DOOR, similar: [], binding, nowMs: NOW }).scenarios.find((s) => s.id === "acted_at_suggest")!;
  const bound = (over: Partial<SimulationBinding>): SimulationBinding => ({ bound: true, tool_id: "telegram", action: "notify", risk_class: "B", step_up_required: false, ...over });

  it("`bindable: false` gir hinderet `action_not_bindable`; `true` gir det ikke", () => {
    expect(run(bound({ bindable: false })).blocked_by).toContain("action_not_bindable");
    expect(run(bound({ bindable: false })).requires_owner_approval).toBe(true);
    expect(run(bound({ bindable: true })).blocked_by).not.toContain("action_not_bindable");
  });
});

describe("ekte Postgres: SimulationService mot motorens avgjoerelse", () => {
  let db: G4Db;
  beforeAll(async () => { db = await startG4Db("wpg4b_simbind"); }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => { await db.reset(); });

  class Spy implements ToolTransport { async invoke(): Promise<{ external_id?: string; data?: JsonValue }> { return { external_id: "x" }; } }
  const def = (tool_id: string, action: string, bindable: boolean): ToolDefinition => ({
    tool_id, action, description: "t", input_schema: record({ situation_id: z.string().optional() }), capability_class: "B", scopes: [], reversible: true, rollback_procedure: "angre", idempotent_external: false,
    timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_TOKEN", output_trust: "internal", transport: new Spy(), ...(bindable ? { autonomy_bindable: TEST_BINDABLE } : {})
  } as ToolDefinition);
  const insertRow = (scope: string, tool_id: string, action: string, over: { enabled?: boolean; expired?: boolean } = {}) => db.adminPool.query(
    `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id, expires_at, scope_key)
     VALUES ($1,'home','home',$2,$3,'{}'::jsonb,$4,$5,$6,$7)`,
    [TENANT_A, tool_id, action, over.enabled ?? true, OWNER, over.expired === true ? new Date(Date.now() - 3_600_000).toISOString() : null, scope]
  );
  const seed = async (key: string) => (await db.engine.evaluateCandidate(TENANT_A, "home", { domain: "home", detection_key: key, priority: "high", confidence: 0.9, reason: "r", rule_key: DOOR }, NOW)).situation;
  async function simulate(gateway: ReturnType<G4Db["newGateway"]>["gateway"], situationId: string) {
    const report = await new SimulationService(db.appPool, simulationToolInfoFrom(gateway), () => NOW).simulate(TENANT_A, "home", situationId);
    return { report, acted: report.scenarios.find((s) => s.id === "acted_at_suggest")! };
  }

  it("FIX-10: en binding til en UKJENT handling (ikke registrert) gir `action_not_bindable` + krever eierens godkjenning; en kjent, bindbar handling gir det ikke", async () => {
    const { gateway } = db.newGateway();
    gateway.register(def("known_tool", "act", true));
    await insertRow("*", "ukjent_verktoy", "handling");
    const unknown = await simulate(gateway, (await seed("home:simbind:unknown")).situation_id);
    expect(unknown.acted.blocked_by).toContain("action_not_bindable");
    expect(unknown.acted.requires_owner_approval).toBe(true);
    await db.reset();
    await insertRow("*", "known_tool", "act");
    const known = await simulate(gateway, (await seed("home:simbind:known")).situation_id);
    expect(known.acted.blocked_by).not.toContain("action_not_bindable");
    expect(known.report.recommendation).toBe("already_bound");
    await db.reset();
    gateway.register(def("known_tool", "act", false)); // registrert, men uten erklaering
    await insertRow("*", "known_tool", "act");
    expect((await simulate(gateway, (await seed("home:simbind:undeclared")).situation_id)).acted.blocked_by).toContain("action_not_bindable");
  });

  it("X-16: en UTLOEPT binding er ikke `bound` (databaseklokken): bred utloept = tak, smal utloept = unntak; uten utloep er den bundet", async () => {
    const { gateway } = db.newGateway();
    gateway.register(def("known_tool", "act", true));
    // bred rad utloept -> ingen effektiv binding
    await insertRow("*", "known_tool", "act", { expired: true });
    const expiredBroad = await simulate(gateway, (await seed("home:simbind:x1")).situation_id);
    expect(expiredBroad.acted.blocked_by).toContain("no_binding");
    expect(expiredBroad.report.recommendation).not.toBe("already_bound");
    // smal regelrad utloept (bred aktiv) = eksplisitt unntak: ingen binding for akkurat denne regelen
    await db.reset();
    await insertRow("*", "known_tool", "act");
    await insertRow(`rule:${DOOR}`, "known_tool", "act", { expired: true });
    const expiredNarrow = await simulate(gateway, (await seed("home:simbind:x2")).situation_id);
    expect(expiredNarrow.acted.blocked_by).toContain("no_binding");
    // kontroll: samme rad UTEN utloep er bundet
    await db.reset();
    await insertRow("*", "known_tool", "act");
    await insertRow(`rule:${DOOR}`, "known_tool", "act");
    const live = await simulate(gateway, (await seed("home:simbind:x3")).situation_id);
    expect(live.acted.blocked_by).not.toContain("no_binding");
    expect(live.report.recommendation).toBe("already_bound");
    // avslaatt (enabled=false) oppfoerer seg som utloept
    await db.reset();
    await insertRow("*", "known_tool", "act", { enabled: false });
    expect((await simulate(gateway, (await seed("home:simbind:x4")).situation_id)).acted.blocked_by).toContain("no_binding");
  });
});
