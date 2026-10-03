import { afterEach, describe, expect, it, vi } from "vitest";
import { KlingTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-323. Kling sitt REST-API (`api.klingai.com`) er STRUKTURELT ANNERLEDES
 * enn ALLE andre connectorer i registeret: autentisering er en selv-
 * generert, kortlevd JWT (HS256) signert med et Access Key/Secret Key-par,
 * IKKE en statisk Bearer-token videresendt uendret. API-formen er
 * sekundærkilde-krysssjekket via `WebSearch` denne økten (flere
 * uavhengige kilder), IKKE denne-økten primærkilde-verifisert - se
 * `KlingTransport` sin doc-kommentar i `live-transports.ts`.
 */
describe("A: KlingTransport signerer en JWT (HS256) fra access_key + secret_key i stedet for å videresende en statisk token", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
    const [headerB64, payloadB64] = token.split(".");
    return {
      header: JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"))
    };
  }

  it("Authorization-headeren er 'Bearer <jwt>' med HS256-header og iss=access_key i payload", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: { task_id: "task-abc123" } }) } as unknown as Response;
    });
    const transport = new KlingTransport(() => Promise.resolve("ak-my-access-key"));
    await transport.invoke("generate_video", { image_url: "https://example.com/img.png" }, "sk-my-secret-key");
    expect(calls).toHaveLength(1);
    const authHeader = (calls[0]!.init?.headers as Record<string, string>)["authorization"]!;
    expect(authHeader.startsWith("Bearer ")).toBe(true);
    const { header, payload } = decodeJwt(authHeader.slice("Bearer ".length));
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload["iss"]).toBe("ak-my-access-key");
    expect(typeof payload["exp"]).toBe("number");
    expect(typeof payload["nbf"]).toBe("number");
    expect((payload["exp"] as number) - (payload["nbf"] as number)).toBeGreaterThan(1700);
  });

  it("signaturen endres når secret_key endres (ekte HMAC, ikke en fast streng)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ data: { task_id: "t" } }) }) as unknown as Response);
    const transport = new KlingTransport(() => Promise.resolve("ak-fixed"));
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>)["authorization"]!);
      return { ok: true, json: async () => ({ data: { task_id: "t" } }) } as unknown as Response;
    });
    await transport.invoke("generate_video", { image_url: "https://example.com/a.png" }, "secret-one");
    await transport.invoke("generate_video", { image_url: "https://example.com/a.png" }, "secret-two");
    expect(calls[0]).not.toBe(calls[1]);
    void realFetch;
  });

  it("mangler access_key -> kaster 'kling_access_key_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new KlingTransport(() => Promise.resolve(null));
    await expect(transport.invoke("generate_video", { image_url: "https://example.com/a.png" }, "sk-secret")).rejects.toThrow("kling_access_key_not_configured");
    expect(calls).toHaveLength(0);
  });
});

describe("B: KlingTransport.invoke('generate_video', ...) - POST /v1/videos/image2video, ekte kostnad per kall", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer til /v1/videos/image2video med JSON-kropp (image_url + valgfrie felter)", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: { task_id: "task-abc123" } }) } as unknown as Response;
    });
    const transport = new KlingTransport(() => Promise.resolve("ak-key"));
    const result = await transport.invoke(
      "generate_video",
      { image_url: "https://example.com/img.png", prompt: "en katt som hopper", duration: "5", aspect_ratio: "16:9" },
      "sk-key"
    );
    expect(calls[0]!.url).toBe("https://api.klingai.com/v1/videos/image2video");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      image_url: "https://example.com/img.png",
      prompt: "en katt som hopper",
      duration: "5",
      aspect_ratio: "16:9"
    });
    expect(result.external_id).toBe("task-abc123");
  });

  it("manglende data.task_id i svaret -> external_id defaulter til 'queued'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new KlingTransport(() => Promise.resolve("ak-key"));
    const result = await transport.invoke("generate_video", { image_url: "https://example.com/img.png" }, "sk-key");
    expect(result.external_id).toBe("queued");
  });

  it("en HTTP-feil kaster 'kling_error_<status>' UTEN å late som generering skjedde", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new KlingTransport(() => Promise.resolve("ak-key"));
    await expect(transport.invoke("generate_video", { image_url: "https://example.com/img.png" }, "sk-key")).rejects.toThrow("kling_error_401");
  });
});

describe("C: KlingTransport.invoke('get_task_status', ...) - GET /v1/videos/image2video/{task_id}, INGEN sideeffekt, PÅKREVD for polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /v1/videos/image2video/<task_id> og returnerer data-feltet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ data: { task_id: "task-abc123", task_status: "succeed" } }) } as unknown as Response;
    });
    const transport = new KlingTransport(() => Promise.resolve("ak-key"));
    const result = await transport.invoke("get_task_status", { task_id: "task-abc123" }, "sk-key");
    expect(calls[0]).toBe("https://api.klingai.com/v1/videos/image2video/task-abc123");
    expect(result.data).toEqual({ task_id: "task-abc123", task_status: "succeed" });
  });

  it("manglende data-felt i svaret -> data er null", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new KlingTransport(() => Promise.resolve("ak-key"));
    const result = await transport.invoke("get_task_status", { task_id: "task-abc123" }, "sk-key");
    expect(result.data).toBeNull();
  });
});

describe("D: en ukjent handling kaster 'kling_unsupported_action_<action>'", () => {
  it("invoke('get_account_info', ...) kaster (INGEN verifisert gratis/parameterløst kontoendepunkt funnet - D-41 DEFERRED)", async () => {
    await expect(new KlingTransport(() => Promise.resolve("ak-key")).invoke("get_account_info", {}, "sk-key")).rejects.toThrow("kling_unsupported_action_get_account_info");
  });
});

describe("E: firstWaveTools() registrerer begge kling.*-handlinger med korrekt risikoklasse", () => {
  it("kling.generate_video er klasse C (ekte kostnad per kall, ALDRI live_test)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "kling" && t.action === "generate_video");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("C");
    expect(tool!.idempotent_external).toBe(false);
    expect(tool!.credential_ref).toBe("JARVIS_KLING_SECRET_KEY");
  });

  it("kling.get_task_status er klasse A (lesing, PÅKREVD polling for asynkron generering)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "kling" && t.action === "get_task_status");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
  });

  it("INGEN kling.get_account_info er registrert - D-41 BEVISST DEFERRED, ikke stille utelatt", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "kling" && t.action === "get_account_info");
    expect(tool).toBeUndefined();
  });
});
