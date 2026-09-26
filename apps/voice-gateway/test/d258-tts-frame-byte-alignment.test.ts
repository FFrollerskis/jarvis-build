import { describe, expect, it } from "vitest";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import {
  VoiceSession,
  alignPcm16Frames,
  type CoreClient,
  type SessionEvents,
  type TurnMetrics,
  type VoiceIdentity
} from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";

/**
 * D-258 (Tobias direkte i chat, live NAS-test etter D-257): talegjenkjenning/
 * -svar fungerte ("Hallo?" -> ekte modellsvar fra Charlie), men klienten
 * (`apps/web/voice.html`) logget "ugyldig melding fra server" gjentatte
 * ganger per tur og lyden var brutt/uteble - opplevd av Tobias som "ingen
 * respons". Root cause: rå `tts_frame`-chunker fra `LocalPiperTts`/
 * `OpenAiTts` er ikke garantert sample-justerte (partall byte-lengde), og
 * klientens `new Int16Array(bytes.buffer)` kaster en `RangeError` for
 * enhver chunk med et oddetall antall bytes. Se `alignPcm16Frames()`-
 * kommentaren i session.ts for hele funnet/fiksen. Denne suiten beviser
 * fiksen på to nivåer: den rene funksjonen isolert, og hele
 * `VoiceSession.speakNext()`-løkken (via `pushAudio()`/den ekte VAD-banen,
 * samme mønster som d30-foundation.test.ts) med en fake TTS-adapter som
 * bevisst produserer byte-mismatchede chunks (samme mønster en OS-pipe/
 * stdout kan levere).
 */

async function collect(iter: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of iter) {
    out.push(chunk);
  }
  return out;
}

async function* fromChunks(chunks: Buffer[]): AsyncIterable<Buffer> {
  for (const c of chunks) {
    yield c;
  }
}

describe("D-258: alignPcm16Frames()", () => {
  it("hver yield-ede buffer har partall lengde, uansett hvor oddetall-grensene i input ligger", async () => {
    // 3 + 5 + 2 + 1 bytes = 11 bytes totalt -> siste (oddetall) byte kan
    // strukturelt aldri bli en hel 2-byte sample og skal droppes; de
    // resterende 10 bytene skal alle videreformidles, uendret rekkefølge.
    const input = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6, 7, 8]), Buffer.from([9, 10]), Buffer.from([11])];
    const out = await collect(alignPcm16Frames(fromChunks(input)));
    for (const chunk of out) {
      expect(chunk.length % 2).toBe(0);
    }
    const all = Buffer.concat(out);
    expect(Array.from(all)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("en helt tom strøm gir ingen rammer (ingen krasj på tom input)", async () => {
    const out = await collect(alignPcm16Frames(fromChunks([])));
    expect(out).toEqual([]);
  });

  it("allerede sample-justerte chunks passerer uendret (ingen unødvendig buffering/forsinkelse)", async () => {
    const input = [Buffer.from([1, 2]), Buffer.from([3, 4, 5, 6])];
    const out = await collect(alignPcm16Frames(fromChunks(input)));
    expect(out).toEqual(input);
  });

  it("en enkelt 1-bytes chunk etterfulgt av en 1-bytes chunk kombineres til én 2-bytes sample", async () => {
    const input = [Buffer.from([42]), Buffer.from([43])];
    const out = await collect(alignPcm16Frames(fromChunks(input)));
    expect(out).toEqual([Buffer.from([42, 43])]);
  });
});

const identity: VoiceIdentity = {
  person_id: "person-tobias",
  tenant_id: "tenant-personal",
  device_id: "dev-voice",
  memory_space: "personal",
  channel: "voice"
};

const LOCAL_TEST_PROCESSOR: SpeechProcessorDeclaration = {
  processor_id: "voice-test-fake",
  locality: "local",
  processor_row_declared: true,
  processor_terms_status: "NOT_APPLICABLE_LOCAL"
};

/** STT-fake: fast transkript (identisk mønster som d30-foundation.test.ts). */
function fixedStt(text: string): SttAdapter {
  return {
    name: "fixed-stt",
    processor: LOCAL_TEST_PROCESSOR,
    available: () => true,
    startStream(): SttStream {
      return { pushAudio: () => undefined, end: async () => text, onPartial: () => undefined };
    }
  };
}

/**
 * TTS-fake som produserer NØYAKTIG samme byte-mismatch-mønster en ekte
 * `for await (const chunk of proc.stdout)` kan levere (se D-256/D-257 sine
 * kommentarer i tts.ts om at dette IKKE er et hypotetisk scenario - piper
 * sitt subprosess-stdout leverer i vilkårlige OS-pipe-bufrede biter).
 */
function misalignedChunkTts(chunks: number[][]): TtsAdapter {
  return {
    name: "misaligned-fake-tts",
    processor: LOCAL_TEST_PROCESSOR,
    available: () => true,
    synthesize(): TtsPlayback {
      async function* frames(): AsyncIterable<Buffer> {
        for (const bytes of chunks) {
          yield Buffer.from(bytes);
        }
      }
      return { frames: frames(), cancel: () => undefined };
    }
  };
}

function events(): { handlers: SessionEvents; frames: Buffer[]; errors: string[]; metrics: TurnMetrics[] } {
  const frames: Buffer[] = [];
  const errors: string[] = [];
  const metrics: TurnMetrics[] = [];
  return {
    frames,
    errors,
    metrics,
    handlers: {
      onState: () => undefined,
      onPartial: () => undefined,
      onFinal: () => undefined,
      onReply: () => undefined,
      onTtsFrame: (f) => frames.push(f),
      onTtsCancelled: () => undefined,
      onMetrics: (m) => metrics.push(m),
      onError: (e) => errors.push(e),
      onToolActivity: () => undefined
    }
  };
}

/** Lydrammer for VAD-banen (identisk mønster som d30-foundation.test.ts). */
function speech(): Buffer {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) {
    b.writeInt16LE(9000, i * 2);
  }
  return b;
}
const silence = (): Buffer => Buffer.alloc(640);

async function runVoiceTurn(session: VoiceSession): Promise<void> {
  let t = 1000;
  session.pushAudio(speech(), t);
  session.pushAudio(speech(), (t += 50));
  session.pushAudio(silence(), (t += 800)); // > hangover (D-275: 700) -> end_of_turn
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitUntil timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("D-258: VoiceSession.speakNext() sender ALDRI en byte-mismatchet tts_frame videre til klienten", () => {
  it("odde-lengde chunks fra TTS-adapteren produserer kun partall-lengde onTtsFrame-kall, ingen tapt lyd, ingen tts_error", async () => {
    // Simulerer en piper-strøm som (som observert live på NAS-en) leverer
    // omtrent annenhver chunk med et oddetall antall bytes.
    const rawChunks = [
      [1, 2, 3],
      [4, 5],
      [6],
      [7, 8, 9, 10, 11],
      [12, 13, 14]
    ];
    const tts = misalignedChunkTts(rawChunks);
    const core: CoreClient = {
      chat: async () => ({ reply: "svar", routed: "model", session_id: "sess-test" })
    };
    const ev = events();
    const session = new VoiceSession(identity, core, fixedStt("test"), tts, ev.handlers);
    await runVoiceTurn(session);
    await waitUntil(() => ev.metrics.length === 1);

    expect(ev.errors).not.toContain("tts_error");
    expect(ev.frames.length).toBeGreaterThan(0);
    for (const f of ev.frames) {
      expect(f.length % 2).toBe(0);
    }
    const all = Buffer.concat(ev.frames);
    expect(Array.from(all)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});
