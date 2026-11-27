import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalPiperTts, resolvePiperSampleRate } from "../src/tts.ts";
import { TestClient, startGateway, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 K6b (JARVIS-080): samplerate for piper-rammene leses fra stemmens `<modell>.onnx.json` (`audio.sample_rate`; lest i kildekoden til
 * OHF-Voice/piper1-gpl: `config["audio"]["sample_rate"]`, `config_path = f"{model_path}.json"` - IKKE kjørt mot en ekte stemme),
 * `JARVIS_PIPER_SAMPLE_RATE` overstyrer, standard 22 050. Kilden rapporteres i /status, avvik logges.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const OK_BIN = `${FIXTURES}/mock-piper-ok.sh`;

let gateway: RunningGateway | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await gateway?.close();
  gateway = undefined;
});

async function voiceWithConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wpv2-voice-"));
  const model = join(dir, "no_NO-test-medium.onnx");
  await writeFile(model, "fixture: ikke en ekte stemme\n");
  await writeFile(`${model}.json`, typeof config === "string" ? config : JSON.stringify(config));
  return model;
}

describe("resolvePiperSampleRate", () => {
  it("stemmens egen konfig (audio.sample_rate) brukes når env ikke er satt", async () => {
    const model = await voiceWithConfig({ audio: { sample_rate: 16000, quality: "medium" }, num_speakers: 1 });
    expect(resolvePiperSampleRate(model, undefined)).toEqual({ rate: 16000, source: "model_config" });
  });

  it("env overstyrer, og et avvik mot modellfilen rapporteres (mismatch)", async () => {
    const model = await voiceWithConfig({ audio: { sample_rate: 16000 } });
    expect(resolvePiperSampleRate(model, "22050")).toEqual({ rate: 22050, source: "env", mismatch: { env: 22050, model_config: 16000 } });
    expect(resolvePiperSampleRate(model, "16000")).toEqual({ rate: 16000, source: "env" }); // enig: ingen mismatch
  });

  it("manglende/ugyldig konfig og ugyldige verdier faller til standard 22 050 (aldri en gjetning)", async () => {
    expect(resolvePiperSampleRate(undefined, undefined)).toEqual({ rate: 22050, source: "default" });
    expect(resolvePiperSampleRate("/nonexistent/voice.onnx", undefined)).toEqual({ rate: 22050, source: "default" });
    for (const bad of ["{ikke json", "[]", "null", JSON.stringify({ audio: {} }), JSON.stringify({ audio: { sample_rate: "22050" } }),
      JSON.stringify({ audio: { sample_rate: 22050.5 } }), JSON.stringify({ audio: { sample_rate: 0 } }), JSON.stringify({ audio: { sample_rate: 5 } }),
      JSON.stringify({ audio: { sample_rate: 10_000_000 } }), JSON.stringify({ sample_rate: 16000 })]) {
      const model = await voiceWithConfig(bad);
      expect(resolvePiperSampleRate(model, undefined), `konfig: ${bad}`).toEqual({ rate: 22050, source: "default" });
    }
  });

  it("ugyldig env (tom, tekst, urimelig) ignoreres - «tom streng er ikke usatt»-disiplinen", async () => {
    const model = await voiceWithConfig({ audio: { sample_rate: 16000 } });
    for (const env of ["", "   ", "abc", "0", "-5", "NaN", "99999999"]) {
      expect(resolvePiperSampleRate(model, env), `env: ${env}`).toEqual({ rate: 16000, source: "model_config" });
    }
  });
});

describe("LocalPiperTts rapporterer rate og kilde", () => {
  it("fra modellkonfig; status() og /status viser kilden; started.tts_sample_rate følger raten", async () => {
    const model = await voiceWithConfig({ audio: { sample_rate: 16000 } });
    vi.stubEnv("JARVIS_PIPER_SAMPLE_RATE", "");
    const tts = new LocalPiperTts(OK_BIN, model);
    expect(tts.sampleRate).toBe(16000);
    expect(tts.sampleRateSource).toBe("model_config");
    expect(tts.status()["sample_rate_source"]).toBe("model_config");
    gateway = await startGateway({ tts });
    const status = (await (await fetch(`http://127.0.0.1:${gateway.port}/status`)).json()) as { tts: Record<string, unknown> };
    expect(status.tts["sample_rate"]).toBe(16000);
    expect(status.tts["sample_rate_source"]).toBe("model_config");
    const client = await new TestClient(gateway.url).connect();
    client.send({ type: "start", identity: { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal" } });
    const started = await client.waitFor((m) => m.type === "started");
    expect(started["tts_sample_rate"]).toBe(16000);
    client.close();
  });

  it("env vinner, avviket logges som piper_sample_rate_mismatch (kun tall)", async () => {
    const model = await voiceWithConfig({ audio: { sample_rate: 16000 } });
    vi.stubEnv("JARVIS_PIPER_SAMPLE_RATE", "24000");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tts = new LocalPiperTts(OK_BIN, model);
    expect(tts.sampleRate).toBe(24000);
    expect(tts.sampleRateSource).toBe("env");
    expect(tts.status()["sample_rate_mismatch"]).toEqual({ env: 24000, model_config: 16000 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({ msg: "piper_sample_rate_mismatch", env: 24000, model_config: 16000, using: 24000 });
  });

  it("uten env og uten konfigfil: 22 050 med kilde «default» (uendret standard)", () => {
    vi.stubEnv("JARVIS_PIPER_SAMPLE_RATE", "");
    const tts = new LocalPiperTts(OK_BIN, `${FIXTURES}/fake-voice.onnx`);
    expect(tts.sampleRate).toBe(22_050);
    expect(tts.sampleRateSource).toBe("default");
  });

  it("eksplisitt konstruktørargument (tester/kode) vinner over alt", () => {
    vi.stubEnv("JARVIS_PIPER_SAMPLE_RATE", "24000");
    const tts = new LocalPiperTts(OK_BIN, `${FIXTURES}/fake-voice.onnx`, 12_345);
    expect(tts.sampleRate).toBe(12_345);
    expect(tts.sampleRateSource).toBe("constructor");
  });
});
