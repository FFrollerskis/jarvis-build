import { afterEach, describe, expect, it } from "vitest";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";
import { LOCAL, ScriptedCore, TestClient, sleep, speechFrame, startGateway, trackUncaught, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 K3: meldingsvalidering (audit A3: `String(undefined)` -> «undefined» -> søppelbytes) og sesjonslekkasje (en ny `start` på samme
 * socket overskrev `session` uten å stoppe den forrige).
 */
let gateway: RunningGateway | undefined;
let tracker = trackUncaught();

afterEach(async () => {
  tracker.stop();
  await gateway?.close();
  gateway = undefined;
  tracker = trackUncaught();
  expect(tracker.errors).toEqual([]);
});

/** TTS som produserer 10 ms-rammer til den kanselleres - for å bevise at en erstattet sesjons TTS faktisk stoppes. */
class CountingTts implements TtsAdapter {
  readonly name = "wpv2-counting-tts";
  readonly processor = LOCAL;
  readonly sampleRate = 16_000;
  produced = 0;
  cancelled = 0;
  available(): boolean {
    return true;
  }
  synthesize(): TtsPlayback {
    let stop = false;
    const onFrame = (): void => {
      this.produced += 1;
    };
    async function* frames(): AsyncIterable<Buffer> {
      for (let i = 0; i < 1000 && !stop; i++) {
        await sleep(10);
        if (stop) return;
        onFrame();
        yield Buffer.alloc(320);
      }
    }
    return {
      frames: frames(),
      cancel: () => {
        stop = true;
        this.cancelled += 1;
      }
    };
  }
}

describe("K3: audio.data valideres strengt", () => {
  it.each([
    ["mangler data", undefined],
    ["tall", 12345],
    ["objekt", { a: 1 }],
    ["tom streng", ""],
    ["«undefined» (gyldige base64-tegn, ugyldig lengde)", "undefined"],
    ["ugyldige tegn", "!!!!"],
    ["oddetall bytes etter dekoding (3 byte)", "AAAA"],
    ["for mye padding", "A==="]
  ])("%s -> malformed_message, tilkoblingen lever", async (_label, data) => {
    gateway = await startGateway({ core: new ScriptedCore() });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven();
    client.send({ type: "audio", ...(data !== undefined ? { data } : {}) });
    await client.waitFor((m) => m.type === "error" && m["error"] === "malformed_message");
    // Tilkoblingen er fortsatt åpen og aksepterer en gyldig ramme uten feil.
    client.send({ type: "audio", data: speechFrame() });
    await sleep(100);
    expect(client.errors()).toEqual(["malformed_message"]);
    expect(client.closeEvent).toBeNull();
    client.close();
  });

  it("dekodet ramme over maxAudioFrameBytes -> malformed_message (men gyldig størrelse passerer)", async () => {
    gateway = await startGateway({ limits: { maxAudioFrameBytes: 700 } });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven();
    client.send({ type: "audio", data: Buffer.alloc(1000).toString("base64") });
    await client.waitFor((m) => m.type === "error" && m["error"] === "malformed_message");
    client.send({ type: "audio", data: speechFrame() }); // 640 byte
    await sleep(100);
    expect(client.errors()).toEqual(["malformed_message"]);
    client.close();
  });

  it("audio uten sesjon gir fortsatt no_session (ikke malformed_message)", async () => {
    gateway = await startGateway();
    const client = await new TestClient(gateway.url).connect();
    client.send({ type: "audio", data: 42 });
    await client.waitFor((m) => m.type === "error" && m["error"] === "no_session");
    client.close();
  });
});

describe("K3: replay_final valideres - ingen Core-kall på ugyldig input", () => {
  it.each([
    ["mangler utterance_id", { text: "hei" }],
    ["utterance_id er tall", { utterance_id: 7, text: "hei" }],
    ["utterance_id for lang", { utterance_id: "u".repeat(129), text: "hei" }],
    ["utterance_id med ugyldige tegn", { utterance_id: "a b/c", text: "hei" }],
    ["mangler text", { utterance_id: "utt-1" }],
    ["text er tom", { utterance_id: "utt-1", text: "" }],
    ["text er objekt", { utterance_id: "utt-1", text: { x: 1 } }],
    ["text over grensen", { utterance_id: "utt-1", text: "x".repeat(50) }]
  ])("%s -> malformed_message", async (_label, body) => {
    const core = new ScriptedCore();
    gateway = await startGateway({ core, limits: { maxReplayTextChars: 40 } });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven();
    client.send({ type: "replay_final", ...body });
    await client.waitFor((m) => m.type === "error" && m["error"] === "malformed_message");
    expect(core.chatCalls).toHaveLength(0);
    client.close();
  });

  it("gyldig replay_final når Core", async () => {
    const core = new ScriptedCore();
    gateway = await startGateway({ core });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven();
    client.send({ type: "replay_final", utterance_id: "utt-ok:1", text: "hei" });
    await client.waitFor((m) => m.type === "reply");
    expect(core.chatCalls).toHaveLength(1);
    client.close();
  });
});

describe("K3: start valideres", () => {
  it.each([
    ["identity er streng", { identity: "p" }],
    ["identity er liste", { identity: [1, 2] }],
    ["person_id mangler", { identity: { tenant_id: "t", device_id: "d", memory_space: "personal" } }],
    ["device_id er tall", { identity: { person_id: "p", tenant_id: "t", device_id: 5, memory_space: "personal" } }],
    ["memory_space for lang", { identity: { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "m".repeat(65) } }],
    ["kontrolltegn i person_id", { identity: { person_id: "p\nq", tenant_id: "t", device_id: "d", memory_space: "personal" } }],
    ["provider er objekt", { identity: { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", provider: {} } }],
    ["device_proof er liste", { identity: { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal" }, device_proof: [] }]
  ])("%s -> malformed_message, ingen sesjon, ingen Core-autorisasjon", async (_label, body) => {
    const core = new ScriptedCore();
    gateway = await startGateway({ core });
    const client = await new TestClient(gateway.url).connect();
    client.send({ type: "start", ...body });
    await client.waitFor((m) => m.type === "error" && m["error"] === "malformed_message");
    expect(core.authorizeCalls).toHaveLength(0);
    expect(client.messages.some((m) => m.type === "started")).toBe(false);
    client.close();
  });

  it("start uten identity og uten bevis gir fortsatt missing_identity (uendret kode)", async () => {
    gateway = await startGateway();
    const client = await new TestClient(gateway.url).connect();
    client.send({ type: "start" });
    await client.waitFor((m) => m.type === "error" && m["error"] === "missing_identity");
    client.close();
  });

  it("en feilaktig start river ikke ned en eksisterende, fungerende sesjon", async () => {
    gateway = await startGateway();
    const client = await new TestClient(gateway.url).connect();
    await client.startProven();
    client.send({ type: "start", identity: "ødelagt" });
    await client.waitFor((m) => m.type === "error" && m["error"] === "malformed_message");
    client.send({ type: "audio", data: speechFrame() });
    await sleep(100);
    expect(client.errors()).toEqual(["malformed_message"]); // ingen no_session
    client.close();
  });
});

describe("K3: en ny start på samme socket stopper forrige sesjon først", () => {
  it("forrige sesjons TTS kanselleres og strømmen av tts_frame stopper", async () => {
    const tts = new CountingTts();
    gateway = await startGateway({ tts });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven();
    client.send({ type: "voice_sample" });
    await client.waitFor((m) => m.type === "tts_frame");
    expect(tts.cancelled).toBe(0);
    client.send({ type: "start", identity: { person_id: "person-wpv2", tenant_id: "tenant-wpv2", device_id: "dev-wpv2-a", memory_space: "personal" }, device_proof: { challenge: "c", signature: "s" } });
    await sleep(200);
    expect(tts.cancelled).toBeGreaterThanOrEqual(1);
    const framesAtStop = client.messages.filter((m) => m.type === "tts_frame").length;
    await sleep(250);
    expect(client.messages.filter((m) => m.type === "tts_frame").length).toBe(framesAtStop);
    client.close();
  });

  it("forrige sesjons aktive tur aborteres (signal) og får aldri levere svar", async () => {
    const core = new ScriptedCore();
    let aborted = false;
    core.chatStream = async (_identity, _message, _onEvent, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    gateway = await startGateway({ core });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven();
    client.send({ type: "replay_final", utterance_id: "utt-hang-1", text: "hei" });
    await sleep(100);
    expect(aborted).toBe(false);
    client.send({ type: "start", identity: { person_id: "person-wpv2", tenant_id: "tenant-wpv2", device_id: "dev-wpv2-a", memory_space: "personal" }, device_proof: { challenge: "c", signature: "s" } });
    await client.waitFor((m) => m.type === "started" && client.messages.filter((x) => x.type === "started").length === 2);
    expect(aborted).toBe(true);
    expect(client.messages.some((m) => m.type === "reply")).toBe(false);
    client.close();
  });

  it("start som mottas etter at socketen lukket startes ikke som sesjon (ingen lekkasje)", async () => {
    const core = new ScriptedCore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = core.authorizeVoiceSession.bind(core);
    core.authorizeVoiceSession = async (evidence: unknown) => {
      await gate;
      return original(evidence);
    };
    gateway = await startGateway({ core });
    const client = await new TestClient(gateway.url).connect();
    client.send({ type: "start", identity: { person_id: "person-wpv2", tenant_id: "tenant-wpv2", device_id: "dev-wpv2-a", memory_space: "personal" }, device_proof: { challenge: "c", signature: "s" } });
    await sleep(50);
    client.close();
    await client.waitClosed();
    release();
    await sleep(100);
    // Ingen unntak, og ingen `started` kunne sendes til en lukket socket.
    expect(client.messages.some((m) => m.type === "started")).toBe(false);
  });
});
