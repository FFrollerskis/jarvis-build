import { describe, expect, it } from "vitest";
import { MeshToolExecutor, meshToolDefinitions, type ToolGateway } from "@jarvis/tool-gateway";
import { ExecutiveService } from "../src/service.ts";
import { ExecutiveTransport, executiveToolDefinitions } from "../src/transport.ts";
import type { IdentityContext } from "@jarvis/contracts";

/**
 * "Charlie"-selv-bevissthet (D-209, utvidet D-237, GRUPPERT per D-289):
 * DB-uavhengige tester for `executive.get_capability_status` -
 * `getCapabilityStatus()` gjør INGEN nøstet `gateway.execute()`-kall (leser
 * KUN `gateway.list()`/`gateway.hasSecret()` og `gateway.health` direkte, se
 * service.ts sitt filhode), så en ekte embedded-Postgres-`ToolGateway` er
 * UNØDVENDIG her - en minimal fake er nok til å bevise metoden faktisk
 * leser DERFRA.
 *
 * D-289 (Tobias: "vil ha alt at han har full kontroll"): svaret er nå
 * GRUPPERT per `tool_id` (handlinger+klasser samlet), ikke lenger én rad
 * per kuratert mesh-verktøy - se `CapabilityStatus` sitt filhode i types.ts.
 */

interface FakeDefinition {
  tool_id: string;
  action: string;
  capability_class?: string;
  credential_ref?: string;
}

function fakeGateway(
  health: Array<[string, { state: string; at: string; detail?: string }]> = [],
  configuredRefs: Set<string> = new Set(),
  definitions: FakeDefinition[] = [
    { tool_id: "github", action: "read_issues", capability_class: "A" },
    { tool_id: "email", action: "read_inbox", capability_class: "A" },
    { tool_id: "executive", action: "get_capability_status", capability_class: "A" }
  ]
): ToolGateway {
  return {
    health: new Map(health),
    list: () =>
      definitions.map((d) => ({
        tool_id: d.tool_id,
        action: d.action,
        capability_class: d.capability_class ?? "A",
        credential_ref: d.credential_ref ?? `${d.tool_id}:${d.action}`
      })),
    hasSecret: async (ref: string) => configuredRefs.has(ref)
  } as unknown as ToolGateway;
}

function identity(): IdentityContext {
  return {
    person_id: "person-cap-test", tenant_id: "tenant-cap-test", memory_space_id: "business",
    session_id: "sess-cap-test", device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

describe("A: ExecutiveService.getCapabilityStatus() - grounded i ToolGateway.list(), GRUPPERT per tool_id (D-289)", () => {
  it("chat_accessible_tools er RENT avledet av gateway.list(), ett gruppert element per tool_id, sortert", async () => {
    const service = new ExecutiveService(fakeGateway());
    const status = await service.getCapabilityStatus();
    expect(status.chat_accessible_tools).toEqual([
      { tool_id: "email", actions: ["read_inbox"], capability_classes: ["A"], configured: false },
      { tool_id: "executive", actions: ["get_capability_status"], capability_classes: ["A"], configured: false },
      { tool_id: "github", actions: ["read_issues"], capability_classes: ["A"], configured: false }
    ]);
  });

  it("chat_accessible_tools inkluderer 'executive' tool_id selv - verktøyet kan bevise sin egen tilstedeværelse", async () => {
    const service = new ExecutiveService(fakeGateway());
    const status = await service.getCapabilityStatus();
    expect(status.chat_accessible_tools.some((t) => t.tool_id === "executive")).toBe(true);
  });

  it("D-237/D-289: configured=true KUN for tool_id hvis underliggende credential_ref faktisk har en secret", async () => {
    const service = new ExecutiveService(fakeGateway([], new Set(["github:read_issues"])));
    const status = await service.getCapabilityStatus();
    const github = status.chat_accessible_tools.find((t) => t.tool_id === "github");
    const email = status.chat_accessible_tools.find((t) => t.tool_id === "email");
    expect(github?.configured).toBe(true);
    expect(email?.configured).toBe(false);
  });

  it("D-289: en tool_id med FLERE handlinger/klasser samles korrekt (unike, sorterte actions/capability_classes)", async () => {
    const service = new ExecutiveService(
      fakeGateway([], new Set(), [
        { tool_id: "finance_stripe", action: "read_balance", capability_class: "A" },
        { tool_id: "finance_stripe", action: "create_charge", capability_class: "D" }
      ])
    );
    const status = await service.getCapabilityStatus();
    expect(status.chat_accessible_tools).toEqual([
      {
        tool_id: "finance_stripe",
        actions: ["create_charge", "read_balance"],
        capability_classes: ["A", "D"],
        configured: false
      }
    ]);
  });

  it("D-289: en tool_id med TO forskjellige credential_ref-er er configured=true KUN når BEGGE er satt", async () => {
    const definitions = [
      { tool_id: "multi", action: "a", credential_ref: "MULTI_REF_1" },
      { tool_id: "multi", action: "b", credential_ref: "MULTI_REF_2" }
    ];
    const onlyOne = await new ExecutiveService(fakeGateway([], new Set(["MULTI_REF_1"]), definitions)).getCapabilityStatus();
    expect(onlyOne.chat_accessible_tools[0]?.configured).toBe(false);
    const both = await new ExecutiveService(
      fakeGateway([], new Set(["MULTI_REF_1", "MULTI_REF_2"]), definitions)
    ).getCapabilityStatus();
    expect(both.chat_accessible_tools[0]?.configured).toBe(true);
  });

  it("tomt register (gateway.list() === []) gir en tom, ikke en kastet, chat_accessible_tools-liste", async () => {
    const status = await new ExecutiveService(fakeGateway([], new Set(), [])).getCapabilityStatus();
    expect(status.chat_accessible_tools).toEqual([]);
  });

  it("D-317: serving_model er null når ingen servingModel-argument er gitt - ALDRI gjettet til en fast verdi", async () => {
    const status = await new ExecutiveService(fakeGateway()).getCapabilityStatus();
    expect(status.serving_model).toBeNull();
  });

  it("D-317: serving_model speiler EKSAKT det medfulgte {provider, model}-argumentet, uendret", async () => {
    const status = await new ExecutiveService(fakeGateway()).getCapabilityStatus({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(status.serving_model).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
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

  it("D-317: transport.invoke(...) videreformidler context.servingModel UENDRET til service.getCapabilityStatus() - resultatet inneholder serving_model", async () => {
    const transport = new ExecutiveTransport(new ExecutiveService(fakeGateway()));
    const result = await transport.invoke("get_capability_status", {}, "cred", {
      identity: identity(),
      servingModel: { provider: "openai", model: "gpt-5" }
    });
    const data = result.data as unknown as { serving_model: unknown };
    expect(data.serving_model).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("D-317: context UTEN servingModel gir serving_model=null - IKKE en kastet feil, IKKE en gjettet verdi", async () => {
    const transport = new ExecutiveTransport(new ExecutiveService(fakeGateway()));
    const result = await transport.invoke("get_capability_status", {}, "cred", { identity: identity() });
    const data = result.data as unknown as { serving_model: unknown };
    expect(data.serving_model).toBeNull();
  });

  it("D-317: et modell-oppgitt 'provider'/'model'-felt i PARAMETERS (ikke context) har INGEN effekt - serving_model kommer UTELUKKENDE fra trusted context", async () => {
    const transport = new ExecutiveTransport(new ExecutiveService(fakeGateway()));
    const spoofedParameters = { provider: "spoofed-provider", model: "spoofed-model" };
    const result = await transport.invoke("get_capability_status", spoofedParameters, "cred", {
      identity: identity(),
      servingModel: { provider: "anthropic", model: "claude-sonnet-5" }
    });
    const data = result.data as unknown as { serving_model: unknown };
    expect(data.serving_model).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
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
        return { ok: true, data: { chat_accessible_tools: [], connector_health: [], serving_model: null } };
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

  it("D-317: MeshToolExecutor.execute(...) videreformidler call.provider/call.model som servingModel til ToolGateway.execute() - trusted-lag, IKKE via parameters", async () => {
    const calls: Array<{ servingModel: unknown; parameters: unknown }> = [];
    const fakeToolGateway = {
      execute: async (req: { servingModel?: unknown; parameters: unknown }) => {
        calls.push({ servingModel: req.servingModel, parameters: req.parameters });
        return { ok: true, data: { chat_accessible_tools: [], connector_health: [], serving_model: null } };
      }
    } as unknown as ToolGateway;
    const executor = new MeshToolExecutor(fakeToolGateway, identity());
    await executor.execute(
      { tool_call_id: "call-1", tool_name: "check_my_capabilities", arguments: {}, provider: "anthropic", model: "claude-sonnet-5" },
      { tenant_id: "tenant-cap-test", idempotency_key: "idem-1" }
    );
    expect(calls[0]!.servingModel).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("D-317-adversarielt: et modell-oppgitt 'provider'/'model'-felt i call.arguments PÅVIRKER ALDRI den videreformidlede servingModel - den kommer UTELUKKENDE fra ToolCallRequest sine egne, adapter-stemplede felt", async () => {
    const calls: Array<{ servingModel: unknown }> = [];
    const fakeToolGateway = {
      execute: async (req: { servingModel?: unknown }) => {
        calls.push({ servingModel: req.servingModel });
        return { ok: true, data: { chat_accessible_tools: [], connector_health: [], serving_model: null } };
      }
    } as unknown as ToolGateway;
    const executor = new MeshToolExecutor(fakeToolGateway, identity());
    await executor.execute(
      {
        tool_call_id: "call-1", tool_name: "check_my_capabilities",
        arguments: { provider: "spoofed-provider", model: "spoofed-model" },
        provider: "anthropic", model: "claude-sonnet-5"
      },
      { tenant_id: "tenant-cap-test", idempotency_key: "idem-1" }
    );
    expect(calls[0]!.servingModel).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });
});

describe("D-437: forbehold når statusen evalueres i en prosess med snevret miljø", () => {
  it("evaluation_caveat følger svaret når satt (worker), og mangler ellers (api) - aldri skjult", async () => {
    const withCaveat = await new ExecutiveService(fakeGateway(), { evaluationCaveat: "snevret miljø" }).getCapabilityStatus();
    expect(withCaveat.evaluation_caveat).toBe("snevret miljø");
    const without = await new ExecutiveService(fakeGateway()).getCapabilityStatus();
    expect(without.evaluation_caveat).toBeUndefined();
    expect("evaluation_caveat" in without).toBe(false);
  });
});
