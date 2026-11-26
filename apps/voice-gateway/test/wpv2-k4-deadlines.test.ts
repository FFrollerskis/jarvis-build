import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceHealth } from "../src/health.ts";
import { ProcessSlots } from "../src/limits.ts";
import { HttpCoreClient } from "../src/server.ts";
import { VoiceSession, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import { DeepgramStt, LocalWhisperStt, MarkerStt, OpenAiStt, type SttAdapter, type SttStream } from "../src/stt.ts";
import { ElevenLabsTts, LocalPiperTts, OpenAiTts, type TtsAdapter, type TtsPlayback } from "../src/tts.ts";
import { LOCAL, ScriptedCore, sleep, trackUncaught } from "./wpv2-harness.ts";

/**
 * WP-V2 K4 (JARVIS-080): ingen leverandørkall uten frist, og cancel() avbryter selve forespørselen. En hengende leverandør skal gi en
 * kode-feil innen fristen - aldri en kjede som står stille for alltid.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const MODEL = `${FIXTURES}/fake-voice.onnx`;
const WHISPER_MODEL = `${FIXTURES}/fake-model.bin`;
const tracker = trackUncaught();

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `fetch` som aldri svarer før signalet aborteres (som en hengende leverandør). Lagrer signalene for inspeksjon. */
function hangingFetch(): { signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      })
    )
  );
  return { signals };
}

/** `fetch` som svarer 200, leverer én ramme, og så henger inne i kroppen til signalet aborteres. */
function stallingBodyFetch(): { signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      let sent = false;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              sent
                ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
                : ((sent = true), Promise.resolve({ done: false, value: new Uint8Array([1, 2, 3, 4]) })),
            cancel: async () => undefined
          })
        }
      } as unknown as Response;
    })
  );
  return { signals };
}

async function collect(iterable: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

describe("TTS over HTTP: frist og ekte avbrudd", () => {
  it.each([
    ["OpenAI", () => new OpenAiTts("k", "m", "v", 120), "openai_tts_timeout"],
    ["ElevenLabs", () => new ElevenLabsTts("k", "voice", "model", 120), "elevenlabs_tts_timeout"]
  ])("%s: hengende forespørsel gir %s innen fristen, og fetch-signalet er aborteret", async (_name, make, code) => {
    const { signals } = hangingFetch();
    const started = Date.now();
    await expect(collect(make().synthesize("hei").frames)).rejects.toThrow(code);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals[0]?.aborted).toBe(true);
  });

  it.each([
    ["OpenAI", () => new OpenAiTts("k", "m", "v", 150), "openai_tts_timeout"],
    ["ElevenLabs", () => new ElevenLabsTts("k", "voice", "model", 150), "elevenlabs_tts_timeout"]
  ])("%s: en strøm som stanser MIDT i kroppen får samme frist (ikke bare til headers)", async (_name, make, code) => {
    stallingBodyFetch();
    const frames: Buffer[] = [];
    await expect(
      (async () => {
        for await (const f of make().synthesize("hei").frames) frames.push(f);
      })()
    ).rejects.toThrow(code);
    expect(frames).toHaveLength(1); // første ramme ble levert før stansen
  });

  it.each([
    ["OpenAI", () => new OpenAiTts("k", "m", "v", 5000)],
    ["ElevenLabs", () => new ElevenLabsTts("k", "voice", "model", 5000)]
  ])("%s: cancel() aborterer SELVE fetch (signal), og frames avsluttes stille uten feil", async (_name, make) => {
    const { signals } = hangingFetch();
    const playback = make().synthesize("hei");
    const done = collect(playback.frames);
    await sleep(30);
    expect(signals[0]?.aborted).toBe(false);
    playback.cancel();
    expect(signals[0]?.aborted).toBe(true);
    await expect(done).resolves.toEqual([]);
  });

  it("cancel() midt i en strøm som henger i read() avbryter også kroppen", async () => {
    const { signals } = stallingBodyFetch();
    const playback = new OpenAiTts("k", "m", "v", 5000).synthesize("hei");
    const frames: Buffer[] = [];
    const done = (async () => {
      for await (const f of playback.frames) frames.push(f);
    })();
    await sleep(50);
    playback.cancel();
    await done; // løser uten feil
    expect(signals[0]?.aborted).toBe(true);
    expect(frames).toHaveLength(1);
  });

  it("HTTP-feil gir fortsatt statuskoden (uendret kontrakt), nettverksfeil gir en kode - aldri leverandørtekst", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, body: null }) as unknown as Response));
    await expect(collect(new OpenAiTts("k").synthesize("x").frames)).rejects.toThrow("openai_tts_error_503");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed: ECONNREFUSED 10.0.0.1:443 secret-url"); }));
    const err: unknown = await collect(new OpenAiTts("k").synthesize("x").frames).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe("openai_tts_network_error");
  });
});

describe("STT over HTTP: frist", () => {
  it.each([
    ["OpenAI", () => new OpenAiStt("k", "whisper-1", 16000, 120), "openai_stt_timeout"],
    ["Deepgram batch", () => new DeepgramStt("k", "no", 16000, 120), "deepgram_stt_timeout"]
  ])("%s: hengende kall gir %s innen fristen", async (_name, make, code) => {
    const { signals } = hangingFetch();
    const stream = make().startStream();
    stream.pushAudio(Buffer.alloc(640));
    const started = Date.now();
    await expect(stream.end()).rejects.toThrow(code);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("kall som lykkes er uendret (OpenAI + Deepgram)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "hei", results: { channels: [{ alternatives: [{ transcript: "hallo" }] }] } }) }) as unknown as Response));
    const a = new OpenAiStt("k").startStream();
    a.pushAudio(Buffer.alloc(640));
    await expect(a.end()).resolves.toBe("hei");
    const b = new DeepgramStt("k").startStream();
    b.pushAudio(Buffer.alloc(640));
    await expect(b.end()).resolves.toBe("hallo");
  });
});

describe("HttpCoreClient: total turfrist (core_timeout) og rent barge-in-avbrudd", () => {
  const identity: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice", grant_token: ["grt", "wpv2", "k4"].join("-") };

  it("chat(): hengende Core gir core_timeout og forespørselen aborteres", async () => {
    const { signals } = hangingFetch();
    const client = new HttpCoreClient("http://core", { turnTimeoutMs: 120 });
    await expect(client.chat(identity, "hei")).rejects.toThrow("core_timeout");
    expect(signals[0]?.aborted).toBe(true);
  });

  it("chatStream(): hengende Core gir core_timeout", async () => {
    const { signals } = hangingFetch();
    const client = new HttpCoreClient("http://core", { turnTimeoutMs: 120 });
    await expect(client.chatStream(identity, "hei", () => undefined)).rejects.toThrow("core_timeout");
    expect(signals[0]?.aborted).toBe(true);
  });

  it("chatStream(): en strøm som stanser etter første event får samme totalfrist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        let sent = false;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: () =>
                sent
                  ? new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true }))
                  : ((sent = true), Promise.resolve({ done: false, value: new TextEncoder().encode('event: token\ndata: {"token":"Hei"}\n\n') })),
              releaseLock: () => undefined
            })
          }
        } as unknown as Response;
      })
    );
    const tokens: string[] = [];
    const client = new HttpCoreClient("http://core", { turnTimeoutMs: 150 });
    await expect(client.chatStream(identity, "hei", (e) => { if (e.type === "token") tokens.push(e.text); })).rejects.toThrow("core_timeout");
    expect(tokens).toEqual(["Hei"]);
  });

  it("barge-in (ekstern signal) er fortsatt AbortError - ikke core_timeout", async () => {
    hangingFetch();
    const controller = new AbortController();
    const client = new HttpCoreClient("http://core", { turnTimeoutMs: 5000 });
    const pending = client.chatStream(identity, "hei", () => undefined, controller.signal).then(() => null, (e: unknown) => e);
    await sleep(30);
    controller.abort();
    const err = (await pending) as Error;
    expect(err.name).toBe("AbortError");
    expect(err.message).not.toBe("core_timeout");
  });

  it("ubevist sti: voice_session_required kastes FØR noe kall (uendret), og ingen frist-timer lekker", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = new HttpCoreClient("http://core", { turnTimeoutMs: 120 });
    const unproven: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice" };
    await expect(client.chat(unproven, "hei")).rejects.toThrow("voice_session_required");
    await expect(client.chatStream(unproven, "hei", () => undefined)).rejects.toThrow("voice_session_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("lokale prosesser: frist og kill", () => {
  it("whisper: en prosess som henger drepes etter timeoutMs (local_whisper_timeout)", async () => {
    const stt = new LocalWhisperStt(`${FIXTURES}/mock-whisper-hang.sh`, WHISPER_MODEL, 16000, "no", 1, undefined, new ProcessSlots(2, 500), 300);
    const stream = stt.startStream();
    stream.pushAudio(Buffer.alloc(3200));
    const started = Date.now();
    await expect(stream.end()).rejects.toThrow("local_whisper_timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("whisper: opptatt semafor (alle plasser tatt) gir voice_busy etter køfristen, uten å starte en prosess", async () => {
    const slots = new ProcessSlots(1, 80);
    const release = await slots.acquire();
    const stt = new LocalWhisperStt(`${FIXTURES}/mock-whisper-ok.sh`, WHISPER_MODEL, 16000, "no", 1, undefined, slots, 5000);
    const stream = stt.startStream();
    stream.pushAudio(Buffer.alloc(640));
    await expect(stream.end()).rejects.toThrow("voice_busy");
    release();
  });

  it("piper: chunk over maksvarighet drepes (local_piper_timeout) etter at første ramme er levert", async () => {
    const tts = new LocalPiperTts(`${FIXTURES}/mock-piper-hang.sh`, MODEL, undefined, new ProcessSlots(2, 500), 300);
    const frames: Buffer[] = [];
    const started = Date.now();
    await expect(
      (async () => {
        for await (const f of tts.synthesize("hei").frames) frames.push(f);
      })()
    ).rejects.toThrow("local_piper_timeout");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(Buffer.concat(frames).toString()).toBe("AAAA");
  });
});

function spyEvents(): SessionEvents & { frames: Buffer[]; errors: string[]; finals: string[] } {
  const frames: Buffer[] = [];
  const errors: string[] = [];
  const finals: string[] = [];
  return {
    frames, errors, finals,
    onState: () => undefined, onPartial: () => undefined, onFinal: (t) => { finals.push(t); }, onReply: () => undefined,
    onTtsFrame: (f) => { frames.push(f); }, onTtsCancelled: () => undefined, onMetrics: () => undefined,
    onError: (e) => { errors.push(e); }
  };
}

const ID: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice" };

describe("sesjon: en hengende chunk/STT blokkerer aldri kjeden", () => {
  it("ttsWorker: første chunk henger for alltid (ignorerer cancel) -> tts_error, og NESTE chunk spilles", async () => {
    let calls = 0;
    const cancels: number[] = [];
    const tts: TtsAdapter = {
      name: "hang-then-ok", processor: LOCAL, sampleRate: 16_000, available: () => true,
      synthesize(): TtsPlayback {
        calls += 1;
        const mine = calls;
        if (mine === 1) {
          return {
            frames: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Buffer>>(() => undefined) }) },
            cancel: () => { cancels.push(mine); }
          };
        }
        async function* ok(): AsyncIterable<Buffer> {
          yield Buffer.alloc(64, 7);
          yield Buffer.alloc(64, 8);
        }
        return { frames: ok(), cancel: () => undefined };
      }
    };
    const events = spyEvents();
    const health = new VoiceHealth();
    const session = new VoiceSession(ID, new ScriptedCore(), new MarkerStt(), tts, events, undefined, undefined, undefined, undefined, undefined, health, "CLIENT_ASSERTED", { ttsStallTimeoutMs: 100 });
    session.speakSample("Første chunk.");
    session.speakSample("Andre chunk.");
    await sleep(500);
    expect(events.errors).toEqual(["tts_error"]);
    expect(cancels).toEqual([1]); // den hengende chunken avbrytes aktivt
    expect(events.frames.map((f) => f[0])).toEqual([7, 8]); // chunk 2 ble talt
    expect(health.snapshot({ tts: true })["tts"]?.last_error).toBe("tts_stall_timeout");
  });

  it("total chunk-frist: en strøm som drypper rammer for evig stoppes av ttsChunkTimeoutMs", async () => {
    const tts: TtsAdapter = {
      name: "drip", processor: LOCAL, sampleRate: 16_000, available: () => true,
      synthesize(): TtsPlayback {
        let stop = false;
        async function* drip(): AsyncIterable<Buffer> {
          while (!stop) {
            await sleep(20);
            yield Buffer.alloc(64);
          }
        }
        return { frames: drip(), cancel: () => { stop = true; } };
      }
    };
    const events = spyEvents();
    const health = new VoiceHealth();
    const session = new VoiceSession(ID, new ScriptedCore(), new MarkerStt(), tts, events, undefined, undefined, undefined, undefined, undefined, health, "CLIENT_ASSERTED", { ttsStallTimeoutMs: 5000, ttsChunkTimeoutMs: 150 });
    session.speakSample("Evig.");
    await sleep(500);
    expect(events.errors).toEqual(["tts_error"]);
    expect(health.snapshot({ tts: true })["tts"]?.last_error).toBe("tts_chunk_timeout");
    const at = events.frames.length;
    await sleep(150);
    expect(events.frames.length).toBe(at); // avbrutt, ikke bare ignorert
  });

  it("stt.end() som henger gir stt_error innen sttEndTimeoutMs, og neste tur går gjennom", async () => {
    let streams = 0;
    const stt: SttAdapter = {
      name: "hang-then-ok", processor: LOCAL, available: () => true,
      startStream(): SttStream {
        streams += 1;
        const mine = streams;
        return {
          pushAudio: () => undefined,
          onPartial: () => undefined,
          end: () => (mine === 1 ? new Promise<string>(() => undefined) : Promise.resolve("hei"))
        };
      }
    };
    const events = spyEvents();
    const session = new VoiceSession(ID, new ScriptedCore(), stt, new (await import("../src/tts.ts")).FakeTts(1), events, undefined, undefined, undefined, undefined, undefined, new VoiceHealth(), "CLIENT_ASSERTED", { sttEndTimeoutMs: 100 });
    const speech = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) speech.writeInt16LE(9000, i * 2);
    for (const base of [1_000, 10_000]) {
      session.pushAudio(speech, base);
      session.pushAudio(speech, base + 20);
      session.pushAudio(Buffer.alloc(640), base + 900);
      await sleep(350);
    }
    expect(events.errors).toContain("stt_error");
    expect(events.finals).toEqual(["hei"]);
  });
});

describe("ingen uncaught/unhandled i hele filen", () => {
  it("ingen krasj", async () => {
    await sleep(50);
    tracker.stop();
    expect(tracker.errors).toEqual([]);
  });
});
