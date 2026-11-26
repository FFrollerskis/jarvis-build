import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CoreRequestNotSentError, isRequestNotSent } from "../src/core-errors.ts";
import { HttpCoreClient } from "../src/server.ts";
import type { CoreClient, VoiceIdentity } from "../src/session.ts";
import { IDENTITY, ScriptedCore, TestClient, fixtureToken, sleep, startGateway, trackUncaught, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 FIX-5 (F5): etter `core_error` regnes turen som utført og `replay_final` nektes (trygt mot dobbel-ACT, men kommandoen er tapt). Nå skilles det mellom
 * feil der forespørselen BEVISELIG aldri nådde Core (tilkoblings-/DNS-fasen: claimen frigjøres, klienten kan sende på nytt) og alt annet (ukjent utfall: claimen
 * beholdes, aldri retry). Beviset er Node-feilens `syscall`: «connect»/«getaddrinfo» betyr at ingen byte ble skrevet. Målt (Node 22): lukket port ->
 * `TypeError: fetch failed` med `cause {code: ECONNREFUSED, syscall: connect}`; en socket serveren dreper etter mottatt forespørsel -> `UND_ERR_SOCKET` uten syscall.
 */
let gateway: RunningGateway | undefined;
let tracker = trackUncaught();
const servers: Server[] = [];

afterEach(async () => {
  tracker.stop();
  await gateway?.close();
  gateway = undefined;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  tracker = trackUncaught();
  expect(tracker.errors).toEqual([]);
});

/** En port ingen lytter på (lyttet og lukket) - IKKE port 9 (fetch-spesifikasjonen blokkerer den med «bad port» uten nettverk). */
async function closedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type Behaviour = "sse_ok" | "destroy_socket" | "http_500" | "hang";

async function stubCore(port: number, behaviour: Behaviour, hits: string[]): Promise<void> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push(req.url ?? "");
      if (behaviour === "destroy_socket") {
        req.socket.destroy(); // forespørselen er mottatt - Core kan ha utført den
      } else if (behaviour === "http_500") {
        res.writeHead(500);
        res.end();
      } else if (behaviour === "sse_ok") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('event: done\ndata: {"reply":"ok","routed":"fast","session_id":"s"}\n\n');
      } // hang: svarer aldri
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
}

const PROVEN_ID: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice", grant_token: fixtureToken("grant") };

/** Core der autorisering går via en stub, men `/chat` går til en ekte `HttpCoreClient` mot `chatUrl`. */
function splitCore(chatUrl: string, timeouts?: { turnTimeoutMs?: number }): CoreClient {
  const scripted = new ScriptedCore();
  const http = new HttpCoreClient(chatUrl, timeouts);
  return {
    authorizeVoiceSession: (evidence) => scripted.authorizeVoiceSession(evidence),
    chat: (identity, message) => http.chat(identity, message),
    chatStream: (identity, message, onEvent, signal) => http.chatStream(identity, message, onEvent, signal)
  };
}

const withCause = (cause: unknown, message = "fetch failed"): Error => Object.assign(new TypeError(message), { cause });
const sysErr = (code: string, syscall?: string): Error => Object.assign(new Error(`${syscall ?? "x"} ${code}`), { code, ...(syscall ? { syscall } : {}) });

describe("FIX-5: klassifisering - kun BEVIS for at ingenting ble sendt frigjør claimen", () => {
  it("tilkoblings- og DNS-fasen (syscall connect/getaddrinfo) er bevis, også i en AggregateError der ALLE delfeil er det", () => {
    expect(isRequestNotSent(withCause(sysErr("ECONNREFUSED", "connect")))).toBe(true);
    expect(isRequestNotSent(withCause(sysErr("EHOSTUNREACH", "connect")))).toBe(true);
    expect(isRequestNotSent(withCause(sysErr("ETIMEDOUT", "connect")))).toBe(true); // connect-fasen: ingen byte sendt
    expect(isRequestNotSent(withCause(sysErr("ENOTFOUND", "getaddrinfo")))).toBe(true);
    expect(isRequestNotSent(withCause(sysErr("EAI_AGAIN", "getaddrinfo")))).toBe(true);
    const happyEyeballs = Object.assign(new AggregateError([sysErr("ECONNREFUSED", "connect"), sysErr("ECONNREFUSED", "connect")], "x"), { code: "ECONNREFUSED" });
    expect(isRequestNotSent(withCause(happyEyeballs))).toBe(true);
    expect(isRequestNotSent(new CoreRequestNotSentError("core_unreachable:ECONNREFUSED"))).toBe(true);
    expect(isRequestNotSent(new Error("voice_session_required"))).toBe(true); // uendret: kastes før noe kall
  });

  it("alt annet er UKJENT utfall (claimen beholdes): socket lukket midt i, reset, lesefeil, timeout, avbrudd, HTTP-feil, blandet aggregate, ukjente former", () => {
    expect(isRequestNotSent(withCause(sysErr("UND_ERR_SOCKET")))).toBe(false); // «other side closed»: forespørselen kan være mottatt
    expect(isRequestNotSent(withCause(sysErr("ECONNRESET", "read")))).toBe(false);
    expect(isRequestNotSent(withCause(sysErr("ECONNRESET", "write")))).toBe(false);
    expect(isRequestNotSent(withCause(sysErr("ETIMEDOUT", "read")))).toBe(false);
    expect(isRequestNotSent(withCause(sysErr("UND_ERR_CONNECT_TIMEOUT")))).toBe(false); // uten syscall: ikke bevist
    expect(isRequestNotSent(withCause(sysErr("ECONNREFUSED")))).toBe(false); // kode uten syscall er ikke et bevis
    const mixed = new AggregateError([sysErr("ECONNREFUSED", "connect"), sysErr("ECONNRESET", "read")], "x");
    expect(isRequestNotSent(withCause(mixed))).toBe(false);
    expect(isRequestNotSent(withCause(new AggregateError([], "tom")))).toBe(false);
    expect(isRequestNotSent(new Error("core_500"))).toBe(false);
    expect(isRequestNotSent(new Error("core_timeout"))).toBe(false);
    expect(isRequestNotSent(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isRequestNotSent(new Error("core_stream_no_done"))).toBe(false);
    expect(isRequestNotSent(new TypeError("fetch failed"))).toBe(false); // ingen cause
    expect(isRequestNotSent("voice_session_required")).toBe(false); // ikke en Error
    expect(isRequestNotSent(null)).toBe(false);
    expect(isRequestNotSent(undefined)).toBe(false);
    // Dyp kjede (mer enn 4 ledd) følges ikke - ukjent
    let deep: unknown = sysErr("ECONNREFUSED", "connect");
    for (let i = 0; i < 6; i++) deep = withCause(deep);
    expect(isRequestNotSent(deep)).toBe(false);
  });
});

describe("FIX-5: HttpCoreClient klassifiserer ekte nettverksfeil (Node-fetch, ingen mock)", () => {
  it("lukket port: chat() og chatStream() kaster CoreRequestNotSentError; en socket serveren dreper, HTTP 500 og en Core-frist gjør IKKE det", async () => {
    const dead = new HttpCoreClient(`http://127.0.0.1:${await closedPort()}`);
    await expect(dead.chat(PROVEN_ID, "hei")).rejects.toBeInstanceOf(CoreRequestNotSentError);
    await expect(dead.chatStream(PROVEN_ID, "hei", () => undefined)).rejects.toBeInstanceOf(CoreRequestNotSentError);
    await expect(dead.chat(PROVEN_ID, "hei")).rejects.toThrow(/^core_unreachable:/);

    const destroyed: string[] = [];
    const destroyPort = await closedPort();
    await stubCore(destroyPort, "destroy_socket", destroyed);
    const reset = new HttpCoreClient(`http://127.0.0.1:${destroyPort}`);
    for (const call of [() => reset.chat(PROVEN_ID, "hei"), () => reset.chatStream(PROVEN_ID, "hei", () => undefined)]) {
      const err = await call().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(isRequestNotSent(err)).toBe(false);
    }
    expect(destroyed).toHaveLength(2); // forespørslene NÅDDE Core

    const status500: string[] = [];
    const port500 = await closedPort();
    await stubCore(port500, "http_500", status500);
    await expect(new HttpCoreClient(`http://127.0.0.1:${port500}`).chat(PROVEN_ID, "hei")).rejects.toThrow("core_500");

    const hanging: string[] = [];
    const portHang = await closedPort();
    await stubCore(portHang, "hang", hanging);
    const slow = new HttpCoreClient(`http://127.0.0.1:${portHang}`, { turnTimeoutMs: 150 });
    const timeoutErr = await slow.chat(PROVEN_ID, "hei").then(() => undefined, (e: unknown) => e);
    expect((timeoutErr as Error).message).toBe("core_timeout");
    expect(isRequestNotSent(timeoutErr)).toBe(false);
  });
});

describe("FIX-5: replay_final etter Core-feil", () => {
  const replay = (c: TestClient, id: string): void => c.send({ type: "replay_final", utterance_id: id, text: "betal 5000 kr" });
  const errorsAfter = async (c: TestClient, count: number): Promise<string[]> => {
    const started = Date.now();
    while (c.errors().length < count && Date.now() - started < 4000) await sleep(10);
    return c.errors();
  };

  it("Core nektet tilkobling (beviselig ikke nådd): claimen frigjøres, samme id kan sendes på nytt, og lykkes når Core er oppe - kommandoen går ikke tapt", async () => {
    const port = await closedPort();
    gateway = await startGateway({ core: splitCore(`http://127.0.0.1:${port}`) });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven({ ...IDENTITY });
    replay(client, "u-closed");
    expect(await errorsAfter(client, 1)).toEqual(["core_error"]);
    replay(client, "u-closed"); // samme id: IKKE utterance_already_completed
    expect(await errorsAfter(client, 2)).toEqual(["core_error", "core_error"]);

    const hits: string[] = [];
    await stubCore(port, "sse_ok", hits); // Core kommer opp igjen
    replay(client, "u-closed");
    await client.waitFor((m) => m.type === "reply");
    expect(hits).toEqual(["/chat"]);
    replay(client, "u-closed"); // og nå er den utført: ingen ny utførelse
    expect(await errorsAfter(client, 3)).toEqual(["core_error", "core_error", "utterance_already_completed:u-closed"]);
    expect(hits).toHaveLength(1);
    client.close();
  });

  it.each([["destroy_socket" as const], ["http_500" as const]])("ukjent utfall (%s): claimen BEHOLDES - replay nektes, Core kalles ikke på nytt", async (behaviour) => {
    const port = await closedPort();
    const hits: string[] = [];
    await stubCore(port, behaviour, hits);
    gateway = await startGateway({ core: splitCore(`http://127.0.0.1:${port}`) });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven({ ...IDENTITY });
    replay(client, "u-unknown");
    expect(await errorsAfter(client, 1)).toEqual(["core_error"]);
    replay(client, "u-unknown");
    expect(await errorsAfter(client, 2)).toEqual(["core_error", "utterance_already_completed:u-unknown"]);
    expect(hits).toHaveLength(1);
    client.close();
  });

  it("Core-frist (core_timeout): claimen BEHOLDES", async () => {
    const port = await closedPort();
    const hits: string[] = [];
    await stubCore(port, "hang", hits);
    gateway = await startGateway({ core: splitCore(`http://127.0.0.1:${port}`, { turnTimeoutMs: 200 }) });
    const client = await new TestClient(gateway.url).connect();
    await client.startProven({ ...IDENTITY });
    replay(client, "u-timeout");
    expect(await errorsAfter(client, 1)).toEqual(["core_timeout"]);
    replay(client, "u-timeout");
    expect(await errorsAfter(client, 2)).toEqual(["core_timeout", "utterance_already_completed:u-timeout"]);
    expect(hits).toHaveLength(1);
    client.close();
  });
});
