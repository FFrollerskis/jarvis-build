import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { journalKey, UtteranceJournal as SharedJournal } from "../src/journal.ts";
import { UtteranceJournal } from "../src/session.ts";
import { VoiceSession, type CoreReply, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import { HttpCoreClient } from "../src/server.ts";
import { MarkerStt } from "../src/stt.ts";
import { FakeTts } from "../src/tts.ts";
import { EnergyVad, type VadAdapter, type VadEvent } from "../src/vad.ts";
import { IDENTITY, ScriptedCore, TestClient, grantFor, sleep, speechFrame, startGateway, trackUncaught, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 K5 (v2.1 §14): failover uten doble verktøyhandlinger. På `main` ble journalen laget PER SESJON (`options.journal ?? new
 * UtteranceJournal()` inne i `startSession`), så `replay_final` med samme utterance_id på to tilkoblinger ga TO Core-kall. Dessuten:
 * regresjonslås for JARVIS-079 (VAD per sesjon, ingen zombie-tur etter frakobling, barge-in starter ikke nye verktøykall).
 */
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

const ID: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice" };

function spyEvents(): SessionEvents & { replies: CoreReply[]; frames: Buffer[]; errors: string[]; tools: string[]; metricsIds: string[] } {
  const replies: CoreReply[] = [];
  const frames: Buffer[] = [];
  const errors: string[] = [];
  const tools: string[] = [];
  const metricsIds: string[] = [];
  return {
    replies, frames, errors, tools, metricsIds,
    onState: () => undefined, onPartial: () => undefined, onFinal: () => undefined,
    onReply: (r) => { replies.push(r); },
    onTtsFrame: (f) => { frames.push(f); }, onTtsCancelled: () => undefined,
    onMetrics: (m) => { metricsIds.push(m.utterance_id); },
    onError: (e) => { errors.push(e); },
    onToolActivity: (a) => { tools.push(a); }
  };
}

describe("UtteranceJournal: atomisk claim, begrenset (LRU + TTL)", () => {
  it("claim er atomisk: første får `claimed`, andre `in_flight`, etter complete `completed`", () => {
    const j = new SharedJournal();
    expect(j.claim("k")).toBe("claimed");
    expect(j.claim("k")).toBe("in_flight");
    j.complete("k");
    expect(j.claim("k")).toBe("completed");
    expect(j.isCompleted("k")).toBe(true);
  });

  it("release frigjør en claim som aldri nådde Core, men rører aldri en fullført nøkkel", () => {
    const j = new SharedJournal();
    expect(j.claim("a")).toBe("claimed");
    j.release("a");
    expect(j.claim("a")).toBe("claimed");
    j.complete("a");
    j.release("a");
    expect(j.claim("a")).toBe("completed");
  });

  it("kapasitet: aldri flere enn maxEntries; eldste FULLFØRTE kastes først, en pågående claim vernes", () => {
    const j = new SharedJournal({ maxEntries: 5 });
    expect(j.claim("pending")).toBe("claimed");
    for (let i = 0; i < 50; i++) {
      j.claim(`done-${i}`);
      j.complete(`done-${i}`);
    }
    expect(j.size).toBeLessThanOrEqual(5);
    expect(j.evictedForCapacity).toBeGreaterThan(0);
    expect(j.claim("pending")).toBe("in_flight"); // ikke kastet
    expect(j.claim("done-0")).toBe("claimed"); // eldste fullførte ble kastet (dokumentert grense)
  });

  it("minnegrense: 100 000 unike id-er gir aldri mer enn maxEntries nøkler", () => {
    const j = new SharedJournal({ maxEntries: 1000 });
    for (let i = 0; i < 100_000; i++) {
      j.claim(`k-${i}`);
      j.complete(`k-${i}`);
    }
    expect(j.size).toBeLessThanOrEqual(1000);
  });

  it("TTL: fullført nøkkel glemmes etter completedTtlMs; en død claim etter claimedTtlMs", () => {
    let now = 1_000_000;
    const j = new SharedJournal({ completedTtlMs: 5_000, claimedTtlMs: 2_000, now: () => now });
    j.claim("c");
    j.complete("c");
    j.claim("d");
    now += 1_999;
    expect(j.claim("c")).toBe("completed");
    expect(j.claim("d")).toBe("in_flight");
    now += 2;
    expect(j.claim("d")).toBe("claimed"); // claimed-TTL utløpt (turen døde uten complete/release)
    now += 3_100;
    expect(j.claim("c")).toBe("claimed"); // completed-TTL utløpt
  });

  it("isCompleted respekterer TTL (replay_final bruker den som tidlig, billig sjekk): ukjent/claimed er ikke completed, fullført er det til TTL er over", () => {
    let t = 1000;
    const journal = new SharedJournal({ now: () => t, completedTtlMs: 5000 });
    const key = journalKey("SERVER_VERIFIED", "T", "D", "u");
    expect(journal.isCompleted(key)).toBe(false); // ukjent
    expect(journal.claim(key)).toBe("claimed");
    expect(journal.isCompleted(key)).toBe(false); // pågående er ikke fullført
    journal.complete(key);
    expect(journal.isCompleted(key)).toBe(true);
    t += 4999;
    expect(journal.isCompleted(key)).toBe(true);
    t += 2; // TTL (5000 ms) er over
    expect(journal.isCompleted(key)).toBe(false);
    expect(journal.claim(key)).toBe("claimed"); // og claim() er enig: nøkkelen er glemt
  });

  it("LRU: et treff holder nøkkelen ferskere i kapasitetsrekkefølgen", () => {
    const j = new SharedJournal({ maxEntries: 3 });
    for (const k of ["a", "b", "c"]) {
      j.claim(k);
      j.complete(k);
    }
    expect(j.claim("a")).toBe("completed"); // treff: a er nå fersk
    j.claim("d");
    j.complete("d"); // kapasitet: kaster eldste fullførte = b
    expect(j.claim("a")).toBe("completed");
    expect(j.claim("b")).toBe("claimed");
  });

  it("journalKey er entydig (ingen skilletegn-kollisjon) og skiller tillitsnivå, tenant, enhet og id", () => {
    const keys = new Set([
      journalKey("SERVER_VERIFIED", "t", "d", "u"),
      journalKey("CLIENT_ASSERTED", "t", "d", "u"),
      journalKey("SERVER_VERIFIED", "t2", "d", "u"),
      journalKey("SERVER_VERIFIED", "t", "d2", "u"),
      journalKey("SERVER_VERIFIED", "t", "d", "u2"),
      journalKey("SERVER_VERIFIED", "t|d", "", "u"),
      journalKey("SERVER_VERIFIED", "t", "|d", "u")
    ]);
    expect(keys.size).toBe(7);
  });

  it("session.ts re-eksporterer samme klasse (bakoverkompatibel import)", () => {
    expect(UtteranceJournal).toBe(SharedJournal);
  });
});

describe("K5 målt funn: standardoppsettet delte IKKE journal mellom tilkoblinger", () => {
  it("replay_final med samme utterance_id på to tilkoblinger = ÉTT Core-kall (standard journal, ingen injisert)", async () => {
    const core = new ScriptedCore();
    gateway = await startGateway({ core });
    const a = await new TestClient(gateway.url).connect();
    await a.startProven();
    a.send({ type: "replay_final", utterance_id: "utt-shared-1", text: "opprett jobb: x" });
    await a.waitFor((m) => m.type === "reply");
    a.close();

    const b = await new TestClient(gateway.url).connect();
    await b.startProven();
    b.send({ type: "replay_final", utterance_id: "utt-shared-1", text: "opprett jobb: x" });
    const err = await b.waitFor((m) => m.type === "error");
    expect(String(err["error"])).toBe("utterance_already_completed:utt-shared-1");
    expect(core.chatCalls).toHaveLength(1);
    b.close();
  });

  it("to SAMTIDIGE replay_final for samme id (to tilkoblinger) = ÉTT Core-kall (atomisk claim før Core)", async () => {
    const core = new ScriptedCore();
    core.chatDelayMs = 250;
    gateway = await startGateway({ core });
    const a = await new TestClient(gateway.url).connect();
    const b = await new TestClient(gateway.url).connect();
    await a.startProven();
    await b.startProven();
    a.send({ type: "replay_final", utterance_id: "utt-race-1", text: "hei" });
    b.send({ type: "replay_final", utterance_id: "utt-race-1", text: "hei" });
    await sleep(600);
    expect(core.chatCalls).toHaveLength(1);
    const errors = [...a.errors(), ...b.errors()];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^utterance_(in_flight|already_completed):utt-race-1$/);
    a.close();
    b.close();
  });

  it("samme id fra ULIKE enheter er ulike nøkler (to Core-kall)", async () => {
    const core = new ScriptedCore();
    gateway = await startGateway({ core });
    const a = await new TestClient(gateway.url).connect();
    const b = await new TestClient(gateway.url).connect();
    await a.startProven({ ...IDENTITY, device_id: "dev-a" });
    await b.startProven({ ...IDENTITY, device_id: "dev-b" });
    a.send({ type: "replay_final", utterance_id: "utt-same", text: "hei" });
    b.send({ type: "replay_final", utterance_id: "utt-same", text: "hei" });
    await a.waitFor((m) => m.type === "reply");
    await b.waitFor((m) => m.type === "reply");
    expect(core.chatCalls).toHaveLength(2);
    a.close();
    b.close();
  });

  it("samme id og SAMME enhet, men ULIKE tenanter, er ulike nøkler (to Core-kall): tenant er med i sesjonens journalnøkkel", async () => {
    const core = new ScriptedCore();
    gateway = await startGateway({ core });
    const a = await new TestClient(gateway.url).connect();
    const b = await new TestClient(gateway.url).connect();
    await a.startProven({ ...IDENTITY, tenant_id: "tenant-a" });
    await b.startProven({ ...IDENTITY, tenant_id: "tenant-b" });
    a.send({ type: "replay_final", utterance_id: "utt-tenant", text: "hei" });
    b.send({ type: "replay_final", utterance_id: "utt-tenant", text: "hei" });
    await a.waitFor((m) => m.type === "reply");
    await b.waitFor((m) => m.type === "reply");
    expect(core.chatCalls.map((c) => c.identity.tenant_id).sort()).toEqual(["tenant-a", "tenant-b"]);
    expect(a.errors()).toEqual([]);
    expect(b.errors()).toEqual([]);
    a.close();
    b.close();
  });

  it("en UBEVIST klient kan ikke forhåndsclaime id-er i den bevistes nøkkelrom", async () => {
    const core = new ScriptedCore();
    gateway = await startGateway({ core });
    const attacker = await new TestClient(gateway.url).connect();
    await attacker.startUnproven(); // påstår samme tenant/enhet som den bevisste
    attacker.send({ type: "replay_final", utterance_id: "utt-poison", text: "hei" });
    await attacker.waitFor((m) => m.type === "reply");
    const proven = await new TestClient(gateway.url).connect();
    await proven.startProven();
    proven.send({ type: "replay_final", utterance_id: "utt-poison", text: "hei" });
    await proven.waitFor((m) => m.type === "reply");
    expect(core.chatCalls).toHaveLength(2); // ikke «already completed» for den bevisste
    attacker.close();
    proven.close();
  });

  it("injisert journal brukes av alle sesjoner (main.ts-oppsettet)", async () => {
    const core = new ScriptedCore();
    const journal = new SharedJournal();
    gateway = await startGateway({ core, journal });
    const a = await new TestClient(gateway.url).connect();
    await a.startProven();
    a.send({ type: "replay_final", utterance_id: "utt-inj", text: "hei" });
    await a.waitFor((m) => m.type === "reply");
    expect(journal.size).toBe(1);
    a.close();
  });
});

describe("K5: utfall etter claim - aldri en ny utførelse etter et mulig Core-kall", () => {
  async function runReplay(core: ScriptedCore, journal: SharedJournal, id: string): Promise<string[]> {
    const events = spyEvents();
    const session = new VoiceSession(ID, core, new MarkerStt(), new FakeTts(1), events, journal);
    session.replayFinal(id, "hei");
    await sleep(120);
    return events.errors;
  }

  it("Core-feil underveis (kan ha utført verktøy): en replay avvises, Core kalles ikke på nytt", async () => {
    const core = new ScriptedCore();
    core.chatError = new Error("core_503");
    const journal = new SharedJournal();
    expect(await runReplay(core, journal, "utt-fail-1")).toEqual(["core_error"]);
    core.chatError = null;
    expect(await runReplay(core, journal, "utt-fail-1")).toEqual(["utterance_already_completed:utt-fail-1"]);
    expect(core.chatCalls).toHaveLength(1);
  });

  it("voice_session_required (forespørselen nådde aldri Core): claim frigjøres, replay kan kjøre", async () => {
    const core = new ScriptedCore();
    core.chatError = new Error("voice_session_required");
    const journal = new SharedJournal();
    expect(await runReplay(core, journal, "utt-nosend-1")).toEqual(["core_error"]);
    core.chatError = null;
    expect(await runReplay(core, journal, "utt-nosend-1")).toEqual([]);
    expect(core.chatCalls).toHaveLength(2);
  });

  it("frakoblet sesjon (closed) tar aldri en claim", async () => {
    const core = new ScriptedCore();
    const journal = new SharedJournal();
    const session = new VoiceSession(ID, core, new MarkerStt(), new FakeTts(1), spyEvents(), journal);
    session.disconnect();
    session.replayFinal("utt-closed", "hei");
    await sleep(80);
    expect(journal.size).toBe(0);
    expect(core.chatCalls).toHaveLength(0);
  });
});

describe("K5: unike utterance-id-er (ikke Date.now() i ms)", () => {
  it("to sesjoner for samme enhet opprettet i SAMME millisekund får ulike prefikser og begge turene når Core", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const core = new ScriptedCore();
    const journal = new SharedJournal();
    const e1 = spyEvents();
    const e2 = spyEvents();
    const s1 = new VoiceSession(ID, core, new MarkerStt(), new FakeTts(1), e1, journal);
    const s2 = new VoiceSession(ID, core, new MarkerStt(), new FakeTts(1), e2, journal);
    vi.restoreAllMocks();
    for (const [session, text] of [[s1, "en"], [s2, "to"]] as const) {
      session.pushAudio(Buffer.from(speechFrame(text), "base64"), 1_000);
      session.pushAudio(Buffer.from(speechFrame(), "base64"), 1_020);
      session.pushAudio(Buffer.alloc(640), 1_900); // stillhet > hangover (700 ms) = end_of_turn
    }
    await sleep(300);
    expect(core.chatCalls.map((c) => c.message).sort()).toEqual(["en", "to"]);
    expect(e1.metricsIds[0]).not.toBe(e2.metricsIds[0]);
    expect(e1.errors).toEqual([]);
    expect(e2.errors).toEqual([]);
  });
});

/** VAD som teller kall - beviser at hver sesjon har sin EGEN instans og at rammene aldri krysser sesjoner. */
class CountingVad implements VadAdapter {
  pushes = 0;
  private readonly inner = new EnergyVad();
  push(frame: Buffer, atMs: number): VadEvent {
    this.pushes += 1;
    return this.inner.push(frame, atMs);
  }
  reset(): void {
    this.inner.reset();
  }
}

describe("JARVIS-079 regresjonslås (var utestet: grep «vad:» i testene ga 0 treff)", () => {
  it("to samtidige sesjoner får hver sin VadAdapter (fabrikk), og rammer krysser ikke sesjoner", async () => {
    const created: CountingVad[] = [];
    gateway = await startGateway({ vad: () => { const v = new CountingVad(); created.push(v); return v; } });
    const a = await new TestClient(gateway.url).connect();
    const b = await new TestClient(gateway.url).connect();
    await a.startProven({ ...IDENTITY, device_id: "dev-a" });
    await b.startProven({ ...IDENTITY, device_id: "dev-b" });
    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
    for (let i = 0; i < 3; i++) a.send({ type: "audio", data: speechFrame() });
    for (let i = 0; i < 5; i++) b.send({ type: "audio", data: speechFrame() });
    await sleep(200);
    expect(created.map((v) => v.pushes).sort()).toEqual([3, 5]);
    a.close();
    b.close();
  });

  it("frakobling midt i chatStream: signalet aborteres, og ingen onReply/onTtsFrame kommer etter frakobling (selv om Core ignorerer abort)", async () => {
    const core = new ScriptedCore();
    let signalSeen: AbortSignal | undefined;
    core.chatStream = async (_identity, _message, onEvent, signal) => {
      signalSeen = signal;
      onEvent({ type: "token", text: "Hei der. " });
      await sleep(150); // ignorerer abort bevisst
      onEvent({ type: "token", text: "Mer tekst her. " });
      return { reply: "Hei der. Mer tekst her. ", routed: "model", session_id: "s" };
    };
    const events = spyEvents();
    const session = new VoiceSession(ID, core, new MarkerStt(), new FakeTts(1), events, new SharedJournal());
    session.replayFinal("utt-zombie-1", "hei");
    await sleep(40);
    session.disconnect();
    const framesAtDisconnect = events.frames.length;
    await sleep(350);
    expect(signalSeen?.aborted).toBe(true);
    expect(events.replies).toHaveLength(0);
    expect(events.frames.length).toBe(framesAtDisconnect);
  });

  it("barge-in aborterer Core-strømmen og senere verktøyhendelser spilles/varsles ikke (ingen nye verktøykall fra tale-laget)", async () => {
    const core = new ScriptedCore();
    let signalSeen: AbortSignal | undefined;
    let emittedAfterAbort = 0;
    core.chatStream = async (_identity, _message, onEvent, signal) => {
      signalSeen = signal;
      for (let i = 0; i < 20; i++) {
        await sleep(15);
        if (signal?.aborted) emittedAfterAbort += 1;
        onEvent({ type: "tool", tool_name: "calendar__list" });
      }
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const events = spyEvents();
    const session = new VoiceSession(ID, core, new MarkerStt(), new FakeTts(1), events, new SharedJournal(), new EnergyVad());
    session.replayFinal("utt-bargein-1", "hei");
    await sleep(50);
    const toolsBefore = events.tools.length;
    expect(toolsBefore).toBeGreaterThan(0);
    // Ren tale mens turen pågår (state = thinking) = barge-in.
    session.pushAudio(Buffer.from(speechFrame("stopp"), "base64"), 5_000);
    expect(signalSeen?.aborted).toBe(true);
    const toolsAtBargeIn = events.tools.length;
    await sleep(350);
    expect(events.tools.length).toBe(toolsAtBargeIn); // epoch-vernet forkaster sene verktøyhendelser
    expect(emittedAfterAbort).toBeGreaterThan(0); // (Core-fakens sene hendelser kom, men ble ikke videresendt)
  });
});

describe("K5: idempotens gjennom ekte HttpCoreClient mot en HTTP-stub for Core (ikke bare ScriptedCore)", () => {
  let coreServer: Server | undefined;
  afterEach(async () => {
    coreServer?.closeAllConnections();
    await new Promise<void>((resolve) => (coreServer ? coreServer.close(() => resolve()) : resolve()));
    coreServer = undefined;
  });

  it("ubevist: ingen /chat (voice_session_required -> claim frigjort); bevist: nøyaktig ÉN /chat per (tenant, enhet, id) og kroppen er kun grant_token+message", async () => {
    const chats: Array<{ keys: string; message: string }> = [];
    coreServer = createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString("utf8")));
      req.on("end", () => {
        if (req.url === "/voice/session/authorize") {
          const evidence = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, grant: grantFor(evidence) }));
        } else if (req.url === "/chat") {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          chats.push({ keys: Object.keys(parsed).sort().join(","), message: String(parsed["message"]) });
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end('event: done\ndata: {"reply":"ok","routed":"fast","session_id":"s"}\n\n');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => coreServer!.listen(0, "127.0.0.1", resolve));
    const corePort = (coreServer.address() as { port: number }).port;
    gateway = await startGateway({ core: new HttpCoreClient(`http://127.0.0.1:${corePort}`), limits: { maxConnectionsPerPeer: 10 } }); // fem tilkoblinger fra samme loopback-peer
    const replay = (c: TestClient, id: string): void => c.send({ type: "replay_final", utterance_id: id, text: "betal 5000 kr" });
    const settle = (): Promise<void> => sleep(350);

    // A: ubevist - Core nås aldri, og claimen frigjøres (en ny replay gir core_error igjen, ikke «already completed»)
    const unproven = await new TestClient(gateway.url).connect();
    await unproven.startUnproven({ ...IDENTITY, tenant_id: "T1", device_id: "D1" });
    replay(unproven, "u-x");
    await settle();
    replay(unproven, "u-x");
    await settle();
    expect(chats).toHaveLength(0);
    expect(unproven.errors()).toEqual(["core_error", "core_error"]);

    // B: bevist (T1, D1) med SAMME id: den ubevistes forhåndsclaim blokkerer ikke, og kroppen er kun grant_token+message (D-131)
    const t1d1 = await new TestClient(gateway.url).connect();
    await t1d1.startProven({ ...IDENTITY, tenant_id: "T1", device_id: "D1" });
    replay(t1d1, "u-x");
    await settle();
    expect(chats).toHaveLength(1);
    expect(chats[0]?.keys).toBe("grant_token,message");

    // C: annen tenant og annen enhet: hver sin utførelse (ingen kryss-blokkering)
    const t2d1 = await new TestClient(gateway.url).connect();
    const t1d2 = await new TestClient(gateway.url).connect();
    await t2d1.startProven({ ...IDENTITY, tenant_id: "T2", device_id: "D1" });
    await t1d2.startProven({ ...IDENTITY, tenant_id: "T1", device_id: "D2" });
    replay(t2d1, "u-x");
    replay(t1d2, "u-x");
    await settle();
    expect(chats).toHaveLength(3);

    // D: to tilkoblinger for samme (T1, D1) som replayer samme NYE id samtidig: kun ÉN utførelse
    const t1d1b = await new TestClient(gateway.url).connect();
    await t1d1b.startProven({ ...IDENTITY, tenant_id: "T1", device_id: "D1" });
    replay(t1d1, "u-y");
    replay(t1d1b, "u-y");
    await settle();
    expect(chats).toHaveLength(4);
    expect([...t1d1.errors(), ...t1d1b.errors()].filter((e) => e.startsWith("utterance_"))).toHaveLength(1);
    for (const c of [unproven, t1d1, t2d1, t1d2, t1d1b]) c.close();
  });
});
