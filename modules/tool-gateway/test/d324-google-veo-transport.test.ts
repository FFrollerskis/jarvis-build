import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleVeoTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-324. Google Veo kjøres over den SAMME Gemini API-vert/auth-form
 * (`generativelanguage.googleapis.com`, `x-goog-api-key`-header) som
 * `gemini` sin EKSISTERENDE model_provider-oppføring
 * (`packages/provider-adapters/src/gemini.ts`) - `predictLongRunning` er
 * likevel en STRUKTURELT ULIK kapabilitet (videogenerering, ikke
 * tekst-fullføring), derfor en egen `tool_id` her, SAMME presedens som
 * OpenAI Images (D-316). API-formen er sekundærkilde-krysssjekket via
 * `WebSearch` denne økten (flere uavhengige kilder), IKKE denne-økten
 * primærkilde-verifisert.
 */
describe("A: GoogleVeoTransport.invoke('list_models', ...) - GET /v1beta/models, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /v1beta/models med x-goog-api-key-header og returnerer models-feltet", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ models: [{ name: "models/veo-3.1-generate-preview" }] }) } as unknown as Response;
    });
    const transport = new GoogleVeoTransport();
    const result = await transport.invoke("list_models", {}, "api-key-xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(calls[0]!.init?.headers).toMatchObject({ "x-goog-api-key": "api-key-xyz" });
    expect(result.data).toEqual([{ name: "models/veo-3.1-generate-preview" }]);
  });

  it("manglende models-felt i svaret -> data er null", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new GoogleVeoTransport();
    const result = await transport.invoke("list_models", {}, "api-key");
    expect(result.data).toBeNull();
  });

  it("en HTTP-feil kaster 'google_veo_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new GoogleVeoTransport();
    await expect(transport.invoke("list_models", {}, "bad-key")).rejects.toThrow("google_veo_error_401");
  });
});

describe("B: GoogleVeoTransport.invoke('generate_video', ...) - POST /v1beta/models/{model}:predictLongRunning, ekte kostnad per kall", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer til /v1beta/models/veo-3.1-generate-preview:predictLongRunning med instances/prompt-kropp (default-modell)", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ name: "operations/abc123" }) } as unknown as Response;
    });
    const transport = new GoogleVeoTransport();
    const result = await transport.invoke("generate_video", { prompt: "en katt som hopper" }, "api-key-xyz");
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({ "x-goog-api-key": "api-key-xyz", "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ instances: [{ prompt: "en katt som hopper" }], parameters: undefined });
    expect(result.external_id).toBe("operations/abc123");
  });

  it("respekterer explicit model/aspect_ratio i stedet for default", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ name: "operations/xyz" }) } as unknown as Response;
    });
    const transport = new GoogleVeoTransport();
    await transport.invoke("generate_video", { prompt: "en solnedgang", model: "veo-3.0-generate-preview", aspect_ratio: "9:16" }, "tok");
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/veo-3.0-generate-preview:predictLongRunning");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ instances: [{ prompt: "en solnedgang" }], parameters: { aspectRatio: "9:16" } });
  });

  it("manglende name i svaret -> external_id defaulter til 'queued'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new GoogleVeoTransport();
    const result = await transport.invoke("generate_video", { prompt: "en katt" }, "tok");
    expect(result.external_id).toBe("queued");
  });

  it("en HTTP-feil kaster 'google_veo_error_<status>' UTEN å late som generering skjedde", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 429 }) as unknown as Response);
    const transport = new GoogleVeoTransport();
    await expect(transport.invoke("generate_video", { prompt: "en katt" }, "tok")).rejects.toThrow("google_veo_error_429");
  });
});

describe("C: GoogleVeoTransport.invoke('get_task_status', ...) - GET /v1beta/{operation_name}, INGEN sideeffekt, PÅKREVD for polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /v1beta/<operation_name> og returnerer hele svaret som data", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ name: "operations/abc123", done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://example.com/v.mp4" } }] } } }) } as unknown as Response;
    });
    const transport = new GoogleVeoTransport();
    const result = await transport.invoke("get_task_status", { operation_name: "operations/abc123" }, "tok");
    expect(calls[0]).toBe("https://generativelanguage.googleapis.com/v1beta/operations/abc123");
    expect(result.data).toMatchObject({ name: "operations/abc123", done: true });
  });
});

describe("D: en ukjent handling kaster 'google_veo_unsupported_action_<action>'", () => {
  it("invoke('cancel_operation', ...) kaster (ikke bygget denne sliceen)", async () => {
    await expect(new GoogleVeoTransport().invoke("cancel_operation", {}, "tok")).rejects.toThrow("google_veo_unsupported_action_cancel_operation");
  });
});

describe("E: firstWaveTools() registrerer alle tre google_veo.*-handlinger med korrekt risikoklasse", () => {
  it("google_veo.list_models er klasse A (lesing, gratis, live_test)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "google_veo" && t.action === "list_models");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
    expect(tool!.credential_ref).toBe("JARVIS_GOOGLE_VEO_API_KEY");
  });

  it("google_veo.generate_video er klasse B (ekte kostnad per kall, ALDRI live_test)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "google_veo" && t.action === "generate_video");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("B");
    expect(tool!.idempotent_external).toBe(false);
  });

  it("google_veo.get_task_status er klasse A (lesing, PÅKREVD polling for asynkron generering)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "google_veo" && t.action === "get_task_status");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
  });
});
