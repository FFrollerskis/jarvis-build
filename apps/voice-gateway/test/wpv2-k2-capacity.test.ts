import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionTracker, DEFAULT_VOICE_LIMITS, ProcessSlots, TokenBucket, VoiceBusyError, peerKey, resolveLimits } from "../src/limits.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";
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
