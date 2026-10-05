import { MarkerStt, type SttAdapter } from "./stt.ts";
import { FakeTts, type TtsAdapter } from "./tts.ts";

/**
 * REMEDIERING DEL 1 (JARVIS-080): tidligere falt kjeden STILLE til `MarkerStt`/
 * `FakeTts` (deterministiske test-doubles) når verken OpenAI eller lokal
 * whisper/piper var tilgjengelig - gatewayen startet og så frisk ut, men
 * "forsto" kun testmarkører og "snakket" med en fake. Nå feiler oppstarten
 * lukket (kaster) med mindre test-adaptere er EKSPLISITT tillatt
 * (`JARVIS_VOICE_ALLOW_TEST_ADAPTERS=true`, kun dev/test).
 */
export class VoiceAdaptersUnavailableError extends Error {
  constructor(readonly missing: Array<"stt" | "tts">) {
    super(
      `ingen ekte ${missing.join("/").toUpperCase()}-adapter tilgjengelig (verken OpenAI-nøkkel eller lokal whisper/piper) - ` +
        `voice-gateway starter ikke med test-adaptere. Sett JARVIS_VOICE_ALLOW_TEST_ADAPTERS=true KUN i dev/test.`
    );
    this.name = "VoiceAdaptersUnavailableError";
  }
}

interface Candidate<T> {
  available(): boolean;
  readonly name: string;
  readonly _t?: T;
}

export function selectSpeechAdapters(
  candidates: {
    openAiStt: SttAdapter & Candidate<SttAdapter>;
    /** D-403: eierens egen Whisper-server (privat adresse). Valgt FØRST når konfigurert; faller selv tilbake til lokal whisper.cpp ved feil. */
    remoteWhisperStt?: SttAdapter & Candidate<SttAdapter>;
    localWhisperStt: SttAdapter & Candidate<SttAdapter>;
    openAiTts: TtsAdapter & Candidate<TtsAdapter>;
    localPiperTts: TtsAdapter & Candidate<TtsAdapter>;
  },
  env: Record<string, string | undefined> = process.env
): { stt: SttAdapter; tts: TtsAdapter } {
  const allowTest = env["JARVIS_VOICE_ALLOW_TEST_ADAPTERS"] === "true";
  const stt: SttAdapter | undefined = candidates.remoteWhisperStt?.available()
    ? candidates.remoteWhisperStt
    : candidates.openAiStt.available()
    ? candidates.openAiStt
    : candidates.localWhisperStt.available()
      ? candidates.localWhisperStt
      : allowTest
        ? new MarkerStt()
        : undefined;
  const tts: TtsAdapter | undefined = candidates.openAiTts.available()
    ? candidates.openAiTts
    : candidates.localPiperTts.available()
      ? candidates.localPiperTts
      : allowTest
        ? new FakeTts()
        : undefined;
  const missing: Array<"stt" | "tts"> = [];
  if (!stt) missing.push("stt");
  if (!tts) missing.push("tts");
  if (!stt || !tts) throw new VoiceAdaptersUnavailableError(missing);
  return { stt, tts };
}
