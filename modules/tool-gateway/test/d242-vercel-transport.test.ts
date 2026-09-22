import { afterEach, describe, expect, it, vi } from "vitest";
import { VercelTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-242 (Tobias direkte chat-instruks: "du skal bygge det for absolutt alle
 * som tester en gang om dagen"): `vercel` sin `live_test` (`connector-
 * registry.ts`) eksisterte siden D-213, men `main.ts`/`worker-main.ts`
 * ga ALDRI en ekte transport inn i `firstWaveTools({...})` - kallet falt
 * derfor ALLTID gjennom til `UnconfiguredHttpTransport` (`vercel_not_configured`)
 * uansett om `JARVIS_VERCEL_TOKEN` var gyldig. Dette er den fikserte,
 * FAKTISK fungerende transporten - `GET /v6/deployments` (Vercel sin
 * offisielle REST-API, verifisert mot dokumentasjon/websøk).
 */
describe("A: VercelTransport.invoke('read_deployments', ...) - GET /v6/deployments, ingen sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller https://api.vercel.com/v6/deployments?limit=5 med Authorization: Bearer <token>", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ deployments: [{ uid: "dpl_1", name: "jarvis", url: "jarvis.vercel.app", state: "READY", created: 1_700_000_000_000 }] })
      } as unknown as Response;
    });
    const transport = new VercelTransport();
    const result = await transport.invoke("read_deployments", {}, "test-vercel-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.vercel.com/v6/deployments?limit=5");
    expect(calls[0]!.init).toEqual({ headers: { authorization: "Bearer test-vercel-token" } });
    expect(result.data).toEqual({
      deployments: [{ id: "dpl_1", name: "jarvis", url: "jarvis.vercel.app", state: "READY", created_at: new Date(1_700_000_000_000).toISOString() }]
    });
  });

  it("en tom deployments-liste gir en tom array, ikke en kastet feil", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new VercelTransport();
    const result = await transport.invoke("read_deployments", {}, "tok");
    expect(result.data).toEqual({ deployments: [] });
  });

  it("en HTTP-feil kaster 'vercel_error_<status>' (SAMME feilform som github/telegram)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new VercelTransport();
    await expect(transport.invoke("read_deployments", {}, "bad-token")).rejects.toThrow("vercel_error_401");
  });

  it("en ukjent handling kaster 'vercel_unsupported_action_<action>' - ingen stille no-op", async () => {
    const transport = new VercelTransport();
    await expect(transport.invoke("deploy", {}, "tok")).rejects.toThrow("vercel_unsupported_action_deploy");
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
