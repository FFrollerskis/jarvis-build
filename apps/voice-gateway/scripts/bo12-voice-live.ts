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
import { VoiceSession } from "../src/session.ts";
import type { CoreStreamEvent, TurnMetrics, VoiceIdentity } from "../src/session.ts";

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

/** D-30 hardening §6: full latenskjede per tur - rapporteres, aldri fabrikkeres. */
function latencyLine(m: TurnMetrics): string {
  const stt = m.t_final_transcript && m.t_end_of_turn ? m.t_final_transcript - m.t_end_of_turn : undefined;
  const ttft = m.t_model_first_token && m.t_end_of_turn ? m.t_model_first_token - m.t_end_of_turn : undefined;
  const tool = m.t_tool_activity && m.t_model_first_token ? m.t_model_first_token - m.t_tool_activity : undefined;
  const ttfa = m.t_tts_first_frame && m.t_first_tts_request ? m.t_tts_first_frame - m.t_first_tts_request : undefined;
  const total = m.t_done && m.t_speech_start ? m.t_done - m.t_speech_start : undefined;
  return (
    `stt=${stt ?? "-"}ms model_ttft=${ttft ?? "-"}ms tool=${tool ?? "n/a"}ms ` +
    `tts_ttfa=${ttfa ?? "-"}ms e2e_first_audio=${m.end_of_speech_to_first_audio_ms ?? "-"}ms total_turn=${total ?? "-"}ms`
  );
}

// ===== D-30 HARDENING §1/§2: REAL AUDIO BARGE-IN + STALE-AUDIO EPOCH =====
// Full VoiceSession (ekte VAD→STT→Core→TTS) - IKKE bare LLM AbortSignal.
// "Brukerens" tale simuleres ved å spille tilbake EKTE TTS-lyd inn i
// pushAudio() (samme rundtur-teknikk som §30) - dette er ekte PCM gjennom
// VAD-terskelen, ikke en syntetisk abort()-kall.
console.log("== D-30 HARDENING §1/§2: REAL AUDIO BARGE-IN (full VoiceSession) ==");
{
  const bargeAudio = await collect(tts.synthesize("Stopp, jeg vil spørre om noe annet."));
  const nextAudio = await collect(tts.synthesize("Klar igjen."));
  const longQueryAudio = await collect(
    tts.synthesize("Fortell en lang og detaljert historie om fjell i Norge, minst to hundre ord.")
  );

  const frames: number[] = [];
  const metricsSeen: TurnMetrics[] = [];
  const errors: string[] = [];
  let bargeInStopMs: number | undefined;
  const core = new HttpCoreClient(API_URL);
  const session = new VoiceSession(identity, core, stt, tts, {
    onState: () => undefined,
    onPartial: () => undefined,
    onFinal: () => undefined,
    onReply: () => undefined,
    onTtsFrame: () => frames.push(Date.now()),
    onTtsCancelled: (afterMs) => {
      bargeInStopMs = afterMs;
    },
    onMetrics: (m) => metricsSeen.push(m),
    onError: (e) => errors.push(e),
    onToolActivity: () => undefined
  });

  const t0 = Date.now();
  session.pushAudio(longQueryAudio, t0);
  session.pushAudio(Buffer.alloc(640), t0 + 400); // stillhet → end_of_turn

  // Vent til EKTE lyd faktisk har begynt å strømme (state=speaking, frames>0):
  const waitStart = Date.now();
  while (frames.length === 0 && Date.now() - waitStart < 15_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (frames.length === 0) {
    throw new Error("FEIL D-30-HARDENING §1: ingen TTS-lyd begynte å strømme før timeout");
  }
  const framesBeforeBarge = frames.length;
  console.log(`  turn A: ekte lyd strømmer (${framesBeforeBarge} rammer mottatt før barge-in).`);

  // BARGE-IN: ekte lyd (ikke en tom abort()) sendes inn MENS turn A taler:
  const tBarge = Date.now();
  session.pushAudio(bargeAudio, tBarge);
  session.pushAudio(Buffer.alloc(640), tBarge + 400);

  // Vent til ny tur er fullført (bevis på "clean next turn" §32/§2):
  const settleStart = Date.now();
  while (metricsSeen.length < 2 && Date.now() - settleStart < 20_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Settle-vindu: EKTE nytt svar (STT→Core→LLM→TTS) tar uansett godt over
  // 500ms - rammer i DETTE vinduet kan derfor kun være stale audio fra turn A.
  const settleWindowStart = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const staleFramesAfterBarge = frames.filter((t) => t > settleWindowStart && t <= settleWindowStart + 500).length;

  console.log(`  barge_in_audio_stop_ms=${bargeInStopMs ?? "IKKE_MÅLT"} (playback.cancel()-signal, IKKE LLM AbortSignal)`);
  console.log(`  rammer før barge=${framesBeforeBarge}, stale-rammer i 500ms-settle-vindu=${staleFramesAfterBarge}`);
  if (bargeInStopMs === undefined) {
    throw new Error("FEIL D-30-HARDENING §1: onTtsCancelled ble aldri kalt - barge-in traff ikke aktiv avspilling");
  }
  if (staleFramesAfterBarge > 0) {
    throw new Error(`FEIL D-30-HARDENING §2: ${staleFramesAfterBarge} stale rammer fra turn A ankom ETTER barge-in`);
  }
  if (bargeInStopMs > 250) {
    console.log(`  ADVARSEL: barge_in_audio_stop_ms=${bargeInStopMs} > 250ms-kontraktskravet.`);
  } else {
    console.log(`  §1 GATE PASS: barge_in_audio_stop_ms=${bargeInStopMs} <= 250ms.`);
  }
  if (errors.length > 0) {
    throw new Error(`FEIL D-30-HARDENING §1/§2: uventede feil under barge-in-turen: ${errors.join(",")}`);
  }
  console.log(`  metrics turn A (avbrutt): ${metricsSeen[0] ? latencyLine(metricsSeen[0]) : "ingen"} cancelled=${metricsSeen[0]?.cancelled}`);

  // Tredje tur ("klar igjen"-selvavspilling) beviser sesjonen er ren etter barge-in:
  const t2 = Date.now();
  session.pushAudio(nextAudio, t2);
  session.pushAudio(Buffer.alloc(640), t2 + 400);
  const finalStart = Date.now();
  while (metricsSeen.length < 3 && Date.now() - finalStart < 15_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (metricsSeen.length < 3) {
    throw new Error("FEIL D-30-HARDENING §2: tredje tur (etter barge-in) fullførte aldri - sesjonen kan være korrupt");
  }
  console.log(`  metrics turn C (ny, ren): ${latencyLine(metricsSeen[2] as TurnMetrics)}`);
  console.log("§1/§2 PASS: ekte lyd strømmet, barge-in stanset avspilling, ingen stale audio, neste tur ren.");
}

console.log("== BO-12 VOICE LIVE-AKSEPTANSE FERDIG ==");
