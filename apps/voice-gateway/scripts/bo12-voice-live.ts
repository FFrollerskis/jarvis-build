// BO-12 D-30 live-akseptanse på runtime-hosten (§30-§33). Kjøres der
// OPENAI_API_KEY finnes og jarvis-api kjører:
//   node --env-file=.env --experimental-transform-types apps/voice-gateway/scripts/bo12-voice-live.ts
// (transform-types, IKKE strip-types: kodebasen bruker TS parameter properties,
// som ga ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX med strip-types på Node 24-host.)
// Mikrofon trengs ikke: norsk testlyd genereres via TTS og verifiseres via STT
// (rundtur). Printer aldri secrets - kun statuser, transkript og latenser.
import { OpenAiStt } from "../src/stt.ts";
import { OpenAiTts } from "../src/tts.ts";
import { HttpCoreClient } from "../src/server.ts";
import { SentenceChunker } from "../src/chunker.ts";
import { transcriptMatches } from "../src/acceptance.ts";
import type { CoreStreamEvent, VoiceIdentity } from "../src/session.ts";

const API_URL = process.env["JARVIS_CORE_URL"] ?? "http://localhost:3010";
const identity: VoiceIdentity = {
  person_id: "person-tobias",
  tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
  device_id: "jarvis-voice-live",
  memory_space: "personal",
  channel: "voice"
};

const tts = new OpenAiTts();
// OpenAI TTS leverer 24 kHz PCM - STT-rundturen må wav-pakke med riktig rate.
const stt = new OpenAiStt(undefined, "whisper-1", 24000);
if (!tts.available() || !stt.available()) {
  throw new Error("FEIL: OPENAI_API_KEY mangler - live-akseptansen krever STT/TTS-nøkkel");
}

async function collect(playback: { frames: AsyncIterable<Buffer> }): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const frame of playback.frames) {
    parts.push(frame);
  }
  return Buffer.concat(parts);
}

async function transcribe(pcm: Buffer): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  const stream = stt.startStream();
  // OpenAI STT-adapteren buffres per tur; wav-innpakking skjer i adapteren.
  stream.pushAudio(pcm);
  const text = await stream.end();
  return { text, ms: Date.now() - started };
}

// ===== §30/§20: norsk STT via TTS-rundtur + kost-grunnlag =====
console.log("== §30 NORSK STT (TTS→STT-rundtur) ==");
const PHRASES = ["Hva står på kalenderen min i dag?", "Hva er atten ganger sju?"];
for (const phrase of PHRASES) {
  const t0 = Date.now();
  const audio = await collect(tts.synthesize(phrase));
  const ttsMs = Date.now() - t0;
  const { text, ms: sttMs } = await transcribe(audio);
  console.log(
    `  "${phrase}" → tts=${ttsMs}ms audio=${Math.round(audio.length / 32)}ms stt=${sttMs}ms → "${text}"`
  );
  // §10 (live-funn): semantisk ekvivalens godtas ("atten ganger sju" ≙ "18 x 7") -
  // vilkårlig dårlige transkript feiler fortsatt (samme overlappsterskel).
  if (!transcriptMatches(phrase, text)) {
    throw new Error(`FEIL §30: transkript for ulikt originalen ("${text}")`);
  }
}
console.log("§30 STT PASS (norsk rundtur).");

// ===== §30-§31/§33: transcript → Core (AI Mesh) → streaming → TTS-chunking =====
async function voiceTurn(question: string, provider?: string): Promise<void> {
  const core = new HttpCoreClient(API_URL);
  const chunks: string[] = [];
  const chunker = new SentenceChunker((c) => chunks.push(c));
  const tools: string[] = [];
  const tEnd = Date.now(); // "end of speech" = transkript klart
  let tFirstToken = 0;
  const reply = await core.chatStream(
    { ...identity, ...(provider !== undefined ? { provider } : {}) },
    question,
    (e: CoreStreamEvent) => {
      if (e.type === "token" && tFirstToken === 0) {
        tFirstToken = Date.now();
      }
      if (e.type === "token") {
        chunker.push(e.text);
      } else {
        tools.push(e.tool_name);
      }
    }
  );
  chunker.flush();
  const firstChunk = chunks[0] ?? reply.reply;
  const t1 = Date.now();
  const audio = await collect(tts.synthesize(firstChunk));
  const ttfaFromEnd = Date.now() - tEnd;
  console.log(
    `  [${provider ?? "AUTO"}] "${question}" → routed=${reply.routed} tools=[${tools.join(",")}] ` +
      `model_ttft=${tFirstToken ? tFirstToken - tEnd : "-"}ms tts_ttfa=${Date.now() - t1}ms ` +
      `end_of_speech→first_audio=${ttfaFromEnd}ms audio=${Math.round(audio.length / 32)}ms chunks=${chunks.length}`
  );
  console.log(`    svar: "${reply.reply.slice(0, 120)}"`);
}

console.log("== §30 KALENDER-VOICE-TOOL-FLYT (via eksisterende gateway) ==");
await voiceTurn("Hva står på kalenderen min i dag?");
console.log("== §31 IKKE-TOOL-SPØRSMÅL ==");
await voiceTurn("Hva er 18 ganger 7? Svar kort.");
console.log("== §33 CROSS-PROVIDER (samme voice-pipeline) ==");
await voiceTurn("Si hei på norsk med én setning.", "openai");
await voiceTurn("Si hei på norsk med én setning.", "anthropic");

// ===== §32: barge-in - abort mot Core midt i langt streamet svar =====
console.log("== §32 BARGE-IN (abort under generering) ==");
{
  const core = new HttpCoreClient(API_URL);
  const controller = new AbortController();
  let tokens = 0;
  const err = await core
    .chatStream(identity, "Fortell en lang historie om fjell, minst 200 ord.", (e) => {
      if (e.type === "token") {
        tokens += 1;
        if (tokens >= 5) {
          controller.abort(); // bruker "begynner å snakke"
        }
      }
    }, controller.signal)
    .then(() => null)
    .catch((e: unknown) => e);
  if ((err as Error | null)?.name !== "AbortError") {
    throw new Error(`FEIL §32: forventet AbortError, fikk ${(err as Error | null)?.name ?? "suksess"}`);
  }
  console.log(`  abortert etter ${tokens} tokens - generering kansellert upstream (P1A-kjeden).`);
  // Neste tur virker (ingen zombie):
  await voiceTurn("Si 'klar igjen' på norsk.");
  console.log("§32 PASS: barge-in-abort + ren neste tur.");
}

console.log("== BO-12 VOICE LIVE-AKSEPTANSE FERDIG ==");
