import { afterEach, describe, expect, it, vi } from "vitest";
import { HiggsfieldTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-327. Higgsfield sitt REST-API (`api.higgsfield.ai`) er en MULTI-
 * MODELL-markedsplass (proxyer tredjeparts videogenereringsmodeller under
 * vertsnavnet, f.eks. `bytedance/seedance-2.0`) - `model_path` er derfor
 * et PÅKREVD parameter fra kalleren, INGEN hardkodet default-modell (ville
 * vært et ubedt, nestet leverandørvalg). Autentisering er ETT
 * Authorization-header-felt med Key ID og Key Secret kolon-sammensatt i
 * klartekst - IKKE en kryptografisk signeringsoperasjon som Kling (D-323).
 * API-formen er sekundærkilde-krysssjekket via `WebSearch` denne økten.
 */
describe("A: HiggsfieldTransport.invoke('generate_video', ...) - POST /{model_path}/text-to-video, ekte kostnad per kall", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer til /<model_path>/text-to-video med 'Key <key_id>:<key_secret>'-header og {prompt}-kropp", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ request_id: "req-abc123" }) } as unknown as Response;
    });
    const transport = new HiggsfieldTransport(() => Promise.resolve("hf-key-id"));
    const result = await transport.invoke(
      "generate_video",
      { model_path: "bytedance/seedance-2.0", prompt: "en katt som hopper" },
      "hf-key-secret"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.higgsfield.ai/bytedance/seedance-2.0/text-to-video");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: "Key hf-key-id:hf-key-secret",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ prompt: "en katt som hopper" });
    expect(result.external_id).toBe("req-abc123");
  });

  it("bruker den EKSAKTE model_path kalleren oppgir, uansett verdi - INGEN hardkodet default-modell", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ request_id: "r" }) } as unknown as Response; });
    const transport = new HiggsfieldTransport(() => Promise.resolve("id"));
    await transport.invoke("generate_video", { model_path: "higgsfield/soul-cinema", prompt: "p" }, "secret");
    expect(calls[0]).toBe("https://api.higgsfield.ai/higgsfield/soul-cinema/text-to-video");
  });

  it("mangler key_id -> kaster 'higgsfield_key_id_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new HiggsfieldTransport(() => Promise.resolve(null));
    await expect(transport.invoke("generate_video", { model_path: "a/b", prompt: "p" }, "secret")).rejects.toThrow("higgsfield_key_id_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("manglende request_id i svaret -> external_id defaulter til 'queued'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new HiggsfieldTransport(() => Promise.resolve("id"));
    const result = await transport.invoke("generate_video", { model_path: "a/b", prompt: "p" }, "secret");
    expect(result.external_id).toBe("queued");
  });

  it("en HTTP-feil kaster 'higgsfield_error_<status>' UTEN å late som generering skjedde", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new HiggsfieldTransport(() => Promise.resolve("id"));
    await expect(transport.invoke("generate_video", { model_path: "a/b", prompt: "p" }, "bad-secret")).rejects.toThrow("higgsfield_error_401");
  });
});

describe("B: HiggsfieldTransport.invoke('get_task_status', ...) - GET /requests/{request_id}/status, INGEN sideeffekt, PÅKREVD for polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /requests/<request_id>/status og returnerer hele svaret som data", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ status: "completed", request_id: "req-abc123", output: { media_url: ["https://example.com/v.mp4"] } }) } as unknown as Response;
    });
    const transport = new HiggsfieldTransport(() => Promise.resolve("id"));
    const result = await transport.invoke("get_task_status", { request_id: "req-abc123" }, "secret");
    expect(calls[0]).toBe("https://api.higgsfield.ai/requests/req-abc123/status");
    expect(result.data).toMatchObject({ status: "completed", request_id: "req-abc123" });
  });

  it("bruker SAMME 'Key <id>:<secret>'-header-form som generate_video (strukturelt konsistent auth)", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ status: "queued" }) } as unknown as Response;
    });
    const transport = new HiggsfieldTransport(() => Promise.resolve("my-id"));
    await transport.invoke("get_task_status", { request_id: "r" }, "my-secret");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Key my-id:my-secret" });
  });
});

describe("C: en ukjent handling kaster 'higgsfield_unsupported_action_<action>'", () => {
  it("invoke('get_account_info', ...) kaster (INGEN verifisert gratis/parameterløst kontoendepunkt funnet - D-41 DEFERRED)", async () => {
    await expect(new HiggsfieldTransport(() => Promise.resolve("id")).invoke("get_account_info", {}, "secret")).rejects.toThrow("higgsfield_unsupported_action_get_account_info");
  });
});

describe("D: firstWaveTools() registrerer begge higgsfield.*-handlinger med korrekt risikoklasse", () => {
  it("higgsfield.generate_video er klasse B (ekte kostnad per kall, ALDRI live_test)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "higgsfield" && t.action === "generate_video");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("B");
    expect(tool!.idempotent_external).toBe(false);
    expect(tool!.credential_ref).toBe("JARVIS_HIGGSFIELD_KEY_SECRET");
  });

  it("higgsfield.get_task_status er klasse A (lesing, PÅKREVD polling for asynkron generering)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "higgsfield" && t.action === "get_task_status");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
  });

  it("INGEN higgsfield.get_account_info er registrert - D-41 BEVISST DEFERRED, ikke stille utelatt", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "higgsfield" && t.action === "get_account_info");
    expect(tool).toBeUndefined();
  });
});
