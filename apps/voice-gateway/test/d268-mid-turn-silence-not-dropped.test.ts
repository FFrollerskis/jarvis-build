import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { VoiceSession, type CoreClient, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";

/**
 * D-268 (live NAS-funn, SAMME test-runde som D-267 sin -nth 1.01-fiks): etter
 * at D-267 beviste at whisper.cpp sin egen no-speech-vakt IKKE lenger var
 * problemet (ekte, ikke-null decode-tid observert i live-loggen), var
 * transkripsjonen FORTSATT `text_length: 0` - med whisper-rapportert varighet
 * på kun 0,6-0,7 sek for en hel ytring. `pushAudio()` sendte tidligere kun
 * rammer til STT-adapteren når `vadEvent` var "speech"/"speech_start" - ENHVER
 * ramme under terskelen ("silence", `EnergyVad.push()`) ble hoppet over, OGSÅ
 * midt i en allerede aktiv tur (et kort opphold mellom ord, en stemmeløs
 * konsonant) FØR `hangoverMs` faktisk var oppnådd. Slike rammer ble dermed
 * ALDRI del av WAV-en som ble sendt til whisper.cpp - ikke trimmet i endene,
 * men SPLEISET UT AV MIDTEN, som produserer diskontinuerlig lyd. Denne
 * suiten beviser at en slik midt-i-turen "silence"-ramme (under hangover) NÅ
 * faktisk når STT-adapteren, mens selve avslutningsrammen (`end_of_turn`) og
 * rammer FØR/ETTER en tur fortsatt IKKE gjør det.
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

/** STT-spion: teller HVER ramme som faktisk nådde adapteren (samme mønster som ua7-testen). */
function spyStt(text: string): { adapter: SttAdapter; frameCount: () => number } {
  let frames = 0;
  return {
    frameCount: () => frames,
    adapter: {
      name: "spy-stt",
      processor: LOCAL_TEST_PROCESSOR,
      available: () => true,
      startStream(): SttStream {
        return {
          pushAudio: () => {
            frames++;
          },
          end: async () => text,
          onPartial: () => undefined
        };
      }
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

/** Lydrammer for VAD-banen (identisk mønster som d262-testen). */
function speech(): Buffer {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) {
    b.writeInt16LE(9000, i * 2);
  }
  return b;
}
const silence = (): Buffer => Buffer.alloc(640);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("D-268: en kort stillhet MIDT i en aktiv tur (under hangoverMs) droppes IKKE lenger fra lyden som sendes til STT", () => {
  it("en 'silence'-ramme midt i turen (100ms < hangover, D-275: 700ms) når STT-adapteren, IKKE bare speech/speech_start-rammer", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stt = spyStt("hei jarvis");
    const core: CoreClient = {
      chat: async () => ({ reply: "svar", routed: "model", session_id: "sess-test" })
    };
    const session = new VoiceSession(identity, core, stt.adapter, fakeTts(), events());

    let t = 1000;
    session.pushAudio(speech(), t); // speech_start -> pushet (1)
    session.pushAudio(speech(), (t += 50)); // speech -> pushet (2)
    session.pushAudio(silence(), (t += 100)); // silence, MIDT i turen (< hangover) -> pushet NÅ (3)
    session.pushAudio(speech(), (t += 50)); // speech igjen (samme ord fortsetter) -> pushet (4)
    session.pushAudio(silence(), (t += 800)); // >= hangover (D-275: 700) -> end_of_turn, IKKE pushet
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stt.frameCount()).toBe(4);
    spy.mockRestore();
  });

  it("rammer FØR speech_start og ETTER end_of_turn når fortsatt ALDRI STT-adapteren (ingen skjult, kontinuerlig opptak)", async () => {
    const stt = spyStt("");
    const core: CoreClient = {
      chat: async () => ({ reply: "x", routed: "model", session_id: "s" })
    };
    const session = new VoiceSession(identity, core, stt.adapter, fakeTts(), events());

    let t = 1000;
    session.pushAudio(silence(), t); // idle silence FØR tale -> ikke pushet
    session.pushAudio(silence(), (t += 100)); // fortsatt idle -> ikke pushet
    session.pushAudio(speech(), (t += 100)); // speech_start -> pushet (1)
    session.pushAudio(silence(), (t += 800)); // >= hangover (D-275: 700) -> end_of_turn, ikke pushet
    session.pushAudio(silence(), (t += 100)); // etter turen, idle igjen -> ikke pushet
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stt.frameCount()).toBe(1);
  });
});
