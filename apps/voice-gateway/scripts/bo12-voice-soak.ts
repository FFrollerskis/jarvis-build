// D-30 FINAL HOST ACCEPTANCE HARDENING §4/§6: 10-turn soak over ÉN
// sammenhengende VoiceSession/runtime-sesjon (samme forutsetninger som
// bo12-voice-live.ts). Kjøres på hosten:
//   node --env-file=.env --experimental-transform-types apps/voice-gateway/scripts/bo12-voice-soak.ts
// Blander no-tool/kalender-verktøy/normal samtale/tvunget OpenAI/tvunget
// Anthropic/kansellering (ekte barge-in). Turn 6 og 10 gjentar turn 2s
// kalenderspørsmål med VILJE - dette er den live-observerbare Q-18-sjekken
// (§5): samme spørsmål i samme sesjon kan gi tomt/dedupert svar (se
// OPEN_QUESTIONS.md Q-18 for det deterministiske beviset). Printer aldri
// secrets - kun statuser, transkript og latenser.
import { OpenAiStt } from "../src/stt.ts";
import { OpenAiTts } from "../src/tts.ts";
import { HttpCoreClient } from "../src/server.ts";
import { VoiceSession } from "../src/session.ts";
import type { TurnMetrics, VoiceIdentity } from "../src/session.ts";

const API_URL = process.env["JARVIS_CORE_URL"] ?? "http://localhost:3010";
const identity: VoiceIdentity = {
  person_id: "person-tobias",
  tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
  device_id: "jarvis-voice-live",
  memory_space: "personal",
  channel: "voice"
};

const tts = new OpenAiTts();
const stt = new OpenAiStt(undefined, "whisper-1", 24000);
if (!tts.available() || !stt.available()) {
  throw new Error("FEIL: OPENAI_API_KEY mangler - soak krever STT/TTS-nøkkel");
}

async function collect(playback: { frames: AsyncIterable<Buffer> }): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const frame of playback.frames) {
    parts.push(frame);
  }
  return Buffer.concat(parts);
}

function latencyLine(m: TurnMetrics): string {
  const sttLat = m.t_final_transcript && m.t_end_of_turn ? m.t_final_transcript - m.t_end_of_turn : undefined;
  const ttft = m.t_model_first_token && m.t_end_of_turn ? m.t_model_first_token - m.t_end_of_turn : undefined;
  const tool = m.t_tool_activity && m.t_model_first_token ? m.t_model_first_token - m.t_tool_activity : undefined;
  const ttfa = m.t_tts_first_frame && m.t_first_tts_request ? m.t_tts_first_frame - m.t_first_tts_request : undefined;
  const total = m.t_done && m.t_speech_start ? m.t_done - m.t_speech_start : undefined;
  return (
    `stt=${sttLat ?? "-"}ms model_ttft=${ttft ?? "-"}ms tool=${tool ?? "n/a"}ms ` +
    `tts_ttfa=${ttfa ?? "-"}ms e2e_first_audio=${m.end_of_speech_to_first_audio_ms ?? "-"}ms total_turn=${total ?? "-"}ms`
  );
}

interface TurnSpec {
  label: string;
  text: string;
  provider?: string;
}

const TURNS: TurnSpec[] = [
  { label: "1 no-tool", text: "Hva er tolv pluss femten?" },
  { label: "2 calendar", text: "Hva står på kalenderen min i dag?" },
  { label: "3 normal", text: "Fortell en kort vits på norsk." },
  { label: "4 forced-openai", text: "Si hei på norsk med én setning.", provider: "openai" },
  { label: "5 forced-anthropic", text: "Si hei på norsk med én setning.", provider: "anthropic" },
  { label: "6 calendar-repeat (Q-18 live-observasjon)", text: "Hva står på kalenderen min i dag?" },
  { label: "7 no-tool", text: "Hva er hovedstaden i Norge?" },
  { label: "8 long (avbrytes av turn 9)", text: "Fortell en lang og detaljert historie om havet, minst to hundre ord." },
  { label: "9 cancellation (barge-in mot turn 8)", text: "Stopp, si i stedet 'klar igjen' på norsk." },
  { label: "10 calendar (skal fungere normalt - sesjon ikke korrupt)", text: "Hva står på kalenderen min i dag?" }
];

const metricsByTurn: Array<TurnMetrics | undefined> = [];
const toolsByTurn: string[][] = [];
const errorsByTurn: string[][] = [];
const sessionIds = new Set<string>();
let duplicateToolExecutions = 0;
let sessionCorrupted = false;

const core = new HttpCoreClient(API_URL);
// Mutérbar identity-referanse: VoiceSession bruker ÉN identity for hele sin
// levetid (per design - tale gir ingen ekstra authority per tur, §43), men vi
// trenger provider-override PER TUR (4/5) mens sesjonskontinuiteten (§4)
// krever ÉN VoiceSession. Muterer .provider rett før hver pushAudio - lovlig
// (TS "readonly" på klassefeltet hindrer kun reassignment, ikke objektmutasjon)
// og speiler nøyaktig hvordan /chat allerede støtter per-kall provider (§33).
const sessionIdentity: VoiceIdentity = { ...identity };
let currentTurnTools: string[] = [];
let currentTurnErrors: string[] = [];
const session = new VoiceSession(sessionIdentity, core, stt, tts, {
  onState: () => undefined,
  onPartial: () => undefined,
  onFinal: () => undefined,
  onReply: (r) => sessionIds.add(r.session_id),
  onTtsFrame: () => undefined,
  onTtsCancelled: () => undefined,
  onMetrics: (m) => {
    metricsByTurn.push(m);
    toolsByTurn.push(currentTurnTools);
    errorsByTurn.push(currentTurnErrors);
    currentTurnTools = [];
    currentTurnErrors = [];
  },
  onError: (e) => currentTurnErrors.push(e),
  onToolActivity: (activity) => currentTurnTools.push(activity)
});

console.log(`== D-30 §4 10-TURN SOAK (ÉN sesjon, ${TURNS.length} turer) ==`);
for (let i = 0; i < TURNS.length; i++) {
  const spec = TURNS[i] as TurnSpec;
  const before = metricsByTurn.length;
  if (spec.provider !== undefined) {
    sessionIdentity.provider = spec.provider;
  } else {
    delete sessionIdentity.provider;
  }
  const audio = await collect(tts.synthesize(spec.text));
  const t = Date.now();
  session.pushAudio(audio, t);
  session.pushAudio(Buffer.alloc(640), t + 400);

  // Turn 9 er ment å avbryte turn 8 mens den fortsatt taler - vent til turn 8
  // faktisk er i gang med avspilling FØR turn 9 sitt "brukertale" sendes inn.
  if (i === 8) {
    const waitStart = Date.now();
    while (session.currentState() !== "speaking" && Date.now() - waitStart < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const started = Date.now();
  while (metricsByTurn.length <= before && Date.now() - started < 25_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (metricsByTurn.length <= before) {
    sessionCorrupted = true;
    console.log(`  [${i + 1}/10] ${spec.label}: TIMEOUT - ingen metrics mottatt (mulig sesjons-korrupsjon)`);
    break;
  }
  const m = metricsByTurn[metricsByTurn.length - 1] as TurnMetrics;
  const tools = toolsByTurn[toolsByTurn.length - 1] ?? [];
  const errs = errorsByTurn[errorsByTurn.length - 1] ?? [];
  // Duplicate-tool-i-samme-tur-sjekk (aldri to identiske verktøystatuser i én tur):
  if (new Set(tools).size < tools.length) {
    duplicateToolExecutions += tools.length - new Set(tools).size;
  }
  console.log(
    `  [${i + 1}/10] ${spec.label}: cancelled=${m.cancelled ?? false} tool_activity=[${tools.join(",")}] ` +
      `errors=[${errs.join(",")}] ${latencyLine(m)}`
  );
}

console.log(`\n== SOAK-OPPSUMMERING ==`);
console.log(`turer_fullført=${metricsByTurn.length}/${TURNS.length}`);
console.log(`session_ids_observert=${[...sessionIds].join(",")} (skal være NØYAKTIG 1 - sesjonskontinuitet)`);
console.log(`duplicate_tool_executions=${duplicateToolExecutions} (skal være 0)`);
console.log(`session_corrupted=${sessionCorrupted}`);

if (metricsByTurn.length < TURNS.length) {
  throw new Error(`FEIL §4: kun ${metricsByTurn.length}/${TURNS.length} turer fullførte`);
}
if (sessionIds.size !== 1) {
  throw new Error(`FEIL §4: forventet nøyaktig 1 session_id (sesjonskontinuitet), fikk ${sessionIds.size}`);
}
if (duplicateToolExecutions > 0) {
  throw new Error(`FEIL §4: ${duplicateToolExecutions} duplikate verktøyutførelser observert i én tur`);
}
if (sessionCorrupted) {
  throw new Error("FEIL §4: sesjonen ble korrupt underveis");
}
const last = metricsByTurn[9] as TurnMetrics;
if (last.cancelled) {
  throw new Error("FEIL §4: turn 10 (siste) skal IKKE være kansellert - sesjonen skal fungere normalt til slutt");
}
console.log("§4 PASS: 10/10 turer fullført, én sesjon, ingen duplikate verktøyutførelser, turn 10 normal.");
console.log(
  "MERK Q-18 (§5): sammenlign svarteksten fra turn 2, 6 og 10 manuelt over - identisk kalenderspørsmål i " +
    "samme sesjon. Hvis turn 6/10 svarer generisk/tomt der turn 2 ga et faktisk kalendersvar, er dette den " +
    "LIVE-observerbare siden av Q-18 (deterministisk bevist i modules/tool-gateway/test/q18-read-dedupe.test.ts)."
);
