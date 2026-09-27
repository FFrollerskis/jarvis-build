import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsTts } from "../src/tts.ts";

/**
 * D-319. `ElevenLabsTts` - NY `TtsAdapter`-implementasjon (ikke en
 * `ToolGateway`-connector, se klassekommentaren i `tts.ts` for full D-64-stil
 * begrunnelse). `processor.processor_terms_status` er BEVISST `"NOT_VERIFIED"`
 * - denne suiten beviser koden fungerer strukturelt korrekt, IKKE at
 * behandleren er kvalifisert for produksjonsbruk (den porten er
 * `evaluateSpeechRouting()`, testet separat i `ua7-speech-routing.test.ts`).
 */

async function collect(iter: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of iter) {
    out.push(chunk);
  }
  return out;
}

function fakeReadableBody(chunks: Buffer[]): { getReader: () => ReturnType<typeof fakeReader> } {
  return { getReader: () => fakeReader(chunks) };
}

function fakeReader(chunks: Buffer[]) {
  let i = 0;
  let cancelled = false;
  return {
    async read() {
      if (cancelled || i >= chunks.length) {
        return { done: true, value: undefined };
      }
      const value = chunks[i++]!;
      return { done: false, value: new Uint8Array(value) };
    },
    async cancel() {
      cancelled = true;
    }
  };
}

describe("A: available() krever BÅDE API-nøkkel OG voice_id (voice_id er påkrevd i selve URL-stien)", () => {
  it("false uten noen av delene", () => {
    expect(new ElevenLabsTts(undefined, undefined).available()).toBe(false);
  });
  it("false med kun nøkkel, ingen voice_id", () => {
    expect(new ElevenLabsTts("key", undefined).available()).toBe(false);
  });
  it("false med kun voice_id, ingen nøkkel", () => {
    expect(new ElevenLabsTts(undefined, "voice-1").available()).toBe(false);
  });
  it("true med begge deler", () => {
    expect(new ElevenLabsTts("key", "voice-1").available()).toBe(true);
  });
});

describe("B: synthesize() - POST mot voice_id-stien med xi-api-key-header og pcm_16000-output-format", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bygger korrekt URL/headers/body og strømmer rå PCM-rammer fra responsen", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, body: fakeReadableBody([Buffer.from([1, 2]), Buffer.from([3, 4])]) } as unknown as Response;
    });
    const tts = new ElevenLabsTts("test-key", "voice-1");
    const playback = tts.synthesize("hallo");
    const frames = await collect(playback.frames);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_16000");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({ "xi-api-key": "test-key", "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: "hallo", model_id: "eleven_multilingual_v2" });
    expect(Buffer.concat(frames)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("respekterer en eksplisitt model_id", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, body: fakeReadableBody([]) } as unknown as Response;
    });
    const tts = new ElevenLabsTts("test-key", "voice-1", "eleven_turbo_v2");
    await collect(tts.synthesize("hallo").frames);
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ model_id: "eleven_turbo_v2" });
  });

  it("en HTTP-feil kaster 'elevenlabs_tts_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401, body: null }) as unknown as Response);
    const tts = new ElevenLabsTts("test-key", "voice-1");
    await expect(collect(tts.synthesize("hallo").frames)).rejects.toThrow("elevenlabs_tts_error_401");
  });

  it("manglende body på en ellers OK-respons kaster (ingen stille tom avspilling)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, body: null }) as unknown as Response);
    const tts = new ElevenLabsTts("test-key", "voice-1");
    await expect(collect(tts.synthesize("hallo").frames)).rejects.toThrow("elevenlabs_tts_error_undefined");
  });

  it("synthesize() kaster synkront uten konfigurasjon, ingen fetch gjøres", () => {
    const tts = new ElevenLabsTts(undefined, undefined);
    expect(() => tts.synthesize("hallo")).toThrow("elevenlabs_tts_not_configured");
  });

  it("cancel() stopper strømmen og kaller reader.cancel() - ingen flere rammer etter kansellering", async () => {
    let cancelCalled = false;
    const reader = {
      async read() {
        return { done: false, value: new Uint8Array([9, 9]) };
      },
      async cancel() {
        cancelCalled = true;
      }
    };
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: true, body: { getReader: () => reader } }) as unknown as Response
    );
    const tts = new ElevenLabsTts("test-key", "voice-1");
    const playback = tts.synthesize("hallo");
    playback.cancel();
    const frames = await collect(playback.frames);
    expect(frames).toEqual([]);
    expect(cancelCalled).toBe(true);
  });
});

describe("C: processor - EKSTERN, NOT_VERIFIED (D-319/Q-32, fail-closed - ALDRI VERIFIED uten en ekte Tobias-gjennomgang)", () => {
  it("locality=external, processor_row_declared=true, processor_terms_status=NOT_VERIFIED", () => {
    const tts = new ElevenLabsTts("key", "voice-1");
    expect(tts.processor).toEqual({
      processor_id: "elevenlabs-text-to-speech",
      locality: "external",
      processor_row_declared: true,
      processor_terms_status: "NOT_VERIFIED"
    });
  });
});
