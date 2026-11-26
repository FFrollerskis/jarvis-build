import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionTracker, DEFAULT_VOICE_LIMITS, ProcessSlots, TokenBucket, VoiceBusyError, peerKey, resolveLimits } from "../src/limits.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";
import { LocalWhisperStt } from "../src/stt.ts";
import { LocalPiperTts } from "../src/tts.ts";
import { LOCAL, TestClient, sleep, speechFrame, startGateway, trackUncaught, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 K2 (JARVIS-063 voice-delen): kapasitet og rate limit. For HVER grense: overskridelse gir en definert feilkode/lukking
 * (aldri et krasj), og en uberørt ANNEN økt fortsetter å fungere.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const MODEL = `${FIXTURES}/fake-voice.onnx`;

let gateway: RunningGateway | undefined;
let tracker = trackUncaught();

afterEach(async () => {
  tracker.stop();
  await gateway?.close();
  gateway = undefined;
  tracker = trackUncaught();
  expect(tracker.errors).toEqual([]);
  vi.restoreAllMocks();
});

async function expectBystanderAlive(client: TestClient): Promise<void> {
  const before = client.messages.filter((m) => m.type === "voice_settings").length;
  client.send({ type: "voice_settings", settings: {} });
  await client.waitFor(() => client.messages.filter((m) => m.type === "voice_settings").length > before);
}

describe("grensekonstanter (begrunnet i runbooken)", () => {
  it("standardverdiene", () => {
    expect(DEFAULT_VOICE_LIMITS).toMatchObject({
      maxPayloadBytes: 64 * 1024,
      maxAudioFrameBytes: 16 * 1024,
      maxConnections: 16,
      maxConnectionsPerPeer: 4,
      audioFramesPerSecond: 100,
      audioBurst: 200,
      idleTimeoutMs: 120_000,
      maxUnprovenSessionMs: 30 * 60_000,
      pingIntervalMs: 30_000,
      maxBufferedBytes: 1024 * 1024,
      maxConcurrentWhisper: 2
    });
  });

  it("resolveLimits: ugyldige overstyringer (0, negative, NaN, Infinity) slår aldri en grense AV", () => {
    const limits = resolveLimits({ maxConnections: 0, maxPayloadBytes: -5, idleTimeoutMs: Number.NaN, audioBurst: Number.POSITIVE_INFINITY, maxConnectionsPerPeer: 7 });
    expect(limits.maxConnections).toBe(16);
    expect(limits.maxPayloadBytes).toBe(64 * 1024);
    expect(limits.idleTimeoutMs).toBe(120_000);
    expect(limits.audioBurst).toBe(200);
    expect(limits.maxConnectionsPerPeer).toBe(7);
  });

  it("nettleserens 64 ms-ramme (2 048 byte PCM16, ca. 2,8 KB base64) og 20 ms-satellittrammen ligger langt under rammegrensene", () => {
    const base64OfBrowserFrame = Math.ceil(2048 / 3) * 4;
    expect(base64OfBrowserFrame).toBeLessThan(DEFAULT_VOICE_LIMITS.maxPayloadBytes / 8);
    expect(2048).toBeLessThan(DEFAULT_VOICE_LIMITS.maxAudioFrameBytes);
    expect(50).toBeLessThan(DEFAULT_VOICE_LIMITS.audioFramesPerSecond); // 20 ms-satellitt
    expect(1000 / 64).toBeLessThan(DEFAULT_VOICE_LIMITS.audioFramesPerSecond); // nettleser
  });
});

describe("TokenBucket", () => {
  it("burst, jevn påfylling og aldri over burst (injisert klokke)", () => {
    let t = 0;
    const bucket = new TokenBucket(10, 5, () => t);
    for (let i = 0; i < 5; i++) expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    t += 100; // 0,1 s * 10/s = 1 token
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    t += 10_000; // lang pause fyller kun opp til burst
    for (let i = 0; i < 5; i++) expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("standard audio-grense tåler 50 rammer/s i det uendelige og avviser en flom", () => {
    let t = 0;
    const bucket = new TokenBucket(DEFAULT_VOICE_LIMITS.audioFramesPerSecond, DEFAULT_VOICE_LIMITS.audioBurst, () => t);
    for (let i = 0; i < 10_000; i++) {
      t += 20; // 50/s
      expect(bucket.tryTake()).toBe(true);
    }
    let accepted = 0;
    for (let i = 0; i < 1_000; i++) if (bucket.tryTake()) accepted += 1; // 1 000 rammer på 0 ms
    expect(accepted).toBeLessThanOrEqual(DEFAULT_VOICE_LIMITS.audioBurst);
  });
});

describe("peerKey (speiler apps/api http-guard clientKey)", () => {
  const req = (remote: string | undefined, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} }) as never;
  it("loopback-peer: siste X-Forwarded-For-element (vår egen proxy); ellers selve adressen", () => {
    expect(peerKey(req("127.0.0.1", "9.9.9.9, 100.64.0.7"))).toBe("100.64.0.7");
    expect(peerKey(req("::1", "100.64.0.8"))).toBe("100.64.0.8");
    expect(peerKey(req("127.0.0.1"))).toBe("127.0.0.1");
  });
  it("ikke-loopback: X-Forwarded-For er klientstyrt og IGNORERES", () => {
    expect(peerKey(req("100.64.0.9", "1.1.1.1"))).toBe("100.64.0.9");
    expect(peerKey(req(undefined))).toBe("unknown");
  });
});

describe("ConnectionTracker", () => {
  it("global og per-peer-grense; release frigjør; ukjent release røres ikke", () => {
    const t = new ConnectionTracker(3, 2);
    expect(t.tryAcquire("a")).toBeNull();
    expect(t.tryAcquire("a")).toBeNull();
    expect(t.tryAcquire("a")).toBe("peer_limit");
    expect(t.tryAcquire("b")).toBeNull();
    expect(t.tryAcquire("c")).toBe("global_limit");
    expect(t.active).toBe(3);
    t.release("a");
    expect(t.tryAcquire("c")).toBeNull();
    t.release("zzz");
    expect(t.active).toBe(3);
  });
});

describe("ProcessSlots (semafor for lokale prosesser)", () => {
  it("maks samtidige; neste slipper inn når en frigjøres; release er idempotent", async () => {
    const slots = new ProcessSlots(2, 1000);
    const r1 = await slots.acquire();
    const r2 = await slots.acquire();
    expect(slots.inUse).toBe(2);
    let third = false;
    const p3 = slots.acquire().then((release) => {
      third = true;
      return release;
    });
    await sleep(30);
    expect(third).toBe(false);
    expect(slots.queued).toBe(1);
    r1();
    r1(); // dobbel release teller ikke to ganger
    const r3 = await p3;
    expect(third).toBe(true);
    expect(slots.inUse).toBe(2);
    r2();
    r3();
    expect(slots.inUse).toBe(0);
  });

  it("kø med frist: uten plass innen fristen avvises forespørselen med VoiceBusyError (voice_busy)", async () => {
    const slots = new ProcessSlots(1, 60);
    await slots.acquire();
    const err = await slots.acquire().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceBusyError);
    expect((err as Error).message).toBe("voice_busy");
    expect(slots.queued).toBe(0);
  });

  it("en ventende forespørsel kan avbrytes (barge-in) og tar aldri en plass", async () => {
    const slots = new ProcessSlots(1, 5000);
    const holder = await slots.acquire();
    const ac = new AbortController();
    const waiting = slots.acquire(ac.signal).catch((e: unknown) => e);
    await sleep(20);
    ac.abort();
    expect(((await waiting) as Error).name).toBe("AbortError");
    holder();
    expect(slots.inUse).toBe(0);
    expect(slots.queued).toBe(0);
  });

  it("whisper: plassen frigjøres etter suksess, feil og timeout (ingen lekkasje: seks turer gjennom to plasser, aldri voice_busy)", async () => {
    const slots = new ProcessSlots(2, 200);
    const whisperModel = `${FIXTURES}/fake-model.bin`;
    const run = async (bin: string, timeoutMs: number): Promise<unknown> => {
      const stream = new LocalWhisperStt(`${FIXTURES}/${bin}`, whisperModel, 16000, "no", 1, undefined, slots, timeoutMs).startStream();
      stream.pushAudio(Buffer.alloc(3200));
      return stream.end().then(
        () => "ok",
        (err: Error) => err.message
      );
    };
    for (let i = 0; i < 3; i++) {
      expect(await run("mock-whisper-ok.sh", 5000)).toBe("ok");
      expect(slots.inUse).toBe(0);
    }
    for (let i = 0; i < 2; i++) {
      expect(String(await run("mock-whisper-fail.sh", 5000))).toContain("local_whisper_process_failed");
      expect(slots.inUse).toBe(0);
    }
    expect(await run("mock-whisper-hang.sh", 300)).toBe("local_whisper_timeout");
    expect(slots.inUse).toBe(0);
    expect(slots.queued).toBe(0);
  });

  it("piper: opptatt semafor gir voice_busy fra frames (ikke krasj), og cancel i køen frigjør uten å ta plass", async () => {
    const slots = new ProcessSlots(1, 80);
    const hang = new LocalPiperTts(`${FIXTURES}/mock-piper-hang.sh`, MODEL, undefined, slots, 30_000);
    const first = hang.synthesize("hei");
    const it1 = first.frames[Symbol.asyncIterator]();
    const firstNext = it1.next().catch(() => undefined); // holder plassen (prosessen henger)
    await sleep(100);
    expect(slots.inUse).toBe(1);
    const second = new LocalPiperTts(`${FIXTURES}/mock-piper-hang.sh`, MODEL, undefined, slots, 30_000).synthesize("hei2");
    const err = await (async () => {
      for await (const _ of second.frames) void _;
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceBusyError);
    first.cancel();
    await firstNext;
    await sleep(100);
    expect(slots.inUse).toBe(0);
  });
});

describe("tilkoblingsgrenser", () => {
  it("per-peer-grense: tilkobling nr. N+1 får voice_busy og lukkes med 1013; de andre er upåvirket; plass frigjøres ved lukking", async () => {
    gateway = await startGateway({ limits: { maxConnectionsPerPeer: 2, maxConnections: 10 } });
    const a = await new TestClient(gateway.url).connect();
    const b = await new TestClient(gateway.url).connect();
    await a.startUnproven();
    await b.startUnproven();
    const refused = await new TestClient(gateway.url).connect();
    await refused.waitFor((m) => m.type === "error" && m["error"] === "voice_busy");
    expect((await refused.waitClosed()).code).toBe(1013);
    await expectBystanderAlive(a);
    await expectBystanderAlive(b);
    a.close();
    await a.waitClosed();
    await sleep(50);
    const next = await new TestClient(gateway.url).connect();
    await next.startUnproven();
    expect(next.closeEvent).toBeNull();
    b.close();
    next.close();
  });

  it("global grense uavhengig av peer", async () => {
    gateway = await startGateway({ limits: { maxConnections: 2, maxConnectionsPerPeer: 50 } });
    const a = await new TestClient(gateway.url).connect();
    const b = await new TestClient(gateway.url).connect();
    await a.startUnproven();
    await b.startUnproven();
    const refused = await new TestClient(gateway.url).connect();
    expect((await refused.waitClosed()).code).toBe(1013);
    await expectBystanderAlive(a);
    a.close();
    b.close();
  });
});

describe("rate limit og rammegrenser", () => {
  it("lydflom (token bucket): lukkes med 1008 rate_limited; en annen økt er upåvirket", async () => {
    gateway = await startGateway({ limits: { audioBurst: 5, audioFramesPerSecond: 1 } });
    const bystander = await new TestClient(gateway.url).connect();
    await bystander.startUnproven();
    const flood = await new TestClient(gateway.url).connect();
    await flood.startUnproven();
    for (let i = 0; i < 30; i++) flood.send({ type: "audio", data: speechFrame() });
    const closed = await flood.waitClosed();
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe("rate_limited");
    expect(flood.errors()).toContain("rate_limited");
    await expectBystanderAlive(bystander);
    bystander.close();
  });

  it("normal lydrate (innenfor burst) lukkes ikke", async () => {
    gateway = await startGateway({ limits: { audioBurst: 40, audioFramesPerSecond: 100 } });
    const client = await new TestClient(gateway.url).connect();
    await client.startUnproven();
    for (let i = 0; i < 30; i++) client.send({ type: "audio", data: speechFrame() });
    await sleep(150);
    expect(client.closeEvent).toBeNull();
    client.close();
  });

  it("kontrollmeldinger har egen, lav grense (voice_sample/start trigger dyre kall)", async () => {
    gateway = await startGateway({ limits: { controlBurst: 4, controlPerSecond: 1 } });
    const client = await new TestClient(gateway.url).connect();
    for (let i = 0; i < 20; i++) client.send({ type: "voice_settings", settings: {} });
    const closed = await client.waitClosed();
    expect(closed.code).toBe(1008);
  });

  it("ugyldig JSON teller mot kontrollgrensen (ingen gratis flom av parse-feil)", async () => {
    gateway = await startGateway({ limits: { controlBurst: 3, controlPerSecond: 1 } });
    const client = await new TestClient(gateway.url).connect();
    for (let i = 0; i < 20; i++) client.sendRaw("{ikke json");
    expect((await client.waitClosed()).code).toBe(1008);
    expect(client.errors()).toContain("invalid_json");
  });

  it("JSON som ikke er et objekt (null, tall, liste) gir invalid_json - ikke internal_error/krasj", async () => {
    gateway = await startGateway();
    const client = await new TestClient(gateway.url).connect();
    for (const raw of ["null", "42", "[1,2]", '"tekst"']) client.sendRaw(raw);
    await sleep(100);
    expect(client.errors()).toEqual(["invalid_json", "invalid_json", "invalid_json", "invalid_json"]);
    expect(client.closeEvent).toBeNull();
    client.close();
  });

  it("kø av ubehandlede meldinger er begrenset (overloaded) når Core-autorisasjon henger", async () => {
    const { ScriptedCore } = await import("./wpv2-harness.ts");
    const core = new ScriptedCore();
    core.authorizeVoiceSession = () => new Promise(() => undefined); // henger
    gateway = await startGateway({ core, limits: { maxQueuedMessages: 10, audioBurst: 1000, audioFramesPerSecond: 1000 } });
    const client = await new TestClient(gateway.url).connect();
    client.send({ type: "start", identity: { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal" }, device_proof: { challenge: "c", signature: "s" } });
    for (let i = 0; i < 40; i++) client.send({ type: "audio", data: speechFrame() });
    const closed = await client.waitClosed();
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe("overloaded");
  });
});

describe("inaktivitet, varighet og halvåpne tilkoblinger", () => {
  it("ingen melding på idleTimeoutMs lukker tilkoblingen (1000 idle_timeout); aktivitet utsetter", async () => {
    gateway = await startGateway({ limits: { idleTimeoutMs: 300 } });
    const idle = await new TestClient(gateway.url).connect();
    const active = await new TestClient(gateway.url).connect();
    await idle.startUnproven();
    await active.startUnproven();
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      active.send({ type: "voice_settings", settings: {} });
    }
    const closed = await idle.waitClosed();
    expect(closed).toEqual({ code: 1000, reason: "idle_timeout" });
    expect(active.closeEvent).toBeNull();
    active.close();
  });

  it("ubevist tilkobling lukkes etter maxUnprovenSessionMs (1000 max_duration), selv med jevn aktivitet", async () => {
    gateway = await startGateway({ limits: { maxUnprovenSessionMs: 400, idleTimeoutMs: 10_000 } });
    const client = await new TestClient(gateway.url).connect();
    await client.startUnproven();
    for (let i = 0; i < 8 && client.closeEvent === null; i++) {
      await sleep(100);
      if (client.closeEvent === null) client.send({ type: "voice_settings", settings: {} });
    }
    expect(await client.waitClosed()).toEqual({ code: 1000, reason: "max_duration" });
  });

  it("BEVIST sesjon omfattes ikke av 30 min-taket (grant-levetiden styrer)", async () => {
    gateway = await startGateway({ limits: { maxUnprovenSessionMs: 200, idleTimeoutMs: 10_000 } });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven();
    await sleep(700);
    expect(client.closeEvent).toBeNull();
    await expectBystanderAlive(client);
    client.close();
  });

  it("halvåpen tilkobling (klienten svarer aldri på ping) termineres av server-ping", async () => {
    gateway = await startGateway({ limits: { pingIntervalMs: 100, idleTimeoutMs: 10_000 } });
    const half = await new TestClient(gateway.url, { autoPong: false }).connect();
    await half.startUnproven();
    const healthy = await new TestClient(gateway.url).connect(); // svarer automatisk på ping
    await healthy.startUnproven();
    const closed = await half.waitClosed(3000);
    expect(closed.code).toBe(1006);
    await sleep(350);
    expect(healthy.closeEvent).toBeNull();
    await expectBystanderAlive(healthy);
    healthy.close();
  });
});

/** TTS som leverer mye data raskt (for å fylle sendebufferet til en klient som ikke leser). */
class FloodTts implements TtsAdapter {
  readonly name = "wpv2-flood-tts";
  readonly processor = LOCAL;
  readonly sampleRate = 16_000;
  cancelled = 0;
  produced = 0;
  available(): boolean {
    return true;
  }
  synthesize(): TtsPlayback {
    let stop = false;
    const onFrame = (): void => {
      this.produced += 1;
    };
    async function* frames(): AsyncIterable<Buffer> {
      for (let i = 0; i < 3000 && !stop; i++) {
        onFrame();
        yield Buffer.alloc(16 * 1024);
        if (i % 20 === 0) await sleep(1);
      }
    }
    return { frames: frames(), cancel: () => { stop = true; this.cancelled += 1; } };
  }
}

describe("backpressure", () => {
  it("langsom forbruker (ws.bufferedAmount over taket): TTS avbrytes og tilkoblingen lukkes med 1013; en annen økt er upåvirket", async () => {
    const tts = new FloodTts();
    gateway = await startGateway({ tts, limits: { maxBufferedBytes: 64 * 1024 } });
    const bystander = await new TestClient(gateway.url).connect();
    await bystander.startUnproven();
    const slow = await new TestClient(gateway.url).connect();
    await slow.startUnproven();
    slow.pauseReading(); // klienten leser aldri fra socketen
    slow.send({ type: "voice_sample" });
    // Serveren skal gi opp: TTS avbrutt (cancel kalt) lenge før alle 3000 rammer (48 MB) er produsert.
    const started = Date.now();
    while (tts.cancelled === 0 && Date.now() - started < 8000) await sleep(20);
    expect(tts.cancelled).toBeGreaterThanOrEqual(1);
    expect(tts.produced).toBeLessThan(3000);
    await expectBystanderAlive(bystander);
    bystander.close();
  }, 20_000);
});

/** Venter til `predicate` er sann (maks `timeoutMs`); kaster ved tidsavbrudd. */
async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timeout i waitUntil");
    }
    await sleep(10);
  }
}

/** Rå TCP + håndlaget WebSocket-oppgradering. Nøkkelen bygges ved kjøring (aldri en literal). Klienten leser aldri etter 101-svaret. */
async function rawUpgradeNonReading(port: number): Promise<Socket> {
  const sock = connect(port, "127.0.0.1");
  sock.on("error", () => undefined);
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  const key = randomBytes(16).toString("base64");
  sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise<void>((resolve) => sock.once("data", () => resolve()));
  sock.pause(); // fra nå av leses ingenting fra serveren: alt serveren sender hoper seg opp i dens sendebuffer
  return sock;
}

/** Maskert klientramme (opcode 0x9 ping / 0xA pong, 125 byte nyttelast = maks for en kontrollramme). */
function maskedControlFrame(opcode: number): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.alloc(125, 0x61);
  const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] as number)));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 125]), mask, masked]);
}

describe("FIX-1 (F1): kontrollramme-flom (ping/pong) - ws svarer ikke lenger automatisk og uten grense", () => {
  it("standardverdiene for ping/pong-bøtta (2/s, burst 10) er med i grensene", () => {
    expect(DEFAULT_VOICE_LIMITS).toMatchObject({ pingPongPerSecond: 2, pingPongBurst: 10 });
  });

  it("legitim bruk: noen få pings innenfor bøtta besvares med SAMME nyttelast (RFC 6455 §5.5.3), og tilkoblingen lever", async () => {
    gateway = await startGateway();
    const client = await new TestClient(gateway.url).connect();
    const pongs: string[] = [];
    client.ws.on("pong", (data: Buffer) => pongs.push(data.toString("utf8")));
    for (let i = 0; i < 5; i++) client.ws.ping(`p${i}`);
    await waitUntil(() => pongs.length >= 5);
    expect(pongs).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(client.closeEvent).toBeNull();
    await expectBystanderAlive(client);
    client.close();
  });

  it("ping-flom fra en klient som LESER: kun bøtta besvares (aldri alle), tilkoblingen termineres, flommen logges ÉN gang, og en annen økt er upåvirket", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    gateway = await startGateway();
    const bystander = await new TestClient(gateway.url).connect();
    await bystander.startUnproven();
    const flood = await new TestClient(gateway.url).connect();
    let pongs = 0;
    flood.ws.on("pong", () => {
      pongs += 1;
    });
    const payload = Buffer.alloc(125, 0x61);
    for (let i = 0; i < 20_000; i++) flood.ws.ping(payload);
    const closed = await flood.waitClosed(6000);
    expect(closed.code).toBe(1006); // terminert uten høflig lukking: en flom får ikke 5 s ekstra parsing
    expect(pongs).toBeLessThanOrEqual(DEFAULT_VOICE_LIMITS.pingPongBurst + 2);
    // Tusenvis av rammer kan leveres i samme tikk etter at bøtta er tom: kun den første logges (ikke én loggline per ramme).
    expect(logs.filter((l) => l.includes("voice_control_frame_flood"))).toEqual(['{"msg":"voice_control_frame_flood","frame":"ping"}']);
    await expectBystanderAlive(bystander);
    bystander.close();
  }, 20_000);

  it("ping-flom fra en klient som IKKE leser (rå TCP): serveren lukker raskt og serverens minne vokser ikke", async () => {
    gateway = await startGateway();
    const sock = await rawUpgradeNonReading(gateway.port);
    let closed = false;
    sock.on("error", () => {
      closed = true;
    });
    sock.on("close", () => {
      closed = true;
    });
    const batch = Buffer.concat(Array.from({ length: 2000 }, () => maskedControlFrame(0x9))); // 262 KB per skriving
    const rssBefore = process.memoryUsage().rss;
    const startedAt = Date.now();
    let sentBytes = 0;
    while (!closed && Date.now() - startedAt < 2500) {
      const flushed = sock.write(batch);
      sentBytes += batch.length;
      if (!flushed) {
        await new Promise<void>((resolve) => {
          const done = (): void => resolve();
          sock.once("drain", done);
          sock.once("close", done);
          setTimeout(done, 100);
        });
      }
    }
    await sleep(100);
    const rssGrowthMb = (process.memoryUsage().rss - rssBefore) / (1024 * 1024);
    sock.destroy();
    expect(closed).toBe(true);
    expect(sentBytes).toBeLessThan(40 * 1024 * 1024); // avbrutt tidlig - ikke 2,5 s med full flom
    expect(rssGrowthMb).toBeLessThan(60); // uten fiksen: hundrevis av MB (målt 105 MB -> 2,1 GB på 10 s)
  }, 20_000);

  it("pong-flom (ubedte pong): lukkes på samme måte; en ubedt pong er ellers lov (ensrettet hjerteslag)", async () => {
    gateway = await startGateway();
    const one = await new TestClient(gateway.url).connect();
    one.ws.pong(); // én ubedt pong innenfor bøtta
    await sleep(50);
    expect(one.closeEvent).toBeNull();
    one.close();
    const flood = await new TestClient(gateway.url).connect();
    for (let i = 0; i < 5000; i++) flood.ws.pong(Buffer.alloc(8, 0x62));
    expect((await flood.waitClosed(6000)).code).toBe(1006);
  }, 20_000);

  it("pong som SVAR på serverens egen ping er forespurt og koster ingen token (halvåpen-vernet kan ikke slå seg selv av)", async () => {
    // Bøtta har plass til ÉN ubedt pong og fylles nesten ikke på. Serveren pinger hvert 20. ms; en frisk klient svarer på hver ping.
    gateway = await startGateway({ limits: { pingIntervalMs: 20, pingPongBurst: 1, pingPongPerSecond: 0.001, idleTimeoutMs: 10_000 } });
    const healthy = await new TestClient(gateway.url).connect();
    let serverPings = 0;
    healthy.ws.on("ping", () => {
      serverPings += 1;
    });
    await sleep(500);
    expect(serverPings).toBeGreaterThanOrEqual(10); // serveren har pinget mange ganger, og klienten har (auto)svart på alle
    expect(healthy.closeEvent).toBeNull();
    await expectBystanderAlive(healthy);
    healthy.close();
  });
});
