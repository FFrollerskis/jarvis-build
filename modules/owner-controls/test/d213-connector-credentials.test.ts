import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { ToolGateway, ToolResult } from "@jarvis/tool-gateway";
import type { OwnerControlsService } from "../src/service.ts";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "../src/transport.ts";

/**
 * Task #122 (D-213): DB-uavhengige tester for `owner_controls.
 * set_connector_credential`/`owner_controls.test_connector` - de øvrige
 * `owner_controls.*`-handlingene (kill switch/frys/enhet) er UBERØRT av
 * denne sliceen og forblir dekket av de eksisterende DB-testene. Disse to
 * NYE handlingene rører aldri `OwnerControlsService`/DB - en stub-`service`
 * er derfor nok (samme "fake er nok når koden faktisk ikke bruker den ekte
 * avhengigheten"-presedens som `connector-status.test.ts`).
 */

function fakeService(): OwnerControlsService {
  return {} as unknown as OwnerControlsService;
}

function identity(): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "personal",
    session_id: "sess-d213", device_id: "dev-test", channel: "api", auth_strength: "active"
  };
}

interface ExecuteCall {
  identity: IdentityContext;
  tool_id: string;
  action: string;
  parameters: Record<string, unknown>;
  approval?: unknown;
}

function fakeGateway(opts: {
  setSecret?: (ref: string, value: string) => Promise<void>;
  execute?: (call: ExecuteCall) => Promise<ToolResult>;
} = {}): { gateway: ToolGateway; setSecretCalls: Array<{ ref: string; value: string }>; executeCalls: ExecuteCall[] } {
  const setSecretCalls: Array<{ ref: string; value: string }> = [];
  const executeCalls: ExecuteCall[] = [];
  const gateway = {
    setSecret: async (ref: string, value: string) => {
      setSecretCalls.push({ ref, value });
      if (opts.setSecret) await opts.setSecret(ref, value);
    },
    execute: async (call: ExecuteCall) => {
      executeCalls.push(call);
      if (opts.execute) return opts.execute(call);
      return { ok: true, output_trust: "untrusted", deduplicated: false } as ToolResult;
    }
  } as unknown as ToolGateway;
  return { gateway, setSecretCalls, executeCalls };
}

describe("A: owner_controls.set_connector_credential", () => {
  it("avvist FØR gateway.setSecret() kalles når gatewayen ikke er gitt inn i konstruktøren", async () => {
    const transport = new OwnerControlsTransport(fakeService());
    await expect(
      transport.invoke("set_connector_credential", { connector_id: "github", credential_ref: "JARVIS_GITHUB_TOKEN", value: "x" }, "cred", { identity: identity() })
    ).rejects.toThrow("owner_controls_gateway_not_configured");
  });

  it("avvist for en ukjent connector_id - ALDRI et setSecret()-kall", async () => {
    const { gateway, setSecretCalls } = fakeGateway();
    const transport = new OwnerControlsTransport(fakeService(), gateway);
    await expect(
      transport.invoke("set_connector_credential", { connector_id: "does_not_exist", credential_ref: "X", value: "v" }, "cred", { identity: identity() })
    ).rejects.toThrow("unknown_connector:does_not_exist");
    expect(setSecretCalls).toEqual([]);
  });

  it("avvist når credential_ref IKKE er registrert for DEN PÅSTÅTTE connectoren - hindrer en vilkårlig secret-skrive-primitiv", async () => {
    const { gateway, setSecretCalls } = fakeGateway();
    const transport = new OwnerControlsTransport(fakeService(), gateway);
    await expect(
      transport.invoke(
        "set_connector_credential",
        { connector_id: "github", credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN", value: "v" },
        "cred", { identity: identity() }
      )
    ).rejects.toThrow("credential_ref_not_registered_for_connector:github");
    expect(setSecretCalls).toEqual([]);
  });

  it("en gyldig (connector_id, credential_ref)-kombinasjon kaller gateway.setSecret() med EKSAKT verdien, og ekkoer ALDRI verdien tilbake", async () => {
    const { gateway, setSecretCalls } = fakeGateway();
    const transport = new OwnerControlsTransport(fakeService(), gateway);
    const result = await transport.invoke(
      "set_connector_credential",
      { connector_id: "github", credential_ref: "JARVIS_GITHUB_TOKEN", value: "ghp_real_secret_value" },
      "cred", { identity: identity() }
    );
    expect(setSecretCalls).toEqual([{ ref: "JARVIS_GITHUB_TOKEN", value: "ghp_real_secret_value" }]);
    const data = result.data as unknown as Record<string, unknown>;
    expect(data).toEqual({ connector_id: "github", credential_ref: "JARVIS_GITHUB_TOKEN", configured: true });
    expect(JSON.stringify(result)).not.toContain("ghp_real_secret_value");
  });
});

describe("B: owner_controls.test_connector", () => {
  it("avvist FØR noe kalles når gatewayen ikke er gitt inn", async () => {
    const transport = new OwnerControlsTransport(fakeService());
    await expect(
      transport.invoke("test_connector", { connector_id: "github" }, "cred", { identity: identity() })
    ).rejects.toThrow("owner_controls_gateway_not_configured");
  });

  it("avvist for en ukjent connector_id", async () => {
    const { gateway } = fakeGateway();
    const transport = new OwnerControlsTransport(fakeService(), gateway);
    await expect(
      transport.invoke("test_connector", { connector_id: "does_not_exist" }, "cred", { identity: identity() })
    ).rejects.toThrow("unknown_connector:does_not_exist");
  });

  it("en presence_only-connector (uten live_test, f.eks. 'anthropic' - ModelGateway, ikke ToolGateway, D-242) gir en STRUKTURERT svar - ALDRI en kastet feil, og gateway.execute() kalles ALDRI", async () => {
    const { gateway, executeCalls } = fakeGateway();
    const transport = new OwnerControlsTransport(fakeService(), gateway);
    const result = await transport.invoke("test_connector", { connector_id: "anthropic" }, "cred", { identity: identity() });
    expect(result.data).toEqual({
      connector_id: "anthropic", test_method: "presence_only", tested: false,
      reason: "live_test_not_available_for_connector"
    });
    expect(executeCalls).toEqual([]);
  });

  it("en live-connector (f.eks. 'github') gjør et NØSTET gateway.execute() mot CONNECTOR_REGISTRY sin live_test.tool_id/action, identiteten videreformidlet UENDRET", async () => {
    const { gateway, executeCalls } = fakeGateway({
      execute: async () => ({ ok: true, data: { some: "data" }, output_trust: "untrusted", deduplicated: false })
    });
    const transport = new OwnerControlsTransport(fakeService(), gateway);
    const id = identity();
    const result = await transport.invoke("test_connector", { connector_id: "github" }, "cred", { identity: id });
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]!.identity).toBe(id);
    expect(executeCalls[0]!.tool_id).toBe("github");
    expect(executeCalls[0]!.action).toBe("read_issues");
    expect(result.data).toMatchObject({ connector_id: "github", test_method: "live", tested: true, ok: true });
  });

  it("context.approval videreformidles UENDRET til det nøstede kallet (D-68-mønsteret), ALDRI en fabrikkert godkjenning", async () => {
    const { gateway, executeCalls } = fakeGateway();
    const transport = new OwnerControlsTransport(fakeService(), gateway);
    const approval = { signature: "sig-abc", approver: "person-tobias" };
    await transport.invoke("test_connector", { connector_id: "vercel" }, "cred", { identity: identity(), approval });
    expect(executeCalls[0]!.approval).toBe(approval);
  });

  it("et MISLYKKET nøstet kall (ok:false) rapporteres ærlig med tested:true, ok:false og reason - IKKE en kastet feil", async () => {
    const { gateway } = fakeGateway({
      execute: async () => ({ ok: false, reason: "credential_unavailable" })
    });
    const transport = new OwnerControlsTransport(fakeService(), gateway);
    const result = await transport.invoke("test_connector", { connector_id: "gmail" }, "cred", { identity: identity() });
    expect(result.data).toEqual({
      connector_id: "gmail", test_method: "live", tested: true, ok: false, reason: "credential_unavailable"
    });
  });
});

describe("C: ownerControlsToolDefinitions() - de to nye handlingene er registrert med riktig capability_class", () => {
  it("set_connector_credential er klasse C, SAMME nivå som revoke_credential", () => {
    const tools = ownerControlsToolDefinitions(new OwnerControlsTransport(fakeService()));
    const tool = tools.find((t) => t.action === "set_connector_credential");
    expect(tool).toBeDefined();
    expect(tool!.tool_id).toBe("owner_controls");
    expect(tool!.capability_class).toBe("C");
  });

  it("test_connector er klasse A (ren, nøstet lesing)", () => {
    const tools = ownerControlsToolDefinitions(new OwnerControlsTransport(fakeService()));
    const tool = tools.find((t) => t.action === "test_connector");
    expect(tool).toBeDefined();
    expect(tool!.tool_id).toBe("owner_controls");
    expect(tool!.capability_class).toBe("A");
  });

  it("BEGGE handlingene finnes fortsatt nøyaktig ÉN gang hver, i tillegg til de 8 eksisterende owner_controls-handlingene", () => {
    const tools = ownerControlsToolDefinitions(new OwnerControlsTransport(fakeService()));
    const ownerControlsActions = tools.filter((t) => t.tool_id === "owner_controls").map((t) => t.action);
    expect(new Set(ownerControlsActions).size).toBe(ownerControlsActions.length);
    expect(ownerControlsActions).toEqual(
      expect.arrayContaining(["set_connector_credential", "test_connector"])
    );
    expect(ownerControlsActions).toHaveLength(10);
  });
});
