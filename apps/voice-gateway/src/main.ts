import { VoiceHealth } from "./health.ts";
import { createVoiceGateway, HttpCoreClient } from "./server.ts";
import { LocalWhisperStt, MarkerStt, OpenAiStt } from "./stt.ts";
import { FakeTts, LocalPiperTts, OpenAiTts } from "./tts.ts";

const port = Number(process.env["JARVIS_VOICE_PORT"] ?? 3020);
const coreUrl = process.env["JARVIS_CORE_URL"] ?? "http://127.0.0.1:3010";

// Leverandørvalg skjer i stop/go-porten (D-10/D-29); inntil da brukes første
// tilgjengelige adapter, med deterministisk fallback uten nettverk.
// BO-12 §5-§7: OpenAI STT/TTS er P0-baseline fordi OPENAI_API_KEY allerede er
// live i runtime; andre providere kommer bak samme adapterlag etter benchmark.
// Task #125 (D-217): lokal whisper.cpp/piper er NESTE tilgjengelige tier - kun
// aktiv når Tobias faktisk har satt JARVIS_WHISPER_BIN/_MODEL eller
// JARVIS_PIPER_BIN/_MODEL (Q-32 punkt 3) - `available()` er `false` inntil da,
// og kjeden faller videre til den deterministiske test-adapteren uendret.
const openAiStt = new OpenAiStt();
const openAiTts = new OpenAiTts();
const localWhisperStt = new LocalWhisperStt();
const localPiperTts = new LocalPiperTts();
const stt = openAiStt.available() ? openAiStt : localWhisperStt.available() ? localWhisperStt : new MarkerStt();
const tts = openAiTts.available() ? openAiTts : localPiperTts.available() ? localPiperTts : new FakeTts();
const health = new VoiceHealth();

const server = createVoiceGateway({ core: new HttpCoreClient(coreUrl), stt, tts, health });
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "jarvis-voice-gateway listening", port, stt: stt.name, tts: tts.name }));
});
