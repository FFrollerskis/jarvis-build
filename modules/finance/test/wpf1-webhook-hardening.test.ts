import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  CardService,
  FinanceService,
  InvalidWebhookSignatureError,
  WallesterPayloadError,
  WallesterTransport,
  createRsaJwtSigner,
  parseNeonomicsEventEnvelope,
  parseStripeEventEnvelope,
  parseVippsEventEnvelope,
  parseWallesterEventEnvelope,
  type WallesterGateway
} from "../src/index.ts";
import { malformedWebhookKey, rejectionCode, safeProviderId, safeToken, strictUnixSeconds, strictWebhookAmount, strictWebhookCurrency, strictWebhookTimestamp } from "../src/webhook-guard.ts";

/**
 * WP-F1 (D-453, JARVIS-020/070): webhook-herding for ALLE fire leverandører. Streng heltallsparsing i minste enhet (ingen `Number()`-coercion; NaN/Infinity/negative/brøk/for store
 * avvises), trygge id-er/tidsstempler, og permanent ugyldig innhold lagres som dødbrev `rejected` (2xx, ingen evig retry) uten å røre domenetilstanden. Wallester får samme
 * tilstandsmaskin som Stripe/Vipps/Neonomics: SAVEPOINT, gjenbehandling av `failed_retryable`, ukjent klasse = `unsupported`. Neonomics: hendelsesorden (forsinket tidligere status
 * overskriver aldri). Ekte embedded Postgres; ingen nettverk.
 */
const J = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

describe("A: webhook-guard - rene byggeklosser", () => {
  it("safeProviderId: kun trygge id-er (tegnsett, lengde); kontrolltegn, mellomrom, unicode og tom/for lang avvises", () => {
    for (const ok of ["evt_1Abc", "pi_3N", "fin-pi-3f2c9a2e-0000-4000-8000-000000000001", "a", "A.b:c/d=e+f@g-h_i"]) expect(safeProviderId(ok), ok).toBe(ok);
    for (const bad of ["", " ", "evt 1", "evt\n1", "evt\t1", "évt", "-evt", ".evt", "a".repeat(256), "evt;DROP", "evt'--", "<script>", 5, null, undefined, {}, ["x"]]) expect(safeProviderId(bad as string), String(bad)).toBeNull();
    expect(safeProviderId("a".repeat(255))).toBe("a".repeat(255));
  });

  it("strictWebhookAmount/Currency/Timestamp/UnixSeconds: fraværende = ok(null), tilstedeværende må være gyldig", () => {
    expect(strictWebhookAmount(undefined)).toEqual({ ok: true, value: null });
    expect(strictWebhookAmount(null)).toEqual({ ok: true, value: null });
    expect(strictWebhookAmount(1500)).toEqual({ ok: true, value: 1500 });
    expect(strictWebhookAmount(-1)).toEqual({ ok: false, rejection: "amount_invalid:amount_negative" });
    expect(strictWebhookAmount(1.5)).toEqual({ ok: false, rejection: "amount_invalid:amount_not_integer" });
    expect(strictWebhookAmount("1e3")).toEqual({ ok: false, rejection: "amount_invalid:amount_not_digits" });
    expect(strictWebhookCurrency(undefined)).toEqual({ ok: true, value: null });
    expect(strictWebhookCurrency("nok")).toEqual({ ok: true, value: "NOK" });
    for (const bad of ["NO", "NOKK", "N0K", "", 5, {}]) expect(strictWebhookCurrency(bad), String(bad)).toEqual({ ok: false, rejection: "currency_invalid" });
    expect(strictWebhookTimestamp("2026-08-25T12:00:00.000Z")).toEqual({ ok: true, value: "2026-08-25T12:00:00.000Z" });
    expect(strictWebhookTimestamp(undefined)).toEqual({ ok: true, value: null });
    for (const bad of ["ikke-en-dato", "2026-13-45", "1999-12-31T23:59:59Z", "2100-01-01T00:00:00Z", 12345, {}, "x".repeat(41)]) expect(strictWebhookTimestamp(bad as string), String(bad)).toEqual({ ok: false, rejection: "timestamp_invalid" });
    expect(strictUnixSeconds(1_700_000_000)).toEqual({ ok: true, value: 1_700_000_000 });
    for (const bad of [0, -1, 1.5, 1e12, 4_102_444_800, "1700000000", null, Number.NaN, Number.POSITIVE_INFINITY]) expect(strictUnixSeconds(bad as number), String(bad)).toEqual({ ok: false, rejection: "created_invalid" });
  });

  it("rejectionCode og malformedWebhookKey: trygt tegnsett, avkortet, deterministisk hash-nøkkel uten innhold", () => {
    expect(rejectionCode("amount_invalid", "amount_negative")).toBe("amount_invalid:amount_negative");
    expect(rejectionCode("x y\nz'--")).toBe("x_y_z_--");
    expect(rejectionCode("a".repeat(200))).toHaveLength(80);
    const key = malformedWebhookKey(Buffer.from("hemmelig innhold 4242424242424242"));
    expect(key).toMatch(/^malformed:[0-9a-f]{40}$/);
    expect(key).not.toContain("4242");
    expect(malformedWebhookKey(Buffer.from("a"))).toBe(malformedWebhookKey(Buffer.from("a")));
    expect(malformedWebhookKey(Buffer.from("a"))).not.toBe(malformedWebhookKey(Buffer.from("b")));
    expect(safeToken("payment_intent")).toBe("payment_intent");
    expect(safeToken("payment intent")).toBeNull();
    expect(safeToken("x".repeat(65))).toBeNull();
  });
});

describe("B: parserne - feilformede nyttelaster", () => {
  const stripe = (object: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    parseStripeEventEnvelope(J({ id: "evt_1", type: "payment_intent.succeeded", created: 1_700_000_000, data: { object: { id: "pi_1", object: "payment_intent", ...object } }, ...over }));

  it("Stripe: gyldig; beløp må være trygt, ikke-negativt heltall (rått JSON-tall utenfor double-området er Infinity)", () => {
    expect(stripe({ amount: 5000, currency: "nok", status: "succeeded" })).toMatchObject({ amount_ore: 5000, currency: "NOK", rejection: null });
    expect(stripe({ amount: 0 }).rejection).toBeNull();
    expect(stripe({ amount: -5 }).rejection).toBe("amount_invalid:amount_negative");
    expect(stripe({ amount: 1.5 }).rejection).toBe("amount_invalid:amount_not_integer");
    expect(stripe({ amount: 2 ** 53 }).rejection).toBe("amount_invalid:amount_too_large");
    expect(stripe({ amount: 1e15 }).rejection).toBe("amount_invalid:amount_too_large");
    expect(stripe({ amount: "1e3" }).rejection).toBe("amount_invalid:amount_not_digits");
    expect(stripe({ amount: "0x10" }).rejection).toBe("amount_invalid:amount_not_digits");
    expect(stripe({ amount: true }).rejection).toBe("amount_invalid:amount_wrong_type");
    expect(stripe({ amount: { value: 5 } }).rejection).toBe("amount_invalid:amount_wrong_type");
    expect(stripe({ amount: [5] }).rejection).toBe("amount_invalid:amount_wrong_type");
    const infinite = parseStripeEventEnvelope(Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded","created":1700000000,"data":{"object":{"id":"pi_1","object":"payment_intent","amount":1e400}}}'));
    expect(infinite.rejection).toBe("amount_invalid:amount_not_finite");
    expect(infinite.amount_ore).toBeNull();
  });

  it("Stripe: valuta, created, id-er, objekttype og referanser valideres; ikke-penge-objekter ignoreres (negative saldobeløp er normale der)", () => {
    expect(stripe({ amount: 5, currency: "NO" }).rejection).toBe("currency_invalid");
    expect(stripe({ amount: 5, currency: 5 }).rejection).toBe("currency_invalid");
    expect(stripe({}, { created: 0 }).rejection).toBe("created_invalid");
    expect(stripe({}, { created: "1700000000" }).rejection).toBe("created_invalid");
    expect(stripe({}, { created: 1e12 }).rejection).toBe("created_invalid");
    expect(stripe({}, { created: 0 }).created).toBe(0);
    expect(stripe({ id: "pi 1" }).rejection).toBe("object_id_invalid");
    expect(stripe({ object: "payment intent" }).rejection).toBe("object_type_invalid");
    expect(stripe({ object: "charge", payment_intent: "pi 1" }).rejection).toBe("payment_intent_ref_invalid");
    // balance_transaction/payout-aktige objekter: negativt beløp er normalt og ignoreres (ikke et pengeobjekt Jarvis anvender)
    const payout = parseStripeEventEnvelope(J({ id: "evt_2", type: "payout.paid", created: 1_700_000_000, data: { object: { id: "po_1", object: "payout", amount: -100000, currency: "nok" } } }));
    expect(payout).toMatchObject({ rejection: null, amount_ore: null, currency: null });
    // første problem vinner deterministisk
    expect(stripe({ amount: -5, currency: "NO" }, { created: 0 }).rejection).toBe("created_invalid");
  });

  it("Stripe: ikke-identifiserbar nyttelast KASTER (kalleren lagrer dødbrev under hash-nøkkel)", () => {
    for (const bad of [{ foo: "bar" }, { id: "evt 1", type: "a.b", created: 1_700_000_000 }, { id: "evt_1", type: "Payment.Succeeded", created: 1_700_000_000 }, { id: "evt_1", type: "a".repeat(121), created: 1_700_000_000 }, { id: 5, type: "a.b" }, [], "streng", 5, null]) {
      expect(() => parseStripeEventEnvelope(J(bad)), JSON.stringify(bad)).toThrow("stripe_event_envelope_malformed");
    }
    expect(() => parseStripeEventEnvelope(Buffer.from("ikke json"))).toThrow();
    expect(() => parseStripeEventEnvelope(Buffer.from('{"id":"evt_1","type":"a.b","created":1700000000,"data":{"object":'))).toThrow();
  });

  it("Vipps: beløp/valuta/tidsstempel valideres (ugyldig dato ga tidligere RangeError og evig 5xx); navn og referanse må være trygge", () => {
    const vipps = (over: Record<string, unknown>) => parseVippsEventEnvelope(J({ reference: "fin-pi-abc", name: "AUTHORIZED", amount: { value: 5000, currency: "NOK" }, timestamp: "2026-08-25T12:00:00.000Z", ...over }));
    expect(vipps({})).toMatchObject({ amount_ore: 5000, currency: "NOK", timestamp: "2026-08-25T12:00:00.000Z", rejection: null });
    expect(vipps({ amount: { value: -1, currency: "NOK" } }).rejection).toBe("amount_invalid:amount_negative");
    expect(vipps({ amount: { value: 1.25, currency: "NOK" } }).rejection).toBe("amount_invalid:amount_not_integer");
    expect(vipps({ amount: { value: "5000", currency: "NOK" } }).rejection).toBeNull(); // rene sifre er et gyldig heltall i minste enhet
    expect(vipps({ amount: { value: "50,00", currency: "NOK" } }).rejection).toBe("amount_invalid:amount_not_digits");
    expect(vipps({ amount: { value: 5000, currency: "NOKR" } }).rejection).toBe("currency_invalid");
    expect(vipps({ amount: 5000 }).rejection).toBe("amount_invalid:wrong_type");
    for (const ts of ["ikke-en-dato", "2026-13-45T00:00:00Z", "1999-01-01T00:00:00Z", 1_700_000_000, {}]) expect(vipps({ timestamp: ts }).rejection, String(ts)).toBe("timestamp_invalid");
    expect(vipps({ timestamp: undefined }).dedupeKey).toBe("fin-pi-abc:AUTHORIZED:no-timestamp");
    expect(vipps({ idempotencyKey: "idem 1" }).dedupeKey).toBe("fin-pi-abc:AUTHORIZED:2026-08-25T12:00:00.000Z"); // ugyldig nøkkel brukes aldri som dedupe-nøkkel
    for (const bad of [{ reference: "fin pi" }, { name: "a" }, { name: "AUTH ORIZED" }, { name: 5 }, { reference: undefined }]) expect(() => vipps(bad), JSON.stringify(bad)).toThrow("vipps_event_envelope_malformed");
    expect(() => parseVippsEventEnvelope(J([]))).toThrow("vipps_event_envelope_malformed");
  });

  it("Neonomics: betalings-id og ISO 20022-lignende status må være trygge; ellers kastes (dødbrev)", () => {
    expect(parseNeonomicsEventEnvelope(J({ paymentId: "pay-1", status: "ACSC" }))).toEqual({ dedupeKey: "pay-1:ACSC", paymentId: "pay-1", status: "ACSC" });
    expect(parseNeonomicsEventEnvelope(J({ id: "pay-2", status: "RJCT" })).paymentId).toBe("pay-2");
    for (const bad of [{ paymentId: "pay 1", status: "ACSC" }, { paymentId: "pay-1", status: "AC SC" }, { paymentId: "pay-1", status: "" }, { paymentId: "pay-1", status: "X".repeat(33) }, { paymentId: "pay-1", status: 5 }, { paymentId: "pay-1" }, { status: "ACSC" }, [], "x", null]) {
      expect(() => parseNeonomicsEventEnvelope(J(bad)), JSON.stringify(bad)).toThrow("neonomics_event_envelope_malformed");
    }
  });

  it("Wallester: påkrevd, strengt heltall i minste enhet + valuta for penge-hendelser; aldri `Number(x ?? 0)` / «EUR»-standard", () => {
    const wal = (type: string, data: Record<string, unknown>, over: Record<string, unknown> = {}) => parseWallesterEventEnvelope(J({ event: "notification", type, event_id: "evt-w-1", data: { id: "wauth-1", card_id: "wcard-1", status: "approved", ...data }, ...over }));
    expect(wal("authorization", { amount: 7500, currency: "eur" })).toMatchObject({ amountOre: 7500, currency: "EUR", rejection: null });
    expect(wal("authorization", { currency: "EUR" }).rejection).toBe("amount_invalid:amount_missing"); // manglende beløp er avvist, ikke 0
    expect(wal("authorization", { amount: null, currency: "EUR" }).rejection).toBe("amount_invalid:amount_missing");
    expect(wal("transaction", { amount: 12.5, currency: "EUR" }).rejection).toBe("amount_invalid:amount_not_integer"); // desimal hovedenhet feilskaleres ikke - avvises
    expect(wal("transaction", { amount: -100, currency: "EUR" }).rejection).toBe("amount_invalid:amount_negative");
    expect(wal("transaction", { amount: "abc", currency: "EUR" }).rejection).toBe("amount_invalid:amount_not_digits");
    expect(wal("authorization_release", { amount: 1, currency: "EU" }).rejection).toBe("currency_invalid");
    expect(wal("authorization", { amount: 1 }).rejection).toBe("currency_invalid"); // ingen stille standardvaluta
    // kort-hendelser bærer ikke beløp
    expect(wal("card", { status: "active" })).toMatchObject({ kind: "card", amountOre: null, currency: null, rejection: null });
    // id-er
    expect(wal("authorization", { amount: 1, currency: "EUR" }, { event_id: "evt 1" }).rejection).toBe("event_id_invalid");
    expect(wal("authorization", { amount: 1, currency: "EUR", card_id: "wcard 1" }).rejection).toBe("card_id_invalid");
    expect(() => wal("authorization", { id: "bad id" })).toThrow("wallester_event_envelope_malformed:missing_object_id");
    expect(() => wal("authorization", {}, { data: "ikke objekt" })).toThrow("wallester_event_envelope_malformed:data_not_an_object");
    expect(() => parseWallesterEventEnvelope(J([]))).toThrow("wallester_event_envelope_malformed:not_an_object");
    expect(() => wal("auth orization", { amount: 1, currency: "EUR" })).toThrow("wallester_event_envelope_malformed:missing_type");
  });
});

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-wpf1-wh";
const STRIPE_SECRET = "not-a-real-stripe-webhook-secret-fixture-wh";
const VIPPS_SECRET = "not-a-real-vipps-webhook-secret-fixture-wh";
const NEO_KEY = "not-a-real-neonomics-webhook-api-key-wh";
const WAL_USER = "wallester-wh-user";
const WAL_PASS = "wallester-wh-pass-fixture";
const VIPPS_HOST = "jarvis.example.test";
const VIPPS_PATH = "/webhooks/vipps";
let finance: FinanceService;
let cards: CardService;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-wh-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_wh LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_wh");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 webhook', 'business')`);
  appPool = createPool({ ...base, user: "jarvis_wpf1_wh", password: "pw2" });
  finance = new FinanceService(
    appPool, undefined, undefined, undefined, () => STRIPE_SECRET, () => TENANT,
    undefined, undefined, () => VIPPS_SECRET, () => TENANT,
    undefined, undefined, () => NEO_KEY, () => TENANT
  );
  const gateway = new Proxy({}, {
    get: (_t, name: string | symbol) => {
      if (typeof name !== "string" || name === "then") return undefined; // ingen thenable (en proxy som awaites ellers henger)
      if (name === "createCard") return async () => ({ id: `wcard-${randomUUID()}`, status: "active", maskedCardNumber: "…4321", accountId: "wacc-1", tokenizationStatus: null });
      return async () => { throw new Error(`unexpected_gateway_call:${name}`); };
    }
  }) as unknown as WallesterGateway;
  cards = new CardService(appPool, { getCredentials: async () => ({ baseUrl: "https://wallester.test", apiKey: "k", privateKeyPem: "p", accountId: "a" }) as never }, () => gateway, () => ({ username: WAL_USER, password: WAL_PASS }), () => TENANT);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const stripeHeader = (raw: Buffer): string => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", STRIPE_SECRET).update(`${t}.${raw.toString("utf8")}`, "utf8").digest("hex")}`;
};
const vippsHeaders = (raw: Buffer) => {
  const date = "Tue, 25 Aug 2026 12:00:00 GMT";
  const hash = createHash("sha256").update(raw).digest("base64");
  const sig = createHmac("sha256", VIPPS_SECRET).update(`POST\n${VIPPS_PATH}\n${date};${VIPPS_HOST};${hash}`, "utf8").digest("base64");
  return { host: VIPPS_HOST, xMsDate: date, xMsContentSha256: hash, authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${sig}` };
};
const walAuth = `Basic ${Buffer.from(`${WAL_USER}:${WAL_PASS}`).toString("base64")}`;
const row = async (sql: string, params: unknown[] = []) => (await adminPool.query(sql, params)).rows[0] as Record<string, unknown> | undefined;

async function acknowledgedIntent(provider: "stripe" | "vipps" | "neonomics", providerRef: string, status: string): Promise<string> {
  const intent = await finance.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "webhook", amount_ore: 10_000, vendor_name: "V", account_code: "kategori", provider,
    ...(provider === "neonomics" ? { vendor_provider_ref: "NO9386011117947", counter_account_code: "bank-x" } : {})
  });
  await adminPool.query("UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = $2, provider_status = $3, provider_status_updated_at = now() - interval '1 hour' WHERE payment_intent_id = $1", [intent.payment_intent_id, providerRef, status]);
  return intent.payment_intent_id;
}

describe("C: Stripe/Vipps/Neonomics - dødbrev `rejected` uten å røre domenetilstanden (og ingen evig retry)", () => {
  it("Stripe: negativt/brøk/astronomisk beløp, ugyldig dato og valuta -> rejected + årsak; intensjonen er uendret; redelivery = duplicate", async () => {
    const ref = `pi_wh_${randomUUID().slice(0, 8)}`;
    const id = await acknowledgedIntent("stripe", ref, "requires_payment_method");
    const before = await row("SELECT provider_status, provider_reported_amount_ore, updated_at, state FROM payment_intents WHERE payment_intent_id = $1", [id]);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["negativt", { amount: -5, currency: "nok", status: "succeeded" }, "amount_invalid:amount_negative"],
      ["brøk", { amount: 1.5, currency: "nok", status: "succeeded" }, "amount_invalid:amount_not_integer"],
      ["astronomisk", { amount: 1e15, currency: "nok", status: "succeeded" }, "amount_invalid:amount_too_large"],
      ["ugyldig valuta", { amount: 100, currency: "kroner", status: "succeeded" }, "currency_invalid"]
    ];
    for (const [name, object, reason] of cases) {
      const raw = J({ id: `evt_${randomUUID().slice(0, 12)}`, type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000), data: { object: { id: ref, object: "payment_intent", ...object } } });
      const result = await finance.ingestStripeWebhookEvent(raw, stripeHeader(raw));
      expect(result.status, name).toBe("rejected");
      const stored = (await row("SELECT status, error_message, payload_summary FROM stripe_webhook_events WHERE stripe_event_id = $1", [result.eventId]))!;
      expect(stored["status"]).toBe("rejected");
      expect(stored["error_message"]).toBe(reason);
      expect(JSON.stringify(stored["payload_summary"])).not.toMatch(/-5|1\.5|1e15|kroner/); // aldri det avviste innholdet
      expect((await finance.ingestStripeWebhookEvent(raw, stripeHeader(raw))).status, name).toBe("duplicate");
    }
    const bad = J({ id: "evt_baddate", type: "payment_intent.succeeded", created: 99, data: { object: { id: ref, object: "payment_intent", amount: 100, currency: "nok", status: "succeeded" } } });
    expect((await finance.ingestStripeWebhookEvent(bad, stripeHeader(bad))).status).toBe("rejected");
    expect((await row("SELECT error_message, stripe_created_at FROM stripe_webhook_events WHERE stripe_event_id = 'evt_baddate'"))!["error_message"]).toBe("created_invalid");
    // domenet er rørt av INGEN av dem
    const after = await row("SELECT provider_status, provider_reported_amount_ore, updated_at, state FROM payment_intents WHERE payment_intent_id = $1", [id]);
    expect(after).toEqual(before);
  });

  it("Stripe: en gyldig hendelse behandles som før (positiv kontroll), og en ikke-identifiserbar signert nyttelast blir dødbrev under hash-nøkkel (ikke 500)", async () => {
    const ref = `pi_wh_${randomUUID().slice(0, 8)}`;
    const id = await acknowledgedIntent("stripe", ref, "requires_payment_method");
    const ok = J({ id: `evt_${randomUUID().slice(0, 12)}`, type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000), data: { object: { id: ref, object: "payment_intent", amount: 10_000, currency: "nok", status: "succeeded" } } });
    expect((await finance.ingestStripeWebhookEvent(ok, stripeHeader(ok))).status).toBe("processed");
    expect((await row("SELECT state FROM payment_intents WHERE payment_intent_id = $1", [id]))!["state"]).toBe("settled");

    const garbage = Buffer.from('{"dette":"er signert men ikke en hendelse"}');
    const r1 = await finance.ingestStripeWebhookEvent(garbage, stripeHeader(garbage));
    expect(r1.status).toBe("rejected");
    expect(r1.eventId).toBe(malformedWebhookKey(garbage));
    expect((await row("SELECT event_type, status, error_message FROM stripe_webhook_events WHERE stripe_event_id = $1", [r1.eventId]))).toEqual({ event_type: "malformed", status: "rejected", error_message: "envelope_malformed" });
    expect((await finance.ingestStripeWebhookEvent(garbage, stripeHeader(garbage))).status).toBe("duplicate");
    const notJson = Buffer.from("ikke json i det hele tatt");
    expect((await finance.ingestStripeWebhookEvent(notJson, stripeHeader(notJson))).status).toBe("rejected");
    // feil signatur avvises fortsatt FØR noe lagres
    await expect(finance.ingestStripeWebhookEvent(garbage, "t=1,v1=00")).rejects.toThrow(InvalidWebhookSignatureError);
  });

  it("Vipps: ugyldig tidsstempel (tidligere RangeError -> 500 -> evig retry), ugyldig beløp og ikke-identifiserbar nyttelast -> rejected; intensjonen uendret", async () => {
    const ref = `fin-pi-wh-${randomUUID().slice(0, 8)}`;
    const id = await acknowledgedIntent("vipps", ref, "CREATED");
    const before = await row("SELECT provider_status, updated_at, state FROM payment_intents WHERE payment_intent_id = $1", [id]);
    const send = async (body: Record<string, unknown>) => { const raw = J(body); return finance.ingestVippsWebhookEvent(raw, "POST", VIPPS_PATH, vippsHeaders(raw)); };
    expect((await send({ reference: ref, name: "AUTHORIZED", timestamp: "ikke-en-dato", idempotencyKey: `k-${randomUUID()}` })).status).toBe("rejected");
    expect((await send({ reference: ref, name: "AUTHORIZED", amount: { value: -100, currency: "NOK" }, timestamp: "2026-08-25T12:00:00Z", idempotencyKey: `k-${randomUUID()}` })).status).toBe("rejected");
    expect((await send({ reference: ref, name: "AUTHORIZED", amount: { value: 100.5, currency: "NOK" }, timestamp: "2026-08-25T12:00:00Z", idempotencyKey: `k-${randomUUID()}` })).status).toBe("rejected");
    const malformed = J({ ikke: "vipps" });
    const rm = await finance.ingestVippsWebhookEvent(malformed, "POST", VIPPS_PATH, vippsHeaders(malformed));
    expect(rm).toMatchObject({ status: "rejected", eventId: malformedWebhookKey(malformed) });
    expect((await finance.ingestVippsWebhookEvent(malformed, "POST", VIPPS_PATH, vippsHeaders(malformed))).status).toBe("duplicate");
    const rows = (await adminPool.query("SELECT error_message FROM vipps_webhook_events WHERE status = 'rejected' ORDER BY created_at")).rows as Array<{ error_message: string }>;
    expect(rows.map((r) => r.error_message)).toEqual(expect.arrayContaining(["timestamp_invalid", "amount_invalid:amount_negative", "amount_invalid:amount_not_integer", "envelope_malformed"]));
    expect(await row("SELECT provider_status, updated_at, state FROM payment_intents WHERE payment_intent_id = $1", [id])).toEqual(before);
    // positiv kontroll (tidsstempel «nå»: den lagrede tilstanden er en time gammel, så hendelsen er ikke foreldet)
    expect((await send({ reference: ref, name: "AUTHORIZED", amount: { value: 10_000, currency: "NOK" }, timestamp: new Date().toISOString(), idempotencyKey: `k-${randomUUID()}` })).status).toBe("processed");
    expect((await row("SELECT provider_status FROM payment_intents WHERE payment_intent_id = $1", [id]))!["provider_status"]).toBe("AUTHORIZED");
  });

  it("Neonomics: ugyldig status/id -> rejected (dødbrev); hendelsesorden - en forsinket tidligere status overskriver aldri en status i oppgjør", async () => {
    const ref = `neo-pay-${randomUUID().slice(0, 8)}`;
    const id = await acknowledgedIntent("neonomics", ref, "PDNG");
    const send = (body: Record<string, unknown>) => finance.ingestNeonomicsWebhookEvent(J(body), NEO_KEY);
    expect((await send({ paymentId: ref, status: "AC SC" })).status).toBe("rejected");
    expect((await send({ paymentId: "pay 1", status: "ACSC" })).status).toBe("rejected");
    expect((await send({ paymentId: ref })).status).toBe("rejected");
    await expect(finance.ingestNeonomicsWebhookEvent(J({ paymentId: ref, status: "ACSC" }), "feil-noekkel")).rejects.toThrow(InvalidWebhookSignatureError);
    const providerStatus = async () => (await row("SELECT provider_status, state FROM payment_intents WHERE payment_intent_id = $1", [id]))!;

    // før oppgjør: tidligere statuser kan komme i vilkårlig rekkefølge (kun observasjonelt)
    expect((await send({ paymentId: ref, status: "ACCP" })).status).toBe("processed");
    expect((await send({ paymentId: ref, status: "ACTC" })).status).toBe("processed");
    expect((await providerStatus())["provider_status"]).toBe("ACTC");
    // samme (betaling, status) en gang til er idempotent: duplicate, aldri anvendt på nytt
    expect((await send({ paymentId: ref, status: "ACTC" })).status).toBe("duplicate");
    // oppgjør i gang (ACSP): fra nå overskrives provider_status aldri av en FORSINKET tidligere status (første gang den sees)
    expect((await send({ paymentId: ref, status: "ACSP" })).status).toBe("processed");
    expect((await providerStatus())["provider_status"]).toBe("ACSP");
    for (const late of ["RCVD", "PATC", "ACWC"]) {
      expect((await send({ paymentId: ref, status: late })).status, late).toBe("processed"); // mottatt og håndtert (ikke en feil) men ikke anvendt
      expect((await providerStatus())["provider_status"], late).toBe("ACSP");
    }
    // fullført oppgjør
    expect((await send({ paymentId: ref, status: "ACSC" })).status).toBe("processed");
    expect(await providerStatus()).toMatchObject({ provider_status: "ACSC", state: "settled" });
    expect((await send({ paymentId: ref, status: "PDNG" })).status).toBe("processed");
    expect(await providerStatus()).toMatchObject({ provider_status: "ACSC", state: "settled" }); // aldri regresjon
    // et senere terminalt negativt utfall for en allerede oppgjort betaling flagges, overskriver aldri
    expect((await send({ paymentId: ref, status: "RJCT" })).status).toBe("processed");
    expect(await providerStatus()).toMatchObject({ provider_status: "ACSC", state: "settled" });
    expect((await row("SELECT anomaly_flags FROM payment_intents WHERE payment_intent_id = $1", [id]))!["anomaly_flags"]).toContain("WEBHOOK_STATE_CONFLICT");
  });
});

describe("D: Wallester - samme tilstandsmaskin som de øvrige (rejected, SAVEPOINT, gjenbehandling, ukjent klasse)", () => {
  async function activeCard(): Promise<{ card_id: string; provider_card_id: string }> {
    const draft = await cards.createCard(TENANT, "business", { idempotency_key: `card-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual", currency: "EUR" });
    const submitted = await cards.submitCard(TENANT, "business", draft.card_id);
    return { card_id: submitted.card_id, provider_card_id: submitted.provider_card_id! };
  }
  const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => J({ event: "notification", type, event_id: `evt-${randomUUID()}`, data, ...extra });

  it("manglende/ugyldig beløp eller valuta og en ugyldig konvolutt -> rejected (ikke 5xx, ikke en stille 0/EUR); ingenting skrives til kort-tabellene", async () => {
    const { card_id, provider_card_id } = await activeCard();
    const results = [
      await cards.ingestWallesterWebhookEvent(ev("authorization", { id: `wauth-${randomUUID()}`, card_id: provider_card_id, status: "approved", currency: "EUR" }), walAuth),
      await cards.ingestWallesterWebhookEvent(ev("authorization", { id: `wauth-${randomUUID()}`, card_id: provider_card_id, status: "approved", amount: 12.5, currency: "EUR" }), walAuth),
      await cards.ingestWallesterWebhookEvent(ev("transaction", { id: `wtx-${randomUUID()}`, card_id: provider_card_id, amount: -100, currency: "EUR" }), walAuth),
      await cards.ingestWallesterWebhookEvent(ev("transaction", { id: `wtx-${randomUUID()}`, card_id: provider_card_id, amount: 100 }), walAuth)
    ];
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    const reasons = (await adminPool.query("SELECT error_message FROM wallester_webhook_events WHERE dedupe_key = ANY($1::text[]) AND status = 'rejected'", [results.map((r) => r.eventId)])).rows.map((r) => (r as { error_message: string }).error_message).sort();
    expect(reasons).toEqual(["amount_invalid:amount_missing", "amount_invalid:amount_negative", "amount_invalid:amount_not_integer", "currency_invalid"].sort());
    expect(await cards.listAuthorizations(TENANT, "business", { card_id })).toHaveLength(0);
    expect(await cards.listCardTransactions(TENANT, "business", { card_id })).toHaveLength(0);

    const wrongEnvelope = J({ event: "something_else", type: "authorization", data: { id: "x-1" } });
    const rw = await cards.ingestWallesterWebhookEvent(wrongEnvelope, walAuth);
    expect(rw).toMatchObject({ status: "rejected", eventId: malformedWebhookKey(wrongEnvelope) });
    expect((await row("SELECT error_message FROM wallester_webhook_events WHERE dedupe_key = $1", [rw.eventId]))!["error_message"]).toBe("envelope_malformed:unexpected_envelope_event");
    expect((await cards.ingestWallesterWebhookEvent(wrongEnvelope, walAuth)).status).toBe("duplicate");
    await expect(cards.ingestWallesterWebhookEvent(wrongEnvelope, `Basic ${Buffer.from("x:y").toString("base64")}`)).rejects.toThrow(InvalidWebhookSignatureError);
  });

  it("en gyldig hendelse behandles (positiv kontroll); ukjent hendelsesklasse er `unsupported` - aldri `processed`", async () => {
    const { card_id, provider_card_id } = await activeCard();
    const ok = await cards.ingestWallesterWebhookEvent(ev("authorization", { id: `wauth-${randomUUID()}`, card_id: provider_card_id, status: "approved", amount: 7_500, currency: "eur" }), walAuth);
    expect(ok.status).toBe("processed");
    const auths = await cards.listAuthorizations(TENANT, "business", { card_id });
    expect(auths).toHaveLength(1);
    expect(auths[0]).toMatchObject({ amount_ore: 7_500, currency: "EUR" });
    const unknown = await cards.ingestWallesterWebhookEvent(ev("noe_helt_ukjent", { id: `x-${randomUUID()}`, card_id: provider_card_id, status: "x" }), walAuth);
    expect(unknown.status).toBe("unsupported");
    expect((await row("SELECT status FROM wallester_webhook_events WHERE dedupe_key = $1", [unknown.eventId]))!["status"]).toBe("unsupported");
  });

  it("SAVEPOINT + gjenbehandling: en SQL-feil under anvendelsen gir failed_retryable (ikke en avbrutt transaksjon/502 uten spor), og leverandørens retry behandler hendelsen på nytt", async () => {
    const { card_id, provider_card_id } = await activeCard();
    await adminPool.query("ALTER TABLE card_authorizations ADD CONSTRAINT zz_wpf1_fail CHECK (merchant_name IS DISTINCT FROM 'FEIL-INJISERT')");
    const raw = ev("authorization", { id: `wauth-${randomUUID()}`, card_id: provider_card_id, status: "approved", amount: 4_000, currency: "EUR", merchant_name: "FEIL-INJISERT" });
    try {
      const first = await cards.ingestWallesterWebhookEvent(raw, walAuth);
      expect(first.status).toBe("failed_retryable");
      const stored = (await row("SELECT status, error_message FROM wallester_webhook_events WHERE dedupe_key = $1", [first.eventId]))!;
      expect(stored["status"]).toBe("failed_retryable"); // dødbrevet SKREV seg (SAVEPOINT) - tidligere ble hele transaksjonen avbrutt
      expect(String(stored["error_message"])).toMatch(/zz_wpf1_fail/);
      expect(await cards.listAuthorizations(TENANT, "business", { card_id })).toHaveLength(0);
    } finally {
      await adminPool.query("ALTER TABLE card_authorizations DROP CONSTRAINT zz_wpf1_fail");
    }
    // leverandørens retry (samme hendelse) er IKKE «duplicate»: failed_retryable behandles på nytt
    const retry = await cards.ingestWallesterWebhookEvent(raw, walAuth);
    expect(retry.status).toBe("processed");
    expect(await cards.listAuthorizations(TENANT, "business", { card_id })).toHaveLength(1);
    expect((await cards.ingestWallesterWebhookEvent(raw, walAuth)).status).toBe("duplicate"); // nå ferdig
  });
});

describe("E: leverandørlesinger (Wallester-transport) er like strenge som webhook - ugyldig svar kaster synlig, aldri et gjettet tall", () => {
  afterEach(() => vi.unstubAllGlobals());
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const transport = () => new WallesterTransport("https://wallester.test", "api-key-fixture", createRsaJwtSigner(privateKey), "acc-1");
  const stubJson = (body: unknown) => vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response);

  it("gyldige beløp/valuta passerer; manglende, negative, brøk og tekst kaster WallesterPayloadError; valuta har ingen stille standard", async () => {
    stubJson({ authorizations: [{ id: "a1", card_id: "c1", status: "approved", amount: 7500, currency: "eur" }] });
    expect((await transport().listAuthorizations("c1", null)).items[0]).toMatchObject({ amountOre: 7500, currency: "EUR" });
    for (const [amount, reason] of [[undefined, "amount_missing"], [-5, "amount_negative"], [12.5, "amount_not_integer"], ["abc", "amount_not_digits"], [1e15, "amount_too_large"]] as const) {
      stubJson({ authorizations: [{ id: "a1", card_id: "c1", status: "approved", amount, currency: "EUR" }] });
      await expect(transport().listAuthorizations("c1", null), String(amount)).rejects.toThrow(`wallester_payload_invalid:authorization:${reason}`);
    }
    stubJson({ authorizations: [{ id: "a1", card_id: "c1", status: "approved", amount: 1 }] });
    await expect(transport().listAuthorizations("c1", null)).rejects.toBeInstanceOf(WallesterPayloadError);
    stubJson({ transactions: [{ id: "t1", card_id: "c1", type: "purchase", amount: null, currency: "EUR" }] });
    await expect(transport().listTransactions("c1", null)).rejects.toThrow("wallester_payload_invalid:transaction:amount_missing");
    stubJson({ available_amount: "tolv", currency: "EUR" });
    await expect(transport().getAccountBalance()).rejects.toThrow("wallester_payload_invalid:balance:amount_not_digits");
    stubJson({ available_amount: 125_000, currency: "eur" });
    expect(await transport().getAccountBalance()).toMatchObject({ availableAmountOre: 125_000, currency: "EUR" });
  });
});
