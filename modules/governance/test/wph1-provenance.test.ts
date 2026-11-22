import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { GovernanceTransport, deriveGovernanceProvenance } from "../src/transport.ts";
import type { GovernanceService } from "../src/service.ts";

/**
 * WP-H1 (JARVIS-087 del 2): proveniens på journalradene. Rene, DB-frie tester av transportlaget (`GovernanceService` er en fake). Bevisene som krever ekte Postgres (kolonnene, alt-eller-ingenting-CHECK, RLS)
 * ligger i `wph1-provenance-db.test.ts`.
 *  - flagget er AV som standard: tjenesten får `undefined` (eksisterende oppførsel uendret);
 *  - flagget PÅ: kanal/sesjon/jobb/opphav utledes UTELUKKENDE fra den betrodde konteksten, aldri fra parametre;
 *  - `model` vinner alltid over en `owner_direct`-påstand; `unspecified` er aldri `owner_direct`.
 */
function identity(overrides: Partial<IdentityContext> = {}): IdentityContext {
  return { person_id: "person-prov", tenant_id: "tenant-prov", memory_space_id: "business", session_id: "sess-prov-1", device_id: "dev-1", channel: "web", auth_strength: "signed", ...overrides };
}

function fakeService() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec = (method: string, ret: unknown) => async (...args: unknown[]) => { calls.push({ method, args }); return ret; };
  return {
    createDecision: rec("createDecision", { decision_id: "dec-1" }),
    createScenario: rec("createScenario", { scenario_id: "scn-1" }),
    createRisk: rec("createRisk", { risk_id: "risk-1" }),
    createGoal: rec("createGoal", { goal_id: "goal-1" }),
    addKeyResult: rec("addKeyResult", { key_result_id: "kr-1" }),
    reverseDecision: rec("reverseDecision", { decision_id: "dec-1" }),
    _calls: calls
  } as unknown as GovernanceService & { _calls: Array<{ method: string; args: unknown[] }> };
}

const CREATE_CALLS: Array<{ action: string; params: Record<string, JsonValue>; method: string; provenanceIndex: number }> = [
  { action: "create_decision", params: { title: "T", rationale: "R", decision_maker: "owner" }, method: "createDecision", provenanceIndex: 4 },
  { action: "create_scenario", params: { title: "T", assumptions: "A", projected_outcome: "P" }, method: "createScenario", provenanceIndex: 4 },
  { action: "create_risk", params: { title: "T", description: "D", severity: "low", probability: "low" }, method: "createRisk", provenanceIndex: 4 },
  { action: "create_goal", params: { title: "T" }, method: "createGoal", provenanceIndex: 4 },
  { action: "add_key_result", params: { goal_id: "goal-1", title: "KR" }, method: "addKeyResult", provenanceIndex: 3 }
];

describe("deriveGovernanceProvenance: kun fra den betrodde konteksten", () => {
  it("kanal og sesjon fra identiteten; jobb-id fra job:-sesjonen; ellers null", () => {
    expect(deriveGovernanceProvenance({ identity: identity() })).toEqual({ channel: "web", session_id: "sess-prov-1", task_id: null, origin: "unspecified" });
    expect(deriveGovernanceProvenance({ identity: identity({ session_id: "job:task-77", channel: "system" }) })).toEqual({ channel: "system", session_id: "job:task-77", task_id: "task-77", origin: "unspecified" });
    // «job:» uten id er ingen jobb
    expect(deriveGovernanceProvenance({ identity: identity({ session_id: "job:" }) }).task_id).toBeNull();
  });

  it("opphav: model (servingModel) > owner_direct (attestert av trusted kode) > unspecified - en modell i løkka vinner alltid, og unspecified er aldri owner_direct", () => {
    const base = { identity: identity() };
    expect(deriveGovernanceProvenance(base).origin).toBe("unspecified");
    expect(deriveGovernanceProvenance({ ...base, contentOrigin: "owner_direct" }).origin).toBe("owner_direct");
    expect(deriveGovernanceProvenance({ ...base, servingModel: { provider: "anthropic", model: "x" } }).origin).toBe("model");
    expect(deriveGovernanceProvenance({ ...base, servingModel: { provider: "gemma_local", model: "x" }, contentOrigin: "owner_direct" }).origin).toBe("model");
    // en signert økt alene er IKKE en attest om at eieren skrev innholdet (en eier-godkjent bekreftelse kan utføre et modellskrevet kall)
    expect(deriveGovernanceProvenance({ identity: identity({ auth_strength: "signed" }) }).origin).toBe("unspecified");
  });
});

describe("flagget JARVIS_GOVERNANCE_PROVENANCE (recordProvenance): AV som standard", () => {
  for (const c of CREATE_CALLS) {
    it(`${c.action}: uten flagg får tjenesten INGEN proveniens (eksisterende oppførsel uendret)`, async () => {
      const service = fakeService();
      const transport = new GovernanceTransport(service);
      await transport.invoke(c.action, c.params, "cred", { identity: identity(), contentOrigin: "owner_direct" });
      expect(service._calls[0]!.method).toBe(c.method);
      expect(service._calls[0]!.args[c.provenanceIndex]).toBeUndefined();
    });

    it(`${c.action}: med flagg PÅ skrives proveniensen fra konteksten (ikke fra parametre)`, async () => {
      const service = fakeService();
      const transport = new GovernanceTransport(service, { recordProvenance: true });
      await transport.invoke(c.action, c.params, "cred", { identity: identity({ session_id: "job:task-9", channel: "system" }), servingModel: { provider: "anthropic", model: "m" } });
      expect(service._calls[0]!.args[c.provenanceIndex]).toEqual({ channel: "system", session_id: "job:task-9", task_id: "task-9", origin: "model" });
    });
  }

  it("flagget er KUN den eksakte verdien true - alt annet (undefined/false) er av", async () => {
    for (const options of [undefined, {}, { recordProvenance: false }]) {
      const service = fakeService();
      await new GovernanceTransport(service, options).invoke("create_goal", { title: "T" }, "cred", { identity: identity() });
      expect(service._calls[0]!.args[4]).toBeUndefined();
    }
  });

  it("proveniens kan ikke oppgis i parametre: strict-skjemaet avviser prov_*-felt (ToolGateway), og transporten leser dem aldri", async () => {
    const service = fakeService();
    const transport = new GovernanceTransport(service, { recordProvenance: true });
    await transport.invoke("create_goal", { title: "T", prov_origin: "owner_direct", prov_session_id: "falsk" } as Record<string, JsonValue>, "cred", { identity: identity() });
    expect(service._calls[0]!.args[4]).toEqual({ channel: "web", session_id: "sess-prov-1", task_id: null, origin: "unspecified" });
  });

  it("oppdateringer (reverse_decision) får ingen proveniens-parameter (kun opprettelse er merket; endringer spores via audit_events)", async () => {
    const service = fakeService();
    await new GovernanceTransport(service, { recordProvenance: true }).invoke("reverse_decision", { decision_id: "dec-1" }, "cred", { identity: identity() });
    expect(service._calls[0]!.args).toHaveLength(3);
  });
});
