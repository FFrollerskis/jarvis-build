import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalWhisperStt } from "../src/stt.ts";

/**
 * Task #125 (D-217): DB-uavhengige tester for `LocalWhisperStt` mot en
 * FAKET whisper.cpp-binær (`test/fixtures/mock-whisper-*.sh`) - INGEN ekte
 * whisper.cpp/modell nødvendig eller antatt installert (Q-32 punkt 3 forblir
 * åpent for selve installasjonen). Beviser den EKTE subprosess-/WAV-/
 * feilhåndteringskoden: `pushAudio()`-buffring, korrekt argv (`-m`/`-f`/
 * `-nt`/`-otxt`/`-of`/`-l`), og feilbanen når prosessen feiler.
 *
 * D-281: `end()` leser IKKE lenger transkriptet fra `stdout` - se
 * `../src/stt.ts` sin kommentar over `spawn()`-kallet for hvorfor
 * whisper.cpp sin `/dev/stdout`-gjenåpning er upålitelig under Node.js sin
 * pipe-baserte `child_process.spawn()`. Fixturene skriver derfor til
 * `<-of-argumentet>.txt` (whisper.cpp sin egen `-of`-skrivevei), samme sted
 * `end()` nå faktisk leser fra.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const OK_BIN = `${FIXTURES}/mock-whisper-ok.sh`;
const FAIL_BIN = `${FIXTURES}/mock-whisper-fail.sh`;
const CLOSES_STDIN_EARLY_BIN = `${FIXTURES}/mock-whisper-closes-stdin-early.sh`;
const BLANK_AUDIO_BIN = `${FIXTURES}/mock-whisper-blank-audio.sh`;
const MODEL = `${FIXTURES}/fake-model.bin`;

function pcmFrame(): Buffer {
  return Buffer.alloc(320, 1); // 20ms @16kHz PCM16 (320 bytes)
}

function bigPcm(): Buffer {
  // Stor nok til at .end(wav) sin write ikke passer i OS-pipe-bufferet i ett
  // syscall - kreves for å pålitelig reprodusere EPIPE-kappløpet under (se
  // D-256), samme grunn som den ekte lyden fra en flerturs-samtale ville
  // vært mer enn nok bytes til å trigge dette.
  return Buffer.alloc(1_000_000, 1);
}

describe("A: available() krever BÅDE binær OG modell", () => {
  it("mangler modell -> false selv med binær satt", () => {
    const stt = new LocalWhisperStt(OK_BIN, undefined);
    expect(stt.available()).toBe(false);
  });

  it("mangler binær -> false selv med modell satt", () => {
    const stt = new LocalWhisperStt(undefined, MODEL);
    expect(stt.available()).toBe(false);
  });

  it("begge satt -> true", () => {
    const stt = new LocalWhisperStt(OK_BIN, MODEL);
    expect(stt.available()).toBe(true);
  });
});

describe("B: startStream() kaster FØR noe prosessarbeid uten binær/modell", () => {
  it("local_whisper_not_configured uten binær", () => {
    const stt = new LocalWhisperStt(undefined, MODEL);
    expect(() => stt.startStream()).toThrow("local_whisper_not_configured");
  });

  it("local_whisper_not_configured uten modell", () => {
    const stt = new LocalWhisperStt(OK_BIN, undefined);
    expect(() => stt.startStream()).toThrow("local_whisper_not_configured");
  });
});

describe("C: end() - lykkes-banen mot mock-whisper-ok.sh", () => {
  it("pushAudio() bufres, end() leser og returnerer TRIMMET tekst fra -of-filen", async () => {
    const stt = new LocalWhisperStt(OK_BIN, MODEL, 16000, "no");
    const stream = stt.startStream();
    stream.pushAudio(pcmFrame());
    stream.pushAudio(pcmFrame());
    const text = await stream.end();
    expect(text).toBe("hei jarvis");
  });

  it("tom lyd (ingen pushAudio-kall) fungerer likevel - wav-headeren alene er ikke-tom", async () => {
    const stt = new LocalWhisperStt(OK_BIN, MODEL);
    const stream = stt.startStream();
    const text = await stream.end();
    expect(text).toBe("hei jarvis");
  });

  it("onPartial() er en bevisst no-op (batch-CLI, se klassekommentaren) - kastes ALDRI, kalles ALDRI", async () => {
    const stt = new LocalWhisperStt(OK_BIN, MODEL);
    const stream = stt.startStream();
    const partials: string[] = [];
    stream.onPartial((t) => partials.push(t));
    stream.pushAudio(pcmFrame());
    await stream.end();
    expect(partials).toEqual([]);
  });
});

describe("D: end() - feilbanen mot mock-whisper-fail.sh", () => {
  it("prosessfeil kastes som local_whisper_process_failed med kode + stderr-utdrag", async () => {
    const stt = new LocalWhisperStt(FAIL_BIN, MODEL);
    const stream = stt.startStream();
    stream.pushAudio(pcmFrame());
    await expect(stream.end()).rejects.toThrow(/local_whisper_process_failed:3:.*model_load_error/);
  });
});

describe("D-256: end() krasjer ALDRI hele prosessen når binæren avslutter FØR stdin er ferdigskrevet", () => {
  it("EPIPE på proc.stdin.end(wav) blir en normal avvist Promise, ALDRI en uhåndtert 'error'-hendelse", async () => {
    // Live funn på NAS-en: mock-whisper-ok.sh/mock-whisper-fail.sh drenerer
    // BEGGE hele stdin FØR de avslutter (`wc -c <&0`/`cat >/dev/null`), noe
    // som skjulte denne bug-klassen fullstendig i den opprinnelige suiten -
    // DENNE fixturen avslutter derimot UTEN å lese noe, akkurat som den
    // reelle produksjonsfeilen. FØR fiksen (manglende `proc.stdin.on("error",
    // ...)`) kastet dette en uhåndtert exception som krasjet HELE
    // Node-prosessen - selve testen ville aldri kommet hit i det hele tatt,
    // den ville tatt ned test-runneren.
    const stt = new LocalWhisperStt(CLOSES_STDIN_EARLY_BIN, MODEL);
    const stream = stt.startStream();
    stream.pushAudio(bigPcm());
    await expect(stream.end()).rejects.toThrow(/local_whisper_process_failed:7:/);
  });
});

describe("D-263/D-264: end() logger et diagnostikk-utdrag av whisper.cpp sin EGEN stderr NÅR (og KUN når) den lykkes (kode 0) MED et tomt resultat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kode 0 + tomt stdout -> voice_stt_empty_result_diagnostic med wav_bytes og et stderr-utdrag SOM FAKTISK NÅR FORBI det flerlinjers modell-laste-banneret, ALDRI en kastet feil", async () => {
    // D-264: fixturen sender et REALISTISK, flerlinjers whisper.cpp-banner
    // (over 300 tegn alene) FØR selve "no speech"-linjen - reproduserer det
    // EKTE live-funnet der et 300-tegns utdrag (D-263 sin opprinnelige
    // grense) kuttet av MIDT i banneret og aldri viste den nyttige delen.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stt = new LocalWhisperStt(BLANK_AUDIO_BIN, MODEL);
    const stream = stt.startStream();
    stream.pushAudio(pcmFrame());
    const text = await stream.end();
    expect(text).toBe("");

    const diagnostics = spy.mock.calls
      .map((c) => JSON.parse(String(c[0])))
      .filter((m) => m.msg === "voice_stt_empty_result_diagnostic");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].wav_bytes).toBeGreaterThan(44); // WAV-header (44) + selve PCM-en
    expect(diagnostics[0].stderr_excerpt.length).toBeGreaterThan(300); // beviser D-263 sin ORIGINALE, for smale grense IKKE lenger gjelder
    expect(diagnostics[0].stderr_excerpt).toContain("no speech detected");
    // D-271: fixturen skriver ALDRI noe til stdout (kun stderr) - beviser at
    // `stdout_raw_length: 0` faktisk skiller "ingen bytes ankom i det hele
    // tatt" fra "bytes ankom, men var kun whitespace" på NESTE live-forsøk.
    expect(diagnostics[0].stdout_raw_length).toBe(0);
  });

  it("kode 0 + IKKE-tomt stdout (den vanlige lykkes-banen) logger ALDRI diagnostikken", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stt = new LocalWhisperStt(OK_BIN, MODEL);
    const stream = stt.startStream();
    stream.pushAudio(pcmFrame());
    await stream.end();

    const diagnostics = spy.mock.calls
      .map((c) => JSON.parse(String(c[0])))
      .filter((m) => m.msg === "voice_stt_empty_result_diagnostic");
    expect(diagnostics).toHaveLength(0);
  });
});

describe("E: to påfølgende streams er isolerte (ingen delt buffer-tilstand mellom turer)", () => {
  it("to startStream()-kall får hver sin egen chunks-buffer", async () => {
    const stt = new LocalWhisperStt(OK_BIN, MODEL);
    const first = stt.startStream();
    first.pushAudio(pcmFrame());
    const second = stt.startStream();
    second.pushAudio(pcmFrame());
    const [a, b] = await Promise.all([first.end(), second.end()]);
    expect(a).toBe("hei jarvis");
    expect(b).toBe("hei jarvis");
  });
});
