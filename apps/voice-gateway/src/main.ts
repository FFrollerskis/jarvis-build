import { VoiceHealth } from "./health.ts";
import { createVoiceGateway, HttpCoreClient } from "./server.ts";
import { MarkerStt, OpenAiStt } from "./stt.ts";
import { FakeTts, OpenAiTts } from "./tts.ts";

const port = Number(process.env["JARVIS_VOICE_PORT"] ?? 3020);
const coreUrl = process.env["JARVIS_CORE_URL"] ?? "http://127.0.0.1:3010";

// Leverandørvalg skjer i stop/go-porten (D-10/D-29); inntil da brukes første
// tilgjengelige adapter, med deterministisk fallback uten nettverk.
// BO-12 §5-§7: OpenAI STT/TTS er P0-baseline fordi OPENAI_API_KEY allerede er
// live i runtime; andre providere kommer bak samme adapterlag etter benchmark.
const openAiStt = new OpenAiStt();
const openAiTts = new OpenAiTts();
const stt = openAiStt.available() ? openAiStt : new MarkerStt();
const tts = openAiTts.available() ? openAiTts : new FakeTts();
const health = new VoiceHealth();

const server = createVoiceGateway({ core: new HttpCoreClient(coreUrl), stt, tts, health });
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "jarvis-voice-gateway listening", port, stt: stt.name, tts: tts.name }));
});
