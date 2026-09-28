import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { VoiceSession, type CoreClient, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";

/**
 * D-261 (Tobias direkte i chat): en ellers HELT feilfri tilkobling - "started"
 * med `SERVER_VERIFIED`, ingen krasj, ingen feilmelding noe sted - etterfulgt
 * av total stillhet (INGEN state-endring i det hele tatt) i ~57 sekunder,
 * deretter en ren frakobling. Verken klientens Tekniske logg (viser kun
 * MOTTATTE meldinger) eller container-loggen (`pushAudio()` logget
 * ingenting) kunne skille mellom "lydrammer når aldri serveren" og
 * "lydrammer ankommer, men krysser aldri VAD-terskelen". Eksplisitt gjentatt
 * tilbakemelding gjennom hele denne økten: "sett opp bedre logging på hele
 * systemet". Denne suiten beviser de to nye, throttlede diagnostikk-
 * logglinjene i `pushAudio()` faktisk skriver det de skal - se
 * feltkommentaren over `audioFrameCount`/`lastAudioHeartbeatAt` i
 * session.ts for hele funnet.
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

/** Stille ramme (bevisst under VAD-terskelen 0.05): energi = 0. */
const silentFrame = (): Buffer => Buffer.alloc(640);

const core: CoreClient = {
  chat: async () => ({ reply: "x", routed: "model", session_id: "s" })
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("D-261: pushAudio() logger et diagnostisk 'hjertesignal' - skiller 'ingen lydrammer ankommer' fra 'lydrammer ankommer, men treffer aldri VAD-terskelen'", () => {
  it("logger voice_audio_first_frame ÉN gang, ved akkurat den FØRSTE rammen (ikke ved senere rammer)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new VoiceSession(identity, core, fixedStt(""), fakeTts(), events());

    session.pushAudio(silentFrame(), 100);
    session.pushAudio(silentFrame(), 200);
    session.pushAudio(silentFrame(), 300);

    const firstFrameCalls = spy.mock.calls.filter((c) => String(c[0]).includes("voice_audio_first_frame"));
    expect(firstFrameCalls).toHaveLength(1);
    expect(firstFrameCalls.at(0)?.[0]).toBe(JSON.stringify({ msg: "voice_audio_first_frame", bytes: 640 }));
  });

  it("logger voice_audio_heartbeat throttlet til maks én gang per 2000ms (klokke-styrt via atMs, ikke per ramme)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new VoiceSession(identity, core, fixedStt(""), fakeTts(), events());

    session.pushAudio(silentFrame(), 100); // t=100: for tidlig, ingen heartbeat ennå
    session.pushAudio(silentFrame(), 1900); // t=1900: fortsatt < 2000ms siden forrige (0)
    session.pushAudio(silentFrame(), 2200); // t=2200: >= 2000ms siden forrige (0) -> heartbeat #1
    session.pushAudio(silentFrame(), 3000); // t=3000: kun 800ms siden forrige (2200) -> ingen
    session.pushAudio(silentFrame(), 4300); // t=4300: >= 2000ms siden forrige (2200) -> heartbeat #2

    const heartbeats = spy.mock.calls
      .filter((c) => String(c[0]).includes("voice_audio_heartbeat"))
      .map((c) => JSON.parse(String(c[0])));
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[0]).toMatchObject({ msg: "voice_audio_heartbeat", frame_count: 3, vad_event: "silence" });
    expect(heartbeats[1]).toMatchObject({ msg: "voice_audio_heartbeat", frame_count: 5, vad_event: "silence" });
  });

  it("heartbeat sin rms_energy avslører PRESIST en stille/for-svak mikrofoninngang (energi ~0, under VAD-terskelen 0.05) - dette er nøyaktig signalet som manglet i D-261 sitt live-funn", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new VoiceSession(identity, core, fixedStt(""), fakeTts(), events());

    session.pushAudio(silentFrame(), 2100);

    const heartbeat = spy.mock.calls
      .map((c) => JSON.parse(String(c[0])))
      .find((m) => m.msg === "voice_audio_heartbeat");
    expect(heartbeat.rms_energy).toBe(0);
    expect(heartbeat.vad_event).toBe("silence");
  });
});
