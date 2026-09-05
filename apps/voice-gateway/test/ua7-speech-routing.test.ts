import { describe, expect, it } from "vitest";
import {
  evaluateSpeechRouting,
  speechSensitivityForMemorySpace,
  MemorySpaceSchema,
  SpeechProcessorDeclarationSchema,
  type MemorySpaceAuthority,
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
 *
 * RETTELSE etter uavhengig arkitekt-review av PR #71 (samme D-122):
 * suiten dekker nå de to funnene direkte -
 * **E**: en NAVNGITT, men uverifisert ekstern behandler er IKKE kvalifisert
 * (matrise-regel 3), og
 * **F**: en klient-oppgitt memory space kan ALDRI kvalifisere for ekstern
 * behandling, uansett hvor troverdig den ser ut (Q-32).
 */

/** Ekstern behandler der ALLE matrise-regel-3-feltene er verifisert. Finnes IKKE i dag - hypotetisk. */
const EXTERNAL_VERIFIED: SpeechProcessorDeclaration = {
  processor_id: "test-external-verified",
  locality: "external",
  processor_row_declared: true,
  processor_terms_status: "VERIFIED"
};
/** Ekstern behandler som er NAVNGITT i matrisen, men med `IKKE VERIFISERT`-felter. Dette er OpenAI i dag. */
const EXTERNAL_NAMED_UNVERIFIED: SpeechProcessorDeclaration = {
  processor_id: "test-external-named-unverified",
  locality: "external",
  processor_row_declared: true,
  processor_terms_status: "NOT_VERIFIED"
};
const EXTERNAL_UNDECLARED: SpeechProcessorDeclaration = {
  processor_id: "test-external-undeclared",
  locality: "external",
  processor_row_declared: false,
  processor_terms_status: "NOT_VERIFIED"
};
const LOCAL_DECLARED: SpeechProcessorDeclaration = {
  processor_id: "test-local",
  locality: "local",
  processor_row_declared: true,
  processor_terms_status: "NOT_APPLICABLE_LOCAL"
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

/**
 * Sesjonsfabrikk. `authority` utelatt = samme fail-closed default som
 * produksjonskoden (`CLIENT_ASSERTED`) - testene skal aldri være «snillere»
 * mot porten enn virkeligheten er.
 */
function sessionWith(
  memorySpace: string,
  stt: SttAdapter,
  tts: TtsAdapter,
  events: SessionEvents,
  authority?: MemorySpaceAuthority
): VoiceSession {
  return new VoiceSession(
    identityIn(memorySpace),
    staticCore,
    stt,
    tts,
    events,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    authority
  );
}

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
      expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, space, "SERVER_VERIFIED")).toMatchObject({
        allowed: true,
        outcome: "ALLOWED_EXTERNAL_PROCESSOR"
      });
    }
  });

  it("A2: health + ekstern behandler = AVVIST (D-23 / matrise-regel 2)", () => {
    expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, "health", "SERVER_VERIFIED")).toMatchObject({
      allowed: false,
      outcome: "DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR",
      sensitivity: "SECRET_RESTRICTED"
    });
  });

  it("A3: health + LOKAL behandler = tillatt - porten forbyr ikke tale, den forbyr EKSTERN behandling", () => {
    expect(evaluateSpeechRouting(LOCAL_DECLARED, "health", "CLIENT_ASSERTED")).toMatchObject({
      allowed: true,
      outcome: "ALLOWED_LOCAL_PROCESSOR"
    });
  });

  it("A4: ukjent/manglende memory space tolkes ALDRI som lav-sensitiv (D-81-lærdommen, fail-closed)", () => {
    for (const bogus of [undefined, "", "helse", "HEALTH", "unknown-space", "admin"]) {
      expect(speechSensitivityForMemorySpace(bogus)).toBeNull();
      expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, bogus, "SERVER_VERIFIED")).toMatchObject({
        allowed: false,
        outcome: "DENIED_UNKNOWN_MEMORY_SPACE"
      });
    }
  });

  it("A5: ekstern behandler UTEN erklært matriserad avvises for ALLE spaces (matrise-regel 1)", () => {
    for (const space of MemorySpaceSchema.options) {
      expect(evaluateSpeechRouting(EXTERNAL_UNDECLARED, space, "SERVER_VERIFIED")).toMatchObject({
        allowed: false,
        outcome: "DENIED_PROCESSOR_ROW_NOT_DECLARED"
      });
    }
  });

  it("A6: manglende rad slår ut FØR space-vurderingen - en lav-sensitiv space kan aldri 'redde' en uerklært behandler", () => {
    expect(evaluateSpeechRouting(EXTERNAL_UNDECLARED, "personal", "SERVER_VERIFIED").outcome).toBe(
      "DENIED_PROCESSOR_ROW_NOT_DECLARED"
    );
  });

  it("A7: en lokal behandler er tillatt selv med ukjent space, uerklært rad og klient-oppgitt space - lyden forlater aldri maskinen", () => {
    expect(
      evaluateSpeechRouting(
        {
          processor_id: "lokal",
          locality: "local",
          processor_row_declared: false,
          processor_terms_status: "NOT_VERIFIED"
        },
        "tullespace",
        "CLIENT_ASSERTED"
      )
    ).toMatchObject({ allowed: true, outcome: "ALLOWED_LOCAL_PROCESSOR" });
  });

  it("A8: erklæringen er `.strict()` - et ukjent felt kan ikke smugles inn i en behandler-erklæring", () => {
    expect(SpeechProcessorDeclarationSchema.safeParse({ ...EXTERNAL_VERIFIED, trust_me: true }).success).toBe(false);
  });
});

describe("D-122 E: NAVNGITT rad ≠ KVALIFISERT behandler (matrise-regel 3, arkitekt-funn 1)", () => {
  it("E1: en navngitt, men uverifisert ekstern behandler avvises for ALLE spaces - også med betrodd space-autoritet", () => {
    for (const space of MemorySpaceSchema.options) {
      expect(evaluateSpeechRouting(EXTERNAL_NAMED_UNVERIFIED, space, "SERVER_VERIFIED")).toMatchObject({
        allowed: false,
        outcome: "DENIED_PROCESSOR_TERMS_NOT_VERIFIED"
      });
    }
  });

  it("E2: vilkårssjekken slår ut FØR space-vurderingen - en lav-sensitiv space kan ikke 'redde' en uverifisert behandler", () => {
    expect(evaluateSpeechRouting(EXTERNAL_NAMED_UNVERIFIED, "personal", "SERVER_VERIFIED").outcome).toBe(
      "DENIED_PROCESSOR_TERMS_NOT_VERIFIED"
    );
  });

  it("E3: `NOT_APPLICABLE_LOCAL` på en EKSTERN behandler kvalifiserer IKKE - kun `VERIFIED` slipper gjennom (fail-closed)", () => {
    const mislabelled: SpeechProcessorDeclaration = {
      processor_id: "ekstern-som-later-som-den-er-lokal",
      locality: "external",
      processor_row_declared: true,
      processor_terms_status: "NOT_APPLICABLE_LOCAL"
    };
    expect(evaluateSpeechRouting(mislabelled, "personal", "SERVER_VERIFIED")).toMatchObject({
      allowed: false,
      outcome: "DENIED_PROCESSOR_TERMS_NOT_VERIFIED"
    });
  });

  it("E4: en erklæring UTEN `processor_terms_status` parser til `NOT_VERIFIED` - en glemt verdi åpner aldri porten", () => {
    const parsed = SpeechProcessorDeclarationSchema.parse({
      processor_id: "gammel-konfig-uten-feltet",
      locality: "external",
      processor_row_declared: true
    });
    expect(parsed.processor_terms_status).toBe("NOT_VERIFIED");
    expect(evaluateSpeechRouting(parsed, "personal", "SERVER_VERIFIED").allowed).toBe(false);
  });
});

describe("D-122 F: klient-oppgitt memory space kvalifiserer ALDRI for ekstern behandling (arkitekt-funn 2)", () => {
  it("F1: fullt verifisert ekstern behandler + klient-oppgitt space = AVVIST for hver eneste ikke-health space", () => {
    for (const space of MemorySpaceSchema.options.filter((s) => s !== "health")) {
      expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, space, "CLIENT_ASSERTED")).toMatchObject({
        allowed: false,
        outcome: "DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED"
      });
    }
  });

  it("F2: ADVERSARIELT - en klient som merker en helsesamtale `personal`/`business` vinner INGENTING", () => {
    // Angrepet arkitekt-reviewen beskrev: kall det noe ufarlig, få sky-ruting.
    for (const løgn of ["personal", "business", "project", "home", "shared", "guest"]) {
      const decision = evaluateSpeechRouting(EXTERNAL_VERIFIED, løgn, "CLIENT_ASSERTED");
      expect(decision.allowed).toBe(false);
      // Ingen av de påståtte spaces gir et ALLOWED-utfall - uansett hvilken.
      expect(decision.outcome).toBe("DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED");
    }
    // ...og med dagens faktiske behandler stanser det allerede på regel 3.
    expect(evaluateSpeechRouting(new OpenAiStt("k").processor, "personal", "CLIENT_ASSERTED").allowed).toBe(false);
  });

  it("F3: en klient som SELV oppgir `health` tas på ordet i innstrammende retning - avslaget er D-23, ikke en autoritetsteknikalitet", () => {
    expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, "health", "CLIENT_ASSERTED")).toMatchObject({
      allowed: false,
      outcome: "DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR"
    });
  });

  it("F4: porten er strengt INNSTRAMMENDE - betrodd autoritet kan tillate, klient-påstand kan bare nekte", () => {
    const trusted = evaluateSpeechRouting(EXTERNAL_VERIFIED, "personal", "SERVER_VERIFIED");
    const asserted = evaluateSpeechRouting(EXTERNAL_VERIFIED, "personal", "CLIENT_ASSERTED");
    expect(trusted.allowed).toBe(true);
    expect(asserted.allowed).toBe(false);
    // Det finnes ingen kombinasjon der CLIENT_ASSERTED gir et ALLOWED_EXTERNAL-utfall.
    for (const space of [...MemorySpaceSchema.options, "tullespace", undefined]) {
      expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, space, "CLIENT_ASSERTED").outcome).not.toBe(
        "ALLOWED_EXTERNAL_PROCESSOR"
      );
    }
  });

  it("F5: utfallet BÆRER tillitsnivået - et avslag kan aldri feilleses som «space var trygg»", () => {
    expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, "personal", "CLIENT_ASSERTED").memory_space_authority).toBe(
      "CLIENT_ASSERTED"
    );
    expect(evaluateSpeechRouting(LOCAL_DECLARED, "health", "SERVER_VERIFIED").memory_space_authority).toBe(
      "SERVER_VERIFIED"
    );
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
    expect(evaluateSpeechRouting(new OpenAiStt("k").processor, "health", "SERVER_VERIFIED").allowed).toBe(false);
    expect(evaluateSpeechRouting(new OpenAiTts("k").processor, "health", "SERVER_VERIFIED").allowed).toBe(false);
  });

  it("B3: OpenAI STT/TTS er AVVIST for ALLE spaces mens matriseradene står `IKKE VERIFISERT` (regel 3)", () => {
    // Dette er den ærlige, tilsiktede konsekvensen av arkitekt-funn 1: BO-12
    // sin talekjede er policy-blokkert til Q-32 faktisk er besvart av eieren.
    for (const space of MemorySpaceSchema.options) {
      for (const authority of ["SERVER_VERIFIED", "CLIENT_ASSERTED"] as const) {
        expect(evaluateSpeechRouting(new OpenAiStt("k").processor, space, authority).allowed).toBe(false);
        expect(evaluateSpeechRouting(new OpenAiTts("k").processor, space, authority).allowed).toBe(false);
      }
    }
    expect(evaluateSpeechRouting(new OpenAiStt("k").processor, "personal", "SERVER_VERIFIED").outcome).toBe(
      "DENIED_PROCESSOR_TERMS_NOT_VERIFIED"
    );
  });

  it("B4: INGEN adapter i repoet påstår `VERIFIED` vilkår - verdien kan ikke flippes uten at matrisen endres først", () => {
    const declarations: SpeechProcessorDeclaration[] = [
      new OpenAiStt("k").processor,
      new OpenAiTts("k").processor,
      new MarkerStt().processor,
      new LocalWhisperStt("/bin/whisper").processor,
      new FakeTts().processor,
      new LocalPiperTts("/bin/piper").processor
    ];
    for (const declaration of declarations) {
      expect(declaration.processor_terms_status).not.toBe("VERIFIED");
      if (declaration.locality === "local") {
        expect(declaration.processor_terms_status).toBe("NOT_APPLICABLE_LOCAL");
      } else {
        expect(declaration.processor_terms_status).toBe("NOT_VERIFIED");
      }
    }
  });
});

describe("D-122 C: VoiceSession håndhever porten - ikke ÉN lydramme når en ukvalifisert behandler", () => {
  it("C1: health-space + ekstern STT → NULL rammer og NULL streams til adapteren, eksplisitt feil, ingen stille fallback", () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("health", stt.adapter, tts.adapter, ev.handlers);

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
    const stt = spyStt(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("health", stt.adapter, spyTts(LOCAL_DECLARED).adapter, ev.handlers);
    for (let i = 0; i < 50; i++) {
      session.pushAudio(loudFrame(), 2000 + i * 20);
    }
    expect(ev.errors).toHaveLength(1);
  });

  it("C3: ukjent memory space + ekstern STT → samme fail-closed avvisning", () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("ikke-en-space", stt.adapter, spyTts(LOCAL_DECLARED).adapter, ev.handlers, "SERVER_VERIFIED");
    session.pushAudio(loudFrame(), 3000);
    expect(stt.frames()).toBe(0);
    expect(ev.errors).toEqual(["speech_routing_denied_stt:DENIED_UNKNOWN_MEMORY_SPACE"]);
  });

  it("C4: health-space + LOKAL STT → rammene slippes gjennom (porten blokkerer ekstern behandling, ikke tale som sådan)", () => {
    const stt = spyStt(LOCAL_DECLARED);
    const ev = recordingEvents();
    const session = sessionWith("health", stt.adapter, spyTts(LOCAL_DECLARED).adapter, ev.handlers);
    for (let i = 0; i < 10; i++) {
      session.pushAudio(loudFrame(), 4000 + i * 20);
    }
    expect(stt.frames()).toBeGreaterThan(0);
    expect(ev.errors).toEqual([]);
  });

  it("C5: personal-space + KVALIFISERT ekstern STT + BETRODD space-autoritet → rammene slippes gjennom", () => {
    // Porten er ikke en blankosperre: er begge betingelsene faktisk oppfylt,
    // fungerer ekstern behandling nøyaktig som før.
    const stt = spyStt(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("personal", stt.adapter, spyTts(EXTERNAL_VERIFIED).adapter, ev.handlers, "SERVER_VERIFIED");
    for (let i = 0; i < 10; i++) {
      session.pushAudio(loudFrame(), 5000 + i * 20);
    }
    expect(stt.frames()).toBeGreaterThan(0);
    expect(ev.errors).toEqual([]);
    expect(session.speechRouting().stt.outcome).toBe("ALLOWED_EXTERNAL_PROCESSOR");
  });

  it("C6: DEFAULTEN er fail-closed - en sesjon som ikke oppgir space-autoritet får CLIENT_ASSERTED og avvises", () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("personal", stt.adapter, spyTts(LOCAL_DECLARED).adapter, ev.handlers);
    for (let i = 0; i < 10; i++) {
      session.pushAudio(loudFrame(), 6000 + i * 20);
    }
    expect(stt.frames()).toBe(0);
    expect(ev.errors).toEqual(["speech_routing_denied_stt:DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED"]);
  });

  it("C7: ADVERSARIELT - en klient som merker helsesamtalen `personal` får IKKE sky-behandling", () => {
    // Nøyaktig angrepet i arkitekt-funn 2, kjørt gjennom hele sesjonen.
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("personal", stt.adapter, tts.adapter, ev.handlers);
    for (let i = 0; i < 30; i++) {
      session.pushAudio(loudFrame(), 7000 + i * 20);
    }
    expect(stt.frames()).toBe(0);
    expect(stt.streams()).toBe(0);
    expect(tts.calls()).toEqual([]);
    expect(session.speechRouting().stt.allowed).toBe(false);
    expect(session.speechRouting().tts.allowed).toBe(false);
  });

  it("C8: de EKTE OpenAI-adapterne når ikke lyden i dag - regel 3 blokkerer før noe sendes ut av huset", () => {
    const ev = recordingEvents();
    const session = sessionWith("personal", new OpenAiStt("k"), new OpenAiTts("k"), ev.handlers, "SERVER_VERIFIED");
    session.pushAudio(loudFrame(), 8000);
    expect(ev.errors).toEqual(["speech_routing_denied_stt:DENIED_PROCESSOR_TERMS_NOT_VERIFIED"]);
    expect(session.speechRouting().tts.outcome).toBe("DENIED_PROCESSOR_TERMS_NOT_VERIFIED");
  });
});

describe("D-122 D: TTS-siden - svarteksten fra en sensitiv samtale når aldri en ekstern behandler", () => {
  it("D1: health-space + ekstern TTS → synthesize kalles ALDRI, eksplisitt feil, svaret er fortsatt levert som tekst", async () => {
    const tts = spyTts(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("health", spyStt(LOCAL_DECLARED).adapter, tts.adapter, ev.handlers);

    session.replayFinal("utt-health-1", "hva sa legen om prøvesvaret");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(tts.calls()).toEqual([]);
    expect(ev.errors).toEqual(["speech_routing_denied_tts:DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR"]);
    expect(session.speechRouting().tts.allowed).toBe(false);
  });

  it("D2: personal-space + KVALIFISERT ekstern TTS + BETRODD autoritet → syntetiseres som før (ingen regresjon)", async () => {
    const tts = spyTts(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("personal", spyStt(LOCAL_DECLARED).adapter, tts.adapter, ev.handlers, "SERVER_VERIFIED");

    session.replayFinal("utt-personal-1", "hei");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(tts.calls()).toEqual(["svar fra jarvis"]);
    expect(ev.errors).toEqual([]);
  });

  it("D3: samme sesjon med KLIENT-oppgitt space → svarteksten når aldri den eksterne behandleren", async () => {
    const tts = spyTts(EXTERNAL_VERIFIED);
    const ev = recordingEvents();
    const session = sessionWith("personal", spyStt(LOCAL_DECLARED).adapter, tts.adapter, ev.handlers);

    session.replayFinal("utt-personal-2", "hei");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(tts.calls()).toEqual([]);
    expect(ev.errors).toEqual(["speech_routing_denied_tts:DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED"]);
  });
});
