import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { VoiceSession, type CoreClient, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";

/**
 * D-262 (Tobias direkte i chat, live NAS-test MED D-261 sin nye logging
 * aktiv): heartbeaten viste ekte tale/stillhet-mønster og INGEN feillogg noe
 * sted - likevel svarte Jarvis fortsatt ikke ("ingen svar"). D-261 sin
 * 2-sekunders sampling kan strukturelt aldri bekrefte om `end_of_turn`
 * faktisk fyrte, og `finishTurn()` sin tomt-transkript-gren var (og er, for
 * selve transkriptet) fullstendig stille. Denne suiten beviser at de tre nye
 * logglinjene (`voice_vad_transition`, `voice_stt_result`,
 * `voice_core_reply_sent`) faktisk skriver det de skal, i BEGGE de to
 * scenarioene som var umulig å skille fra hverandre før denne fiksen: en tur
 * som fullfører med et ekte transkript, og en tur der STT-en returnerer tomt.
 */

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

function fakeTts(): TtsAdapter {
  return {
    name: "fake-tts",
    processor: LOCAL_TEST_PROCESSOR,
    available: () => true,
    synthesize(): TtsPlayback {
      return { frames: (async function* () {})(), cancel: () => undefined };
    }
  };
}

function events(): SessionEvents {
  return {
    onState: () => undefined,
    onPartial: () => undefined,
    onFinal: () => undefined,
    onReply: () => undefined,
    onTtsFrame: () => undefined,
    onTtsCancelled: () => undefined,
    onMetrics: () => undefined,
    onError: () => undefined,
    onToolActivity: () => undefined
  };
}

/** Lydrammer for VAD-banen (identisk mønster som d258-testen). */
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

function logged(spy: ReturnType<typeof vi.spyOn>, msg: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null && m["msg"] === msg);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("D-262: turens hele livsløp logges definitivt - skiller 'turen kjørte aldri' fra 'turen kjørte, svaret nådde bare ikke klienten'", () => {
  it("en fullstendig, vellykket tur logger BÅDE speech_start OG end_of_turn, et ikke-tomt voice_stt_result, og voice_core_reply_sent", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const core: CoreClient = {
      chat: async () => ({ reply: "Hallo, hvordan kan jeg hjelpe?", routed: "model", session_id: "sess-test" })
    };
    const session = new VoiceSession(identity, core, fixedStt("hei jarvis"), fakeTts(), events());
    await runVoiceTurn(session);

    const transitions = logged(spy, "voice_vad_transition").map((m) => m["vad_event"]);
    expect(transitions).toEqual(["speech_start", "end_of_turn"]);

    const sttResults = logged(spy, "voice_stt_result");
    expect(sttResults).toHaveLength(1);
    expect(sttResults[0]).toMatchObject({ text_length: "hei jarvis".length });

    const replies = logged(spy, "voice_core_reply_sent");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      reply_chars: "Hallo, hvordan kan jeg hjelpe?".length,
      routed: "model",
      cancelled: false
    });
  });

  it("et TOMT STT-transkript logger voice_stt_result med text_length 0 og ALDRI voice_core_reply_sent - eksakt symptomet whisper.cpp kan produsere for svak/kort tale", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const core: CoreClient = {
      chat: async () => ({ reply: "skal aldri kalles", routed: "model", session_id: "sess-test" })
    };
    const session = new VoiceSession(identity, core, fixedStt(""), fakeTts(), events());
    await runVoiceTurn(session);

    const sttResults = logged(spy, "voice_stt_result");
    expect(sttResults).toHaveLength(1);
    expect(sttResults[0]).toMatchObject({ text_length: 0 });

    expect(logged(spy, "voice_core_reply_sent")).toHaveLength(0);
  });

  it("voice_vad_transition logges ALDRI for de hyppige speech/silence-hendelsene mellom overgangene (kun ved selve overgangen)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new VoiceSession(identity, { chat: async () => ({ reply: "x", routed: "model", session_id: "s" }) }, fixedStt(""), fakeTts(), events());

    let t = 1000;
    session.pushAudio(speech(), t); // speech_start
    session.pushAudio(speech(), (t += 50)); // speech (ikke logget)
    session.pushAudio(speech(), (t += 50)); // speech (ikke logget)
    session.pushAudio(silence(), (t += 100)); // silence (< hangover, D-275: 700ms, ikke logget)
    session.pushAudio(silence(), (t += 800)); // end_of_turn (D-275: > 700ms hangover)

    expect(logged(spy, "voice_vad_transition")).toHaveLength(2);
  });
});
