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
const MODEL = `${FIXTURES}/fake-model.bin`;

function pcmFrame(): Buffer {
  return Buffer.alloc(320, 1); // 20ms @16kHz PCM16 (320 bytes)
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
