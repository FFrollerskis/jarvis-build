import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalPiperTts } from "../src/tts.ts";

/**
 * Task #125 (D-217): DB-uavhengige tester for `LocalPiperTts` mot en FAKET
 * piper-binær (`test/fixtures/mock-piper-*.sh`) - INGEN ekte piper/
 * stemmemodell nødvendig eller antatt installert (Q-32 punkt 3 forblir åpent
 * for selve installasjonen). Beviser den EKTE subprosess-/strømme-/
 * kanselleringskoden: korrekt argv (`--model`/`--output_raw`), rammer
 * leveres FORTLØPENDE (ekte strømming, ikke batch), feilbanen når prosessen
 * feiler, og at `cancel()` faktisk DREPER den underliggende prosessen
 * (session.ts sitt §15/§16-krav - se `tts.ts` sin klassekommentar).
 */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const OK_BIN = `${FIXTURES}/mock-piper-ok.sh`;
const FAIL_BIN = `${FIXTURES}/mock-piper-fail.sh`;
const HANG_BIN = `${FIXTURES}/mock-piper-hang.sh`;
const CLOSES_STDIN_EARLY_BIN = `${FIXTURES}/mock-piper-closes-stdin-early.sh`;
const MODEL = `${FIXTURES}/fake-voice.onnx`;

async function collect(iterable: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of iterable) {
    out.push(chunk);
  }
  return out;
}

describe("A: available() krever BÅDE binær OG modell", () => {
  it("mangler modell -> false selv med binær satt", () => {
    const tts = new LocalPiperTts(OK_BIN, undefined);
    expect(tts.available()).toBe(false);
  });

  it("mangler binær -> false selv med modell satt", () => {
    const tts = new LocalPiperTts(undefined, MODEL);
    expect(tts.available()).toBe(false);
  });

  it("begge satt -> true", () => {
    const tts = new LocalPiperTts(OK_BIN, MODEL);
    expect(tts.available()).toBe(true);
  });
});

describe("B: synthesize() kaster FØR noe prosessarbeid uten binær/modell", () => {
  it("local_piper_not_configured uten binær", () => {
    const tts = new LocalPiperTts(undefined, MODEL);
    expect(() => tts.synthesize("hei")).toThrow("local_piper_not_configured");
  });

  it("local_piper_not_configured uten modell", () => {
    const tts = new LocalPiperTts(OK_BIN, undefined);
    expect(() => tts.synthesize("hei")).toThrow("local_piper_not_configured");
  });
});

describe("C: frames - lykkes-banen mot mock-piper-ok.sh, EKTE strømming", () => {
  it("leverer alle tre rammene i rekkefølge, sammenslått lik forventet byte-strøm", async () => {
    const tts = new LocalPiperTts(OK_BIN, MODEL);
    const playback = tts.synthesize("hei jarvis");
    const frames = await collect(playback.frames);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.concat(frames).toString("utf8")).toBe("AAAABBBBCCCC");
  });

  it("rammer ankommer FORTLØPENDE, ikke som én batch ved slutt (ekte strømming - mock-scriptet sover 0.3s mellom hver)", async () => {
    const tts = new LocalPiperTts(OK_BIN, MODEL);
    const playback = tts.synthesize("hei jarvis");
    const it_ = playback.frames[Symbol.asyncIterator]();
    const t0 = performance.now();
    const first = await it_.next();
    const firstMs = performance.now() - t0;
    expect(first.done).toBe(false);
    // Første ramme kommer FØR den andre sleep(0.3) - langt under 300ms.
    expect(firstMs).toBeLessThan(250);
    const second = await it_.next();
    expect(second.done).toBe(false);
    const third = await it_.next();
    expect(third.done).toBe(false);
    const fourth = await it_.next();
    expect(fourth.done).toBe(true);
  });
});

describe("D: frames - feilbanen mot mock-piper-fail.sh", () => {
  it("prosessfeil kastes som local_piper_process_failed med kode + stderr-utdrag, INGEN rammer levert", async () => {
    const tts = new LocalPiperTts(FAIL_BIN, MODEL);
    const playback = tts.synthesize("hei jarvis");
    await expect(collect(playback.frames)).rejects.toThrow(/local_piper_process_failed:2:.*voice_model_load_error/);
  });
});

describe("D-256: synthesize() krasjer ALDRI hele prosessen når binæren avslutter FØR stdin er ferdigskrevet", () => {
  it("EPIPE på proc.stdin.end(text) blir en normal avvist Promise, ALDRI en uhåndtert 'error'-hendelse", async () => {
    // Samme bug-klasse/funn som D-256 sin LocalWhisperStt-test (stt.ts) -
    // mock-piper-fail.sh drenerer hele stdin FØR den avslutter (`cat
    // >/dev/null`), noe som skjulte dette fullstendig - denne fixturen
    // avslutter i stedet UTEN å lese noe. En stor nok tekst kreves for at
    // selve `.end(text)`-skrivingen ikke passer i OS-pipe-bufferet i ett
    // syscall (samme grunn som `bigPcm()` i stt.ts sin egen test).
    const tts = new LocalPiperTts(CLOSES_STDIN_EARLY_BIN, MODEL);
    const bigText = "hei jarvis ".repeat(100_000);
    const playback = tts.synthesize(bigText);
    await expect(collect(playback.frames)).rejects.toThrow(/local_piper_process_failed:9:/);
  });
});

describe("E: cancel() - §15/§16-kravet: dreper prosessen umiddelbart, henger ALDRI", () => {
  it("cancel() rett etter første ramme stopper strømmen UTEN å vente på at prosessen selv avslutter (mock-piper-hang.sh sover 30s)", async () => {
    const tts = new LocalPiperTts(HANG_BIN, MODEL);
    const playback = tts.synthesize("hei jarvis");
    const it_ = playback.frames[Symbol.asyncIterator]();
    const first = await it_.next();
    expect(first.done).toBe(false);
    playback.cancel();
    const second = await it_.next();
    expect(second.done).toBe(true);
  }, 10_000);

  it("cancel() kalt FØR generatoren i det hele tatt begynner å kjøre gir en umiddelbart tom strøm (ingen prosess spawnes)", async () => {
    const tts = new LocalPiperTts(HANG_BIN, MODEL);
    const playback = tts.synthesize("hei jarvis");
    playback.cancel();
    const frames = await collect(playback.frames);
    expect(frames).toEqual([]);
  });
});
