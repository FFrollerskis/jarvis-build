import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceHealth } from "../src/health.ts";
import { VoiceSession, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import { LocalWhisperStt } from "../src/stt.ts";
import { LocalPiperTts } from "../src/tts.ts";
import { ScriptedCore, TestClient, sleep, startGateway, trackUncaught, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 K1 (P1, krasjvern). Alle tester asserterer eksplisitt at INGEN uncaughtException/unhandledRejection oppstod - på `main` krasjet
 * hele prosessen på: (a) en ugyldig WebSocket-ramme (ingen `ws.on("error")`), (b) Piper med ikke-eksisterende binær (ingen
 * `proc.once("error")`), og (c) `available()` sa «true» for en binær som ikke finnes.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const OK_BIN = `${FIXTURES}/mock-piper-ok.sh`;
const MODEL = `${FIXTURES}/fake-voice.onnx`;
const WHISPER_BIN = `${FIXTURES}/mock-whisper-ok.sh`;
const WHISPER_MODEL = `${FIXTURES}/fake-model.bin`;

let gateway: RunningGateway | undefined;
let tracker = trackUncaught();

afterEach(async () => {
  tracker.stop();
  await gateway?.close();
  gateway = undefined;
  tracker = trackUncaught();
});

async function collect(iterable: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

describe("K1a: ugyldige WebSocket-rammer krasjer aldri gatewayen", () => {
  it("tekstramme med ugyldig UTF-8: tilkoblingen lukkes, prosessen overlever, en annen tilkobling er upåvirket", async () => {
    gateway = await startGateway();
    const bystander = await new TestClient(gateway.url).connect();
    await bystander.startUnproven();
    const attacker = await new TestClient(gateway.url).connect();
    attacker.sendRawFrame(1, Buffer.from([0xc3, 0x28])); // 0xC3 0x28 = ugyldig UTF-8-sekvens i en tekstramme
    const closed = await attacker.waitClosed();
    expect(closed.code).toBe(1007);
    await sleep(100);
    expect(tracker.errors).toEqual([]);
    // Den andre tilkoblingen lever og får fortsatt svar.
    bystander.send({ type: "voice_settings", settings: {} });
    await bystander.waitFor((m) => m.type === "voice_settings");
    bystander.close();
  });

  it("reservert opcode (3): tilkoblingen lukkes, prosessen overlever", async () => {
    gateway = await startGateway();
    const attacker = await new TestClient(gateway.url).connect();
    attacker.sendRawFrame(3, Buffer.alloc(0));
    const closed = await attacker.waitClosed();
    expect(closed.code).toBe(1002);
    await sleep(100);
    expect(tracker.errors).toEqual([]);
    // Gatewayen tar fortsatt imot nye tilkoblinger.
    const next = await new TestClient(gateway.url).connect();
    await next.startUnproven();
    next.close();
  });

  it("melding over maxPayload: lukkes med 1009 (message too big), prosessen overlever", async () => {
    gateway = await startGateway({ limits: { maxPayloadBytes: 1024 } });
    const client = await new TestClient(gateway.url).connect();
    client.sendRaw(JSON.stringify({ type: "audio", data: "A".repeat(4096) }));
    const closed = await client.waitClosed();
    expect(closed.code).toBe(1009);
    await sleep(50);
    expect(tracker.errors).toEqual([]);
  });

  it("standard maxPayload er 64 KiB (ws-standarden var 100 MiB)", async () => {
    gateway = await startGateway();
    const client = await new TestClient(gateway.url).connect();
    client.sendRaw(JSON.stringify({ type: "audio", data: "A".repeat(70 * 1024) }));
    const closed = await client.waitClosed();
    expect(closed.code).toBe(1009);
    expect(tracker.errors).toEqual([]);
  });

  it("brå TCP-reset midt i en tilkobling: prosessen overlever, øvrige tilkoblinger upåvirket", async () => {
    gateway = await startGateway();
    const bystander = await new TestClient(gateway.url).connect();
    await bystander.startUnproven();
    const victim = await new TestClient(gateway.url).connect();
    await victim.startUnproven();
    victim.resetTcp();
    await sleep(150);
    expect(tracker.errors).toEqual([]);
    bystander.send({ type: "voice_settings", settings: {} });
    await bystander.waitFor((m) => m.type === "voice_settings");
    bystander.close();
  });

  it("en ugyldig ramme frigjør tilkoblingsplassen umiddelbart (connections.active tilbake til 0) selv om motparten ikke svarer på close", async () => {
    gateway = await startGateway();
    const active = async (): Promise<number> =>
      ((await (await fetch(`http://127.0.0.1:${gateway!.port}/status`)).json()) as { connections: { active: number } }).connections.active;
    const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
    let closedAt = 0;
    socket.on("close", () => {
      closedAt = Date.now();
    });
    socket.on("error", () => undefined);
    let handshake = "";
    socket.on("data", (d) => {
      handshake += d.toString("latin1"); // leser, men svarer ALDRI på close-rammen
    });
    socket.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const started = Date.now();
    while (!handshake.includes("101") && Date.now() - started < 3000) await sleep(10);
    expect(handshake).toContain("101");
    expect(await active()).toBe(1);
    const sentAt = Date.now();
    socket.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4])); // maskert ramme med reservert opcode 3
    while (closedAt === 0 && Date.now() - sentAt < 8000) await sleep(20);
    expect(closedAt).toBeGreaterThan(0);
    expect(closedAt - sentAt).toBeLessThan(3000);
    await sleep(100);
    expect(await active()).toBe(0);
    expect(tracker.errors).toEqual([]);
  }, 20_000);

  it("ødelagt HTTP-forespørsel (clientError): 400 og prosessen overlever", async () => {
    gateway = await startGateway();
    const response = await new Promise<string>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: gateway!.port }, () => {
        socket.write("GARBAGE \u0000 NOT HTTP\r\n\r\n");
      });
      let data = "";
      socket.on("data", (d) => (data += d.toString("latin1")));
      socket.on("error", () => resolve(data));
      socket.on("close", () => resolve(data));
    });
    expect(response).toContain("400");
    await sleep(50);
    expect(tracker.errors).toEqual([]);
    const next = await new TestClient(gateway.url).connect();
    await next.startUnproven();
    next.close();
  });
});

describe("K1b: Piper spawn-feil er en vanlig TTS-feil, aldri et prosesskrasj", () => {
  it("ikke-eksisterende binær: frames kaster local_piper_spawn_failed:ENOENT", async () => {
    const tts = new LocalPiperTts("/nonexistent/wpv2/piper-bin", MODEL);
    const playback = tts.synthesize("hei");
    await expect(collect(playback.frames)).rejects.toThrow("local_piper_spawn_failed:ENOENT");
    await sleep(50);
    expect(tracker.errors).toEqual([]);
  });

  it("fil uten kjørerett: local_piper_spawn_failed:EACCES", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wpv2-piper-"));
    const noExec = join(dir, "piper-noexec");
    await writeFile(noExec, "#!/bin/sh\necho hi\n");
    await chmod(noExec, 0o644);
    const tts = new LocalPiperTts(noExec, MODEL);
    await expect(collect(tts.synthesize("hei").frames)).rejects.toThrow(/local_piper_spawn_failed:(EACCES|EPERM)/);
    expect(tracker.errors).toEqual([]);
  });

  it("feilen når sesjonen som tts_error + health.recordFailure(tts) - uten krasj", async () => {
    const identity: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice" };
    const errors: string[] = [];
    const events: SessionEvents = {
      onState: () => undefined, onPartial: () => undefined, onFinal: () => undefined, onReply: () => undefined,
      onTtsFrame: () => undefined, onTtsCancelled: () => undefined, onMetrics: () => undefined,
      onError: (e) => { errors.push(e); }
    };
    const health = new VoiceHealth();
    const session = new VoiceSession(
      identity, new ScriptedCore(), new (await import("../src/stt.ts")).MarkerStt(), new LocalPiperTts("/nonexistent/wpv2/piper-bin", MODEL),
      events, undefined, undefined, undefined, undefined, undefined, health
    );
    session.speakSample("hei");
    await sleep(200);
    expect(errors).toContain("tts_error");
    expect(health.snapshot({ tts: true })["tts"]?.failures).toBeGreaterThanOrEqual(1);
    expect(health.snapshot({ tts: true })["tts"]?.last_error).toBe("local_piper_spawn_failed:ENOENT");
    expect(tracker.errors).toEqual([]);
  });
});

describe("K1c: available() sjekker at binær og modell faktisk finnes", () => {
  it("piper: ikke-eksisterende binær, manglende modell, og gyldig oppsett", () => {
    expect(new LocalPiperTts("/nonexistent/wpv2/piper-bin", MODEL).available()).toBe(false);
    expect(new LocalPiperTts("/nonexistent/wpv2/piper-bin", MODEL).status?.()["unavailable_reason"]).toBe("binary_not_executable");
    expect(new LocalPiperTts(OK_BIN, "/nonexistent/wpv2/voice.onnx").available()).toBe(false);
    expect(new LocalPiperTts(OK_BIN, "/nonexistent/wpv2/voice.onnx").status?.()["unavailable_reason"]).toBe("model_not_readable");
    expect(new LocalPiperTts(undefined, MODEL).status?.()["unavailable_reason"]).toBe("not_configured");
    expect(new LocalPiperTts(OK_BIN, MODEL).available()).toBe(true);
    expect(new LocalPiperTts(OK_BIN, MODEL).status?.()["unavailable_reason"]).toBeUndefined();
  });

  it("piper: en mappe er ikke en kjørbar binær; et rent kommandonavn søkes i PATH", () => {
    expect(new LocalPiperTts(FIXTURES, MODEL).available()).toBe(false);
    expect(new LocalPiperTts("wpv2-no-such-command-in-path", MODEL).available()).toBe(false);
  });

  it("whisper: samme sjekk", () => {
    expect(new LocalWhisperStt("/nonexistent/wpv2/whisper-bin", WHISPER_MODEL).available()).toBe(false);
    expect(new LocalWhisperStt(WHISPER_BIN, "/nonexistent/wpv2/model.bin").available()).toBe(false);
    expect(new LocalWhisperStt(WHISPER_BIN, "/nonexistent/wpv2/model.bin").status?.()["unavailable_reason"]).toBe("model_not_readable");
    expect(new LocalWhisperStt(WHISPER_BIN, WHISPER_MODEL).available()).toBe(true);
  });

  it("/health gir 503 og NOT_CONFIGURED for tts ved feil piper-oppsett (aldri krasj); 200 når oppsettet er riktig", async () => {
    const { MarkerStt } = await import("../src/stt.ts");
    gateway = await startGateway({ stt: new MarkerStt(), tts: new LocalPiperTts("/nonexistent/wpv2/piper-bin", MODEL) });
    const bad = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as { checks: Record<string, string> }).checks["tts"]).toBe("NOT_CONFIGURED");
    const status = (await (await fetch(`http://127.0.0.1:${gateway.port}/status`)).json()) as { tts: Record<string, unknown> };
    expect(status.tts["unavailable_reason"]).toBe("binary_not_executable");
    await gateway.close();
    gateway = await startGateway({ stt: new MarkerStt(), tts: new LocalPiperTts(OK_BIN, MODEL) });
    const good = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    expect(good.status).toBe(200);
    expect(tracker.errors).toEqual([]);
  });
});
