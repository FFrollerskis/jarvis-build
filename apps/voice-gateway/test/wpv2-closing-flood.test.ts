import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosedPeerBudget, DEFAULT_VOICE_LIMITS } from "../src/limits.ts";
import { TestClient, sleep, startGateway, trackUncaught, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 fiks-runde 2, FIX-1 (F10, søsken av F1): FLOM AV VANLIGE RAMMER fra en klient som ikke svarer på close.
 *
 * `rejectFlood` (og enhver annen høflig lukking) sender close-rammen og venter på klientens svar i opptil 5 s. `ws` leser og parser likevel hver ramme
 * klienten sender i mellomtiden, og handlerne ignorerte dem uten bøtte og uten terminering. Målt mot ekte `main.ts` (tekstrammer `{}` fra en klient som aldri
 * svarer på close): `/health` p50 138 ms (grunnlinje 2 ms) og en annen økts TTS-strøm på 35 mot 151 rammer per 3 s. Nå tåles etter close-rammen høyst
 * `pingPongBurst` rammer (+ `pingPongPerSecond`/s) av ALLE typer (tekst, binær, ping, pong) - deretter terminereres tilkoblingen. En klient som svarer på close
 * (ingen flom) fullfører håndtrykket som før.
 */
let gateway: RunningGateway | undefined;
let tracker = trackUncaught();
const sockets: Socket[] = [];

afterEach(async () => {
  tracker.stop();
  for (const s of sockets.splice(0)) s.destroy();
  await gateway?.close();
  gateway = undefined;
  tracker = trackUncaught();
  expect(tracker.errors).toEqual([]);
  vi.restoreAllMocks();
});

/** En maskert klientramme (nyttelast høyst 125 byte). */
function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] as number)));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

type FrameKind = "text" | "binary" | "ping" | "pong";
const OPCODES: Record<FrameKind, number> = { text: 0x1, binary: 0x2, ping: 0x9, pong: 0xa };
const frameOf = (kind: FrameKind): Buffer => maskedFrame(OPCODES[kind], kind === "text" ? Buffer.from("{}") : Buffer.alloc(8, 0x61));

interface RawClient {
  sock: Socket;
  received: Buffer[];
  closed: boolean;
}

/** Rå TCP + håndlaget WebSocket-oppgradering (nøkkelen bygges ved kjøring). Klienten leser alt serveren sender, men SVARER ALDRI på en close-ramme. */
async function rawUpgrade(port: number): Promise<RawClient> {
  const sock = connect(port, "127.0.0.1");
  sockets.push(sock);
  const raw: RawClient = { sock, received: [], closed: false };
  sock.on("error", () => {
    raw.closed = true;
  });
  sock.on("close", () => {
    raw.closed = true;
  });
  sock.on("data", (d: Buffer) => raw.received.push(d));
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  const key = randomBytes(16).toString("base64");
  sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const started = Date.now();
  while (!Buffer.concat(raw.received).includes("\r\n\r\n")) {
    if (Date.now() - started > 4000) throw new Error("ingen 101-respons");
    await sleep(5);
  }
  return raw;
}

/** Close-koden (og årsaken) i serverens første close-ramme (opcode 8), eller `null`. Serverrammer er umaskerte og her alltid under 126 byte. */
function receivedClose(raw: RawClient): { code: number; reason: string } | null {
  const all = Buffer.concat(raw.received);
  let offset = all.indexOf("\r\n\r\n") + 4;
  while (offset + 2 <= all.length) {
    const opcode = (all[offset] as number) & 0x0f;
    const length = (all[offset + 1] as number) & 0x7f;
    if (offset + 2 + length > all.length) return null;
    if (opcode === 0x8) return { code: all.readUInt16BE(offset + 2), reason: all.subarray(offset + 4, offset + 2 + length).toString("utf8") };
    offset += 2 + length;
  }
  return null;
}

const connections = (gw: RunningGateway): Promise<number> => new Promise((resolve, reject) => gw.server.getConnections((err, n) => (err ? reject(err) : resolve(n))));

/** Skriver `frame` i store batcher til tilkoblingen er borte (eller `maxMs` er gått). Returnerer ms brukt. */
async function floodUntilClosed(raw: RawClient, frame: Buffer, maxMs: number): Promise<number> {
  const batch = Buffer.concat(Array.from({ length: 2000 }, () => frame));
  const started = Date.now();
  while (!raw.closed && Date.now() - started < maxMs) {
    if (!raw.sock.write(batch)) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        raw.sock.once("drain", done);
        raw.sock.once("close", done);
        setTimeout(done, 50);
      });
    }
  }
  return Date.now() - started;
}

/** Venter til serveren har `expected` åpne tilkoblinger; returnerer ms brukt (eller `timeoutMs` ved tidsavbrudd). */
async function untilConnections(gw: RunningGateway, expected: number, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while ((await connections(gw)) !== expected) {
    if (Date.now() - started >= timeoutMs) return timeoutMs;
    await sleep(10);
  }
  return Date.now() - started;
}

/** 25 tekstrammer `{}`: kontrollbøtta (burst 20) tømmes av de 20 første, den 21. utløser `rejectFlood` (close 1008), og 4 rammer kommer ETTER close. */
const TRIGGER_RATE_LIMIT = (): Buffer => Buffer.concat(Array.from({ length: 25 }, () => frameOf("text")));

describe("FIX-1 (F10): ClosedPeerBudget (enhet, injisert klokke)", () => {
  const limits = { pingPongPerSecond: 2, pingPongBurst: 10 };

  it("burst rammer er gratis, den neste kaller onExceeded - nøyaktig ÉN gang - og senere rammer ignoreres stille", () => {
    let exceeded = 0;
    const budget = new ClosedPeerBudget(limits, () => (exceeded += 1), () => 0);
    for (let i = 0; i < 10; i++) budget.frame();
    expect(exceeded).toBe(0); // 10 rammer er innenfor budsjettet
    budget.frame();
    expect(exceeded).toBe(1); // den 11. bruker det opp
    for (let i = 0; i < 1000; i++) budget.frame();
    expect(exceeded).toBe(1); // aldri en ny terminering/logg for rammene som ligger igjen
  });

  it("budsjettet fylles på jevnt (2/s): en ramme per 500 ms er innenfor, flere i samme øyeblikk er over", () => {
    let t = 0;
    let exceeded = 0;
    const budget = new ClosedPeerBudget(limits, () => (exceeded += 1), () => t);
    for (let i = 0; i < 10; i++) budget.frame(); // tømmer burst
    t += 500; // ett token er fylt på
    budget.frame();
    expect(exceeded).toBe(0);
    budget.frame(); // ... men ikke to
    expect(exceeded).toBe(1);
  });

  it("settle(): tilkoblingen er allerede terminert av oss - rammer etterpå kaller aldri onExceeded", () => {
    let exceeded = 0;
    const budget = new ClosedPeerBudget(limits, () => (exceeded += 1), () => 0);
    budget.settle();
    for (let i = 0; i < 100; i++) budget.frame();
    expect(exceeded).toBe(0);
  });
});

describe("FIX-1 (F10): etter at close-rammen er sendt tåles bare et lite budsjett av rammer - alle typer", () => {
  it("standardbudsjettet er kontrollrammebøtta (burst 10, 2/s) - ingen ny konstant", () => {
    expect(DEFAULT_VOICE_LIMITS).toMatchObject({ pingPongPerSecond: 2, pingPongBurst: 10 });
  });

  it("tekstflom fra en klient som ALDRI svarer på close: close 1008 leveres, så termineres tilkoblingen straks (ikke først etter 5 s), og flommen logges ÉN gang", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    gateway = await startGateway();
    const flood = await rawUpgrade(gateway.port);
    const startedAt = Date.now();
    await floodUntilClosed(flood, frameOf("text"), 4000);
    await untilConnections(gateway, 0, 4000);
    expect(Date.now() - startedAt).toBeLessThan(1500); // uten fiksen holdes tilkoblingen til 5 s-fristen (`force`-tidtakeren)
    expect(receivedClose(flood)).toEqual({ code: 1008, reason: "rate_limited" }); // den høflige close-rammen kom først
    // Tusenvis av rammer kan leveres i samme tikk etter at budsjettet er brukt opp: kun den første logges.
    expect(logs.filter((l) => l.includes("voice_closed_peer_flood"))).toEqual(['{"msg":"voice_closed_peer_flood"}']);
  }, 20_000);

  it.each<FrameKind>(["text", "binary", "ping", "pong"])("%s-rammer ETTER close: innenfor budsjettet berøres ikke tilkoblingen, over budsjettet termineres den", async (kind) => {
    gateway = await startGateway();
    const client = await rawUpgrade(gateway.port);
    client.sock.write(TRIGGER_RATE_LIMIT());
    const started = Date.now();
    while (receivedClose(client) === null && Date.now() - started < 4000) await sleep(5);
    expect(receivedClose(client)).toEqual({ code: 1008, reason: "rate_limited" });
    await sleep(100);
    expect(await connections(gateway)).toBe(1); // 4 rammer etter close er innenfor budsjettet: håndtrykket får fortsatt tid
    client.sock.write(Buffer.concat(Array.from({ length: DEFAULT_VOICE_LIMITS.pingPongBurst + 20 }, () => frameOf(kind))));
    expect(await untilConnections(gateway, 0, 1500)).toBeLessThan(1500);
  }, 20_000);

  it("ping-flom fra en klient som LESER: ping-bøtta terminerer (voice_control_frame_flood), og budsjettet for lukkede klienter logger/terminerer ikke en gang til", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    gateway = await startGateway();
    const flood = await new TestClient(gateway.url).connect();
    const payload = Buffer.alloc(125, 0x61);
    for (let i = 0; i < 5000; i++) flood.ws.ping(payload);
    await flood.waitClosed(6000);
    await sleep(100);
    expect(logs.filter((l) => l.includes("voice_control_frame_flood"))).toHaveLength(1);
    expect(logs.filter((l) => l.includes("voice_closed_peer_flood"))).toEqual([]); // rammene som lå igjen i samme chunk regnes ikke som en ny flom
  }, 20_000);

  it("en klient som SVARER på close (ingen flom) fullfører håndtrykket straks, også med noen rammer under vei - ingen terminering, ingen flomlogg", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    gateway = await startGateway();
    const client = await rawUpgrade(gateway.port);
    client.sock.write(TRIGGER_RATE_LIMIT());
    const started = Date.now();
    while (receivedClose(client) === null && Date.now() - started < 4000) await sleep(5);
    client.sock.write(frameOf("text")); // en ramme som var under vei
    client.sock.write(maskedFrame(0x8, Buffer.from([0x03, 0xf0]))); // klientens close-svar (1008)
    expect(await untilConnections(gateway, 0, 1500)).toBeLessThan(1500);
    expect(logs.filter((l) => l.includes("voice_closed_peer_flood"))).toEqual([]);
  });

  it("en AVVIST tilkobling (1013 voice_busy) som ikke svarer på close og flommer: termineres straks - ikke først etter svarfristen - og eieren berøres ikke", async () => {
    gateway = await startGateway({ limits: { maxConnections: 1, maxConnectionsPerPeer: 10, refusedCloseGraceMs: 60_000 } });
    const owner = await new TestClient(gateway.url).connect();
    await owner.startProven(); // bevist = aldri utkastet: nye tilkoblinger avvises
    const refused = await rawUpgrade(gateway.port);
    const started = Date.now();
    while (receivedClose(refused) === null && Date.now() - started < 4000) await sleep(5);
    expect(receivedClose(refused)).toEqual({ code: 1013, reason: "voice_busy" });
    expect(await connections(gateway)).toBe(2);
    const floodStarted = Date.now();
    await floodUntilClosed(refused, frameOf("text"), 4000);
    await untilConnections(gateway, 1, 4000);
    expect(Date.now() - floodStarted).toBeLessThan(1500); // kun eieren er igjen (svarfristen er satt til 60 s)
    owner.send({ type: "voice_settings", settings: {} });
    await owner.waitFor((m) => m.type === "voice_settings");
    owner.close();
  }, 20_000);
});

// ---- Ekte main.ts-prosess (port av reviewerens d7): andre økter merker ikke flommen ----

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

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
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function startMain(port: number): Running {
  const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", MAIN], {
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", JARVIS_VOICE_PORT: String(port), JARVIS_VOICE_ALLOW_TEST_ADAPTERS: "true", JARVIS_CORE_URL: "http://127.0.0.1:9" },
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

async function waitForListening(r: Running): Promise<void> {
  const started = Date.now();
  while (!r.lines.some((l) => /jarvis-voice-gateway listening/.test(l))) {
    if (r.child.exitCode !== null || Date.now() - started > 20_000) throw new Error(`main.ts startet ikke: ${r.lines.slice(-5).join(" | ")}`);
    await sleep(25);
  }
}

describe("FIX-1 (F10): ekte main.ts - en tekstflom fra en klient som ikke svarer på close lar andre økter være", () => {
  it("/health-latens og en annen økts TTS-strøm er uberørt under flommen (målt uten fiksen: p50 138 ms mot 2 ms, og 35 mot 151 TTS-rammer per 3 s)", async () => {
    const port = await freePort();
    const r = startMain(port);
    await waitForListening(r);
    const legit = await new TestClient(`ws://127.0.0.1:${port}`).connect();
    await legit.startUnproven();
    const health = async (): Promise<number> => {
      const t = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
      await res.arrayBuffer();
      return Date.now() - t;
    };
    const measure = async (ms: number): Promise<{ p50: number; frames: number }> => {
      const before = legit.messages.length;
      legit.send({ type: "voice_sample" });
      const lat: number[] = [];
      const started = Date.now();
      while (Date.now() - started < ms) {
        lat.push(await health());
        await sleep(50);
      }
      const frames = legit.messages.slice(before).filter((m) => m.type === "tts_frame").length;
      lat.sort((a, b) => a - b);
      return { p50: lat[Math.floor(lat.length / 2)] as number, frames };
    };
    await measure(500); // oppvarming (JIT, første /health)
    await sleep(1500); // la oppvarmingens TTS-strøm bli ferdig
    const baseline = await measure(2000);
    await sleep(1500);
    const flood = await rawUpgrade(port);
    const before = legit.messages.length;
    legit.send({ type: "voice_sample" });
    const lat: number[] = [];
    const floodStarted = Date.now();
    void floodUntilClosed(flood, frameOf("text"), 2500);
    while (Date.now() - floodStarted < 2000) {
      lat.push(await health());
      await sleep(50);
    }
    const frames = legit.messages.slice(before).filter((m) => m.type === "tts_frame").length;
    lat.sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length / 2)] as number;
    expect(baseline.frames).toBeGreaterThan(60); // 2 s TTS-strøm ≈ 100 rammer à 20 ms
    expect(p50).toBeLessThan(60); // grunnlinje ca. 2 ms; uten fiksen 138 ms
    expect(frames).toBeGreaterThan(baseline.frames * 0.6); // uten fiksen ca. 23 % av grunnlinjen
    expect(r.child.exitCode).toBeNull();
    legit.close();
  }, 60_000);
});
