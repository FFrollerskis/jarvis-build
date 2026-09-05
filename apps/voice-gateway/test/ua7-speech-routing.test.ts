import { describe, expect, it } from "vitest";
import {
  evaluateSpeechRouting,
  speechSensitivityForMemorySpace,
  MemorySpaceSchema,
  SpeechProcessorDeclarationSchema,
  type SpeechProcessorDeclaration
} from "@jarvis/contracts";
import { VoiceSession, type CoreClient, type CoreReply, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import { MarkerStt, OpenAiStt, LocalWhisperStt, type SttAdapter, type SttStream } from "../src/stt.ts";
import { FakeTts, LocalPiperTts, OpenAiTts, type TtsAdapter, type TtsPlayback } from "../src/tts.ts";

/**
 * D-122 (UA-7 Communications Hub, TREDJE slice) - akseptansekriterium 4:
 * «Transcription/call processing has documented retention and legal basis
 * where required».
 *
 * Disse testene beviser STRUKTURELT det `docs/UA7_COMMUNICATIONS_DPIA.md`,
 * `docs/security/DPIA_VOICE.md` og `docs/security/PROCESSOR_REGION_MATRIX.md`
 * PÅSTÅR - i stedet for å la dokumentasjonen være en ren tekstpåstand (som er
 * nøyaktig feilen denne sliceen retter: DPIA-en påsto «ingen rå lyd forlater
 * maskinen» mens `main.ts` sendte all lyd til OpenAI så snart nøkkelen fantes).
 */

const EXTERNAL_DECLARED: SpeechProcessorDeclaration = {
  processor_id: "test-external-declared",
  locality: "external",
  processor_row_declared: true
};
const EXTERNAL_UNDECLARED: SpeechProcessorDeclaration = {
  processor_id: "test-external-undeclared",
  locality: "external",
  processor_row_declared: false
};
const LOCAL_DECLARED: SpeechProcessorDeclaration = {
  processor_id: "test-local",
  locality: "local",
  processor_row_declared: true
};

/** STT-spion: teller HVER ramme som faktisk nådde adapteren. */
function spyStt(processor: SpeechProcessorDeclaration): { adapter: SttAdapter; frames: () => number; streams: () => number } {
  let frames = 0;
  let streams = 0;
  return {
    frames: () => frames,
    streams: () => streams,
    adapter: {
      name: "spy-stt",
      processor,
      available: () => true,
      startStream(): SttStream {
        streams++;
        return {
          pushAudio: () => {
            frames++;
          },
          end: async () => "hei jarvis",
          onPartial: () => undefined
        };
      }
    }
  };
}

/** TTS-spion: teller HVER synthesize - altså hver tekst som nådde behandleren. */
function spyTts(processor: SpeechProcessorDeclaration): { adapter: TtsAdapter; calls: () => string[] } {
  const calls: string[] = [];
  return {
    calls: () => calls,
    adapter: {
      name: "spy-tts",
      processor,
      available: () => true,
      synthesize(text: string): TtsPlayback {
        calls.push(text);
        async function* frames(): AsyncIterable<Buffer> {
          yield Buffer.alloc(16);
        }
        return { frames: frames(), cancel: () => undefined };
      }
    }
  };
}

function identityIn(memorySpace: string): VoiceIdentity {
  return {
    person_id: "p-owner",
    tenant_id: "t-1",
    device_id: "dev-voice",
    memory_space: memorySpace,
    channel: "voice"
  };
}

function recordingEvents(): { handlers: SessionEvents; errors: string[]; finals: string[] } {
  const errors: string[] = [];
  const finals: string[] = [];
  return {
    errors,
    finals,
    handlers: {
      onState: () => undefined,
      onPartial: () => undefined,
      onFinal: (text) => finals.push(text),
      onReply: () => undefined,
      onToolActivity: () => undefined,
      onTtsFrame: () => undefined,
      onTtsCancelled: () => undefined,
      onMetrics: () => undefined,
      onError: (error) => errors.push(error)
    }
  };
}

const staticCore: CoreClient = {
  chat: async (): Promise<CoreReply> => ({ reply: "svar fra jarvis", routed: "test", session_id: "s-1" })
};

/** Tale-ramme med nok energi til at `EnergyVad` registrerer speech_start. */
function loudFrame(): Buffer {
  const frame = Buffer.alloc(640);
  for (let i = 0; i < frame.length; i += 2) {
    frame.writeInt16LE(12000, i);
  }
  return frame;
}

describe("D-122 A: den rene rutingsregelen (kanonisk, leverandør-uavhengig)", () => {
  it("A1: `health` er den ENESTE space-en som klassifiseres SECRET_RESTRICTED - resten beholder dagens ruting (migrasjonssikkerhet)", () => {
    expect(speechSensitivityForMemorySpace("health")).toBe("SECRET_RESTRICTED");
    const others = MemorySpaceSchema.options.filter((s) => s !== "health");
    for (const space of others) {
      expect(speechSensitivityForMemorySpace(space)).not.toBe("SECRET_RESTRICTED");
      expect(evaluateSpeechRouting(EXTERNAL_DECLARED, space)).toMatchObject({
        allowed: true,
        outcome: "ALLOWED_EXTERNAL_PROCESSOR"
      });
    }
  });

  it("A2: health + ekstern behandler = AVVIST (D-23 / matrise-regel 2)", () => {
    expect(evaluateSpeechRouting(EXTERNAL_DECLARED, "health")).toMatchObject({
      allowed: false,
      outcome: "DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR",
      sensitivity: "SECRET_RESTRICTED"
    });
  });

  it("A3: health + LOKAL behandler = tillatt - porten forbyr ikke tale, den forbyr EKSTERN behandling", () => {
    expect(evaluateSpeechRouting(LOCAL_DECLARED, "health")).toMatchObject({
      allowed: true,
      outcome: "ALLOWED_LOCAL_PROCESSOR"
    });
  });

  it("A4: ukjent/manglende memory space tolkes ALDRI som lav-sensitiv (D-81-lærdommen, fail-closed)", () => {
    for (const bogus of [undefined, "", "helse", "HEALTH", "unknown-space", "admin"]) {
      expect(speechSensitivityForMemorySpace(bogus)).toBeNull();
      expect(evaluateSpeechRouting(EXTERNAL_DECLARED, bogus)).toMatchObject({
        allowed: false,
        outcome: "DENIED_UNKNOWN_MEMORY_SPACE"
      });
    }
  });

  it("A5: ekstern behandler UTEN erklært matriserad avvises for ALLE spaces (matrise-regel 1)", () => {
    for (const space of MemorySpaceSchema.options) {
      expect(evaluateSpeechRouting(EXTERNAL_UNDECLARED, space)).toMatchObject({
        allowed: false,
        outcome: "DENIED_PROCESSOR_ROW_NOT_DECLARED"
      });
    }
  });

  it("A6: manglende rad slår ut FØR space-vurderingen - en lav-sensitiv space kan aldri 'redde' en uerklært behandler", () => {
    expect(evaluateSpeechRouting(EXTERNAL_UNDECLARED, "personal").outcome).toBe("DENIED_PROCESSOR_ROW_NOT_DECLARED");
  });

  it("A7: en lokal behandler er tillatt selv med ukjent space og uerklært rad - lyden forlater aldri maskinen", () => {
    expect(
      evaluateSpeechRouting({ processor_id: "lokal", locality: "local", processor_row_declared: false }, "tullespace")
    ).toMatchObject({ allowed: true, outcome: "ALLOWED_LOCAL_PROCESSOR" });
  });

  it("A8: erklæringen er `.strict()` - et ukjent felt kan ikke smugles inn i en behandler-erklæring", () => {
    expect(SpeechProcessorDeclarationSchema.safeParse({ ...EXTERNAL_DECLARED, trust_me: true }).success).toBe(false);
  });
});

describe("D-122 B: de faktiske adapternes erklæringer stemmer med hva koden GJØR", () => {
  it("B1: OpenAI STT/TTS er erklært EKSTERN (de kaller api.openai.com), lokale/test-adaptere er erklært lokale", () => {
    expect(new OpenAiStt("k").processor.locality).toBe("external");
    expect(new OpenAiTts("k").processor.locality).toBe("external");
    expect(new MarkerStt().processor.locality).toBe("local");
    expect(new LocalWhisperStt("/bin/whisper").processor.locality).toBe("local");
    expect(new FakeTts().processor.locality).toBe("local");
    expect(new LocalPiperTts("/bin/piper").processor.locality).toBe("local");
  });

  it("B2: BO-12-baselinen (OpenAI) kan IKKE betjene health-space - dette er den reelle, dokumenterte kapabilitets-mangelen", () => {
    expect(evaluateSpeechRouting(new OpenAiStt("k").processor, "health").allowed).toBe(false);
    expect(evaluateSpeechRouting(new OpenAiTts("k").processor, "health").allowed).toBe(false);
    // ...men den er uendret for alle andre spaces (ingen regresjon av BO-12).
    expect(evaluateSpeechRouting(new OpenAiStt("k").processor, "personal").allowed).toBe(true);
  });
});

describe("D-122 C: VoiceSession håndhever porten - ikke ÉN lydramme når en ukvalifisert behandler", () => {
  it("C1: health-space + ekstern STT → NULL rammer og NULL streams til adapteren, eksplisitt feil, ingen stille fallback", () => {
    const stt = spyStt(EXTERNAL_DECLARED);
    const tts = spyTts(EXTERNAL_DECLARED);
    const ev = recordingEvents();
    const session = new VoiceSession(identityIn("health"), staticCore, stt.adapter, tts.adapter, ev.handlers);

    for (let i = 0; i < 25; i++) {
      session.pushAudio(loudFrame(), 1000 + i * 20);
    }

    expect(stt.frames()).toBe(0);
    expect(stt.streams()).toBe(0);
    expect(ev.finals).toEqual([]);
    expect(ev.errors).toEqual(["speech_routing_denied_stt:DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR"]);
    expect(session.speechRouting().stt.allowed).toBe(false);
  });

  it("C2: avslaget rapporteres ÉN gang per sesjon, ikke én gang per lydramme (ingen feil-flom)", () => {
    const stt = spyStt(EXTERNAL_DECLARED);
    const ev = recordingEvents();
    const session = new VoiceSession(identityIn("health"), staticCore, stt.adapter, spyTts(LOCAL_DECLARED).adapter, ev.handlers);
    for (let i = 0; i < 50; i++) {
      session.pushAudio(loudFrame(), 2000 + i * 20);
    }
    expect(ev.errors).toHaveLength(1);
  });

  it("C3: ukjent memory space + ekstern STT → samme fail-closed avvisning", () => {
    const stt = spyStt(EXTERNAL_DECLARED);
    const ev = recordingEvents();
    const session = new VoiceSession(identityIn("ikke-en-space"), staticCore, stt.adapter, spyTts(LOCAL_DECLARED).adapter, ev.handlers);
    session.pushAudio(loudFrame(), 3000);
    expect(stt.frames()).toBe(0);
    expect(ev.errors).toEqual(["speech_routing_denied_stt:DENIED_UNKNOWN_MEMORY_SPACE"]);
  });

  it("C4: health-space + LOKAL STT → rammene slippes gjennom (porten blokkerer ekstern behandling, ikke tale som sådan)", () => {
    const stt = spyStt(LOCAL_DECLARED);
    const ev = recordingEvents();
    const session = new VoiceSession(identityIn("health"), staticCore, stt.adapter, spyTts(LOCAL_DECLARED).adapter, ev.handlers);
    for (let i = 0; i < 10; i++) {
      session.pushAudio(loudFrame(), 4000 + i * 20);
    }
    expect(stt.frames()).toBeGreaterThan(0);
    expect(ev.errors).toEqual([]);
  });

  it("C5: personal-space + ekstern STT → uendret oppførsel (BO-12 regresjonsvern)", () => {
    const stt = spyStt(EXTERNAL_DECLARED);
    const ev = recordingEvents();
    const session = new VoiceSession(identityIn("personal"), staticCore, stt.adapter, spyTts(EXTERNAL_DECLARED).adapter, ev.handlers);
    for (let i = 0; i < 10; i++) {
      session.pushAudio(loudFrame(), 5000 + i * 20);
    }
    expect(stt.frames()).toBeGreaterThan(0);
    expect(ev.errors).toEqual([]);
    expect(session.speechRouting().stt.outcome).toBe("ALLOWED_EXTERNAL_PROCESSOR");
  });
});

describe("D-122 D: TTS-siden - svarteksten fra en sensitiv samtale når aldri en ekstern behandler", () => {
  it("D1: health-space + ekstern TTS → synthesize kalles ALDRI, eksplisitt feil, svaret er fortsatt levert som tekst", async () => {
    const tts = spyTts(EXTERNAL_DECLARED);
    const ev = recordingEvents();
    const session = new VoiceSession(identityIn("health"), staticCore, spyStt(LOCAL_DECLARED).adapter, tts.adapter, ev.handlers);

    session.replayFinal("utt-health-1", "hva sa legen om prøvesvaret");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(tts.calls()).toEqual([]);
    expect(ev.errors).toEqual(["speech_routing_denied_tts:DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR"]);
    expect(session.speechRouting().tts.allowed).toBe(false);
  });

  it("D2: personal-space + ekstern TTS → syntetiseres som før (ingen regresjon)", async () => {
    const tts = spyTts(EXTERNAL_DECLARED);
    const ev = recordingEvents();
    const session = new VoiceSession(identityIn("personal"), staticCore, spyStt(LOCAL_DECLARED).adapter, tts.adapter, ev.handlers);

    session.replayFinal("utt-personal-1", "hei");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(tts.calls()).toEqual(["svar fra jarvis"]);
    expect(ev.errors).toEqual([]);
  });
});
