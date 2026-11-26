import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_LIMITS, ProcessSlots, VoiceBusyError } from "../src/limits.ts";
import type { SpeechCallContext } from "../src/speech-context.ts";
import { LocalWhisperStt, RemoteWhisperStt, type SttAdapter } from "../src/stt.ts";
import { LocalPiperTts } from "../src/tts.ts";
import { sleep } from "./wpv2-harness.ts";

/**
 * WP-V2 FIX-4 (F4): prosess-semaforene (whisper 2 / piper 4) er globale. Målt (p2): seks klienter ga fire plasser og to `voice_busy`, og en UBEVIST
 * klient kunne holde alle plasser og sulte eierens STT. Nå er ÉN plass reservert for BEVISTE sesjoner (`SERVER_VERIFIED`): ubeviste får høyst
 * `max - reserved` samtidig, og en bevist forespørsel finner alltid en ledig plass så lenge ikke flere bevisste enn det er plasser kjører.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const MODEL = `${FIXTURES}/fake-voice.onnx`;
const WHISPER_MODEL = `${FIXTURES}/fake-model.bin`;
const UNPROVEN: SpeechCallContext = { memorySpace: "personal", authority: "CLIENT_ASSERTED" };
const PROVEN: SpeechCallContext = { memorySpace: "personal", authority: "SERVER_VERIFIED" };

describe("ProcessSlots: reservert plass for bevist (FIX-4)", () => {
  it("standard: én reservert plass (gjelder både whisper 2 og piper 4)", () => {
    expect(DEFAULT_VOICE_LIMITS.reservedProvenSlots).toBe(1);
    expect(DEFAULT_VOICE_LIMITS.reservedProvenSlots).toBeLessThan(DEFAULT_VOICE_LIMITS.maxConcurrentWhisper);
  });

  it("ubevist tar høyst max-reservert samtidige plasser (resten venter og får voice_busy); en bevist får den siste umiddelbart; slipp gir videre", async () => {
    const slots = new ProcessSlots(2, 80, 1);
    const u1 = await slots.acquire(undefined, { unproven: true });
    const u2 = slots.acquire(undefined, { unproven: true }).catch((e: unknown) => e); // alle ubevist-plasser er tatt: venter, avvises etter 80 ms
    const p1 = await slots.acquire(undefined, { unproven: false }); // den reserverte plassen
    expect(slots.inUse).toBe(2);
    expect(await u2).toBeInstanceOf(VoiceBusyError);
    expect(slots.queued).toBe(0);
    p1();
    const u3 = await slots.acquire(undefined, { unproven: true }).then(() => "ok", () => "busy");
    expect(u3).toBe("busy"); // u1 holder fortsatt den ene ubevist-plassen
    u1();
    expect(slots.inUse).toBe(0);
    const u4 = await slots.acquire(undefined, { unproven: true });
    u4();
  });

  it("uten flagg regnes en forespørsel som BEVIST (bakoverkompatibel: eksisterende kallere er uendret)", async () => {
    const slots = new ProcessSlots(2, 80, 1);
    const a = await slots.acquire();
    const b = await slots.acquire();
    expect(slots.inUse).toBe(2);
    a();
    b();
  });

  it("uten reservasjon (standard for ProcessSlots(max, timeout)) oppfører ubeviste seg som før: alle plasser kan tas", async () => {
    const slots = new ProcessSlots(2, 80);
    const a = await slots.acquire(undefined, { unproven: true });
    const b = await slots.acquire(undefined, { unproven: true });
    expect(slots.inUse).toBe(2);
    a();
    b();
  });

  it("reservasjonen klemmes slik at ubeviste alltid kan bruke minst én plass (max 1 gir aldri et deadlock for ubeviste)", async () => {
    const slots = new ProcessSlots(1, 80, 1);
    expect(slots.reservedForProven).toBe(0);
    const u = await slots.acquire(undefined, { unproven: true });
    u();
    const clamped = new ProcessSlots(3, 80, 99);
    expect(clamped.reservedForProven).toBe(2);
  });

  it("kø: en ledig plass går til første som FAKTISK kan få den - en ventende ubevist hoder ikke køen foran en bevist", async () => {
    const slots = new ProcessSlots(2, 2000, 1);
    const u1 = await slots.acquire(undefined, { unproven: true });
    const p1 = await slots.acquire(undefined, { unproven: false });
    let u2Granted = false;
    let p2Granted = false;
    const u2 = slots.acquire(undefined, { unproven: true }).then((release) => {
      u2Granted = true;
      return release;
    });
    const p2 = slots.acquire(undefined, { unproven: false }).then((release) => {
      p2Granted = true;
      return release;
    });
    await sleep(30);
    expect(slots.queued).toBe(2);
    p1(); // én plass blir ledig: u2 (først i køen) KAN ikke ha den (ubevist-taket er nådd), p2 kan
    const releaseP2 = await p2;
    expect({ u2Granted, p2Granted }).toEqual({ u2Granted: false, p2Granted: true });
    u1(); // nå er ubevist-taket ledig igjen
    const releaseU2 = await u2;
    expect(u2Granted).toBe(true);
    releaseP2();
    releaseU2();
    expect(slots.inUse).toBe(0);
    expect(slots.queued).toBe(0);
  });
});

describe("FIX-4: adapterne sender sesjonens tillitsnivå til semaforen", () => {
  it("whisper: en ubevist tur som henger holder kun den ubevist-tillatte plassen - en annen ubevist får voice_busy, men en BEVIST tur kjører umiddelbart", async () => {
    const slots = new ProcessSlots(2, 200, 1);
    const hang = new LocalWhisperStt(`${FIXTURES}/mock-whisper-hang.sh`, WHISPER_MODEL, 16000, "no", 1, undefined, slots, 3000);
    const ok = new LocalWhisperStt(`${FIXTURES}/mock-whisper-ok.sh`, WHISPER_MODEL, 16000, "no", 1, undefined, slots, 5000);
    const holder = hang.startStream(UNPROVEN);
    holder.pushAudio(Buffer.alloc(3200));
    const holding = holder.end().catch((e: unknown) => e);
    await sleep(100);
    expect(slots.inUse).toBe(1);

    const second = ok.startStream(UNPROVEN);
    second.pushAudio(Buffer.alloc(3200));
    await expect(second.end()).rejects.toThrow("voice_busy");

    const noContext = ok.startStream(); // manglende kontekst = fail-closed: regnes som ubevist
    noContext.pushAudio(Buffer.alloc(3200));
    await expect(noContext.end()).rejects.toThrow("voice_busy");

    const proven = ok.startStream(PROVEN);
    proven.pushAudio(Buffer.alloc(3200));
    await expect(proven.end()).resolves.toBeTypeOf("string"); // den reserverte plassen er ledig
    expect(slots.inUse).toBe(1); // kun holderen
    expect(String(await holding)).toContain("local_whisper_timeout");
    expect(slots.inUse).toBe(0);
  }, 20_000);

  it("piper: samme regel (ubevist avvises når ubevist-plassene er tatt; bevist syntetiserer)", async () => {
    const slots = new ProcessSlots(2, 200, 1);
    const hang = new LocalPiperTts(`${FIXTURES}/mock-piper-hang.sh`, MODEL, undefined, slots, 30_000);
    const ok = new LocalPiperTts(`${FIXTURES}/mock-piper-ok.sh`, MODEL, undefined, slots, 30_000);
    const holder = hang.synthesize("hei", undefined, UNPROVEN);
    const holderNext = holder.frames[Symbol.asyncIterator]().next().catch(() => undefined); // starter prosessen og holder plassen
    await sleep(150);
    expect(slots.inUse).toBe(1);

    const blocked = ok.synthesize("hei", undefined, UNPROVEN);
    const err = await (async () => {
      for await (const _ of blocked.frames) void _;
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceBusyError);

    const noContext = ok.synthesize("hei"); // manglende kontekst = fail-closed: regnes som ubevist
    const errNoContext = await (async () => {
      for await (const _ of noContext.frames) void _;
    })().catch((e: unknown) => e);
    expect(errNoContext).toBeInstanceOf(VoiceBusyError);

    const frames: Buffer[] = [];
    for await (const f of ok.synthesize("hei", undefined, PROVEN).frames) frames.push(f);
    expect(Buffer.concat(frames).toString()).toBe("AAAABBBBCCCC");

    holder.cancel();
    await holderNext;
    await sleep(100);
    expect(slots.inUse).toBe(0);
  }, 20_000);
});

describe("FIX-4: remote whisper gir sesjonens kontekst videre til den lokale reserven", () => {
  it("en BEVIST sesjons fallback til lokal whisper får konteksten (og dermed sin reserverte plass); en ubevist får den ubevist", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const seen: Array<SpeechCallContext | undefined> = [];
    const fallback: SttAdapter = {
      name: "spy-local",
      processor: { processor_id: "spy-local", locality: "local", processor_row_declared: true, processor_terms_status: "NOT_APPLICABLE_LOCAL" },
      available: () => true,
      startStream(context?: SpeechCallContext) {
        seen.push(context);
        return { pushAudio: () => undefined, onPartial: () => undefined, end: async () => "lokal tekst" };
      }
    };
    try {
      const remote = new RemoteWhisperStt(url, { fallback, cooldownMs: 1 });
      for (const context of [PROVEN, UNPROVEN]) {
        const stream = remote.startStream(context);
        stream.pushAudio(Buffer.alloc(3200, 1));
        expect(await stream.end()).toBe("lokal tekst");
      }
      expect(seen).toEqual([PROVEN, UNPROVEN]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
