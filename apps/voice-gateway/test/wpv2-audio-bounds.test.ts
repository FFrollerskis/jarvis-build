import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_VOICE_LIMITS, TokenBucket } from "../src/limits.ts";
import { VoiceSession, type CoreClient, type CoreReply, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";
import { EnergyVad } from "../src/vad.ts";
import { LOCAL, ScriptedCore, TestClient, sleep, speechFrame, startGateway, trackUncaught, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 FIX-3 (F3): lydbufferet per tur og kjedene rundt er BEGRENSET. Målt på ed176a1b: en klient som sender 16 KiB-rammer med full rammerate
 * (1,6 MB/s mot 32 KB/s legitimt) ga +2,2 MB/s serverminne per tilkobling (4 tilkoblinger: RSS 106 -> 202 MB på 12 s), og eneste tak var VAD
 * `maxTurnMs` 30 s (ca. 50 MB per tur, tredoblet forbigående av Buffer.concat/WAV). `turnChain` og `ttsQueue` hadde ingen tak.
 */
let gateway: RunningGateway | undefined;
let tracker = trackUncaught();

afterEach(async () => {
  tracker.stop();
  await gateway?.close();
  gateway = undefined;
  tracker = trackUncaught();
  expect(tracker.errors).toEqual([]);
});

const ID: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice" };

function spyEvents(): SessionEvents & { errors: string[]; frames: Buffer[]; replies: CoreReply[] } {
  const errors: string[] = [];
  const frames: Buffer[] = [];
  const replies: CoreReply[] = [];
  return {
    errors, frames, replies,
    onState: () => undefined, onPartial: () => undefined, onFinal: () => undefined, onReply: (r) => { replies.push(r); },
    onTtsFrame: (f) => { frames.push(f); }, onTtsCancelled: () => undefined, onMetrics: () => undefined,
    onError: (e) => { errors.push(e); }
  };
}

/** STT-stub som kun teller byte per strøm (og avslutter tomt, så ingen Core-tur startes). */
function countingStt(): { stt: SttAdapter; streams: Array<{ bytes: number; ended: boolean }> } {
  const streams: Array<{ bytes: number; ended: boolean }> = [];
  const stt: SttAdapter = {
    name: "wpv2-counting-stt",
    processor: LOCAL,
    available: () => true,
    startStream(): SttStream {
      const rec = { bytes: 0, ended: false };
      streams.push(rec);
      return {
        pushAudio: (frame: Buffer) => {
          rec.bytes += frame.length;
        },
        end: async () => {
          rec.ended = true;
          return "";
        },
        onPartial: () => undefined
      };
    }
  };
  return { stt, streams };
}

const SPEECH = Buffer.from(speechFrame(), "base64"); // 640 byte (20 ms @ 16 kHz PCM16), høy energi

function newSession(options: ConstructorParameters<typeof VoiceSession>[12], parts: { core?: CoreClient; stt?: SttAdapter; tts?: TtsAdapter } = {}): { session: VoiceSession; events: ReturnType<typeof spyEvents> } {
  const events = spyEvents();
  const session = new VoiceSession(
    ID,
    parts.core ?? new ScriptedCore(),
    parts.stt ?? countingStt().stt,
    parts.tts ?? ({ name: "silent", processor: LOCAL, sampleRate: 16_000, available: () => true, synthesize: (): TtsPlayback => ({ frames: (async function* () { yield Buffer.alloc(64); })(), cancel: () => undefined }) } as TtsAdapter),
    events,
    undefined,
    new EnergyVad(),
    undefined,
    undefined,
    undefined,
    undefined,
    "CLIENT_ASSERTED",
    options
  );
  return { session, events };
}

describe("FIX-3: grenser (konstanter)", () => {
  it("standardverdiene er begrunnet mot legitim bruk (32 000 byte/s; maks 30 s tur)", () => {
    expect(DEFAULT_VOICE_LIMITS).toMatchObject({
      audioBytesPerSecond: 64 * 1024,
      audioByteBurst: 512 * 1024,
      maxTurnBytes: 2 * 1024 * 1024,
      maxPendingTurns: 8,
      maxQueuedTtsChunks: 128
    });
    const legitBytesPerSecond = 16_000 * 2; // PCM16 16 kHz mono
    expect(DEFAULT_VOICE_LIMITS.audioBytesPerSecond).toBeGreaterThanOrEqual(2 * legitBytesPerSecond);
    expect(DEFAULT_VOICE_LIMITS.maxTurnBytes).toBeGreaterThan(30 * legitBytesPerSecond); // VAD maxTurnMs = 30 s
    // Den gamle rammegrensen alene tillot 100 x 16 KiB per sekund: 50x legitim rate.
    expect(100 * DEFAULT_VOICE_LIMITS.audioBytesPerSecond).toBeGreaterThan(0);
  });

  it("legitim rate (32 000 byte/s, 20 ms-rammer) avvises ALDRI av byte-bøtta, uansett hvor lenge; en flom på 16 KiB-rammer gjør det", () => {
    let t = 0;
    const bucket = new TokenBucket(DEFAULT_VOICE_LIMITS.audioBytesPerSecond, DEFAULT_VOICE_LIMITS.audioByteBurst, () => t);
    for (let i = 0; i < 100_000; i++) {
      t += 20; // 20 ms-rammer à 640 byte = 32 000 byte/s i over 30 minutter
      expect(bucket.tryTake(640)).toBe(true);
    }
    let accepted = 0;
    for (let i = 0; i < 1000; i++) if (bucket.tryTake(16 * 1024)) accepted += 1; // flom uten pause
    expect(accepted * 16 * 1024).toBeLessThanOrEqual(DEFAULT_VOICE_LIMITS.audioByteBurst);
  });
});

describe("FIX-3: byte-rate-bøtte per tilkobling (transport)", () => {
  it("flom av 16 KiB-rammer (gyldige, innenfor rammebøtta): lukkes med 1008 audio_rate_exceeded før minnet vokser; en annen økt er upåvirket", async () => {
    gateway = await startGateway();
    const bystander = await new TestClient(gateway.url).connect();
    await bystander.startUnproven();
    const flood = await new TestClient(gateway.url).connect();
    await flood.startUnproven();
    const big = Buffer.alloc(16 * 1024, 1).toString("base64"); // 16 KiB PCM16 (partall) - lovlig ramme, men 50x legitim rate
    for (let i = 0; i < 80; i++) flood.send({ type: "audio", data: big }); // 1,3 MB innen noen ms
    const closed = await flood.waitClosed(5000);
    expect(closed).toEqual({ code: 1008, reason: "audio_rate_exceeded" });
    expect(flood.errors()).toContain("audio_rate_exceeded");
    bystander.send({ type: "voice_settings", settings: {} });
    await bystander.waitFor((m) => m.type === "voice_settings");
    expect(bystander.closeEvent).toBeNull();
    bystander.close();
  });

  it("legitim innhenting (150 nettleserrammer à 2 048 byte = 307 KB på ett øyeblikk) er innenfor burst og lukkes ikke", async () => {
    gateway = await startGateway();
    const client = await new TestClient(gateway.url).connect();
    await client.startUnproven();
    const frame = Buffer.alloc(2048, 1).toString("base64");
    for (let i = 0; i < 150; i++) client.send({ type: "audio", data: frame });
    await sleep(300);
    expect(client.closeEvent).toBeNull();
    expect(client.errors()).toEqual([]);
    client.close();
  });
});

describe("FIX-3: byte-tak per tur (sesjon)", () => {
  it("en tur som aldri slutter: avsluttes ved maxTurnBytes med det som er mottatt (turn_audio_limit), og ingen strøm får mer enn taket", async () => {
    const { stt, streams } = countingStt();
    const cap = 64_000; // 100 rammer à 640 byte
    const { session, events } = newSession({ maxTurnBytes: cap }, { stt });
    for (let i = 0; i < 1000; i++) {
      session.pushAudio(SPEECH, 1_000 + i * 20); // 20 s kontinuerlig tale: VAD maxTurnMs (30 s) slår aldri inn
    }
    await sleep(100);
    expect(streams.length).toBeGreaterThanOrEqual(2); // den tvungne slutten nullstiller VAD, så neste tale starter en NY tur
    for (const s of streams) expect(s.bytes).toBeLessThanOrEqual(cap);
    expect(streams[0]?.bytes).toBe(cap); // første tur fikk nøyaktig taket (ikke mindre: ingen legitim lyd kastes før taket)
    expect(streams[1]?.bytes).toBe(cap); // og en NY tur starter med nullstilt teller (ikke arvet fra forrige)
    expect(streams[0]?.ended).toBe(true); // avsluttet (transkribert), ikke bare kastet
    expect(events.errors).toContain("turn_audio_limit");
    session.disconnect();
  });

  it("normal tur (3 s tale + stillhet): urørt av taket, avsluttes av VAD", async () => {
    const { stt, streams } = countingStt();
    const { session, events } = newSession({}, { stt });
    const silence = Buffer.alloc(640);
    let t = 5_000;
    for (let i = 0; i < 150; i++) session.pushAudio(SPEECH, (t += 20)); // 3 s
    for (let i = 0; i < 50; i++) session.pushAudio(silence, (t += 20)); // 1 s stillhet > hangover 700 ms
    await sleep(100);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.ended).toBe(true);
    expect(streams[0]?.bytes).toBeGreaterThanOrEqual(150 * 640); // all tale + stillheten frem til hangover (700 ms)
    expect(streams[0]?.bytes).toBeLessThan(200 * 640);
    expect(events.errors).toEqual([]);
    session.disconnect();
  });
});

describe("FIX-3: gatewayens limits flyter inn i sesjonen", () => {
  it("limits.maxTurnBytes (gateway) begrenser turen til en tilkoblet klient: strømmen får aldri mer enn taket, og klienten får turn_audio_limit", async () => {
    const { stt, streams } = countingStt();
    gateway = await startGateway({ stt, limits: { maxTurnBytes: 6_400 } }); // 10 rammer à 640 byte
    const client = await new TestClient(gateway.url).connect();
    await client.startUnproven();
    for (let i = 0; i < 60; i++) client.send({ type: "audio", data: speechFrame() }); // 38 400 byte: langt under byte-bøtta
    await client.waitFor((m) => m.type === "error" && m["error"] === "turn_audio_limit");
    await sleep(100);
    expect(streams.length).toBeGreaterThanOrEqual(1);
    for (const stream of streams) expect(stream.bytes).toBeLessThanOrEqual(6_400);
    expect(client.closeEvent).toBeNull(); // taket avslutter turen, ikke tilkoblingen
    client.close();
  });
});

describe("FIX-3: tak på turkjeden og TTS-køen", () => {
  it("replay_final over maxPendingTurns forkastes med voice_busy (ikke kø uten grense); de som kom inn kjøres i rekkefølge", async () => {
    const core = new ScriptedCore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chat = core.chat.bind(core);
    core.chat = async (identity, message) => {
      await gate; // Core henger til vi slipper den
      return chat(identity, message);
    };
    const { session, events } = newSession({ maxPendingTurns: 2 }, { core });
    for (const id of ["u1", "u2", "u3", "u4", "u5"]) session.replayFinal(id, `tekst-${id}`);
    expect(events.errors).toEqual(["voice_busy", "voice_busy", "voice_busy"]); // u3, u4, u5 forkastet UTEN å røre journalen
    release();
    const started = Date.now();
    while (events.replies.length < 2 && Date.now() - started < 4000) await sleep(10);
    expect(core.chatCalls.map((c) => c.message)).toEqual(["tekst-u1", "tekst-u2"]);
    // En forkastet id er ikke «utført»: den kan sendes på nytt når kjeden er tom.
    session.replayFinal("u3", "tekst-u3");
    await sleep(100);
    expect(core.chatCalls.map((c) => c.message)).toEqual(["tekst-u1", "tekst-u2", "tekst-u3"]);
    session.disconnect();
  });

  it("VAD-avsluttede turer (ikke bare replay) teller mot samme tak: en tur over maxPendingTurns forkastes med voice_busy", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const ended: number[] = [];
    const stt: SttAdapter = {
      name: "gated-stt", processor: LOCAL, available: () => true,
      startStream(): SttStream {
        const index = ended.length;
        return { pushAudio: () => undefined, end: async () => { await gate; ended.push(index); return ""; }, onPartial: () => undefined };
      }
    };
    const { session, events } = newSession({ maxPendingTurns: 1, sttEndTimeoutMs: 20_000 }, { stt });
    const silence = Buffer.alloc(640);
    let t = 10_000;
    const utterance = (): void => {
      for (let i = 0; i < 20; i++) session.pushAudio(SPEECH, (t += 20));
      for (let i = 0; i < 50; i++) session.pushAudio(silence, (t += 20)); // > hangover: end_of_turn
    };
    utterance(); // tur 1: stt.end() henger (porten) = ett ventende steg
    expect(events.errors).toEqual([]);
    utterance(); // tur 2: kjeden er full
    expect(events.errors).toEqual(["voice_busy"]);
    open();
    await sleep(50);
    expect(ended).toEqual([0]); // kun den første turen ble noen gang transkribert; den forkastede strømmen ble aldri avsluttet/kjørt
    session.disconnect();
  });

  it("TTS-køen er begrenset: over maxQueuedTtsChunks forkastes chunker (tts_queue_full, ÉN gang), og de akseptertes lyd leveres etter at stallen er løst", async () => {
    let calls = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const tts: TtsAdapter = {
      name: "gated-tts", processor: LOCAL, sampleRate: 16_000, available: () => true,
      synthesize(): TtsPlayback {
        calls += 1;
        return { frames: (async function* () { await gate; yield Buffer.alloc(64, 7); })(), cancel: () => undefined };
      }
    };
    const { session, events } = newSession({ maxQueuedTtsChunks: 3, ttsStallTimeoutMs: 10_000 }, { tts });
    session.speakSample("Første chunk.");
    await sleep(30); // arbeideren har tatt den første ut av køen og venter på lyd (stalles av porten)
    for (let i = 0; i < 11; i++) session.speakSample(`Chunk nummer ${i + 2}.`); // 11 nye: 3 får plass i køen, 8 forkastes
    expect(events.errors.filter((e) => e === "tts_queue_full")).toEqual(["tts_queue_full"]);
    open();
    const started = Date.now();
    while (events.frames.length < 4 && Date.now() - started < 4000) await sleep(10);
    await sleep(100);
    expect(events.frames).toHaveLength(4); // 1 under avspilling + 3 køede; de 8 øvrige ble aldri syntetisert
    expect(calls).toBe(4);
    session.disconnect();
  });
});
