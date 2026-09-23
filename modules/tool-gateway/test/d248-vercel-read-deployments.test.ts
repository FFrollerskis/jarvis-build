import { afterEach, describe, expect, it, vi } from "vitest";
import { VercelTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-248: `VercelTransport` fantes ALDRI - `transport("vercel")` (se
 * integrations.ts) falt derfor alltid tilbake til
 * `UnconfiguredHttpTransport("vercel")`, som ubetinget kaster
 * `vercel_not_configured` uansett credential-tilstand. Denne suiten beviser
 * at den ekte transporten faktisk kaller Vercel sin offisielle REST API v6
 * "List deployments" og normaliserer svaret.
 */
describe("A: VercelTransport.invoke('read_deployments', ...) - Vercel REST API v6 List Deployments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET https://api.vercel.com/v6/deployments med Bearer-token og normaliserer deployments[]", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          deployments: [
            { uid: "dpl_1", name: "jarvis", url: "jarvis-abc.vercel.app", readyState: "READY", created: 1_726_000_000_000 }
          ]
        })
      } as unknown as Response;
    });
    const transport = new VercelTransport();
    const result = await transport.invoke("read_deployments", {}, "test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.vercel.com/v6/deployments?limit=20");
    expect((calls[0]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer test-token");
    expect(result.data).toEqual({
      deployments: [
        { id: "dpl_1", name: "jarvis", url: "jarvis-abc.vercel.app", state: "READY", created_at: new Date(1_726_000_000_000).toISOString() }
      ]
    });
  });

  it("en tom deployments-liste gir en tom normalisert liste, ikke en feil", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new VercelTransport();
    const result = await transport.invoke("read_deployments", {}, "tok");
    expect(result.data).toEqual({ deployments: [] });
  });

  it("en HTTP-feil kaster 'vercel_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new VercelTransport();
    await expect(transport.invoke("read_deployments", {}, "bad-token")).rejects.toThrow("vercel_error_401");
  });

  it("en ukjent action kaster 'vercel_unsupported_action_<action>' - INGEN implisitt fallback", async () => {
    const transport = new VercelTransport();
    await expect(transport.invoke("delete_deployment", {}, "tok")).rejects.toThrow("vercel_unsupported_action_delete_deployment");
  });
});

describe("B: firstWaveTools() registrerer vercel.read_deployments som klasse A", () => {
  it("tool_id='vercel', action='read_deployments', capability_class='A', credential_ref='JARVIS_VERCEL_TOKEN'", () => {
    const tools = firstWaveTools();
    const tool = tools.find((t) => t.tool_id === "vercel" && t.action === "read_deployments");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
    expect(tool!.credential_ref).toBe("JARVIS_VERCEL_TOKEN");
  });
});
