import { describe, expect, it, vi } from "vitest";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { FailoverStt, FailoverTts, Pcm16Resampler, withLocalSttReserve, withLocalTtsReserve } from "../src/failover.ts";
import { VoiceHealth } from "../src/health.ts";
import { VoiceSession, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import { MarkerStt, type SttAdapter, type SttStream } from "../src/stt.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";
import { EXTERNAL_VERIFIED, LOCAL, ScriptedCore, sleep } from "./wpv2-harness.ts";

// Rutingporten kan bare AVSLÅ en lokal behandler hvis noe er galt (D-122 regel 1: lokal er alltid tillatt) - for å bevise at failover FAKTISK
// konsulterer `evaluateSpeechRouting` for reserven, avslår denne mocken en bestemt (lokal) testbehandler.
vi.mock("@jarvis/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/contracts")>();
  const evaluate: typeof actual.evaluateSpeechRouting = (processor, memorySpace, authority) => {
    const real = actual.evaluateSpeechRouting(processor, memorySpace, authority);
    return processor.processor_id === "wpv2-test-denied-local" ? { ...real, allowed: false } : real;
  };
  return { ...actual, evaluateSpeechRouting: evaluate };
});

/**
 * WP-V2 K4: failover SKY -> LOKAL. Regler: kun før første ramme, kun når lokal er available() og rutingporten slipper den gjennom,
 * lokal -> sky ALDRI, hendelser som koder, primær-/reservefeil skilt i health, ingen dobbel tale, barge-in under failover.
 */
type Behavior = "ok" | "fail-first" | "hang" | "fail-after-first";

interface Fake extends TtsAdapter {
  calls: number;
  cancels: number;
  produced: number;
}

function fakeTts(name: string, processor: SpeechProcessorDeclaration, behavior: Behavior, marker: number, available = true, sampleRate = 24_000): Fake {
  const fake: Fake = {
    name, processor, sampleRate, calls: 0, cancels: 0, produced: 0,
    available: () => available,
    synthesize(): TtsPlayback {
      fake.calls += 1;
      let stop = false;
      async function* frames(): AsyncIterable<Buffer> {
        if (behavior === "fail-first") throw new Error("openai_tts_error_503");
        if (behavior === "hang") {
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => stop && (clearInterval(timer), resolve()), 5);
          });
          return;
        }
        for (let i = 0; i < 3 && !stop; i++) {
          await sleep(2);
          fake.produced += 1;
          yield Buffer.alloc(64, marker);
          if (behavior === "fail-after-first" && i === 0) throw new Error("openai_tts_timeout");
        }
      }
      return { frames: frames(), cancel: () => { stop = true; fake.cancels += 1; } };
    }
  };
  return fake;
}

async function collect(playback: TtsPlayback): Promise<{ frames: Buffer[]; error?: Error }> {
  const frames: Buffer[] = [];
  try {
    for await (const f of playback.frames) frames.push(f);
    return { frames };
  } catch (err) {
    return { frames, error: err as Error };
  }
}

const CTX = { memorySpace: "personal", authority: "SERVER_VERIFIED" } as const;

describe("FailoverTts: regler", () => {
  it("primær feiler FØR første ramme -> reserve tar over; ingen dobbel tale; kode logges; health skiller primær og reserve", async () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "fail-first", 1);
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    const health = new VoiceHealth();
    const events: Array<Record<string, unknown>> = [];
    const tts = new FailoverTts(primary, reserve, { health, log: (e) => events.push(e) });
    const { frames, error } = await collect(tts.synthesize("hei", undefined, CTX));
    expect(error).toBeUndefined();
    expect(frames.map((f) => f[0])).toEqual([2, 2, 2]); // KUN reservens lyd
    expect(events).toEqual([{ msg: "tts_failover", from: "cloud", to: "local", reason: "openai_tts_error_503" }]);
    const snap = health.snapshot({ tts_primary: true, tts_reserve: true });
    expect(snap["tts_primary"]?.failures).toBe(1);
    expect(snap["tts_primary"]?.last_error).toBe("openai_tts_error_503");
    expect(snap["tts_reserve"]?.success).toBe(1);
    expect(snap["tts_reserve"]?.failures).toBe(0);
  });

  it("primær HENGER (ingen ramme): etter primaryFirstFrameTimeoutMs tar reserven over, primæren avbrytes, ingen dobbel tale", async () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "hang", 1);
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    const tts = new FailoverTts(primary, reserve, { primaryFirstFrameTimeoutMs: 80, log: () => undefined });
    const started = Date.now();
    const { frames, error } = await collect(tts.synthesize("hei", undefined, CTX));
    expect(error).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(frames.map((f) => f[0])).toEqual([2, 2, 2]);
    expect(primary.cancels).toBeGreaterThanOrEqual(1);
  });

  it("primær feiler ETTER første ramme -> INGEN failover (kun før første ramme); reserven kalles aldri", async () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "fail-after-first", 1);
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    const tts = new FailoverTts(primary, reserve, { log: () => undefined });
    const { frames, error } = await collect(tts.synthesize("hei", undefined, CTX));
    expect(error?.message).toBe("openai_tts_timeout");
    expect(frames.map((f) => f[0])).toEqual([1]);
    expect(reserve.calls).toBe(0);
  });

  it("reserve ikke tilgjengelig (available() = false): primærfeilen går videre, ingen failover", async () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "fail-first", 1);
    const reserve = fakeTts("local", LOCAL, "ok", 2, false);
    const tts = new FailoverTts(primary, reserve, { log: () => undefined });
    const { error } = await collect(tts.synthesize("hei", undefined, CTX));
    expect(error?.message).toBe("openai_tts_error_503");
    expect(reserve.calls).toBe(0);
  });

  it("lokal -> sky ALDRI: en ikke-lokal reserve avvises ved konstruksjon (stille sky-fallback finnes ikke)", () => {
    const local = fakeTts("local", LOCAL, "ok", 1);
    const cloud = fakeTts("cloud", EXTERNAL_VERIFIED, "ok", 2);
    expect(() => new FailoverTts(local, cloud)).toThrow("failover_reserve_must_be_local");
    expect(() => new FailoverStt(stt("local", LOCAL, "ok"), stt("cloud", EXTERNAL_VERIFIED, "ok"))).toThrow("failover_reserve_must_be_local");
  });

  it("uten sesjonskontekst tillates kun en lokal reserve; med kontekst dømmer evaluateSpeechRouting for sesjonens space (health-space: lokal er tillatt)", async () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "fail-first", 1);
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    const tts = new FailoverTts(primary, reserve, { log: () => undefined });
    expect((await collect(tts.synthesize("hei"))).frames).toHaveLength(3);
    expect((await collect(tts.synthesize("hei", undefined, { memorySpace: "health", authority: "SERVER_VERIFIED" }))).error).toBeUndefined();
  });

  it("rutingporten (evaluateSpeechRouting) konsulteres for reserven: en avslått reserve brukes ikke selv om den er lokal og tilgjengelig (TTS og STT)", async () => {
    const denied = { ...LOCAL, processor_id: "wpv2-test-denied-local" };
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "fail-first", 1);
    const reserve = fakeTts("local", denied, "ok", 2);
    const tts = new FailoverTts(primary, reserve, { log: () => undefined });
    const { error } = await collect(tts.synthesize("hei", undefined, CTX));
    expect(error?.message).toBe("openai_tts_error_503");
    expect(reserve.calls).toBe(0);
    const sttPrimary = stt("cloud", EXTERNAL_VERIFIED, "fail");
    const sttReserve = stt("local", denied, "ok");
    const adapter = new FailoverStt(sttPrimary, sttReserve, { log: () => undefined });
    const stream = adapter.startStream(CTX);
    stream.pushAudio(Buffer.alloc(4));
    await expect(stream.end()).rejects.toThrow("openai_stt_error_500");
    expect(sttReserve.streams).toBe(0);
    // Uten sesjonskontekst brukes den lokale reserven uten rutingvurdering (kun lokal tillates) - ingen avslag å konsultere.
    expect((await collect(tts.synthesize("hei"))).frames).toHaveLength(3);
  });

  it("cooldown: etter en primærfeil hoppes primæren over (ingen ny ventetid per chunk); etter cooldown prøves den igjen", async () => {
    let now = 1_000;
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "fail-first", 1);
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    const tts = new FailoverTts(primary, reserve, { cooldownMs: 5_000, now: () => now, log: () => undefined });
    await collect(tts.synthesize("a", undefined, CTX));
    expect(primary.calls).toBe(1);
    await collect(tts.synthesize("b", undefined, CTX));
    await collect(tts.synthesize("c", undefined, CTX));
    expect(primary.calls).toBe(1); // hoppet over i cooldown
    expect(reserve.calls).toBe(3);
    now += 5_001;
    await collect(tts.synthesize("d", undefined, CTX));
    expect(primary.calls).toBe(2); // prøver primæren igjen
    expect((tts.status()["failover"] as Record<string, unknown>)["failovers"]).toBe(2);
  });

  it("primær OK nullstiller cooldown og helse", async () => {
    let now = 0;
    let behavior: Behavior = "fail-first";
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "ok", 1);
    primary.synthesize = ((text: string) => fakeTts("x", EXTERNAL_VERIFIED, behavior, 1).synthesize(text)) as TtsAdapter["synthesize"];
    const health = new VoiceHealth();
    const tts = new FailoverTts(primary, reserve, { cooldownMs: 100, now: () => now, health, log: () => undefined });
    await collect(tts.synthesize("a", undefined, CTX));
    behavior = "ok";
    now += 101;
    const { frames } = await collect(tts.synthesize("b", undefined, CTX));
    expect(frames.map((f) => f[0])).toEqual([1, 1, 1]);
    expect(health.snapshot({ tts_primary: true })["tts_primary"]?.state).toBe("LIVE");
  });

  it("barge-in under failover: cancel() mens vi venter på primærens første ramme -> reserven starter aldri, primæren avbrytes, ingen feil", async () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "hang", 1);
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    const tts = new FailoverTts(primary, reserve, { primaryFirstFrameTimeoutMs: 5_000, log: () => undefined });
    const playback = tts.synthesize("hei", undefined, CTX);
    const done = collect(playback);
    await sleep(40);
    const cancelledAt = Date.now();
    playback.cancel();
    const { frames, error } = await done;
    // cancel() avbryter primæren UMIDDELBART (ikke først når 5 s-fristen for første ramme går ut).
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);
    expect(error).toBeUndefined();
    expect(frames).toEqual([]);
    expect(reserve.calls).toBe(0);
    expect(primary.cancels).toBeGreaterThanOrEqual(1);
  });

  it("barge-in under failover: cancel() mens RESERVEN strømmer stopper den (ingen flere rammer)", async () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "fail-first", 1);
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    const tts = new FailoverTts(primary, reserve, { log: () => undefined });
    const playback = tts.synthesize("hei", undefined, CTX);
    const frames: Buffer[] = [];
    const done = (async () => {
      for await (const f of playback.frames) {
        frames.push(f);
        if (frames.length === 1) playback.cancel();
      }
    })();
    await done;
    expect(frames).toHaveLength(1);
    expect(reserve.cancels).toBeGreaterThanOrEqual(1);
  });

  it("sampleRate og kapasiteter følger primæren; available() er primær ELLER reserve; status() skiller de to", () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "ok", 1, false, 24_000);
    const reserve = fakeTts("local", LOCAL, "ok", 2, true, 22_050);
    const tts = new FailoverTts(primary, reserve);
    expect(tts.sampleRate).toBe(24_000);
    expect(tts.processor).toBe(EXTERNAL_VERIFIED);
    expect(tts.available()).toBe(true);
    const failover = tts.status()["failover"] as Record<string, unknown>;
    expect(failover["reserve"]).toBe("local");
    expect(failover["reserve_available"]).toBe(true);
  });

  it("reservens rate (22 050) resamples til primærens (24 000) - klienten får ÉN rate per sesjon", async () => {
    const primary = fakeTts("cloud", EXTERNAL_VERIFIED, "fail-first", 1, true, 24_000);
    const reserve = fakeTts("local", LOCAL, "ok", 2, true, 22_050);
    const tts = new FailoverTts(primary, reserve, { log: () => undefined });
    const { frames } = await collect(tts.synthesize("hei", undefined, CTX));
    const total = frames.reduce((n, f) => n + f.length, 0);
    const expected = Math.round((3 * 64 * 24_000) / 22_050);
    expect(Math.abs(total - expected)).toBeLessThanOrEqual(8);
  });

  it("withLocalTtsReserve/withLocalSttReserve: kun ekstern valgt + tilgjengelig lokal reserve; ellers uendret", () => {
    const cloud = fakeTts("cloud", EXTERNAL_VERIFIED, "ok", 1);
    const local = fakeTts("local", LOCAL, "ok", 2);
    expect(withLocalTtsReserve(cloud, local)).toBeInstanceOf(FailoverTts);
    expect(withLocalTtsReserve(local, local)).toBe(local); // lokal valgt: ingenting å failover til
    expect(withLocalTtsReserve(cloud, fakeTts("local2", LOCAL, "ok", 2, false))).toBe(cloud); // reserven er ikke tilgjengelig
    expect(withLocalSttReserve(stt("cloud", EXTERNAL_VERIFIED, "ok"), stt("local", LOCAL, "ok"))).toBeInstanceOf(FailoverStt);
    const localStt = stt("local", LOCAL, "ok");
    expect(withLocalSttReserve(localStt, localStt)).toBe(localStt);
  });
});

describe("Pcm16Resampler", () => {
  const ramp = (n: number): Buffer => {
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(i * 10, i * 2);
    return b;
  };
  const samples = (b: Buffer): number[] => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

  it("lengde ~ rate-forholdet, og en rampe forblir en monotont stigende rampe", () => {
    const out = samples(new Pcm16Resampler(22_050, 24_000).push(ramp(2205)));
    expect(Math.abs(out.length - 2400)).toBeLessThanOrEqual(2);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] as number);
  });

  it("resultatet er uavhengig av hvordan inndata deles (inkl. oddetall bytes)", () => {
    const input = ramp(1000);
    const whole = new Pcm16Resampler(22_050, 24_000).push(input);
    const split = new Pcm16Resampler(22_050, 24_000);
    const parts = [input.subarray(0, 7), input.subarray(7, 300), input.subarray(300, 301), input.subarray(301)];
    const joined = Buffer.concat(parts.map((p) => split.push(p)));
    expect(joined.equals(whole)).toBe(true);
  });

  it("samme rate gir identisk innhold (minus siste sample)", () => {
    const input = ramp(100);
    const out = new Pcm16Resampler(16_000, 16_000).push(input);
    expect(samples(out)).toEqual(samples(input).slice(0, 99));
  });

  it("klemmer til 16 bit og håndterer tom inndata", () => {
    const loud = Buffer.alloc(8);
    loud.writeInt16LE(32767, 0);
    loud.writeInt16LE(-32768, 2);
    loud.writeInt16LE(32767, 4);
    loud.writeInt16LE(-32768, 6);
    expect(() => new Pcm16Resampler(16_000, 48_000).push(loud)).not.toThrow();
    expect(new Pcm16Resampler(16_000, 24_000).push(Buffer.alloc(0))).toHaveLength(0);
  });
});

function stt(name: string, processor: SpeechProcessorDeclaration, mode: "ok" | "fail" | "hang" | "throw-start", available = true, text = "hei"): SttAdapter & { streams: number; pushed: Buffer[] } {
  const fake: SttAdapter & { streams: number; pushed: Buffer[] } = {
    name, processor, streams: 0, pushed: [],
    available: () => available,
    startStream(): SttStream {
      fake.streams += 1;
      if (mode === "throw-start") throw new Error("openai_stt_not_configured");
      return {
        pushAudio: (f) => { fake.pushed.push(f); },
        onPartial: () => undefined,
        end: () => (mode === "fail" ? Promise.reject(new Error("openai_stt_error_500")) : mode === "hang" ? new Promise<string>(() => undefined) : Promise.resolve(`${text}`))
      };
    }
  };
  return fake;
}

describe("FailoverStt", () => {
  it("primær end() feiler -> samme lyd kjøres gjennom lokal reserve (alle rammer, i rekkefølge); kode logges; health skiller", async () => {
    const primary = stt("cloud", EXTERNAL_VERIFIED, "fail");
    const reserve = stt("local", LOCAL, "ok", true, "fra reserve");
    const health = new VoiceHealth();
    const events: Array<Record<string, unknown>> = [];
    const adapter = new FailoverStt(primary, reserve, { health, log: (e) => events.push(e) });
    const stream = adapter.startStream(CTX);
    stream.pushAudio(Buffer.from([1]));
    stream.pushAudio(Buffer.from([2]));
    stream.pushAudio(Buffer.from([3]));
    await expect(stream.end()).resolves.toBe("fra reserve");
    expect(reserve.pushed.map((b) => b[0])).toEqual([1, 2, 3]);
    expect(events).toEqual([{ msg: "stt_failover", from: "cloud", to: "local", reason: "openai_stt_error_500" }]);
    const snap = health.snapshot({ stt_primary: true, stt_reserve: true });
    expect(snap["stt_primary"]?.failures).toBe(1);
    expect(snap["stt_reserve"]?.success).toBe(1);
  });

  it("primær henger -> reserve etter primaryEndTimeoutMs", async () => {
    const adapter = new FailoverStt(stt("cloud", EXTERNAL_VERIFIED, "hang"), stt("local", LOCAL, "ok", true, "lokal"), { primaryEndTimeoutMs: 80, log: () => undefined });
    const stream = adapter.startStream(CTX);
    stream.pushAudio(Buffer.alloc(10));
    const started = Date.now();
    await expect(stream.end()).resolves.toBe("lokal");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("primær startStream() kaster -> reserve brukes direkte; cooldown hopper primæren over til neste tur (lyden sendes ikke til sky i mellomtiden)", async () => {
    let now = 0;
    const primary = stt("cloud", EXTERNAL_VERIFIED, "throw-start");
    const reserve = stt("local", LOCAL, "ok", true, "lokal");
    const adapter = new FailoverStt(primary, reserve, { cooldownMs: 1_000, now: () => now, log: () => undefined });
    const a = adapter.startStream(CTX);
    a.pushAudio(Buffer.alloc(4));
    await expect(a.end()).resolves.toBe("lokal");
    const b = adapter.startStream(CTX);
    b.pushAudio(Buffer.alloc(4));
    await expect(b.end()).resolves.toBe("lokal");
    expect(primary.streams).toBe(1); // andre tur: primæren ble ikke engang forsøkt
    now += 1_001;
    adapter.startStream(CTX);
    expect(primary.streams).toBe(2);
  });

  it("reserve ikke tilgjengelig: primærfeilen går videre (ingen failover)", async () => {
    const adapter = new FailoverStt(stt("cloud", EXTERNAL_VERIFIED, "fail"), stt("local", LOCAL, "ok", false), { log: () => undefined });
    const stream = adapter.startStream(CTX);
    stream.pushAudio(Buffer.alloc(4));
    await expect(stream.end()).rejects.toThrow("openai_stt_error_500");
  });

  it("primær OK: reserven berøres aldri", async () => {
    const reserve = stt("local", LOCAL, "ok");
    const adapter = new FailoverStt(stt("cloud", EXTERNAL_VERIFIED, "ok", true, "sky"), reserve);
    const stream = adapter.startStream(CTX);
    stream.pushAudio(Buffer.alloc(4));
    await expect(stream.end()).resolves.toBe("sky");
    expect(reserve.streams).toBe(0);
  });
});

describe("failover gjennom en ekte VoiceSession", () => {
  const ID: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice" };
  function events(): SessionEvents & { frames: Buffer[]; errors: string[]; cancelled: number[] } {
    const frames: Buffer[] = [];
    const errors: string[] = [];
    const cancelled: number[] = [];
    return {
      frames, errors, cancelled,
      onState: () => undefined, onPartial: () => undefined, onFinal: () => undefined, onReply: () => undefined,
      onTtsFrame: (f) => { frames.push(f); }, onTtsCancelled: (ms) => { cancelled.push(ms); }, onMetrics: () => undefined,
      onError: (e) => { errors.push(e); }
    };
  }

  it("primær TTS feiler: brukeren hører reserven (ingen tts_error); sesjonens tts-helse er LIVE og primærfeilen er registrert separat", async () => {
    const health = new VoiceHealth();
    const tts = new FailoverTts(fakeTts("cloud", EXTERNAL_VERIFIED, "fail-first", 1), fakeTts("local", LOCAL, "ok", 2), { health, log: () => undefined });
    const ev = events();
    const session = new VoiceSession(ID, new ScriptedCore(), new MarkerStt(), tts, ev, undefined, undefined, undefined, undefined, undefined, health, "SERVER_VERIFIED");
    session.speakSample("Test.");
    await sleep(200);
    expect(ev.errors).toEqual([]);
    expect(new Set(ev.frames.map((f) => f[0]))).toEqual(new Set([2]));
    expect(health.snapshot({ tts: true })["tts"]?.state).toBe("LIVE");
    expect(health.snapshot({ tts_primary: true })["tts_primary"]?.failures).toBe(1);
  });

  it("barge-in under failover (primær henger, reserve tar over, bruker avbryter): ingen rammer etter avbrudd, reserven kanselleres", async () => {
    const reserve = fakeTts("local", LOCAL, "ok", 2);
    // Reserve med mange rammer så avbruddet treffer midt i avspillingen.
    reserve.synthesize = (): TtsPlayback => {
      reserve.calls += 1;
      let stop = false;
      async function* frames(): AsyncIterable<Buffer> {
        for (let i = 0; i < 200 && !stop; i++) {
          await sleep(5);
          yield Buffer.alloc(64, 2);
        }
      }
      return { frames: frames(), cancel: () => { stop = true; reserve.cancels += 1; } };
    };
    const tts = new FailoverTts(fakeTts("cloud", EXTERNAL_VERIFIED, "hang", 1), reserve, { primaryFirstFrameTimeoutMs: 40, log: () => undefined });
    const ev = events();
    const session = new VoiceSession(ID, new ScriptedCore(), new MarkerStt(), tts, ev, undefined, undefined, undefined, undefined, undefined, new VoiceHealth(), "SERVER_VERIFIED");
    session.speakSample("Lang tekst her.");
    await sleep(250);
    expect(ev.frames.length).toBeGreaterThan(3);
    // Barge-in: ren tale mens Jarvis snakker.
    const speech = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) speech.writeInt16LE(9000, i * 2);
    session.pushAudio(speech, 5_000);
    const at = ev.frames.length;
    await sleep(150);
    expect(ev.frames.length).toBe(at);
    expect(ev.cancelled).toHaveLength(1);
    expect(reserve.cancels).toBeGreaterThanOrEqual(1);
  });
});
