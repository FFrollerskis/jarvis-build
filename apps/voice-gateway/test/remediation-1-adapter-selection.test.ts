import { describe, expect, it } from "vitest";
import { VoiceAdaptersUnavailableError, selectSpeechAdapters } from "../src/adapter-selection.ts";
import { LocalWhisperStt, OpenAiStt } from "../src/stt.ts";
import { LocalPiperTts, OpenAiTts } from "../src/tts.ts";

/**
 * Remediering del 1 (JARVIS-080): ingen stille fallback til MarkerStt/FakeTts.
 */
const stt = (available: boolean, name: string) =>
  Object.assign(Object.create(available ? OpenAiStt.prototype : LocalWhisperStt.prototype), {
    name,
    available: () => available
  });
const tts = (available: boolean, name: string) =>
  Object.assign(Object.create(available ? OpenAiTts.prototype : LocalPiperTts.prototype), {
    name,
    available: () => available
  });

describe("selectSpeechAdapters", () => {
  it("foretrekker OpenAI, deretter lokal; ingen test-adaptere", () => {
    const picked = selectSpeechAdapters(
      { openAiStt: stt(false, "o-stt"), localWhisperStt: stt(true, "l-stt"), openAiTts: tts(true, "o-tts"), localPiperTts: tts(true, "l-tts") },
      {}
    );
    expect(picked.stt.name).toBe("l-stt");
    expect(picked.tts.name).toBe("o-tts");
  });

  it("feiler lukket når verken OpenAI eller lokal STT/TTS er tilgjengelig", () => {
    const none = { openAiStt: stt(false, "a"), localWhisperStt: stt(false, "b"), openAiTts: tts(false, "c"), localPiperTts: tts(false, "d") };
    expect(() => selectSpeechAdapters(none, {})).toThrow(VoiceAdaptersUnavailableError);
    try {
      selectSpeechAdapters(none, {});
    } catch (err) {
      expect((err as VoiceAdaptersUnavailableError).missing).toEqual(["stt", "tts"]);
    }
    // bare TTS mangler
    expect(() =>
      selectSpeechAdapters({ ...none, openAiStt: stt(true, "ok") }, {})
    ).toThrow(/TTS/);
  });

  it("test-adaptere er kun mulig med eksplisitt JARVIS_VOICE_ALLOW_TEST_ADAPTERS=true", () => {
    const none = { openAiStt: stt(false, "a"), localWhisperStt: stt(false, "b"), openAiTts: tts(false, "c"), localPiperTts: tts(false, "d") };
    expect(() => selectSpeechAdapters(none, { JARVIS_VOICE_ALLOW_TEST_ADAPTERS: "1" })).toThrow(VoiceAdaptersUnavailableError);
    expect(() => selectSpeechAdapters(none, { JARVIS_VOICE_ALLOW_TEST_ADAPTERS: "" })).toThrow(VoiceAdaptersUnavailableError);
    const picked = selectSpeechAdapters(none, { JARVIS_VOICE_ALLOW_TEST_ADAPTERS: "true" });
    expect(picked.stt.name).toBe("marker-test");
    expect(picked.tts.name).toBe("fake-tts");
  });
});
