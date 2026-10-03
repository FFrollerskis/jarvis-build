import { afterEach, describe, expect, it, vi } from "vitest";
import { RunwayTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-322. Runway sitt REST-API v1 (`api.dev.runwayml.com`) - `Authorization:
 * Bearer <api_key>` PLUSS en PÅKREVD `X-Runway-Version: 2024-11-06`-header
 * (strukturelt ulik Telnyx/Twilio som kun krever Bearer/Basic). API-formen
 * er sekundærkilde-krysssjekket via `WebSearch` denne økten, IKKE
 * primærkilde-verifisert (WebFetch mot `dev.runwayml.com` er fortsatt
 * egress-blokkert) - se `RunwayTransport` sin doc-kommentar i
 * `live-transports.ts` for full evidens-kategorisering.
 */
describe("A: RunwayTransport.invoke('get_account_info', ...) - GET /v1/organization, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /v1/organization med Bearer- og X-Runway-Version-header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ creditBalance: 500, tier: "pro" }) } as unknown as Response;
    });
    const transport = new RunwayTransport();
    const result = await transport.invoke("get_account_info", {}, "api-key-xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.dev.runwayml.com/v1/organization");
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: "Bearer api-key-xyz",
      "X-Runway-Version": "2024-11-06"
    });
    expect(result.data).toEqual({ creditBalance: 500, tier: "pro" });
  });

  it("en HTTP-feil kaster 'runway_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new RunwayTransport();
    await expect(transport.invoke("get_account_info", {}, "bad-key")).rejects.toThrow("runway_error_401");
  });
});

describe("B: RunwayTransport.invoke('generate_video', ...) - POST /v1/image_to_video, ekte kostnad per kall", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer til /v1/image_to_video med Bearer+X-Runway-Version-header og full JSON-kropp (defaults)", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "task-abc123" }) } as unknown as Response;
    });
    const transport = new RunwayTransport();
    const result = await transport.invoke("generate_video", { promptImage: "https://example.com/img.png" }, "api-key-xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.dev.runwayml.com/v1/image_to_video");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: "Bearer api-key-xyz",
      "X-Runway-Version": "2024-11-06",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      model: "gen4.5",
      promptImage: "https://example.com/img.png",
      promptText: undefined,
      ratio: "1280:720",
      duration: 5
    });
    expect(result.external_id).toBe("task-abc123");
  });

  it("respekterer explicit model/promptText/ratio/duration i stedet for defaults", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ id: "task-xyz" }) } as unknown as Response;
    });
    const transport = new RunwayTransport();
    await transport.invoke(
      "generate_video",
      { promptImage: "https://example.com/a.png", promptText: "en katt som hopper", model: "gen3a_turbo", ratio: "720:1280", duration: 10 },
      "tok"
    );
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      model: "gen3a_turbo",
      promptImage: "https://example.com/a.png",
      promptText: "en katt som hopper",
      ratio: "720:1280",
      duration: 10
    });
  });

  it("manglende id i svaret -> external_id defaulter til 'queued'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new RunwayTransport();
    const result = await transport.invoke("generate_video", { promptImage: "https://example.com/img.png" }, "tok");
    expect(result.external_id).toBe("queued");
  });

  it("en HTTP-feil kaster 'runway_error_<status>' UTEN å late som generering skjedde", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 429 }) as unknown as Response);
    const transport = new RunwayTransport();
    await expect(transport.invoke("generate_video", { promptImage: "https://example.com/img.png" }, "tok")).rejects.toThrow("runway_error_429");
  });
});

describe("C: RunwayTransport.invoke('get_task_status', ...) - GET /v1/tasks/{id}, INGEN sideeffekt, PÅKREVD for polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /v1/tasks/<task_id> og returnerer hele svaret som data", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ id: "task-abc123", status: "SUCCEEDED", output: ["https://cdn.example.com/v.mp4"] }) } as unknown as Response;
    });
    const transport = new RunwayTransport();
    const result = await transport.invoke("get_task_status", { task_id: "task-abc123" }, "tok");
    expect(calls[0]).toBe("https://api.dev.runwayml.com/v1/tasks/task-abc123");
    expect(result.data).toEqual({ id: "task-abc123", status: "SUCCEEDED", output: ["https://cdn.example.com/v.mp4"] });
  });
});

describe("D: en ukjent handling kaster 'runway_unsupported_action_<action>'", () => {
  it("invoke('cancel_task', ...) kaster (ikke bygget denne sliceen)", async () => {
    await expect(new RunwayTransport().invoke("cancel_task", {}, "tok")).rejects.toThrow("runway_unsupported_action_cancel_task");
  });
});

describe("E: firstWaveTools() registrerer alle tre runway.*-handlinger med korrekt risikoklasse", () => {
  it("runway.get_account_info er klasse A (lesing, gratis, live_test)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "runway" && t.action === "get_account_info");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
    expect(tool!.credential_ref).toBe("JARVIS_RUNWAY_API_KEY");
  });

  it("runway.generate_video er klasse C (ekte kostnad per kall, ALDRI live_test)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "runway" && t.action === "generate_video");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("C");
    expect(tool!.idempotent_external).toBe(false);
  });

  it("runway.get_task_status er klasse A (lesing, PÅKREVD polling for asynkron generering)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "runway" && t.action === "get_task_status");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
  });
});
