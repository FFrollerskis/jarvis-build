import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { VoiceSession, type CoreClient, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import {
  DEFAULT_VOICE_SETTINGS,
  LocalPiperTts,
  OpenAiTts,
  piperArgsFor,
  sanitizeVoiceSettings,
  type TtsAdapter,
  type TtsOptions,
  type TtsPlayback
} from "../src/tts.ts";

/** D-405: stemmeinnstillinger (hastighet/uttrykk/pause) - validering, Piper-flagg, OpenAI-hastighet, fallback og sesjonsflyt. */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const MODEL = `${FIXTURES}/fake-voice.onnx`;
afterEach(() => vi.restoreAllMocks());

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of it) out.push(c);
  return Buffer.concat(out);
}

describe("sanitizeVoiceSettings", () => {
  it("manglende/ugyldig input gir standard", () => {
    for (const raw of [undefined, null, "x", 5, [], {}, { speed: "fort" }, { speed: NaN }, { speed: Infinity }]) {
      expect(sanitizeVoiceSettings(raw)).toEqual(DEFAULT_VOICE_SETTINGS);
    }
  });
  it("klemmer til grensene og runder pausen", () => {
    expect(sanitizeVoiceSettings({ speed: 99, expressiveness: -5, pause_ms: 99999 })).toEqual({ speed: 1.6, expressiveness: 0.3, pause_ms: 1500 });
    expect(sanitizeVoiceSettings({ speed: 0.01, pause_ms: -10 })).toMatchObject({ speed: 0.6, pause_ms: 0 });
    expect(sanitizeVoiceSettings({ pause_ms: 333.7 }).pause_ms).toBe(334);
  });
  it("gyldige verdier beholdes", () => {
    expect(sanitizeVoiceSettings({ speed: 1.25, expressiveness: 0.8, pause_ms: 400 })).toEqual({ speed: 1.25, expressiveness: 0.8, pause_ms: 400 });
  });
});

describe("piperArgsFor", () => {
  it("standardinnstillinger (og ingen innstillinger) gir INGEN ekstra flagg - bit-identisk oppførsel som før", () => {
    expect(piperArgsFor(undefined)).toEqual([]);
    expect(piperArgsFor({})).toEqual([]);
    expect(piperArgsFor({ ...DEFAULT_VOICE_SETTINGS })).toEqual([]);
  });
  it("hastighet: length_scale = 1/speed (høyere hastighet = lavere length_scale)", () => {
    expect(piperArgsFor({ speed: 1.25 })).toEqual(["--length_scale", "0.800"]);
    expect(piperArgsFor({ speed: 0.8 })).toEqual(["--length_scale", "1.250"]);
  });
  it("uttrykk og pause gir egne flagg, kun når de avviker", () => {
    expect(piperArgsFor({ expressiveness: 0.5 })).toEqual(["--noise_scale", "0.334", "--noise_w", "0.400"]);
    expect(piperArgsFor({ pause_ms: 600 })).toEqual(["--sentence_silence", "0.600"]);
    expect(piperArgsFor({ pause_ms: 200 })).toEqual([]);
    expect(piperArgsFor({ speed: 1.5, pause_ms: 0 })).toEqual(["--length_scale", "0.667", "--sentence_silence", "0.000"]);
  });
});

describe("LocalPiperTts med innstillinger (faket binær)", () => {
  it("sender flaggene til binæren i tillegg til --model/--output_raw", async () => {
    const tts = new LocalPiperTts(`${FIXTURES}/mock-piper-args.sh`, MODEL);
    const out = (await collect(tts.synthesize("hei", { speed: 1.25, pause_ms: 600 }).frames)).toString("utf8").trim().split("\n");
    expect(out).toEqual(["--model", MODEL, "--output_raw", "--length_scale", "0.800", "--sentence_silence", "0.600"]);
  });
  it("uten innstillinger: nøyaktig dagens argv", async () => {
    const tts = new LocalPiperTts(`${FIXTURES}/mock-piper-args.sh`, MODEL);
    const out = (await collect(tts.synthesize("hei").frames)).toString("utf8").trim().split("\n");
    expect(out).toEqual(["--model", MODEL, "--output_raw"]);
  });
  it("avviser binæren flaggene, kjøres kallet på nytt uten dem (logget) i stedet for at Jarvis blir stum", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tts = new LocalPiperTts(`${FIXTURES}/mock-piper-rejects-extra.sh`, MODEL);
    const audio = await collect(tts.synthesize("hei", { speed: 1.3 }).frames);
    expect(audio.toString("utf8")).toBe("OKOK");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("piper_custom_voice_params_failed_retry_default"))).toBe(true);
  });
  it("uten egne flagg gir en ekte feil INGEN skjult ny kjøring (feilbanen er uendret)", async () => {
    const tts = new LocalPiperTts(`${FIXTURES}/mock-piper-fail.sh`, MODEL);
    await expect(collect(tts.synthesize("hei").frames)).rejects.toThrow(/local_piper_process_failed/);
  });
  it("støtter alle tre innstillingene", () => {
    expect(new LocalPiperTts(`${FIXTURES}/mock-piper-ok.sh`, MODEL).voiceCapabilities).toEqual({ speed: true, expressiveness: true, pause: true });
  });
});

describe("OpenAiTts hastighet", () => {
  async function bodyFor(options?: TtsOptions): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    });
    try {
      await collect(new OpenAiTts("k").synthesize("hei", options).frames);
    } finally {
      vi.unstubAllGlobals();
    }
    return sent;
  }
  it("sender speed kun når den avviker fra 1", async () => {
    expect(await bodyFor()).not.toHaveProperty("speed");
    expect(await bodyFor({ speed: 1 })).not.toHaveProperty("speed");
    expect(await bodyFor({ speed: 1.3 })).toMatchObject({ speed: 1.3 });
  });
  it("støtter bare hastighet", () => {
    expect(new OpenAiTts("k").voiceCapabilities).toEqual({ speed: true, expressiveness: false, pause: false });
  });
});

const identity: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice" };
const LOCAL: SpeechProcessorDeclaration = { processor_id: "fake", locality: "local", processor_row_declared: true, processor_terms_status: "NOT_APPLICABLE_LOCAL" };
const stt: SttAdapter = { name: "s", processor: LOCAL, available: () => true, startStream: (): SttStream => ({ pushAudio: () => undefined, end: async () => "", onPartial: () => undefined }) };
const core: CoreClient = { chat: async () => ({ reply: "x", routed: "model", session_id: "s" }) };

function capturingTts(calls: Array<{ text: string; options: TtsOptions | undefined }>): TtsAdapter {
  return {
    name: "cap", processor: LOCAL, available: () => true,
    synthesize(text: string, options?: TtsOptions): TtsPlayback {
      calls.push({ text, options });
      async function* frames(): AsyncIterable<Buffer> { yield Buffer.from([1, 2]); }
      return { frames: frames(), cancel: () => undefined };
    }
  };
}
function handlers(frames: Buffer[], states: string[]): SessionEvents {
  return { onState: (s) => states.push(s), onPartial: () => undefined, onFinal: () => undefined, onReply: () => undefined, onTtsFrame: (f) => frames.push(f),
    onTtsCancelled: () => undefined, onMetrics: () => undefined, onError: () => undefined, onToolActivity: () => undefined };
}
async function waitUntil(p: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (!p()) { if (Date.now() - t0 > 3000) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); }
}

describe("VoiceSession: innstillinger og «Test stemmen»", () => {
  it("setVoiceSettings validerer ubetrodd input og gir standard før noe er satt", () => {
    const s = new VoiceSession(identity, core, stt, capturingTts([]), handlers([], []));
    expect(s.currentVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(s.setVoiceSettings({ speed: 100, bogus: "x", pause_ms: "ikke tall" })).toEqual({ speed: 1.6, expressiveness: 1, pause_ms: 200 });
  });
  it("speakSample bruker innstillingene i TTS-kallet, sender lyd og går tilbake til listening", async () => {
    const calls: Array<{ text: string; options: TtsOptions | undefined }> = [];
    const frames: Buffer[] = [];
    const states: string[] = [];
    const s = new VoiceSession(identity, core, stt, capturingTts(calls), handlers(frames, states));
    s.setVoiceSettings({ speed: 1.4, expressiveness: 0.7, pause_ms: 500 });
    s.speakSample("Dette er en test.");
    await waitUntil(() => frames.length > 0 && states.at(-1) === "listening");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe("Dette er en test.");
    expect(calls[0]!.options).toEqual({ speed: 1.4, expressiveness: 0.7, pause_ms: 500 });
  });
  it("en ny innstilling gjelder neste TTS-kall (ikke de gamle)", async () => {
    const calls: Array<{ text: string; options: TtsOptions | undefined }> = [];
    const frames: Buffer[] = [];
    const s = new VoiceSession(identity, core, stt, capturingTts(calls), handlers(frames, []));
    s.speakSample("En.");
    await waitUntil(() => calls.length === 1);
    s.setVoiceSettings({ speed: 0.8 });
    s.speakSample("To.");
    await waitUntil(() => calls.length === 2);
    expect(calls[0]!.options?.speed).toBe(1);
    expect(calls[1]!.options?.speed).toBe(0.8);
  });
});
