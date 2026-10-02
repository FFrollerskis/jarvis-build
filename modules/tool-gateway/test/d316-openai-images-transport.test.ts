import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIImagesTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-316. OpenAI Images API - egen `tool_id` fra `openai` sin
 * model_provider-oppføring (ModelGateway), strukturelt ulik kapabilitet
 * (bildegenerering, ikke tekst-fullføring). `list_models` er gratis/
 * sideeffekt-fritt (brukes som `live_test`) - `generate_image` har EKTE
 * kostnad per kall.
 */
describe("A: OpenAIImagesTransport.invoke('list_models', ...) - GET /v1/models, gratis/ren lesing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med Bearer-header mot models-endepunktet", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: [{ id: "dall-e-3" }] }) } as unknown as Response;
    });
    const transport = new OpenAIImagesTransport();
    const result = await transport.invoke("list_models", {}, "test-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(result.data).toEqual([{ id: "dall-e-3" }]);
  });

  it("en HTTP-feil kaster 'openai_images_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new OpenAIImagesTransport();
    await expect(transport.invoke("list_models", {}, "bad-key")).rejects.toThrow("openai_images_error_401");
  });
});

describe("B: OpenAIImagesTransport.invoke('generate_image', ...) - POST /v1/images/generations, D-41 ekte skrivehandling med reell kostnad", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sender prompt/n/size med fornuftige standardverdier", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: [{ url: "https://example.com/img.png" }] }) } as unknown as Response;
    });
    const transport = new OpenAIImagesTransport();
    const result = await transport.invoke("generate_image", { prompt: "a cat" }, "test-key");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ prompt: "a cat", n: 1, size: "1024x1024" });
    expect(result.data).toEqual([{ url: "https://example.com/img.png" }]);
  });

  it("respekterer eksplisitt n/size-parametre", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response;
    });
    const transport = new OpenAIImagesTransport();
    await transport.invoke("generate_image", { prompt: "a dog", n: 3, size: "512x512" }, "test-key");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ prompt: "a dog", n: 3, size: "512x512" });
  });
});

describe("C: en ukjent handling kaster 'openai_images_unsupported_action_<action>'", () => {
  it("invoke('edit_image', ...) kaster (ikke registrert)", async () => {
    const transport = new OpenAIImagesTransport();
    await expect(transport.invoke("edit_image", {}, "test-key")).rejects.toThrow("openai_images_unsupported_action_edit_image");
  });
});

describe("D: firstWaveTools() registrerer openai_images.list_models som klasse A og openai_images.generate_image som klasse B", () => {
  it("list_models er klasse A (gratis lesing), generate_image er klasse B (ekte skrivehandling med reell kostnad, D-41)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "openai_images");
    expect(tools.map((t) => t.action).sort()).toEqual(["generate_image", "list_models"]);
    const listModels = tools.find((t) => t.action === "list_models")!;
    expect(listModels.capability_class).toBe("A");
    expect(listModels.credential_ref).toBe("JARVIS_OPENAI_IMAGES_API_KEY");
    expect(listModels.output_trust).toBe("untrusted");
    expect(listModels.idempotent_external).toBe(true);
    const generateImage = tools.find((t) => t.action === "generate_image")!;
    expect(generateImage.capability_class).toBe("C");
    expect(generateImage.credential_ref).toBe("JARVIS_OPENAI_IMAGES_API_KEY");
    expect(generateImage.idempotent_external).toBe(false);
  });
});
