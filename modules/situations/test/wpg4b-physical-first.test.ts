import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "@jarvis/tool-gateway";
import { PHYSICAL_NAMESPACES, SituationActActionForbiddenError, autonomyActionBlocker, autonomyBindBlocker } from "../src/autonomy-guard.ts";
import { SimulationService, simulationToolInfoFrom } from "../src/simulation.ts";
import { NOW, OWNER, TENANT_A, identity, record, startG4Db, type G4Db } from "./support/wpg4-db.ts";
import { TEST_BINDABLE } from "./support/bindable.ts";

/**
 * WP-G4b fiks-runde 1, FIX-9 (review A LOW-2): K1-vakten er «fysisk foerst» for ENHVER handling i de fysiske navnerommene (`home-assistant`, `car`) - ogsaa lese-handlinger. Foer fiksen slapp navnerom-vakten kjente lese-handlinger
 * gjennom, saa en feilmerket `home-assistant.list_states` / `car.read_vehicle_state` som erklaerte `autonomy_bindable` kunne bindes og utfoeres (kun manifest-invarianten ved oppstart stengte den). Naa nektes de FOER definisjonssjekken,
 * i alle tre motorveier: bind-tid, utfoerelse (`autoActPending` og `actOn`) og simulering - uansett hva definisjonen paastaar.
 */
const READS: Array<[string, string]> = [
  ["home-assistant", "list_states"], ["home-assistant", "read_state"], ["home-assistant", "read_state_detail"], ["home-assistant", "read_states_detail"], ["home-assistant", "read_critical_state"], ["car", "read_vehicle_state"]
];
const WRITES: Array<[string, string]> = [["home-assistant", "lock_set"], ["home-assistant", "critical_cover"], ["car", "unlock"], ["home-assistant", "ukjent_ny"], ["car", "honk"]];
const ALL = [...READS, ...WRITES];

describe("A (rent): navnerommet avgjoer alene, FOER definisjonssjekken", () => {
  const claimsBindable = () => ({ autonomy_bindable: { reason: "feilmerket: en definisjon som (feilaktig) paastaar at den kan bindes" } });

  it("`autonomyActionBlocker`: alle handlinger i de fysiske navnerommene er nektet, ogsaa lesing; andre navnerom er uendret", () => {
    for (const [tool, action] of ALL) expect(autonomyActionBlocker(tool, action), `${tool}.${action}`).toEqual({ code: "physical_action_not_bindable", tool_id: tool, action });
    for (const other of [["telegram", "notify"], ["business", "create_followup"], ["make", "run_scenario"], ["home-assistant-x", "list_states"], ["Home-Assistant", "list_states"]]) expect(autonomyActionBlocker(other[0], other[1]), other.join(".")).toBeNull();
    expect([...PHYSICAL_NAMESPACES].sort()).toEqual(["car", "home-assistant"]);
  });

  it("`autonomyBindBlocker`: en lese-handling som ERKLAERER seg bindbar aapnes aldri (physical_action_not_bindable, ikke `null` og ikke `action_not_bindable`)", () => {
    for (const [tool, action] of ALL) {
      expect(autonomyBindBlocker(tool, action, claimsBindable), `${tool}.${action}`).toEqual({ code: "physical_action_not_bindable", tool_id: tool, action });
      expect(autonomyBindBlocker(tool, action, undefined)?.code, `${tool}.${action} uten oppslag`).toBe("physical_action_not_bindable");
    }
  });
});

describe("B (ekte Postgres, ekte motor/gateway): en feilmerket lese-handling bindes og utfoeres aldri", () => {
  let db: G4Db;
  beforeAll(async () => { db = await startG4Db("wpg4b_phys"); }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => { await db.reset(); });

  class Spy implements ToolTransport {
    calls = 0;
    async invoke(): Promise<{ external_id?: string; data?: JsonValue }> { this.calls += 1; return { external_id: `s-${this.calls}`, data: { done: true } }; }
  }
  /** Gatewayen har en FEILMERKET definisjon: erklaerer `autonomy_bindable` i et fysisk navnerom (det manifest-invarianten ellers ville felt ved oppstart). */
  function mislabeled(tool_id: string, action: string, spy: Spy): ToolDefinition {
    return {
      tool_id, action, description: "feilmerket", input_schema: record({ situation_id: z.string().optional() }), capability_class: "B", scopes: [], reversible: true, rollback_procedure: "angre", idempotent_external: false,
      timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_TOKEN", output_trust: "internal", transport: spy, autonomy_bindable: TEST_BINDABLE
    } as ToolDefinition;
  }
  const seedSuggest = async (key: string) => (await db.engine.evaluateCandidate(TENANT_A, "home", { domain: "home", detection_key: key, priority: "high", confidence: 0.9, reason: "r" }, NOW)).situation;
  const insertRow = (tool_id: string, action: string) => db.adminPool.query(
    `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id) VALUES ($1, 'home', 'home', $2, $3, '{"situation_id":"{{situation_id}}"}'::jsonb, true, $4)
     ON CONFLICT (tenant_id, memory_space_id, domain, scope_key) DO UPDATE SET tool_id = EXCLUDED.tool_id, action = EXCLUDED.action`,
    [TENANT_A, tool_id, action, OWNER]
  );

  for (const [tool, action] of READS) {
    it(`${tool}.${action}: bind-tid avvises, en lagret rad utfoeres aldri (0 kall, 0 claim) og vises som fysisk, actOn nekter, simuleringen sier physical_action_not_bindable`, async () => {
      const { gateway } = db.newGateway();
      const spy = new Spy();
      gateway.register(mislabeled(tool, action, spy));
      await expect(db.engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: tool, action, parameters: { situation_id: "{{situation_id}}" } }, OWNER)).rejects.toMatchObject({
        name: "SituationActActionForbiddenError", code: "physical_action_not_bindable", message: `situation_autonomy_action_forbidden:physical_action_not_bindable:${tool}.${action}`
      });
      expect((await db.engine.listAutonomyPolicies(TENANT_A, "home"))).toEqual([]);

      await insertRow(tool, action); // en rad skrevet utenom bind-API-et (eldre/direkte)
      const sit = await seedSuggest(`home:phys:${tool}:${action}`);
      const res = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
      expect(res.attempted).toBe(0);
      expect(spy.calls).toBe(0);
      expect((await db.adminPool.query("SELECT act_idempotency_key FROM situations WHERE situation_id = $1", [sit.situation_id])).rows[0]).toEqual({ act_idempotency_key: null });
      // raden er ikke slettet og merkes for eieren som FYSISK (ikke bare «ikke erklaert bindbar»)
      expect(await db.engine.listAutonomyPolicies(TENANT_A, "home")).toMatchObject([{ tool_id: tool, action, blocked_code: "physical_action_not_bindable" }]);

      await expect(db.engine.actOn(TENANT_A, "home", sit.situation_id, { tool_id: tool, action, parameters: { situation_id: sit.situation_id } }, gateway, identity(TENANT_A, "home"), { autoActGuard: { max_age_seconds: 3600 } }))
        .rejects.toBeInstanceOf(SituationActActionForbiddenError);
      expect(spy.calls).toBe(0);

      const report = await new SimulationService(db.appPool, simulationToolInfoFrom(gateway), () => NOW).simulate(TENANT_A, "home", sit.situation_id);
      const acted = report.scenarios.find((s) => s.id === "acted_at_suggest")!;
      expect(acted.blocked_by).toContain("physical_action_not_bindable");
      expect(acted.blocked_by).not.toContain("action_not_bindable");
      expect(acted.requires_owner_approval).toBe(true);
    });
  }
});
