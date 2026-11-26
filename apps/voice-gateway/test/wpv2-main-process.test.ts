import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TestClient, sleep } from "./wpv2-harness.ts";

/**
 * WP-V2: den ekte `main.ts`-prosessen (ikke bare `createVoiceGateway`). Beviser at krasjvernet gjelder entrypointen som kjører i
 * produksjon, og at en mislykket `listen()` stopper prosessen synlig. Barneprosessen drepes alltid av testen (egen PID).
 */
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const MAIN_SOURCE = readFileSync(MAIN, "utf8");

interface Running {
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
}

const running: Running[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    if (r.child.exitCode === null) {
      r.child.kill("SIGTERM");
      const done = await Promise.race([r.exited.then(() => true), sleep(3000).then(() => false)]);
      if (!done) r.child.kill("SIGKILL");
    }
  }
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function startMain(port: number): Running {
  const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", MAIN], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "/tmp",
      JARVIS_VOICE_PORT: String(port),
      JARVIS_VOICE_ALLOW_TEST_ADAPTERS: "true",
      JARVIS_CORE_URL: "http://127.0.0.1:9"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const lines: string[] = [];
  const onData = (d: Buffer): void => {
    lines.push(...d.toString("utf8").split("\n").filter((l) => l.length > 0));
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const r = { child, lines, exited };
  running.push(r);
  return r;
}

async function waitForLine(r: Running, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const found = r.lines.find((l) => pattern.test(l));
    if (found) return found;
    if (r.child.exitCode !== null) throw new Error(`prosessen avsluttet (${r.child.exitCode}) før ${pattern}: ${r.lines.slice(-5).join(" | ")}`);
    if (Date.now() - started > timeoutMs) throw new Error(`timeout på ${pattern}: ${r.lines.slice(-5).join(" | ")}`);
    await sleep(25);
  }
}

describe("ekte main.ts-prosess", () => {
  it("overlever ugyldige WebSocket-rammer og en flom (1007/1002/1009/1008); /health forblir 200; standardgrenser er aktive", async () => {
    const port = await freePort();
    const r = startMain(port);
    await waitForLine(r, /jarvis-voice-gateway listening/);
    const url = `ws://127.0.0.1:${port}`;

    const utf8 = await new TestClient(url).connect();
    utf8.sendRawFrame(1, Buffer.from([0xc3, 0x28]));
    expect((await utf8.waitClosed()).code).toBe(1007);

    const opcode = await new TestClient(url).connect();
    opcode.sendRawFrame(3, Buffer.alloc(0));
    expect((await opcode.waitClosed()).code).toBe(1002);

    const big = await new TestClient(url).connect();
    big.sendRaw(JSON.stringify({ type: "audio", data: "A".repeat(70_000) }));
    expect((await big.waitClosed()).code).toBe(1009);

    const flood = await new TestClient(url).connect();
    for (let i = 0; i < 400; i++) flood.send({ type: "audio", data: Buffer.alloc(640).toString("base64") });
    expect(await flood.waitClosed()).toEqual({ code: 1008, reason: "rate_limited" });

    expect(r.child.exitCode).toBeNull(); // prosessen lever
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    const status = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as {
      limits: { maxPayloadBytes: number; maxConnections: number };
      connections: { active: number };
      journal: { entries: number };
    };
    expect(status.limits.maxPayloadBytes).toBe(64 * 1024);
    expect(status.limits.maxConnections).toBe(16);
    expect(status.journal.entries).toBe(0);
    await sleep(100);
    expect(r.lines.some((l) => /uncaught|Unhandled|Error: /.test(l))).toBe(false);
  }, 60_000);

  it("en mislykket listen() (adressen er i bruk) stopper prosessen med exit 1 og en kodet loggline", async () => {
    const port = await freePort();
    const first = startMain(port);
    await waitForLine(first, /jarvis-voice-gateway listening/);
    const second = startMain(port);
    const code = await Promise.race([second.exited, sleep(20_000).then(() => "timeout" as const)]);
    expect(code).toBe(1);
    expect(second.lines.some((l) => l.includes('"msg":"jarvis-voice-gateway server_error"') && l.includes('"code":"EADDRINUSE"'))).toBe(true);
    expect(first.child.exitCode).toBeNull(); // den første påvirkes ikke
  }, 60_000);
});

describe("main.ts-kobling (statisk)", () => {
  it("ÉN prosess-delt journal opprettes i main.ts og gis til gatewayen (K5)", () => {
    expect(MAIN_SOURCE).toMatch(/const journal = new UtteranceJournal\(\);/);
    expect(MAIN_SOURCE).toMatch(/createVoiceGateway\(\{[^}]*\bjournal\b[^}]*\}\)/);
  });

  it("failover komponeres ETTER selectSpeechAdapters (som er uendret), kun via withLocal*Reserve (K4)", () => {
    expect(MAIN_SOURCE).toMatch(/const selected = selectOrExit\(\);/);
    expect(MAIN_SOURCE).toMatch(/withLocalSttReserve\(selected\.stt, localWhisperStt, \{ health \}\)/);
    expect(MAIN_SOURCE).toMatch(/withLocalTtsReserve\(selected\.tts, localPiperTts, \{ health \}\)/);
    expect(MAIN_SOURCE).toContain("selectSpeechAdapters({ openAiStt, remoteWhisperStt, localWhisperStt, openAiTts, localPiperTts })");
  });

  it("lokale prosesser deler semaforer med grenser fra VoiceLimits, og en listen-feil stopper prosessen (K1/K2)", () => {
    expect(MAIN_SOURCE).toContain("new ProcessSlots(DEFAULT_VOICE_LIMITS.maxConcurrentWhisper");
    expect(MAIN_SOURCE).toContain("new ProcessSlots(DEFAULT_VOICE_LIMITS.maxConcurrentPiper");
    // FIX-4: begge semaforene har den reserverte plassen for bevisste sesjoner (uten den kan en ubevist klient sulte eierens tur).
    expect(MAIN_SOURCE).toMatch(/new ProcessSlots\(DEFAULT_VOICE_LIMITS\.maxConcurrentWhisper, [^)]*DEFAULT_VOICE_LIMITS\.reservedProvenSlots\)/);
    expect(MAIN_SOURCE).toMatch(/new ProcessSlots\(DEFAULT_VOICE_LIMITS\.maxConcurrentPiper, [^)]*DEFAULT_VOICE_LIMITS\.reservedProvenSlots\)/);
    expect(MAIN_SOURCE).toMatch(/server\.on\("error"[\s\S]*?process\.exit\(1\)/);
  });
});
