import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalWhisperStt } from "../src/stt.ts";

/**
 * Task #125 (D-217): DB-uavhengige tester for `LocalWhisperStt` mot en
 * FAKET whisper.cpp-binær (`test/fixtures/mock-whisper-*.sh`) - INGEN ekte
 * whisper.cpp/modell nødvendig eller antatt installert (Q-32 punkt 3 forblir
 * åpent for selve installasjonen). Beviser den EKTE subprosess-/WAV-/
 * feilhåndteringskoden: `pushAudio()`-buffring, `pcm16ToWav()`-skriving til
 * en midlertidig fil FØR prosessen startes, korrekt argv (`-m`/`-f`/`-nt`/
 * `-l`), stdout trimmet riktig, og feilbanen når prosessen feiler.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const OK_BIN = `${FIXTURES}/mock-whisper-ok.sh`;
const FAIL_BIN = `${FIXTURES}/mock-whisper-fail.sh`;
const CLOSES_STDIN_EARLY_BIN = `${FIXTURES}/mock-whisper-closes-stdin-early.sh`;
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
  it("pushAudio() bufres, end() skriver wav og returnerer TRIMMET stdout", async () => {
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
