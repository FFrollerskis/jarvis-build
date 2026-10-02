import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import {
  FORBIDDEN_MODEL_TOOL_IDS,
  MODEL_SURFACE_ALLOWLIST,
  MODEL_SURFACE_QUARANTINE_WRITES,
  MemorySearchTransport,
  MeshToolExecutor,
  ModelSurfaceViolationError,
  allMeshTools,
  assertReadOnlyModelSurface,
  curatedReadOnlyMeshTools,
  firstWaveTools,
  memoryToolDefinitions,
  resolveModelToolSurface,
  type ToolDefinition,
  type ToolGateway
} from "@jarvis/tool-gateway";

/**
 * Remediering del 1 / JARVIS-002: modellens aktive verktøyflate er et
 * EKSPLISITT, LESENDE minimumssett. Dette er en ATFERDSTEST mot de ekte
 * produksjons-ToolDefinition-ene (firstWaveTools + executive + memory) - ikke
 * en regex mot kildekode.
 */
function productionDefinitions(): ToolDefinition[] {
  const fakeGatewayForExecutive = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  const fakeRetriever = { search: async () => [] } as never;
  return firstWaveTools(
    {},
    {
      additionalTools: [
        ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGatewayForExecutive))),
        ...memoryToolDefinitions(new MemorySearchTransport(fakeRetriever, {} as never))
      ]
    }
  );
}

const registry = (defs: ToolDefinition[]) => ({ list: () => defs });

const FORBIDDEN_NAME_PARTS =
  /(send|delete|remove|create|update|pay|refund|capture|merge|revoke|activate|kill|freeze|pause|propose|submit|notify|transfer|publish|generate|reset|restart|stop|grant)/;

describe("JARVIS-002: modellens aktive verktøyflate", () => {
  const defs = productionDefinitions();

  it("registeret er stort og inneholder farlige verktøy - men de er IKKE på modellflaten", () => {
    expect(defs.length).toBeGreaterThan(100);
    const keys = new Set(defs.map((d) => `${d.tool_id}:${d.action}`));
    for (const dangerous of ["email:send", "github:merge_pr", "docker:restart_container", "telegram:notify"]) {
      // minst noen av disse eksisterer i produksjonsregisteret (ellers tester vi ingenting)
      if (keys.has(dangerous)) expect(keys.has(dangerous)).toBe(true);
    }
    expect(defs.some((d) => d.capability_class === "D")).toBe(true);
    expect(defs.some((d) => d.capability_class === "C")).toBe(true);
  });

  it("flaten er nøyaktig allowlisten: 5 lese-handlinger (klasse A) + 1 karantene-skriving (memory.propose, klasse B, D-367)", () => {
    const surface = resolveModelToolSurface(registry(defs));
    const expected = [...MODEL_SURFACE_ALLOWLIST, ...MODEL_SURFACE_QUARANTINE_WRITES].map((a) => `${a.tool_id}:${a.action}`).sort();
    expect(surface.map((m) => `${m.tool_id}:${m.action}`).sort()).toEqual(expected);
    expect(surface).toHaveLength(6);
    expect(MODEL_SURFACE_QUARANTINE_WRITES.map((a) => `${a.tool_id}:${a.action}`)).toEqual(["memory:propose"]);
    const byKey = new Map(defs.map((d) => [`${d.tool_id}:${d.action}`, d]));
    for (const m of surface) {
      const isQuarantineWrite = m.tool_id === "memory" && m.action === "propose";
      expect(byKey.get(`${m.tool_id}:${m.action}`)?.capability_class, `${m.tool_id}:${m.action}`).toBe(isQuarantineWrite ? "B" : "A");
    }
  });

  it("D-367: eier-handlingene (approve/reject/list_proposals) er registrert men IKKE på modellflaten", () => {
    const surfaceKeys = new Set(resolveModelToolSurface(registry(defs)).map((m) => `${m.tool_id}:${m.action}`));
    const registered = new Set(defs.map((d) => `${d.tool_id}:${d.action}`));
    for (const ownerOnly of ["memory:approve_proposal", "memory:reject_proposal", "memory:list_proposals"]) {
      expect(registered.has(ownerOnly), ownerOnly).toBe(true);
      expect(surfaceKeys.has(ownerOnly), ownerOnly).toBe(false);
    }
  });

  it("D-367: memory.propose må være klasse B med nøyaktig scope [memory.propose] - ellers feiler oppstarten lukket", () => {
    const tampered = defs.map((d) => (d.tool_id === "memory" && d.action === "propose" ? { ...d, capability_class: "C" as const } : d));
    expect(() => resolveModelToolSurface(registry(tampered))).toThrow(/karantene-skriving må være klasse B/);
    const wrongScope = defs.map((d) => (d.tool_id === "memory" && d.action === "propose" ? { ...d, scopes: ["memory.approve"] } : d));
    expect(() => resolveModelToolSurface(registry(wrongScope))).toThrow(/scopes må være nøyaktig/);
  });

  it("modellens aktive tool-list mangler ALLE write/delete/send/pay/merge/owner-control-verktøy", () => {
    const surface = resolveModelToolSurface(registry(defs));
    const names = surface.map((m) => m.def.name);
    for (const name of names) {
      expect(name, name).not.toMatch(FORBIDDEN_NAME_PARTS);
    }
    for (const forbiddenId of FORBIDDEN_MODEL_TOOL_IDS) {
      expect(surface.some((m) => m.tool_id === forbiddenId), forbiddenId).toBe(false);
    }
    // og ingen klasse B/C/D-handling kan ha sneket seg inn - UNNTATT den ene, eksplisitt navngitte karantene-skrivingen (D-367)
    const surfaceKeys = new Set(surface.map((m) => `${m.tool_id}:${m.action}`));
    const exposedNonReadClasses = defs
      .filter((d) => surfaceKeys.has(`${d.tool_id}:${d.action}`))
      .filter((d) => d.capability_class !== "A")
      .map((d) => `${d.tool_id}:${d.action}:${d.capability_class}`);
    expect(exposedNonReadClasses).toEqual(["memory:propose:B"]);
  });

  it("modellen kan ikke kalle et verktøy utenfor flaten: MeshToolExecutor returnerer TOOL_NOT_FOUND uten å nå ToolGateway", async () => {
    let gatewayCalls = 0;
    const fakeToolGateway = {
      execute: async () => {
        gatewayCalls++;
        return { ok: true, data: {}, output_trust: "internal", deduplicated: false };
      }
    } as unknown as ToolGateway;
    const identity = { person_id: "p", tenant_id: "t", memory_space_id: "personal", session_id: "s", device_id: "d" } as unknown as IdentityContext;
    const executor = new MeshToolExecutor(fakeToolGateway, identity, 20_000, resolveModelToolSurface(registry(defs)));
    for (const toolName of [
      "email__send",
      "github__merge_pr",
      "owner_controls__set_connector_credential",
      "owner_controls__deactivate_kill_switch",
      "finance_stripe__refund_payment",
      "docker__restart_container",
      "delegate_code_task",
      "self_modification__propose_personality_change"
    ]) {
      const result = await executor.execute(
        { tool_call_id: "c1", tool_name: toolName, arguments: {}, provider: "scripted", model: "scripted-1" },
        { tenant_id: "t", idempotency_key: "k" }
      );
      expect(result.success, toolName).toBe(false);
      expect(result.error_category, toolName).toBe("TOOL_NOT_FOUND");
    }
    expect(gatewayCalls).toBe(0);
  });

  it("den fulle generatoren (allMeshTools) avvises som modellflate - boot-sjekken kaster", () => {
    const full = allMeshTools(registry(defs) as unknown as ToolGateway);
    expect(full.length).toBeGreaterThan(100);
    expect(() => assertReadOnlyModelSurface(registry(defs), full)).toThrow(ModelSurfaceViolationError);
  });

  it("boot-sjekken feiler lukket når et allowlistet verktøy ikke er klasse A", () => {
    const tampered = defs.map((d) =>
      d.tool_id === "email" && d.action === "read_inbox" ? { ...d, capability_class: "C" as const } : d
    );
    expect(() => resolveModelToolSurface(registry(tampered))).toThrow(/klasse C/);
  });

  it("boot-sjekken feiler lukket når et allowlistet verktøy mangler i registeret (api-prosessen)", () => {
    const withoutMemory = defs.filter((d) => d.tool_id !== "memory");
    expect(() => resolveModelToolSurface(registry(withoutMemory))).toThrow(/ikke registrert/);
    // worker-prosessen registrerer en delmengde: skjæringen er tillatt, utvidelse er det aldri
    const workerSurface = resolveModelToolSurface(registry(withoutMemory), { onlyRegistered: true });
    expect(workerSurface.map((m) => m.tool_id)).not.toContain("memory");
    expect(workerSurface.length).toBeLessThan(5);
  });

  it("curatedReadOnlyMeshTools returnerer en kopi - kallere kan ikke utvide den interne listen", () => {
    const copy = curatedReadOnlyMeshTools();
    copy.push({ def: { name: "x", description: "x", input_schema: { type: "object" } }, tool_id: "email", action: "send" });
    expect(curatedReadOnlyMeshTools()).toHaveLength(6);
  });

  it("getCapabilityStatus påstår IKKE at hele registeret er tilgjengelig når flaten er begrenset", async () => {
    const gateway = {
      list: () => defs,
      health: new Map(),
      hasSecret: async () => true
    } as unknown as ToolGateway;
    const fullSurface = [...MODEL_SURFACE_ALLOWLIST, ...MODEL_SURFACE_QUARANTINE_WRITES];
    const restricted = await new ExecutiveService(gateway, { modelSurface: fullSurface }).getCapabilityStatus();
    const accessibleActions = restricted.chat_accessible_tools.flatMap((t) => t.actions.map((a) => `${t.tool_id}:${a}`));
    expect(accessibleActions.sort()).toEqual(fullSurface.map((a) => `${a.tool_id}:${a.action}`).sort());
    expect(restricted.model_surface).toEqual({
      restricted: true,
      registered_actions: defs.length,
      model_accessible_actions: 6
    });
    // uten begrensning (legacy-bruk) oppfører den seg som før
    const unrestricted = await new ExecutiveService(gateway).getCapabilityStatus();
    expect(unrestricted.model_surface).toBeUndefined();
    expect(unrestricted.chat_accessible_tools.length).toBeGreaterThan(restricted.chat_accessible_tools.length);
  });
});
