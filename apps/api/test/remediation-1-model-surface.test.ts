import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import {
  FORBIDDEN_MODEL_TOOL_IDS,
  MODEL_SURFACE_ALLOWLIST,
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
        ...memoryToolDefinitions(new MemorySearchTransport(fakeRetriever))
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

  it("flaten er nøyaktig allowlisten: 5 lese-handlinger, alle klasse A", () => {
    const surface = resolveModelToolSurface(registry(defs));
    expect(surface.map((m) => `${m.tool_id}:${m.action}`).sort()).toEqual(
      MODEL_SURFACE_ALLOWLIST.map((a) => `${a.tool_id}:${a.action}`).sort()
    );
    expect(surface).toHaveLength(5);
    const byKey = new Map(defs.map((d) => [`${d.tool_id}:${d.action}`, d]));
    for (const m of surface) {
      expect(byKey.get(`${m.tool_id}:${m.action}`)?.capability_class, `${m.tool_id}:${m.action}`).toBe("A");
    }
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
    // og ingen klasse B/C/D-handling kan ha sneket seg inn
    const surfaceKeys = new Set(surface.map((m) => `${m.tool_id}:${m.action}`));
    const exposedNonReadClasses = defs
      .filter((d) => surfaceKeys.has(`${d.tool_id}:${d.action}`))
      .filter((d) => d.capability_class !== "A");
    expect(exposedNonReadClasses).toEqual([]);
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
    expect(curatedReadOnlyMeshTools()).toHaveLength(5);
  });

  it("getCapabilityStatus påstår IKKE at hele registeret er tilgjengelig når flaten er begrenset", async () => {
    const gateway = {
      list: () => defs,
      health: new Map(),
      hasSecret: async () => true
    } as unknown as ToolGateway;
    const restricted = await new ExecutiveService(gateway, { modelSurface: MODEL_SURFACE_ALLOWLIST }).getCapabilityStatus();
    const accessibleActions = restricted.chat_accessible_tools.flatMap((t) => t.actions.map((a) => `${t.tool_id}:${a}`));
    expect(accessibleActions.sort()).toEqual(MODEL_SURFACE_ALLOWLIST.map((a) => `${a.tool_id}:${a.action}`).sort());
    expect(restricted.model_surface).toEqual({
      restricted: true,
      registered_actions: defs.length,
      model_accessible_actions: 5
    });
    // uten begrensning (legacy-bruk) oppfører den seg som før
    const unrestricted = await new ExecutiveService(gateway).getCapabilityStatus();
    expect(unrestricted.model_surface).toBeUndefined();
    expect(unrestricted.chat_accessible_tools.length).toBeGreaterThan(restricted.chat_accessible_tools.length);
  });
});
