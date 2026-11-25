import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptCallSignal, currentCallSignal, runWithCallSignal } from "@jarvis/tool-gateway";
import {
  FikenTransport,
  NeonomicsTransport,
  StripeFinanceTransport,
  StripeTransport,
  VippsTransport,
  WallesterTransport,
  createRsaJwtSigner,
  resetFikenAccessTokenCache,
  type FinanceService
} from "../src/index.ts";
import { financeFetch } from "../src/http.ts";

/**
 * WP-FIN2 K2 (D-486, JARVIS-018-resten) - TRANSPORTNIVÅ mot en EKTE hengende lokal HTTP-server (ekte undici, ekte socket): gatewayens kallsignal avbryter finansforespørslene.
 *   - et avbrudd lukker socketen (serveren SER `close`), selv om leverandøren aldri svarer (tidligere: først etter det egne 20 s-taket),
 *   - en retry-løkke sender ALDRI en ny forespørsel etter avbruddet - ventetiden mellom forsøkene (backoff) avbrytes og rydder timeren,
 *   - et allerede avbrutt kall sender ingenting,
 *   - delt token-utveksling (Fiken) dør ikke med første kallers frist,
 *   - `adoptCallSignal`: et signal gitt som 5. argument er også det ambiente kallsignalet.
 * Port-omskriving: `fetch` er stubbet til å sende ALLE leverandørkall til den lokale serveren (samme sti/metode/headere/signal), ellers uendret. Gateway-nivå (ledger/flagg): `fin2-finance-gateway-abort.test.ts`.
 */
interface Seen { method: string; url: string; closed: boolean; aborted: boolean }
let server: Server;
let port = 0;
let seen: Seen[] = [];
type Handler = (req: IncomingMessage, res: ServerResponse, entry: Seen) => void;
let handler: Handler = () => undefined;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = createServer((req, res) => {
    const entry: Seen = { method: req.method ?? "GET", url: req.url ?? "/", closed: false, aborted: false };
    seen.push(entry);
    req.on("aborted", () => { entry.aborted = true; });
    res.on("close", () => { entry.closed = true; });
    req.resume();
    req.on("end", () => handler(req, res, entry));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const HANG: Handler = () => undefined;
const status503: Handler = (_req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); };
const jsonOk = (body: unknown): Handler => (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, ms = 3_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("waitFor_timeout"); await sleep(10); } };

let initSignals: Array<AbortSignal | undefined> = [];
beforeEach(() => {
  seen = [];
  initSignals = [];
  handler = HANG;
  resetFikenAccessTokenCache();
  vi.stubEnv("JARVIS_FIKEN_CLIENT_ID", "client-fixture");
  vi.stubEnv("JARVIS_FIKEN_CLIENT_SECRET", "secret-fixture");
  vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
    initSignals.push(init.signal ?? undefined);
    const u = new URL(String(input));
    return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
/** Token-endepunktene svarer; alt annet håndteres av `handler`. */
function withTokens(next: Handler): Handler {
  return (req, res, entry) => {
    if (/accesstoken\/get|openid-connect\/token|oauth\/token/.test(req.url ?? "")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ access_token: "tok-fixture", expires_in: 3600 })); return; }
    next(req, res, entry);
  };
}

interface Case { name: string; mutation: boolean; call: () => Promise<unknown>; pathPart: string }
const CASES: readonly Case[] = [
  { name: "Stripe createPaymentIntent (POST med Idempotency-Key)", mutation: true, pathPart: "/v1/payment_intents", call: () => new StripeTransport("sk-fixture-not-a-key").createPaymentIntent({ amountOre: 10_000, currency: "NOK", metadata: {}, idempotencyKey: "k" }) },
  { name: "Stripe getPaymentIntent (GET)", mutation: false, pathPart: "/v1/payment_intents/", call: () => new StripeTransport("sk-fixture-not-a-key").getPaymentIntent("pi_1") },
  { name: "Vipps capturePayment (POST med Idempotency-Key)", mutation: true, pathPart: "/capture", call: () => new VippsTransport("c", "s-fixture", "k", "1", "test").capturePayment({ reference: "fin-pi-1", amountOre: 100, currency: "NOK", idempotencyKey: "k" }) },
  { name: "Vipps getPayment (GET)", mutation: false, pathPart: "/epayment/v1/payments/", call: () => new VippsTransport("c", "s-fixture", "k", "1", "test").getPayment("fin-pi-1") },
  { name: "Neonomics initiateDomesticPayment (POST uten Idempotency-Key)", mutation: true, pathPart: "domestic-transfer", call: () => new NeonomicsTransport("c", "s-fixture", "11111111-2222-3333-4444-555555555555", "sandbox").initiateDomesticPayment({ sessionId: "s", debtorAccountId: "a", creditorName: "L", creditorAccountIdentifier: "98765432101", amountOre: 100, currency: "NOK", referenceText: "x", endToEndReference: "e" }) },
  { name: "Neonomics getPayment (GET)", mutation: false, pathPart: "domestic-transfer/", call: () => new NeonomicsTransport("c", "s-fixture", "11111111-2222-3333-4444-555555555555", "sandbox").getPayment("s", "p1") },
  { name: "Wallester createCard (POST)", mutation: true, pathPart: "/v1/cards", call: () => new WallesterTransport(`http://127.0.0.1:${port}`, "key-fixture", createRsaJwtSigner(privateKey), "acc-1").createCard({ externalReference: "card-1", name: "K", type: "virtual", currency: "EUR", cardholderName: null, limits: { transactionLimitOre: null, dailyLimitOre: null, weeklyLimitOre: null, monthlyLimitOre: null, atmEnabled: false, onlineEnabled: true, contactlessEnabled: true } }) },
  { name: "Wallester getCard (GET)", mutation: false, pathPart: "/v1/cards/", call: () => new WallesterTransport(`http://127.0.0.1:${port}`, "key-fixture", createRsaJwtSigner(privateKey), "acc-1").getCard("wc-1") },
  { name: "Fiken createGeneralJournalEntry (POST uten Idempotency-Key)", mutation: true, pathPart: "generalJournalEntries", call: () => new FikenTransport("refresh-fixture", "firma").createGeneralJournalEntry({ description: "x", date: "2026-11-25", lines: [{ account: "3000", amount: 100 }, { account: "1920", amount: -100 }] }) },
  { name: "Fiken listCompanies (GET)", mutation: false, pathPart: "/companies", call: () => new FikenTransport("refresh-fixture", "firma").listCompanies() }
];

describe("K2: hengende leverandør - kallsignalet avbryter forespørselen (socketen lukkes), nøyaktig én forespørsel", () => {
  for (const c of CASES) {
    it(`${c.name}: avbrudd etter 150 ms avviser med årsaken og lukker socketen; ingen retry`, async () => {
      handler = withTokens(HANG);
      const controller = new AbortController();
      const reason = new Error("tool_timeout");
      const t0 = Date.now();
      const pending = runWithCallSignal(controller.signal, () => c.call()).catch((e: unknown) => e);
      await waitFor(() => seen.some((s) => s.url.includes(c.pathPart) && !/token/.test(s.url)));
      controller.abort(reason);
      const err = await pending;
      expect(err).toBe(reason); // selve avbruddsårsaken (gatewayens `tool_timeout`), ikke en generisk feil
      expect(Date.now() - t0).toBeLessThan(2_000); // ikke det egne 20 s-taket
      const mine = seen.filter((s) => s.url.includes(c.pathPart) && !/token/.test(s.url));
      await waitFor(() => mine.every((s) => s.closed), 2_000); // serveren SER at forbindelsen er lukket
      await sleep(300);
      expect(seen.filter((s) => s.url.includes(c.pathPart) && !/token/.test(s.url))).toHaveLength(1); // aldri en ny forespørsel
    });
  }
});

describe("K2: ventetiden mellom forsøk (backoff) avbrytes - ingen forespørsel etter fristen", () => {
  for (const c of CASES.filter((x) => /getPaymentIntent|getPayment \(GET\)|getCard|listCompanies/.test(x.name) || /Stripe createPaymentIntent|Vipps capturePayment/.test(x.name))) {
    it(`${c.name}: 5xx -> backoff (500 ms) avbrytes av kallsignalet etter 120 ms; nøyaktig én forespørsel`, async () => {
      handler = withTokens(status503);
      const controller = new AbortController();
      const reason = new Error("tool_timeout");
      const t0 = Date.now();
      const pending = runWithCallSignal(controller.signal, () => c.call()).catch((e: unknown) => e);
      await waitFor(() => seen.some((s) => s.url.includes(c.pathPart) && !/token/.test(s.url)));
      await sleep(60);
      controller.abort(reason);
      expect(await pending).toBe(reason);
      expect(Date.now() - t0).toBeLessThan(450); // backoff-timeren (500 ms) ble avbrutt, ikke avventet
      await sleep(700); // lenger enn første backoff: en uavbrytbar sleep ville nå sendt forsøk nr. 2
      expect(seen.filter((s) => s.url.includes(c.pathPart) && !/token/.test(s.url))).toHaveLength(1);
    });
  }

  it("kontroll: uten kallsignal gjentas en retry-sikker 5xx (GET) som før - flagg AV er identisk med main", async () => {
    handler = status503;
    const err = await new StripeTransport("sk-fixture-not-a-key").getPaymentIntent("pi_1").catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/stripe_api_failed_503/);
    expect(seen.filter((s) => s.url.includes("/v1/payment_intents/"))).toHaveLength(3); // MAX_ATTEMPTS
  }, 15_000);

  it("kontroll: en mutasjon UTEN Idempotency-Key som får 5xx sendes ÉN gang (isRetrySafe er uendret)", async () => {
    handler = withTokens(status503);
    await new FikenTransport("refresh-fixture", "firma").createGeneralJournalEntry({ description: "x", date: "2026-11-25", lines: [{ account: "3000", amount: 100 }, { account: "1920", amount: -100 }] }).catch(() => undefined);
    expect(seen.filter((s) => s.url.includes("generalJournalEntries"))).toHaveLength(1);
  });
});

describe("K2: allerede avbrutt kall sender ingenting; eget 20 s-tak består uten kallsignal", () => {
  it("avbrutt FØR forsøket: ingen forespørsel (verken token eller ressurs) og årsaken kastes", async () => {
    const controller = new AbortController();
    const reason = new Error("caller_call_aborted");
    controller.abort(reason);
    for (const c of CASES) {
      seen = [];
      const err = await runWithCallSignal(controller.signal, () => c.call()).catch((e: unknown) => e);
      expect(err, c.name).toBe(reason);
      expect(seen, c.name).toHaveLength(0);
    }
  });

  it("uten kallsignal settes kun det egne tidsavbruddet (en AbortSignal som ikke er avbrutt) - og med kallsignal er signalet SAMMENSATT (avbrytes av begge)", async () => {
    handler = jsonOk({});
    await financeFetch("https://api.stripe.com/v1/balance").then((r) => r.text());
    expect(initSignals[0]).toBeInstanceOf(AbortSignal);
    expect(initSignals[0]!.aborted).toBe(false);
    const controller = new AbortController();
    await runWithCallSignal(controller.signal, () => financeFetch("https://api.stripe.com/v1/balance").then((r) => r.text()));
    const composed = initSignals[1]!;
    expect(composed).not.toBe(controller.signal);
    expect(composed.aborted).toBe(false);
    controller.abort(new Error("x"));
    expect(composed.aborted).toBe(true);
  });
});

describe("K2d: delt token-utveksling (Fiken) dør ikke med første kallers frist", () => {
  it("to samtidige kall: A (frist 100 ms) slippes fri av sin egen frist; B (uten frist) får tokenet - ÉN utveksling, utvekslingen ble ikke avbrutt", async () => {
    handler = (req, res) => {
      if (/oauth\/token/.test(req.url ?? "")) { setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ access_token: "tok-shared", expires_in: 3600 })); }, 400); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([{ slug: "firma-as", name: "Firma AS" }]));
    };
    const controller = new AbortController();
    const reason = new Error("tool_timeout");
    const a = runWithCallSignal(controller.signal, () => new FikenTransport("refresh-shared", "firma").listCompanies()).catch((e: unknown) => e);
    await waitFor(() => seen.some((s) => /oauth\/token/.test(s.url)));
    const b = new FikenTransport("refresh-shared", "firma").listCompanies();
    setTimeout(() => controller.abort(reason), 100);
    expect(await a).toBe(reason);
    expect(await b).toEqual([{ slug: "firma-as", name: "Firma AS" }]);
    expect(seen.filter((s) => /oauth\/token/.test(s.url))).toHaveLength(1);
    expect(seen.filter((s) => /oauth\/token/.test(s.url))[0]!.aborted).toBe(false);
  });
});

describe("K2: adoptCallSignal - 5. argument er også det ambiente kallsignalet", () => {
  it("StripeFinanceTransport.invoke(..., signal) kjører tjenestekallet med signalet som ambient kallsignal (uten at gatewayen er involvert)", async () => {
    let ambient: AbortSignal | undefined;
    const service = { getStripeBalance: async () => { ambient = currentCallSignal(); return { object: "balance", available: [], pending: [] }; } } as unknown as FinanceService;
    const transport = new StripeFinanceTransport(service);
    const controller = new AbortController();
    await transport.invoke("get_balance", { tenant_id: "t" }, "", undefined, controller.signal);
    expect(ambient).toBe(controller.signal);
    ambient = undefined;
    await transport.invoke("get_balance", { tenant_id: "t" });
    expect(ambient).toBeUndefined();
  });

  it("adoptCallSignal gjør ingenting hvis signalet allerede ER det ambiente (ingen dobbel innpakning)", () => {
    const controller = new AbortController();
    const seenInside: Array<AbortSignal | undefined> = [];
    runWithCallSignal(controller.signal, () => adoptCallSignal(controller.signal, () => seenInside.push(currentCallSignal())));
    expect(seenInside).toEqual([controller.signal]);
  });
});
