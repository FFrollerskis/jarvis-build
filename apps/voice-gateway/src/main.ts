import "./normalize-env.ts";
import { envPort } from "@jarvis/contracts";
import { VoiceHealth } from "./health.ts";
import { UtteranceJournal } from "./journal.ts";
import { DEFAULT_VOICE_LIMITS, ProcessSlots } from "./limits.ts";
import { createVoiceGateway, HttpCoreClient } from "./server.ts";
import { selectSpeechAdapters } from "./adapter-selection.ts";
import { withLocalSttReserve, withLocalTtsReserve } from "./failover.ts";
import { LocalWhisperStt, OpenAiStt, RemoteWhisperStt } from "./stt.ts";
import { LocalPiperTts, OpenAiTts } from "./tts.ts";
import { EnergyVad } from "./vad.ts";

const port = envPort("JARVIS_VOICE_PORT", 3020);
const coreUrl = process.env["JARVIS_CORE_URL"] ?? "http://127.0.0.1:3010";

/**
 * D-353 (Tobias direkte i chat, live bruk: "den hører meg veldig dårlig
 * ... kan heller ikke bryte han midt i en samtale"). `EnergyVad` sin
 * `threshold`/`hangoverMs` var FØR dette kun tunbare via en kodeendring +
 * redeploy - ingen vei til å kalibrere dem mot Tobias sin FAKTISKE
 * mikrofon/rom uten en hel PR-runde per forsøk. Gjort miljøvariabel-styrt,
 * SAMME default-verdier som før (0.05/700ms, D-275) hvis variablene ikke
 * er satt - ingen atferdsendring uten eksplisitt operatør-handling. Lavere
 * `threshold` fanger svakere/lengre unna tale (inkl. avbrudds-forsøk midt i
 * Jarvis sin egen TTS-avspilling, se `session.ts` sin `bargeIn()` - selve
 * avbruddsmekanismen er BYGGET og testet, D-353 sin undersøkelse fant at
 * det mest sannsynlige hinderet er at VAD-en rett og slett ikke oppdager
 * avbruddsforsøket som tale i utgangspunktet).
 *
 * `numericEnvOrDefault()`: SAMME "tom streng er IKKE usatt"-disiplin som
 * D-236/D-340 allerede etablerte andre steder i kodebasen - `docker compose`
 * sin `${VAR:-}`-interpolasjon setter variabelen til en FAKTISK tom streng
 * når `.env` mangler verdien, og `Number("") ?? default` ville STILLE blitt
 * `0` (tom streng er ikke `null`/`undefined`, så `??` faller ALDRI tilbake) -
 * en reell, ikke-hypotetisk felle her: `threshold=0` ville gjort VAD-en
 * "alt er tale", en FORVERRING, ikke en no-op.
 */
function numericEnvOrDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const vadThreshold = numericEnvOrDefault("JARVIS_VOICE_VAD_THRESHOLD", 0.05);
const vadHangoverMs = numericEnvOrDefault("JARVIS_VOICE_VAD_HANGOVER_MS", 700);
/**
 * D-390: adaptiv terskel (støygulv) er PÅ som standard (`JARVIS_VOICE_VAD_ADAPTIVE=false` slår av) - D-353 fant at én fast
 * terskel var det mest sannsynlige hinderet for både «hører meg dårlig» og manglende avbrudd. Terskelen starter på
 * `vadThreshold` og flytter seg kun innenfor [0.012, 2x] etter hva rommet faktisk måler. ÉN VAD PER SESJON (fabrikk) - JARVIS-079.
 */
const vadAdaptive = (process.env["JARVIS_VOICE_VAD_ADAPTIVE"] ?? "true") !== "false";
const vad = (): EnergyVad => new EnergyVad(vadThreshold, vadHangoverMs, { adaptive: vadAdaptive });
/**
 * D-390: pre-roll (ordets begynnelse før VAD-en trigget), fyllord når modellen er treg til første token, og talt verktøystatus.
 * Alle styres fra miljøet; 0/false slår av.
 */
const sessionOptions = {
  preRollMs: numericEnvOrDefault("JARVIS_VOICE_PREROLL_MS", 300),
  fillerMs: numericEnvOrDefault("JARVIS_VOICE_FILLER_MS", 1500),
  speakToolActivity: (process.env["JARVIS_VOICE_SPEAK_TOOL_ACTIVITY"] ?? "true") !== "false"
};

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
// WP-V2 (K2): samtidige lokale prosesser er begrenset (CPU-tung whisper, lett piper) - se `VoiceLimits` og runbooken for begrunnelsen.
const whisperSlots = new ProcessSlots(DEFAULT_VOICE_LIMITS.maxConcurrentWhisper, DEFAULT_VOICE_LIMITS.processQueueTimeoutMs, DEFAULT_VOICE_LIMITS.reservedProvenSlots);
const piperSlots = new ProcessSlots(DEFAULT_VOICE_LIMITS.maxConcurrentPiper, DEFAULT_VOICE_LIMITS.processQueueTimeoutMs, DEFAULT_VOICE_LIMITS.reservedProvenSlots);
const localWhisperStt = new LocalWhisperStt(
  undefined, undefined, undefined, undefined, undefined, undefined, whisperSlots
);
// D-403: eierens egen Whisper-server (typisk PC-ens GPU over Tailscale). Kun aktiv med JARVIS_STT_REMOTE_URL på en PRIVAT adresse; faller
// selv tilbake til lokal whisper.cpp når serveren ikke svarer. En ikke-privat/ugyldig adresse avvises (fail-closed) og logges her.
const remoteWhisperStt = new RemoteWhisperStt(process.env["JARVIS_STT_REMOTE_URL"], {
  model: process.env["JARVIS_STT_REMOTE_MODEL"] || undefined,
  language: process.env["JARVIS_WHISPER_LANG"] || undefined,
  prompt: process.env["JARVIS_WHISPER_PROMPT"] || undefined,
  timeoutMs: Number(process.env["JARVIS_STT_REMOTE_TIMEOUT_MS"]) || undefined,
  fallback: localWhisperStt
});
if (process.env["JARVIS_STT_REMOTE_URL"]?.trim() && !remoteWhisperStt.available()) {
  console.error(JSON.stringify({ msg: "stt_remote_whisper_rejected", reason: "JARVIS_STT_REMOTE_URL er ugyldig eller ikke en privat adresse (loopback/RFC1918/Tailscale) - ignorert" }));
}
const localPiperTts = new LocalPiperTts(undefined, undefined, undefined, piperSlots);
if (process.env["JARVIS_PIPER_BIN"]?.trim() || process.env["JARVIS_PIPER_MODEL"]?.trim()) {
  // WP-V2 (K1c/K6b): ÉN synlig oppstartslinje om piper-oppsettet (kun koder/tall, aldri stier): hvorfor den evt. ikke er tilgjengelig, og hvor
  // samplerate kommer fra (env > stemmens .onnx.json > standard).
  console.log(
    JSON.stringify({
      msg: "jarvis-voice-gateway piper_config",
      available: localPiperTts.available(),
      unavailable_reason: localPiperTts.unavailableReason() ?? null,
      sample_rate: localPiperTts.sampleRate,
      sample_rate_source: localPiperTts.sampleRateSource
    })
  );
}
// REMEDIERING DEL 1 (JARVIS-080): INGEN stille fallback til MarkerStt/FakeTts - oppstarten
// feiler lukket uten en ekte adapter (se `adapter-selection.ts`).
function selectOrExit() {
  try {
    return selectSpeechAdapters({ openAiStt, remoteWhisperStt, localWhisperStt, openAiTts, localPiperTts });
  } catch (err) {
    console.error(JSON.stringify({ msg: "jarvis-voice-gateway startup_failed", error: (err as Error).message }));
    process.exit(1);
  }
}
const health = new VoiceHealth();
const selected = selectOrExit();
// WP-V2 (K4): failover SKY -> LOKAL komponeres ETTER utvelgelsen (`selectSpeechAdapters` er uendret). Kun når den valgte adapteren er
// EKSTERN og en lokal reserve faktisk er tilgjengelig (binær + modell finnes); aldri lokal -> sky. Se docs/runbooks/WPV2_VOICE_ROBUSTNESS.md.
const stt = withLocalSttReserve(selected.stt, localWhisperStt, { health });
const tts = withLocalTtsReserve(selected.tts, localPiperTts, { health });

// WP-V2 (K5, v2.1 §14): ÉN utterance-journal for hele prosessen - delt av alle sesjoner (før: laget per sesjonsstart).
const journal = new UtteranceJournal();
const server = createVoiceGateway({ core: new HttpCoreClient(coreUrl), stt, tts, health, vad, session: sessionOptions, journal });
// WP-V2 (K1): en feil ved oppstart (typisk EADDRINUSE) skal STOPPE prosessen synlig - `createVoiceGateway` har en `error`-lytter som
// bare logger, så uten denne ville en mislykket `listen()` gitt en prosess som lever uten å lytte.
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(JSON.stringify({ msg: "jarvis-voice-gateway server_error", code: err.code ?? "unknown", listening: server.listening }));
  if (!server.listening) {
    process.exit(1);
  }
});
server.listen(port, () => {
  console.log(
    JSON.stringify({
      msg: "jarvis-voice-gateway listening",
      port,
      stt: stt.name,
      tts: tts.name,
      stt_failover_reserve: stt !== selected.stt ? localWhisperStt.name : null,
      tts_failover_reserve: tts !== selected.tts ? localPiperTts.name : null,
      tts_sample_rate: tts.sampleRate ?? 24_000,
      vad_threshold: vadThreshold,
      vad_hangover_ms: vadHangoverMs,
      vad_adaptive: vadAdaptive,
      ...sessionOptions
    })
  );
});
