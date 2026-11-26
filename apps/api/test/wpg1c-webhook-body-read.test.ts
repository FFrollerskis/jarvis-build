import { PassThrough } from "node:stream";
import { createConnection, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommsWebhookProvider, CommsWebhookService } from "@jarvis/comms";
import { DEFAULT_WEBHOOK_BODY_READ, HttpError, WebhookBodyGuard, readRawBodyGuarded, webhookBodyGuardFor } from "../src/http-guard.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-G1c fiks-runde 2 (FIX-2): Metas byte-grense før signaturen er 4 MiB (FIX-1, runde 1), og uten lesefrist eller global grense kunne en treg avsender holde mange halvferdige kropper: 30 samtidige halvferdige kropper holdt +110 MiB
 * (3,67 MiB per forbindelse mot 0,27 for 256 KB-leverandørene, 13,6x), og Node `requestTimeout` er 300 s. Nå: (i) lesefrist for HELE kroppen (standard 15 s; ved utløp lukkes forbindelsen, 408 `body_read_timeout` logges uten innhold) og (ii) en GLOBAL
 * grense for samtidige lesinger over 256 KB (standard 4; plassen som ikke får plass får 503 `webhook_busy` med `Retry-After`, logges uten innhold). Begge frigis alltid, også ved avbrudd og feil. Konstantene injiseres her med korte verdier.
 * Del A: enhetstester av lesefunksjonen (falsk forespørsel). Del B: den ekte HTTP-ruten (falsk tjeneste, ingen database: ruten skal bare lese kroppen og levere den uendret videre).
 */
const KIB = 1024;
const MIB = 1024 * KIB;

/** En falsk innkommende forespørsel: en `PassThrough` med `headers` (samme `destroy()`/`resume()`/async-iterasjon som `IncomingMessage`). */
function fakeReq(contentLength?: number): PassThrough & { headers: Record<string, string> } {
  return Object.assign(new PassThrough(), { headers: contentLength === undefined ? {} : { "content-length": String(contentLength) } });
}
const asReq = (r: PassThrough): IncomingMessage => r as unknown as IncomingMessage;
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function outcome(p: Promise<Buffer>): Promise<{ ok: true; length: number } | { ok: false; status: number; code: string } | { ok: false; other: string }> {
  try { return { ok: true, length: (await p).length }; } catch (e) { return e instanceof HttpError ? { ok: false, status: e.status, code: e.code } : { ok: false, other: String(e) }; }
}
const activeTimers = (): number => process.getActiveResourcesInfo().filter((t) => t === "Timeout").length;

describe("FIX-2 del A: lesefunksjonen (frist, samtidighetsgrense, frigivelse)", () => {
  it("standardverdiene er 15 s, 4 samtidige, 256 KB og Retry-After 5", () => {
    expect(DEFAULT_WEBHOOK_BODY_READ).toEqual({ deadlineMs: 15_000, maxConcurrentLarge: 4, largeBytes: 256 * KIB, retryAfterSeconds: 5 });
    expect(new WebhookBodyGuard().config).toEqual(DEFAULT_WEBHOOK_BODY_READ);
    expect(new WebhookBodyGuard({ deadlineMs: 50 }).config).toEqual({ ...DEFAULT_WEBHOOK_BODY_READ, deadlineMs: 50 });
  });

  it("en normal kropp leses uendret (byte for byte), og ingen plass er tatt etterpå", async () => {
    const guard = new WebhookBodyGuard({ deadlineMs: 2000 });
    const req = fakeReq(10);
    const read = readRawBodyGuarded(asReq(req), MIB, guard);
    req.end(Buffer.from("0123456789"));
    expect(await read).toEqual(Buffer.from("0123456789"));
    expect(guard.activeLargeReads).toBe(0);
  });

  it("en stor kropp (> 256 KB) tar en plass mens den leses og frigir den når den er ferdig; grensen er presis: nøyaktig 256 KB er IKKE stor, 256 KB + 1 er det", async () => {
    const guard = new WebhookBodyGuard({ deadlineMs: 2000, maxConcurrentLarge: 1 });
    const exact = fakeReq(256 * KIB);
    const readExact = readRawBodyGuarded(asReq(exact), MIB, guard);
    exact.write(Buffer.alloc(100 * KIB, 1));
    await tick();
    expect(guard.activeLargeReads, "256 KB er ikke stor").toBe(0);
    exact.end(Buffer.alloc(156 * KIB, 1));
    expect((await readExact as Buffer).length).toBe(256 * KIB);

    const big = fakeReq(256 * KIB + 1);
    const readBig = readRawBodyGuarded(asReq(big), MIB, guard);
    big.write(Buffer.alloc(100 * KIB, 1));
    await tick();
    expect(guard.activeLargeReads, "256 KB + 1 er stor: plassen er tatt FØR lesingen er ferdig").toBe(1);
    big.end(Buffer.alloc(156 * KIB + 1, 1));
    expect((await readBig).length).toBe(256 * KIB + 1);
    expect(guard.activeLargeReads, "frigitt etter suksess").toBe(0);
  });

  it("lesefristen: en kropp som aldri blir ferdig avbrytes etter fristen med 408 `body_read_timeout` (forespørselen lukkes), og plassen frigis", async () => {
    const guard = new WebhookBodyGuard({ deadlineMs: 120, maxConcurrentLarge: 2 });
    const req = fakeReq(1 * MIB);
    const t0 = Date.now();
    const read = outcome(readRawBodyGuarded(asReq(req), 4 * MIB, guard));
    req.write(Buffer.alloc(300 * KIB, 1));
    await tick();
    expect(guard.activeLargeReads).toBe(1);
    expect(await read).toEqual({ ok: false, status: 408, code: "body_read_timeout" });
    expect(Date.now() - t0, "avbrutt rundt fristen, ikke senere").toBeLessThan(2000);
    expect(req.destroyed, "forespørselen er lukket").toBe(true);
    expect(guard.activeLargeReads, "plassen er frigitt ved utløp").toBe(0);
  });

  it("lesefristen gjelder også en liten kropp som aldri blir ferdig (ingen plass tatt, men fortsatt avbrutt)", async () => {
    const guard = new WebhookBodyGuard({ deadlineMs: 100 });
    const req = fakeReq(1000);
    const read = outcome(readRawBodyGuarded(asReq(req), 256 * KIB, guard));
    req.write(Buffer.alloc(10, 1));
    expect(await read).toEqual({ ok: false, status: 408, code: "body_read_timeout" });
    expect(guard.activeLargeReads).toBe(0);
  });

  it("samtidighetsgrensen: lesing nr. N+1 over 256 KB (Content-Length oppgitt) får 503 `webhook_busy` UTEN at kroppen leses, og de N første påvirkes ikke; en liten kropp avvises aldri av grensen", async () => {
    const guard = new WebhookBodyGuard({ deadlineMs: 5000, maxConcurrentLarge: 3 });
    const reqs = [fakeReq(1 * MIB), fakeReq(1 * MIB), fakeReq(1 * MIB)];
    const first = reqs.map((r) => readRawBodyGuarded(asReq(r), 4 * MIB, guard));
    for (const r of reqs) r.write(Buffer.alloc(300 * KIB, 1));
    await tick();
    expect(guard.activeLargeReads).toBe(3);
    const fourth = fakeReq(1 * MIB);
    expect(await outcome(readRawBodyGuarded(asReq(fourth), 4 * MIB, guard))).toEqual({ ok: false, status: 503, code: "webhook_busy" });
    expect(guard.activeLargeReads, "avvist uten å ta plass").toBe(3);
    const small = fakeReq(100);
    const readSmall = readRawBodyGuarded(asReq(small), 4 * MIB, guard);
    small.end(Buffer.alloc(100, 1));
    expect((await readSmall).length, "en liten kropp slippes alltid inn").toBe(100);
    for (const r of reqs) r.end(Buffer.alloc(300 * KIB, 1));
    expect((await Promise.all(first)).map((b) => b.length)).toEqual([600 * KIB, 600 * KIB, 600 * KIB]);
    expect(guard.activeLargeReads).toBe(0);
    const fifth = fakeReq(1 * MIB);
    const readFifth = readRawBodyGuarded(asReq(fifth), 4 * MIB, guard);
    fifth.end(Buffer.alloc(1 * MIB, 1));
    expect((await readFifth).length, "etter frigivelse er det plass igjen").toBe(1 * MIB);
  });

  it("uten Content-Length (chunked): plassen tas når kroppen passerer 256 KB; er det fullt lukkes forbindelsen og det kastes 503 `webhook_busy`", async () => {
    const guard = new WebhookBodyGuard({ deadlineMs: 5000, maxConcurrentLarge: 1 });
    const holder = fakeReq(1 * MIB);
    const held = readRawBodyGuarded(asReq(holder), 4 * MIB, guard);
    holder.write(Buffer.alloc(10, 1));
    await tick();
    expect(guard.activeLargeReads).toBe(1);
    const chunked = fakeReq();
    const read = outcome(readRawBodyGuarded(asReq(chunked), 4 * MIB, guard));
    chunked.write(Buffer.alloc(200 * KIB, 1));
    await tick();
    expect(guard.activeLargeReads, "under 256 KB: ingen plass").toBe(1);
    chunked.write(Buffer.alloc(100 * KIB, 1));
    expect(await read).toEqual({ ok: false, status: 503, code: "webhook_busy" });
    expect(chunked.destroyed).toBe(true);
    holder.end(Buffer.alloc(10, 1));
    await held;
    expect(guard.activeLargeReads).toBe(0);
  });

  it("413 påvirkes ikke: over byte-grensen (oppgitt eller strømmet) gir 413 uten å ta eller beholde en plass - også når plassene er fulle (413 vurderes først)", async () => {
    const guard = new WebhookBodyGuard({ deadlineMs: 5000, maxConcurrentLarge: 1 });
    const holder = fakeReq(1 * MIB);
    const held = readRawBodyGuarded(asReq(holder), 4 * MIB, guard);
    holder.write(Buffer.alloc(10, 1));
    await tick();
    expect(await outcome(readRawBodyGuarded(asReq(fakeReq(5 * MIB)), 4 * MIB, guard))).toEqual({ ok: false, status: 413, code: "payload_too_large" });
    const streamed = fakeReq();
    const read = outcome(readRawBodyGuarded(asReq(streamed), 300 * KIB, guard));
    streamed.write(Buffer.alloc(301 * KIB, 1));
    expect(await read).toEqual({ ok: false, status: 413, code: "payload_too_large" });
    holder.end(Buffer.alloc(10, 1));
    await held;
    expect(guard.activeLargeReads).toBe(0);
  });

  it("frigivelsen er idempotent: å kalle den to ganger gir aldri en negativ teller eller en ekstra plass", () => {
    const guard = new WebhookBodyGuard({ maxConcurrentLarge: 1 });
    const release = guard.tryAcquire() as () => void;
    expect(guard.tryAcquire()).toBeNull();
    release();
    release();
    expect(guard.activeLargeReads).toBe(0);
    expect(guard.tryAcquire(), "bare én plass er ledig (ikke to)").not.toBeNull();
    expect(guard.tryAcquire()).toBeNull();
  });

  it("INGEN LEKKASJE: 100 sykluser av suksess, utløp, klientavbrudd, strømfeil, 413 og 503 etterlater ingen opptatt plass og ingen ventende timer", async () => {
    const guard = new WebhookBodyGuard({ deadlineMs: 40, maxConcurrentLarge: 2 });
    const timersBefore = activeTimers();
    const tally: Record<string, number> = {};
    const note = (k: string): void => { tally[k] = (tally[k] ?? 0) + 1; };
    for (let i = 0; i < 100; i++) {
      const kind = i % 6;
      if (kind === 0) { // suksess (stor)
        const r = fakeReq(300 * KIB); const p = readRawBodyGuarded(asReq(r), MIB, guard); r.end(Buffer.alloc(300 * KIB, 1)); await p; note("ok");
      } else if (kind === 1) { // utløp (stor)
        const r = fakeReq(300 * KIB); const p = outcome(readRawBodyGuarded(asReq(r), MIB, guard)); r.write(Buffer.alloc(260 * KIB, 1)); expect(await p).toMatchObject({ status: 408 }); note("timeout");
      } else if (kind === 2) { // klienten avbryter midt i
        const r = fakeReq(300 * KIB); const p = outcome(readRawBodyGuarded(asReq(r), MIB, guard)); r.write(Buffer.alloc(270 * KIB, 1)); await tick(); r.destroy(new Error("client_aborted")); await p; note("aborted");
      } else if (kind === 3) { // strømfeil
        const r = fakeReq(); const p = outcome(readRawBodyGuarded(asReq(r), MIB, guard)); r.write(Buffer.alloc(270 * KIB, 1)); await tick(); r.destroy(new Error("stream_failure")); await p; note("stream_error");
      } else if (kind === 4) { // 413 (strømmet, etter at en plass er tatt)
        const r = fakeReq(); const p = outcome(readRawBodyGuarded(asReq(r), 280 * KIB, guard)); r.write(Buffer.alloc(270 * KIB, 1)); await tick(); r.write(Buffer.alloc(20 * KIB, 1)); expect(await p).toMatchObject({ status: 413 }); note("too_large");
      } else { // 503 (fullt: to holdere)
        const h1 = fakeReq(300 * KIB), h2 = fakeReq(300 * KIB);
        const p1 = readRawBodyGuarded(asReq(h1), MIB, guard), p2 = readRawBodyGuarded(asReq(h2), MIB, guard);
        h1.write(Buffer.alloc(1, 1)); h2.write(Buffer.alloc(1, 1)); await tick();
        expect(await outcome(readRawBodyGuarded(asReq(fakeReq(300 * KIB)), MIB, guard))).toMatchObject({ status: 503 });
        h1.end(Buffer.alloc(300 * KIB - 1, 1)); h2.end(Buffer.alloc(300 * KIB - 1, 1)); await Promise.all([p1, p2]); note("busy");
      }
      expect(guard.activeLargeReads, `syklus ${i} (${kind})`).toBe(0);
    }
    expect(Object.keys(tally).sort()).toEqual(["aborted", "busy", "ok", "stream_error", "timeout", "too_large"]);
    expect(guard.activeLargeReads).toBe(0);
    // måles UTEN å vente ut fristen (40 ms): hver lesing skal ha ryddet fristen sin, ikke bare latt den løpe ut
    expect(activeTimers(), "ingen ventende timere (hver lesing rydder fristen sin)").toBeLessThanOrEqual(timersBefore);
  }, 60_000);
});

describe("FIX-2 del B: den ekte ruten", () => {
  const warnings: Array<Record<string, unknown>> = [];
  const received: Array<{ provider: string; bytes: number }> = [];
  let baseUrl = "";
  let port = 0;
  let close: () => Promise<void>;
  let webhooksDeps: NonNullable<NonNullable<ApiDeps["comms"]>["webhooks"]>;

  beforeAll(async () => {
    const service = {
      handle: async (provider: string, req: { rawBody: Buffer }) => { received.push({ provider, bytes: req.rawBody.length }); return { status: 200, body: { received: true } }; },
      noteRejectedBeforeSignature: (provider: string, reason: string) => { warnings.push({ msg: "comms_webhook_rejected", provider, reason }); }
    } as unknown as CommsWebhookService;
    webhooksDeps = { service, providers: new Set<CommsWebhookProvider>(["slack", "meta", "twilio", "telnyx"]), bodyRead: { deadlineMs: 1000, maxConcurrentLarge: 2, retryAfterSeconds: 7 } };
    const server = createApiServer({ comms: { webhooks: webhooksDeps }, rateLimits: { authPerIpPerMinute: 100000, ipPerMinute: 100000 } } as unknown as ApiDeps);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    // Første forespørsel lager vakten (fra `bodyRead`) i RUTEN: testene leser den etterpå, så de aldri skjuler at ruten ignorerer konfigurasjonen.
    expect((await post("slack", 10)).status).toBe(200);
    received.length = 0;
  });
  afterAll(async () => { await close?.(); });
  const guard = (): WebhookBodyGuard => webhookBodyGuardFor(webhooksDeps);
  const waitFor = async (what: string, ok: () => boolean, ms = 6000): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (ok()) return; await tick(10); }
    throw new Error(`timeout: ${what}`);
  };
  /** En rå TCP-forbindelse som sender hodene med en oppgitt Content-Length og bare en del av kroppen (resten holdes tilbake), og samler alt serveren svarer. */
  function stalled(provider: string, declared: number, sendNow: number): { sock: Socket; replies: () => string; closed: () => boolean } {
    const sock = createConnection({ host: "127.0.0.1", port });
    let text = ""; let isClosed = false;
    sock.on("data", (d) => { text += d.toString("latin1"); });
    sock.on("close", () => { isClosed = true; });
    sock.on("error", () => { isClosed = true; });
    sock.write(`POST /webhooks/comms/${provider} HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: ${declared}\r\n\r\n`);
    sock.write(Buffer.alloc(sendNow, 0x61));
    return { sock, replies: () => text, closed: () => isClosed };
  }
  const post = async (provider: string, size: number): Promise<{ status: number; retryAfter: string | null; connection: string | null; text: string }> => {
    const res = await fetch(`${baseUrl}/webhooks/comms/${provider}`, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.alloc(size, 0x61) as never });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), connection: res.headers.get("connection"), text: await res.text() };
  };

  it("en treg kropp avbrytes etter fristen: forbindelsen lukkes, årsaken `body_read_timeout` logges (leverandør og kode, ingen innhold), plassen frigis, og tjenesten ser aldri kroppen", async () => {
    warnings.length = 0; received.length = 0;
    const slow = stalled("meta", 1 * MIB, 300 * KIB);
    await waitFor("plassen er tatt", () => guard().activeLargeReads === 1);
    const t0 = Date.now();
    await waitFor("forbindelsen lukket", () => slow.closed());
    expect(Date.now() - t0, "lukket rundt fristen (1000 ms), ikke først ved Nodes 300 s").toBeLessThan(4000);
    await waitFor("plassen frigitt", () => guard().activeLargeReads === 0);
    expect(warnings).toEqual([{ msg: "comms_webhook_rejected", provider: "meta", reason: "body_read_timeout" }]);
    expect(received, "tjenesten fikk aldri en halv kropp").toEqual([]);
  }, 30_000);

  it("lesing nr. N+1 (N = 2) over 256 KB får 503 `webhook_busy` med Retry-After, logges uten innhold, og ingen kropp når tjenesten; en normal stor kropp går gjennom så snart en plass er ledig", async () => {
    warnings.length = 0; received.length = 0;
    const a = stalled("meta", 1 * MIB, 300 * KIB);
    const b = stalled("meta", 1 * MIB, 300 * KIB);
    await waitFor("begge plasser tatt", () => guard().activeLargeReads === 2);
    const busy = await post("meta", 1 * MIB);
    expect(busy.status).toBe(503);
    expect(JSON.parse(busy.text)).toMatchObject({ error: "webhook_busy" });
    expect(busy.retryAfter).toBe("7");
    expect(busy.connection, "forbindelsen lukkes så resten av den store kroppen ikke leses videre").toBe("close");
    expect(warnings).toEqual([{ msg: "comms_webhook_rejected", provider: "meta", reason: "webhook_busy" }]);
    expect(received).toEqual([]);
    expect(guard().activeLargeReads, "den avviste tok ingen plass").toBe(2);
    // en LITEN kropp (Slack, 1 KB) påvirkes ikke av at plassene er fulle: den når tjenesten
    expect((await post("slack", 1000)).status).toBe(200);
    expect((await post("meta", 100 * KIB)).status, "en Meta-kropp under 256 KB er ikke «stor»").toBe(200);
    // åpne plasser: fristen utløper for de to holderne (1000 ms), så går en normal stor kropp (3 MiB) gjennom
    await waitFor("plassene frigitt av fristen", () => guard().activeLargeReads === 0);
    expect(a.closed() && b.closed()).toBe(true);
    received.length = 0;
    const ok = await post("meta", 3 * MIB);
    expect(ok.status).toBe(200);
    expect(received, "hele kroppen kom uendret frem").toEqual([{ provider: "meta", bytes: 3 * MIB }]);
  }, 30_000);

  it("klienten som avbryter midt i en stor kropp frigir plassen (30 avbrudd): ingen lekkasje, og ruten tar fortsatt imot en normal batch", async () => {
    for (let i = 0; i < 30; i++) {
      const c = stalled("meta", 2 * MIB, 300 * KIB);
      await waitFor("plassen tatt", () => guard().activeLargeReads >= 1);
      c.sock.destroy();
      await waitFor("plassen frigitt", () => guard().activeLargeReads === 0);
    }
    received.length = 0;
    expect((await post("meta", 1 * MIB)).status).toBe(200);
    expect(guard().activeLargeReads).toBe(0);
  }, 60_000);

  it("Slack, Twilio og Telnyx er uendret: 256 KB passerer, 256 KB + 1 gir 413 (aldri 503/408), selv når alle plasser er tatt", async () => {
    const a = stalled("meta", 1 * MIB, 300 * KIB);
    const b = stalled("meta", 1 * MIB, 300 * KIB);
    await waitFor("begge plasser tatt", () => guard().activeLargeReads === 2);
    for (const provider of ["slack", "twilio", "telnyx"] as const) {
      expect((await post(provider, 256 * KIB)).status, provider).toBe(200);
      expect((await post(provider, 256 * KIB + 1)).status, provider).toBe(413);
    }
    a.sock.destroy(); b.sock.destroy();
    await waitFor("plassene frigitt", () => guard().activeLargeReads === 0);
  }, 30_000);

  it("en chunked kropp (uten Content-Length) over 256 KB når alle plasser er tatt: forbindelsen lukkes UTEN statuslinje (som for 413 på en chunked kropp), `webhook_busy` logges, og plassene er uendret", async () => {
    warnings.length = 0; received.length = 0;
    const a = stalled("meta", 1 * MIB, 300 * KIB);
    const b = stalled("meta", 1 * MIB, 300 * KIB);
    await waitFor("begge plasser tatt", () => guard().activeLargeReads === 2);
    const sock = createConnection({ host: "127.0.0.1", port });
    let text = ""; let isClosed = false;
    sock.on("data", (d) => { text += d.toString("latin1"); });
    sock.on("close", () => { isClosed = true; });
    sock.on("error", () => { isClosed = true; });
    sock.write("POST /webhooks/comms/meta HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n");
    sock.write(`${(300 * KIB).toString(16)}\r\n`);
    sock.write(Buffer.alloc(300 * KIB, 0x61));
    sock.write("\r\n");
    await waitFor("forbindelsen lukket", () => isClosed);
    expect(text, "ingen statuslinje: forbindelsen ble lukket uten svar (dokumentert i runbooken)").toBe("");
    expect(warnings).toEqual([{ msg: "comms_webhook_rejected", provider: "meta", reason: "webhook_busy" }]);
    expect(received, "ingen kropp nådde tjenesten").toEqual([]);
    expect(guard().activeLargeReads, "den avviste tok ingen plass").toBe(2);
    a.sock.destroy(); b.sock.destroy();
    await waitFor("plassene frigitt", () => guard().activeLargeReads === 0);
  }, 30_000);
});
