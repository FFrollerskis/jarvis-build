import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepgramStt, pcm16ToWav } from "../src/stt.ts";

/**
 * D-320. `DeepgramStt` - NY `SttAdapter`-implementasjon (ikke en
 * `ToolGateway`-connector, se klassekommentaren i `stt.ts` for full D-64-stil
 * begrunnelse). `processor.processor_terms_status` er BEVISST `"NOT_VERIFIED"`
 * - denne suiten beviser koden fungerer strukturelt korrekt, IKKE at
 * behandleren er kvalifisert for produksjonsbruk (den porten er
 * `evaluateSpeechRouting()`, testet separat i `ua7-speech-routing.test.ts`).
 */

describe("A: available() krever KUN API-nøkkelen", () => {
  it("false uten nøkkel", () => {
    expect(new DeepgramStt(undefined).available()).toBe(false);
  });
  it("true med nøkkel", () => {
    expect(new DeepgramStt("key").available()).toBe(true);
  });
});

describe("B: startStream()/end() - POST mot /v1/listen med Token-header og WAV-kropp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bygger korrekt URL/headers/kropp og returnerer transkriptet fra svaret", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ results: { channels: [{ alternatives: [{ transcript: "hallo verden" }] }] } })
      } as unknown as Response;
    });
    const stt = new DeepgramStt("test-key");
    const stream = stt.startStream();
    stream.pushAudio(Buffer.from([1, 2, 3, 4]));
    const text = await stream.end();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepgram.com/v1/listen?language=no");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Token test-key", "content-type": "audio/wav" });
    expect(Buffer.from(calls[0]!.init?.body as Buffer)).toEqual(pcm16ToWav(Buffer.from([1, 2, 3, 4]), 16000));
    expect(text).toBe("hallo verden");
  });

  it("respekterer et eksplisitt språk", async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push({ url });
      return { ok: true, json: async () => ({ results: { channels: [] } }) } as unknown as Response;
    });
    const stt = new DeepgramStt("test-key", "en");
    await stt.startStream().end();
    expect(calls[0]!.url).toBe("https://api.deepgram.com/v1/listen?language=en");
  });

  it("mangler results/channels/alternatives i svaret -> tomt transkript, ingen krasj", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const stt = new DeepgramStt("test-key");
    const text = await stt.startStream().end();
    expect(text).toBe("");
  });

  it("en HTTP-feil kaster 'deepgram_stt_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const stt = new DeepgramStt("test-key");
    await expect(stt.startStream().end()).rejects.toThrow("deepgram_stt_error_401");
  });

  it("startStream() kaster synkront uten konfigurasjon, ingen fetch gjøres", () => {
    const stt = new DeepgramStt(undefined);
    expect(() => stt.startStream()).toThrow("deepgram_stt_not_configured");
  });

  it("onPartial() er en no-op (batch-API, ingen ekte partials)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ results: { channels: [] } }) }) as unknown as Response);
    const stt = new DeepgramStt("test-key");
    const stream = stt.startStream();
    let called = false;
    stream.onPartial(() => (called = true));
    await stream.end();
    expect(called).toBe(false);
  });
});

describe("C: processor - EKSTERN, NOT_VERIFIED (D-320/Q-32, fail-closed - ALDRI VERIFIED uten en ekte Tobias-gjennomgang)", () => {
  it("locality=external, processor_row_declared=true, processor_terms_status=NOT_VERIFIED", () => {
    const stt = new DeepgramStt("key");
    expect(stt.processor).toEqual({
      processor_id: "deepgram-listen",
      locality: "external",
      processor_row_declared: true,
      processor_terms_status: "NOT_VERIFIED"
    });
  });
});
