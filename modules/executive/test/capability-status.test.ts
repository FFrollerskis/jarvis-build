import { describe, expect, it } from "vitest";
import { MeshToolExecutor, meshToolBindings, meshToolDefinitions, type ToolGateway } from "@jarvis/tool-gateway";
import { ExecutiveService } from "../src/service.ts";
import { ExecutiveTransport, executiveToolDefinitions } from "../src/transport.ts";
import type { IdentityContext } from "@jarvis/contracts";

/**
 * "Charlie"-selv-bevissthet (D-209, utvidet D-237): DB-uavhengige tester for
 * `executive.get_capability_status` - `getCapabilityStatus()` gjør INGEN
 * nøstet `gateway.execute()`-kall (leser KUN `meshToolBindings()`,
 * `gateway.get()`/`gateway.hasSecret()` og `gateway.health` direkte, se
 * service.ts sitt filhode), så en ekte embedded-Postgres-`ToolGateway` er
 * UNØDVENDIG her - en minimal fake er nok til å bevise metoden faktisk
 * leser DERFRA.
 *
 * D-237: hver mesh-binding gis en SYNTETISK, deterministisk
 * `credential_ref` (`"<tool_id>:<action>"`) av `fakeGateway()` under - kun
 * for å kunne styre `configured`/`ikke konfigurert` presist per test, ALDRI
 * et forsøk på å gjenskape ekte `ToolDefinition`-registrering.
 */

function fakeGateway(
  health: Array<[string, { state: string; at: string; detail?: string }]> = [],
  configuredRefs: Set<string> = new Set()
): ToolGateway {
  return {
    health: new Map(health),
    get: (toolId: string, action: string) => ({ credential_ref: `${toolId}:${action}` }),
    hasSecret: async (ref: string) => configuredRefs.has(ref)
  } as unknown as ToolGateway;
}

function identity(): IdentityContext {
  return {
    person_id: "person-cap-test", tenant_id: "tenant-cap-test", memory_space_id: "business",
    session_id: "sess-cap-test", device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

describe("A: ExecutiveService.getCapabilityStatus() - grounded i den SAMME kilden chat-verktøykjeden bruker", () => {
  it("chat_accessible_tools er BYTE-FOR-BYTE meshToolBindings() sin egen name/description (pluss configured) - ingen egen, potensielt avvikende kopi", async () => {
    const service = new ExecutiveService(fakeGateway());
    const status = await service.getCapabilityStatus();
    const expected = meshToolBindings().map((b) => ({ name: b.name, description: b.description, configured: false }));
    expect(status.chat_accessible_tools).toEqual(expected);
  });

  it("chat_accessible_tools inkluderer check_my_capabilities selv - verktøyet kan bevise sin egen tilstedeværelse", async () => {
    const service = new ExecutiveService(fakeGateway());
    const status = await service.getCapabilityStatus();
    expect(status.chat_accessible_tools.some((t) => t.name === "check_my_capabilities")).toBe(true);
  });

  it("D-237: configured=true KUN for mesh-verktøy hvis underliggende credential_ref faktisk har en secret", async () => {
    const service = new ExecutiveService(fakeGateway([], new Set(["github:read_issues"])));
    const status = await service.getCapabilityStatus();
    const github = status.chat_accessible_tools.find((t) => t.name === "read_github_issues");
    const email = status.chat_accessible_tools.find((t) => t.name === "read_recent_email");
    expect(github?.configured).toBe(true);
    expect(email?.configured).toBe(false);
  });

  it("D-237: configured=false (ALDRI en kastet feil) når gateway.get() ikke finner en registrert ToolDefinition for bindingen", async () => {
    const gateway = {
      health: new Map(),
      get: () => undefined,
      hasSecret: async () => true
    } as unknown as ToolGateway;
    const status = await new ExecutiveService(gateway).getCapabilityStatus();
    expect(status.chat_accessible_tools.every((t) => t.configured === false)).toBe(true);
  });

  it("connector_health speiler gateway.health direkte (tool_id + state/at/detail), tomt naar INGENTING er kalt ennå", async () => {
    const empty = await new ExecutiveService(fakeGateway()).getCapabilityStatus();
    expect(empty.connector_health).toEqual([]);

    const withHealth = await new ExecutiveService(fakeGateway([
      ["github:read_issues", { state: "healthy", at: "2026-09-20T12:00:00.000Z" }],
      ["email:read_inbox", { state: "auth_failed", at: "2026-09-20T12:05:00.000Z", detail: "token_expired" }]
    ])).getCapabilityStatus();
    expect(withHealth.connector_health).toEqual([
      { tool_id: "github:read_issues", state: "healthy", at: "2026-09-20T12:00:00.000Z" },
      { tool_id: "email:read_inbox", state: "auth_failed", at: "2026-09-20T12:05:00.000Z", detail: "token_expired" }
    ]);
  });
});

describe("B: executive.get_capability_status - registrert klasse A (lesing), gjennom SAMME transport-dispatch som resten", () => {
  it("registrert i executiveToolDefinitions() som klasse A", () => {
    const tools = executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGateway())));
    const tool = tools.find((t) => t.action === "get_capability_status");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
    expect(tool!.tool_id).toBe("executive");
  });

  it("transport.invoke('get_capability_status', ...) ruter til service.getCapabilityStatus() og returnerer dens data uendret", async () => {
    const service = new ExecutiveService(fakeGateway([["github:read_issues", { state: "healthy", at: "2026-09-20T12:00:00.000Z" }]]));
    const transport = new ExecutiveTransport(service);
    const result = await transport.invoke("get_capability_status", {}, "cred", { identity: identity() });
    expect(result.data).toBeDefined();
    const data = result.data as unknown as { chat_accessible_tools: unknown[]; connector_health: unknown[] };
    expect(data.chat_accessible_tools.length).toBeGreaterThan(0);
    expect(data.connector_health).toEqual([{ tool_id: "github:read_issues", state: "healthy", at: "2026-09-20T12:00:00.000Z" }]);
  });

  it("manglende invocation-context feiler lukket, samme disiplin som resten av executive.*", async () => {
    const transport = new ExecutiveTransport(new ExecutiveService(fakeGateway()));
    await expect(transport.invoke("get_capability_status", {}, "cred")).rejects.toThrow("executive_missing_invocation_context");
  });
});

describe("C: mesh-bridge - check_my_capabilities peker FAKTISK til executive.get_capability_status, ikke bare en isolert definisjon", () => {
  it("meshToolDefinitions() inneholder check_my_capabilities med et gyldig, tomt input_schema (ingen modell-oppgitte parametre trengs)", () => {
    const def = meshToolDefinitions().find((d) => d.name === "check_my_capabilities");
    expect(def).toBeDefined();
    expect(def!.input_schema).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
  });

  it("MeshToolExecutor.execute('check_my_capabilities', ...) ruter GJENNOM den ekte MESH_TOOLS-mappingen til tool_id='executive'/action='get_capability_status' - SAMME kodevei chat-modellen faktisk bruker", async () => {
    const calls: Array<{ tool_id: string; action: string }> = [];
    const fakeToolGateway = {
      execute: async (req: { tool_id: string; action: string }) => {
        calls.push({ tool_id: req.tool_id, action: req.action });
        return { ok: true, data: { chat_accessible_tools: [], connector_health: [] } };
      }
    } as unknown as ToolGateway;
    const executor = new MeshToolExecutor(fakeToolGateway, identity());
    const result = await executor.execute(
      { tool_call_id: "call-1", tool_name: "check_my_capabilities", arguments: {}, provider: "test", model: "test" },
      { tenant_id: "tenant-cap-test", idempotency_key: "idem-1" }
    );
    expect(result.success).toBe(true);
    expect(calls).toEqual([{ tool_id: "executive", action: "get_capability_status" }]);
  });
});
