import { afterEach, describe, expect, it, vi } from "vitest";
import { MakeTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-315. Make (tidligere Integromat) sitt API v2 - `Authorization: Token
 * <token>` (IKKE `Bearer`) mot en zone-spesifikk base-URL, resolver-closure,
 * SAMME mønster som n8n (D-311).
 */
describe("A: MakeTransport.invoke('get_current_user', ...) - GET /api/v2/users/me, ren lesing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med Token-header mot den konfigurerte base-URL-en", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: 1, name: "Jarvis" }) } as unknown as Response;
    });
    const transport = new MakeTransport(async () => "https://eu1.make.com");
    const result = await transport.invoke("get_current_user", {}, "test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://eu1.make.com/api/v2/users/me");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Token test-token" });
    expect(result.data).toEqual({ id: 1, name: "Jarvis" });
  });

  it("strippes trailing slash fra base-URL-en", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new MakeTransport(async () => "https://eu1.make.com/");
    await transport.invoke("get_current_user", {}, "token");
    expect(calls[0]).toBe("https://eu1.make.com/api/v2/users/me");
  });

  it("manglende base-URL kaster 'make_base_url_not_configured' - IKKE et fetch-kall gjøres", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new MakeTransport(async () => null);
    await expect(transport.invoke("get_current_user", {}, "token")).rejects.toThrow("make_base_url_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("en HTTP-feil kaster 'make_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new MakeTransport(async () => "https://eu1.make.com");
    await expect(transport.invoke("get_current_user", {}, "bad-token")).rejects.toThrow("make_error_401");
  });
});

describe("B: MakeTransport.invoke('run_scenario', ...) - POST /api/v2/scenarios/{id}/run, D-41 ekte skrivehandling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller mot riktig id-spesifikk run-adresse", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ executionId: "exec-1" }) } as unknown as Response;
    });
    const transport = new MakeTransport(async () => "https://eu1.make.com");
    const result = await transport.invoke("run_scenario", { scenario_id: "123" }, "test-token");
    expect(calls[0]!.url).toBe("https://eu1.make.com/api/v2/scenarios/123/run");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(result.data).toEqual({ executionId: "exec-1" });
  });
});

describe("C: en ukjent handling kaster 'make_unsupported_action_<action>'", () => {
  it("invoke('delete_scenario', ...) kaster (ikke registrert)", async () => {
    const transport = new MakeTransport(async () => "https://eu1.make.com");
    await expect(transport.invoke("delete_scenario", {}, "token")).rejects.toThrow("make_unsupported_action_delete_scenario");
  });
});

describe("D: firstWaveTools() registrerer make.get_current_user som klasse A og make.run_scenario som klasse B", () => {
  it("get_current_user er klasse A (ren lesing), run_scenario er klasse B (ekte skrivehandling, D-41)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "make");
    expect(tools.map((t) => t.action).sort()).toEqual(["get_current_user", "run_scenario"]);
    const currentUser = tools.find((t) => t.action === "get_current_user")!;
    expect(currentUser.capability_class).toBe("A");
    expect(currentUser.credential_ref).toBe("JARVIS_MAKE_API_KEY");
    expect(currentUser.output_trust).toBe("untrusted");
    expect(currentUser.idempotent_external).toBe(true);
    const runScenario = tools.find((t) => t.action === "run_scenario")!;
    expect(runScenario.capability_class).toBe("B");
    expect(runScenario.credential_ref).toBe("JARVIS_MAKE_API_KEY");
    expect(runScenario.reversible).toBe(true);
  });
});
