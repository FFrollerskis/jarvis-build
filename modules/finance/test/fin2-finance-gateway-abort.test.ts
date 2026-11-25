import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools, type ClassDNotification, type ClassDNotifier, type ToolResult } from "@jarvis/tool-gateway";
import { generateKeyPairSync } from "node:crypto";
import {
  BankingService,
  CardService,
  FikenTransport,
  FinanceService,
  FinanceTransport,
  NeonomicsTransport,
  StripeFinanceTransport,
  StripeTransport,
  VippsFinanceTransport,
  VippsTransport,
  WallesterFinanceTransport,
  WallesterTransport,
  createRsaJwtSigner,
  resetFikenAccessTokenCache,
  type FikenCredentials,
  type NeonomicsCredentials,
  type NeonomicsGateway,
  type PaymentIntent,
  type StripeCredentials,
  type VippsCredentials
} from "../src/index.ts";

/**
 * WP-FIN2 K2 (D-486, JARVIS-018-resten) - GATEWAY-NIVÅ: ekte `ToolGateway` (klasse D-pipeline påslått som i produksjon), ekte `FinanceService`/`CardService`, ekte Postgres og de EKTE
 * leverandørtransportene mot en EKTE hengende lokal HTTP-server (ekte undici). Gatewayens `timeout_ms` (her forkortet) avbryter nå finansforespørselen:
 *   - ÉN forespørsel til leverandøren (aldri en retry etter fristen, heller ikke fra backoff-løkken), socketen lukkes,
 *   - ledger `unverified` (utfall ukjent) og en replay med samme nøkkel sender ingenting,
 *   - domenet: Stripe/Vipps-intensjon tilbake til draft med `SUBMIT_OUTCOME_UNKNOWN`; Fiken/Neonomics blir stående `submitted`; Wallester-kort `draft` med `CARD_SUBMIT_OUTCOME_UNKNOWN`.
 * `JARVIS_TOOL_CALL_ABORT=off` er som før (forespørselen avbrytes ikke av gatewayen). Transportnivå per leverandør: `fin2-finance-transport-abort.test.ts`.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-fin2-gwabort";
const OWNER = "person-fin2-gwabort-owner";
const APP_ROLE = "jarvis_fin2_gwabort";
const GATEWAY_TIMEOUT_MS = 400;

const stripeCreds: StripeCredentials = { secretKey: "sk-fixture-not-a-key" };
const vippsCreds: VippsCredentials = { clientId: "c", clientSecret: "s-fixture", subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" };
const fikenCreds: FikenCredentials = { refreshToken: "refresh-fixture-gw", companySlug: "firma" };
const neonomicsCreds: NeonomicsCredentials = { clientId: "fake-client", clientSecret: "fake-secret-fixture", deviceId: "11111111-2222-3333-4444-555555555555", environment: "sandbox" };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", session_id: "sess-fin2-gwabort", device_id: "dev-pc", channel: "web", auth_strength: "signed" };

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  ready() { return true; }
  async notify(n: ClassDNotification) { this.sent.push(n); }
}

// ------------------------------------------------------------------------------------------------------------------------------ hengende server
interface Seen { method: string; url: string; closed: boolean }
let httpServer: Server;
let port = 0;
let seen: Seen[] = [];
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler = () => undefined;
const realFetch = globalThis.fetch;
const HANG: Handler = () => undefined;
const status503: Handler = (_req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); };
const isToken = (url: string) => /accesstoken\/get|openid-connect\/token|oauth\/token/.test(url);
/** Token-endepunktene svarer gyldig; resten styres av `next`. */
const withTokens = (next: Handler): Handler => (req, res) => {
  if (isToken(req.url ?? "")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ access_token: "tok-fixture", expires_in: 3600 })); return; }
  next(req, res);
};
const requestsTo = (part: string) => seen.filter((s) => s.url.includes(part) && !isToken(s.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 4_000) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error("waitFor_timeout"); await sleep(15); } };

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    const entry: Seen = { method: req.method ?? "GET", url: req.url ?? "/", closed: false };
    seen.push(entry);
    res.on("close", () => { entry.closed = true; });
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  port = (httpServer.address() as AddressInfo).port;

  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-gwabort-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${APP_ROLE}`);
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 gateway abort', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT}');
  `);
  appPool = createPool({ ...base, user: APP_ROLE, password: "pw2" });
}, 240_000);

afterAll(async () => {
  httpServer?.closeAllConnections();
  await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

beforeEach(() => {
  seen = [];
  handler = HANG;
  resetFikenAccessTokenCache();
  vi.stubEnv("JARVIS_FIKEN_CLIENT_ID", "client-fixture");
  vi.stubEnv("JARVIS_FIKEN_CLIENT_SECRET", "secret-fixture");
  vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// ------------------------------------------------------------------------------------------------------------------------------ oppsett
const secrets = {
  name: "fin2-fixture",
  get: async (ref: string) => ({
    JARVIS_BUSINESS_INTERNAL_TOKEN: "internal-sentinel", JARVIS_STRIPE_SECRET_KEY: "sk-fixture-not-a-key", JARVIS_VIPPS_CLIENT_SECRET: "s-fixture",
    JARVIS_FIKEN_REFRESH_TOKEN: "t-fixture", JARVIS_NEONOMICS_CLIENT_SECRET: "n-fixture", JARVIS_WALLESTER_PRIVATE_KEY_PEM: "pem-fixture"
  } as Record<string, string>)[ref] ?? null
};

interface Wired { finance: FinanceService; cards: CardService; gateway: ToolGateway; notifier: FakeNotifier }
function wire(): Wired {
  const notifier = new FakeNotifier();
  const neonomicsProvider = { getCredentials: async () => neonomicsCreds };
  const finance = new FinanceService(
    appPool, (c) => new FikenTransport(c.refreshToken, c.companySlug), { getCredentials: async () => stripeCreds }, (c) => new StripeTransport(c.secretKey), () => "whsec-fixture", () => TENANT,
    { getCredentials: async () => vippsCreds }, (c) => new VippsTransport(c.clientId, c.clientSecret, c.subscriptionKey, c.merchantSerialNumber, c.environment), () => "vipps-fixture", () => TENANT,
    neonomicsProvider, (c) => new NeonomicsTransport(c.clientId, c.clientSecret, c.deviceId, c.environment), () => "neo-key", () => TENANT
  );
  const cards = new CardService(
    appPool, { getCredentials: async () => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "key-fixture", sign: createRsaJwtSigner(privateKey), accountId: "acc-1", environment: "sandbox" as const }) },
    (c) => new WallesterTransport(c.baseUrl, c.apiKey, c.sign, c.accountId), () => null, () => TENANT
  );
  const policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT] }
  });
  const gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, {
    classDPipeline: { enforce: true, notifier },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) }
  });
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(finance, { getCredentials: async () => fikenCreds }), finance_stripe: new StripeFinanceTransport(finance),
    finance_vipps: new VippsFinanceTransport(finance), finance_wallester: new WallesterFinanceTransport(cards)
  })) {
    // fristen forkortes for testen (selve avbruddet er det som bevises); preflight/readback er DB-lesinger og påvirkes ikke
    gateway.register(/^submit_/.test(tool.action) ? { ...tool, timeout_ms: GATEWAY_TIMEOUT_MS } : tool);
  }
  return { finance, cards, gateway, notifier };
}

const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const exec = (w: Wired, tool: string, action: string, parameters: Record<string, JsonValue>, k: string): Promise<ToolResult> =>
  w.gateway.execute({ identity: owner, tool_id: tool, action, parameters: { tenant_id: TENANT, ...parameters }, idempotency_key: k });
const ledger = async (k: string) => (await adminPool.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as { status: string; postcondition_reason: string | null } | undefined;
const intentRow = async (id: string) => (await adminPool.query("SELECT state, provider_ref, anomaly_flags FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as { state: string; provider_ref: string | null; anomaly_flags: string[] };

async function newIntent(w: Wired, provider: "stripe" | "vipps" | "fiken" | "neonomics", extra: Record<string, unknown> = {}): Promise<PaymentIntent> {
  const fikenExtra = provider === "fiken" ? { vendor_provider_ref: "kontakt-9988776655", counter_account_code: "1920" } : {};
  return w.finance.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "FIN2 gateway-avbrudd", amount_ore: 10_000, vendor_name: `Kunde ${randomUUID().slice(0, 8)} AS`,
    account_code: provider === "fiken" ? "6540" : "kategori", provider, ...fikenExtra, ...extra
  } as never);
}

function expectTimedOut(result: ToolResult): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/tool_timeout/);
}

describe("K2: gatewayens tidsavbrudd avbryter finansforespørselen (ekte gateway, ekte transport, hengende server)", () => {
  it("Stripe finance.submit_payment_intent: én forespørsel, socketen lukkes, ledger `unverified`, intensjonen tilbake i draft + flagg, varsel «utfall ukjent», replay sender ingenting", async () => {
    const w = wire();
    const intent = await newIntent(w, "stripe");
    const k = key("g-stripe");
    const t0 = Date.now();
    const result = await exec(w, "finance", "submit_payment_intent", { payment_intent_id: intent.payment_intent_id }, k);
    expectTimedOut(result);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect((await ledger(k))?.status).toBe("unverified");
    await waitFor(async () => requestsTo("/v1/payment_intents").every((s) => s.closed) && (await intentRow(intent.payment_intent_id)).anomaly_flags.includes("SUBMIT_OUTCOME_UNKNOWN"));
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("draft"); // Stripe slår sammen gjentatte kall med samme Idempotency-Key
    expect(row.provider_ref).toBeNull();
    expect(w.notifier.sent.some((n) => n.outcome === "unknown")).toBe(true);
    const again = await exec(w, "finance", "submit_payment_intent", { payment_intent_id: intent.payment_intent_id }, k);
    expect(again.ok).toBe(false);
    await sleep(300);
    expect(requestsTo("/v1/payment_intents")).toHaveLength(1);
  });

  it("Stripe med 5xx (retry-sikker, har Idempotency-Key): backoff-løkken sender IKKE forsøk nr. 2 etter fristen", async () => {
    handler = withTokens(status503);
    const w = wire();
    const intent = await newIntent(w, "stripe");
    const k = key("g-stripe503");
    expectTimedOut(await exec(w, "finance", "submit_payment_intent", { payment_intent_id: intent.payment_intent_id }, k));
    await sleep(1_400); // lenger enn første backoff (500 ms) og andre (1 s): en uavbrytbar sleep ville nå gitt forsøk 2 og 3
    expect(requestsTo("/v1/payment_intents")).toHaveLength(1);
    expect((await ledger(k))?.status).toBe("unverified");
  });

  it("`JARVIS_TOOL_CALL_ABORT=off` er som før: gatewayen avviser med tool_timeout, men forespørselen/retry-løkken avbrytes IKKE (nødutgang)", async () => {
    vi.stubEnv("JARVIS_TOOL_CALL_ABORT", "off");
    handler = withTokens(status503);
    const w = wire();
    const intent = await newIntent(w, "stripe");
    const k = key("g-off");
    expectTimedOut(await exec(w, "finance", "submit_payment_intent", { payment_intent_id: intent.payment_intent_id }, k));
    await waitFor(() => requestsTo("/v1/payment_intents").length >= 2, 3_000); // retry-løkken lever videre etter tidsavbruddet (gammel oppførsel)
    expect((await ledger(k))?.status).toBe("unverified"); // klassifiseringen av ukjent utfall er uendret av flagget
  }, 20_000);

  it("Vipps finance_vipps.submit_capture: én forespørsel til /capture, ledger `unverified`, capturen tilbake i draft + flagg", async () => {
    handler = withTokens(HANG);
    const w = wire();
    const intent = await newIntent(w, "vipps");
    await adminPool.query("UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = $1, provider_status = 'AUTHORIZED', provider_status_updated_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 4_000 });
    const k = key("g-vipps");
    expectTimedOut(await exec(w, "finance_vipps", "submit_capture", { capture_id: capture.capture_id }, k));
    expect((await ledger(k))?.status).toBe("unverified");
    await waitFor(async () => (await adminPool.query("SELECT anomaly_flags FROM vipps_captures WHERE capture_id = $1", [capture.capture_id])).rows[0]!["anomaly_flags"].includes("SUBMIT_OUTCOME_UNKNOWN"));
    const row = (await adminPool.query("SELECT state FROM vipps_captures WHERE capture_id = $1", [capture.capture_id])).rows[0] as { state: string };
    expect(row.state).toBe("draft");
    await sleep(300);
    expect(requestsTo("/capture")).toHaveLength(1);
    expect(requestsTo("/capture")[0]!.closed).toBe(true);
  });

  it("Fiken finance.submit_payment_intent (ingen Idempotency-Key): én journal-POST, ledger `unverified`, intensjonen blir stående `submitted` + flagg (aldri en ny postering)", async () => {
    handler = withTokens(HANG);
    const w = wire();
    const intent = await newIntent(w, "fiken");
    const k = key("g-fiken");
    expectTimedOut(await exec(w, "finance", "submit_payment_intent", { payment_intent_id: intent.payment_intent_id }, k));
    expect((await ledger(k))?.status).toBe("unverified");
    await waitFor(async () => (await intentRow(intent.payment_intent_id)).anomaly_flags.includes("SUBMIT_OUTCOME_UNKNOWN"));
    expect((await intentRow(intent.payment_intent_id)).state).toBe("submitted");
    expect((await intentRow(intent.payment_intent_id)).provider_ref).toBeNull();
    await sleep(300);
    expect(requestsTo("generalJournalEntries")).toHaveLength(1);
  });

  it("Neonomics finance.submit_payment_intent (ingen Idempotency-Key): én betalings-POST, ledger `unverified`, intensjonen blir stående `submitted` + flagg", async () => {
    handler = withTokens(HANG);
    const w = wire();
    // oppsett: samtykke + debitorkonto via en fake bankgateway (kun AIS-delen) - selve innsendingen går gjennom den EKTE transporten
    const setupGateway = new Proxy({}, {
      get: (_t, name: string | symbol) => {
        if (typeof name !== "string" || name === "then") return undefined;
        if (name === "createSession") return async (bankId: string) => ({ sessionId: `sess-${bankId}-${randomUUID()}` });
        if (name === "getConsentUrl") return async () => ({ url: "https://bank.example.test/sca" });
        if (name === "listAccounts") return async () => [{ id: "prov-acc-1", accountName: "Konto", accountNumber: "12345678903", currency: "NOK", accountType: "checking" }];
        return async () => { throw new Error(`unexpected_gateway_call:${name}`); };
      }
    }) as unknown as NeonomicsGateway;
    const banking = new BankingService(appPool, { getCredentials: async () => neonomicsCreds }, () => setupGateway);
    const consent = await banking.createConsent(TENANT, "business", { bank_id: "dnb-no", bank_name: "DNB" });
    const { callback_state } = await banking.getConsentAuthorizationUrl(TENANT, "business", consent.consent_id, "https://jarvis.internal/bank/callback");
    await banking.completeConsentCallback(TENANT, "business", consent.consent_id, callback_state);
    await banking.syncAccounts(TENANT, "business", consent.consent_id);
    const account = (await banking.listBankAccounts(TENANT, "business")).find((a) => a.consent_id === consent.consent_id)!;
    const intent = await newIntent(w, "neonomics", { vendor_provider_ref: "98765432101", counter_account_code: account.bank_account_id });
    const k = key("g-neo");
    expectTimedOut(await exec(w, "finance", "submit_payment_intent", { payment_intent_id: intent.payment_intent_id }, k));
    expect((await ledger(k))?.status).toBe("unverified");
    await waitFor(async () => (await intentRow(intent.payment_intent_id)).anomaly_flags.includes("SUBMIT_OUTCOME_UNKNOWN"));
    expect((await intentRow(intent.payment_intent_id)).state).toBe("submitted");
    await sleep(300);
    expect(requestsTo("domestic-transfer")).toHaveLength(1);
  });

  it("Wallester finance_wallester.submit_card (klasse C): én kort-POST, ledger `unverified`, kortet blir `draft` med CARD_SUBMIT_OUTCOME_UNKNOWN - ny innsending blokkeres", async () => {
    handler = withTokens(HANG);
    const w = wire();
    const card = await w.cards.createCard(TENANT, "business", { idempotency_key: `card-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual", currency: "EUR" });
    const k = key("g-card");
    expectTimedOut(await exec(w, "finance_wallester", "submit_card", { card_id: card.card_id }, k));
    expect((await ledger(k))?.status).toBe("unverified");
    await waitFor(async () => ((await adminPool.query("SELECT anomaly_flags FROM provider_cards WHERE card_id = $1", [card.card_id])).rows[0]!["anomaly_flags"] as string[]).includes("CARD_SUBMIT_OUTCOME_UNKNOWN"));
    const row = (await adminPool.query("SELECT state, provider_card_id FROM provider_cards WHERE card_id = $1", [card.card_id])).rows[0] as { state: string; provider_card_id: string | null };
    expect(row).toEqual({ state: "draft", provider_card_id: null });
    // en NY nøkkel (ny gateway-forespørsel) når tjenestens egen blokkering: ingen ny leverandørforespørsel
    const second = await exec(w, "finance_wallester", "submit_card", { card_id: card.card_id }, key("g-card-2"));
    expect(second.ok).toBe(false);
    await sleep(300);
    expect(requestsTo("/v1/cards")).toHaveLength(1);
  });
});
