import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  FinanceService, IdempotencyKeyConflictError, PaymentIntentNotFoundError, PaymentIntentNotVippsError, ProviderOutcomeUnknownError, StripeTransport, VippsCredentialsUnavailableError, VippsTransport,
  type PaymentIntent, type StripeCredentials, type VippsCredentials
} from "../src/index.ts";
import { Gate, StripeFake, VippsFake } from "./wpf1-fakes.ts";

/**
 * WP-FIN2 fiks-runde 1, mot ekte embedded Postgres (app-rolle, RLS):
 *   FIX-2  Vipps/Stripe-svar gjennom de EKTE transportene: minimal 2xx-kropp gir `applied`/`settled`-flyt (ikke `outcome_unknown`); ekte feil gir fortsatt `outcome_unknown`.
 *   FIX-4  `cancelVippsPayment` slår kun opp credentials når intensjonen finnes hos Vipps og ikke er terminal (rent lokale baner er uavhengige av credential-leverandøren).
 *   FIX-7  konflikthendelsen skrives også når flagget `PROVIDER_STATE_CONFLICT` står fra en annen årsak.
 *   FIX-9  capture-reservasjonen tar intensjonen i `FOR SHARE` (lås-rekkefølge intensjon -> capture): aldri `cancelled` med oppgjort capture under samtidighet, ingen deadlock.
 *   FIX-10 testhull: Vipps-refusjonens nøkkel avgjøres FØR tilstand; `apply` tar intensjonslåsen FØRST; kjøretidsprobe (ingen tx/radlås under credential-oppslag og leverandørkall) for Vipps-cancel/capture/refund og Stripe-refusjon.
 * Ingen nettverk: `fetch` er stubbet, resten er testdobler.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-fin2-fix1";
const APP_ROLE = "jarvis_fin2_fix1";
const WEBHOOK_SECRET = "vipps-webhook-secret-fixture-fix1";
const HOST = "jarvis.test";
const PATH = "/webhooks/vipps";
const vippsCreds: VippsCredentials = { clientId: "c", clientSecret: "s-fixture", subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" };
const stripeCreds: StripeCredentials = { secretKey: "sk-fixture-not-a-key" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-fix1-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${APP_ROLE}`);
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 fix1', 'business')`);
  appPool = createPool({ ...base, user: APP_ROLE, password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);
afterEach(() => vi.unstubAllGlobals());

// === hjelpere ==============================================================================================================================
const fakeService = (vipps: VippsFake, creds: () => Promise<VippsCredentials | null> = async () => vippsCreds, stripe?: StripeFake): FinanceService =>
  new FinanceService(
    appPool, undefined, { getCredentials: async () => stripeCreds }, () => stripe ?? new StripeFake(), undefined, undefined,
    { getCredentials: creds }, () => vipps, () => WEBHOOK_SECRET, () => TENANT
  );
/** Ekte transporter (Vipps og Stripe) mot en stubbet `fetch`. */
const realService = (): FinanceService =>
  new FinanceService(
    appPool, undefined, { getCredentials: async () => stripeCreds }, (c) => new StripeTransport(c.secretKey), undefined, undefined,
    { getCredentials: async () => vippsCreds }, (c) => new VippsTransport(c.clientId, c.clientSecret, c.subscriptionKey, c.merchantSerialNumber, c.environment), () => WEBHOOK_SECRET, () => TENANT
  );
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Token-endepunktet svarer gyldig; alt annet går til `handler(url, method)`. Returnerer URL-ene som ble kalt (uten token-kall). */
function stubProvider(handler: (url: string, method: string) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (/accesstoken\/get/.test(String(url))) return json({ access_token: "tok-fixture", expires_in: 3600 });
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return handler(String(url), init?.method ?? "GET");
  });
  return calls;
}

async function newIntent(svc: FinanceService, provider: "vipps" | "stripe", amountOre = 10_000): Promise<PaymentIntent> {
  return svc.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "FIN2 fix1", amount_ore: amountOre, vendor_name: `Kunde ${randomUUID().slice(0, 6)}`, account_code: "kategori", provider
  });
}
async function authorizedIntent(svc: FinanceService, amountOre = 10_000): Promise<PaymentIntent> {
  const intent = await newIntent(svc, "vipps", amountOre);
  await adminPool.query(
    "UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = $1, provider_status = 'AUTHORIZED', provider_status_updated_at = now() - interval '1 hour' WHERE payment_intent_id = $1",
    [intent.payment_intent_id]
  );
  return intent;
}
async function settledStripeIntent(svc: FinanceService): Promise<PaymentIntent> {
  const intent = await newIntent(svc, "stripe");
  await adminPool.query(
    "UPDATE payment_intents SET state = 'settled', provider_ref = $2, provider_status = 'succeeded', provider_status_updated_at = now() - interval '1 hour', settled_at = now() WHERE payment_intent_id = $1",
    [intent.payment_intent_id, `pi_${randomUUID().slice(0, 8)}`]
  );
  return intent;
}
const draftCapture = (svc: FinanceService, intentId: string, amountOre: number) => svc.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intentId, amount_ore: amountOre });
const intentRow = async (id: string) => (await adminPool.query(
  "SELECT state, provider_ref, provider_status, provider_reported_amount_ore, provider_reported_currency, provider_status_updated_at, anomaly_flags FROM payment_intents WHERE payment_intent_id = $1", [id]
)).rows[0] as { state: string; provider_ref: string | null; provider_status: string | null; provider_reported_amount_ore: string | null; provider_reported_currency: string | null; provider_status_updated_at: Date | null; anomaly_flags: string[] };
const captureRow = async (id: string) => (await adminPool.query("SELECT state, anomaly_flags FROM vipps_captures WHERE capture_id = $1", [id])).rows[0] as { state: string; anomaly_flags: string[] };
const eventTypes = async (id: string) => ((await adminPool.query("SELECT event_type FROM payment_intent_events WHERE payment_intent_id = $1 ORDER BY created_at", [id])).rows as Array<{ event_type: string }>).map((r) => r.event_type);
const conflictEvents = async (id: string) =>
  (await adminPool.query("SELECT metadata FROM payment_intent_events WHERE payment_intent_id = $1 AND event_type = 'anomaly_flagged' AND metadata->'anomaly_flags' ? 'PROVIDER_STATE_CONFLICT'", [id])).rows as Array<{ metadata: Record<string, unknown> }>;

function signedHeaders(raw: Buffer) {
  const date = new Date().toUTCString();
  const contentHash = createHash("sha256").update(raw).digest("base64");
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`POST\n${PATH}\n${date};${HOST};${contentHash}`, "utf8").digest("base64");
  return { host: HOST, xMsDate: date, xMsContentSha256: contentHash, authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}` };
}
async function webhook(svc: FinanceService, reference: string, name: string) {
  const raw = Buffer.from(JSON.stringify({ reference, name, amount: { currency: "NOK", value: 10_000 }, timestamp: new Date().toISOString(), idempotencyKey: `wh-${randomUUID()}` }));
  return svc.ingestVippsWebhookEvent(raw, "POST", PATH, signedHeaders(raw));
}

// === FIX-2: Vipps gjennom den EKTE transporten =============================================================================================
describe("FIX-2: Vipps createPayment med dokumentert svar {reference, redirectUrl}", () => {
  it("innsending lykkes: provider_acknowledged med provider_ref, men state/beløp/valuta/statustidspunkt = NULL; første oppfrisking og første webhook fyller dem (ingen stale-avvisning)", async () => {
    const svc = realService();
    const intent = await newIntent(svc, "vipps");
    const calls = stubProvider((url, method) =>
      method === "POST" && url.endsWith("/epayment/v1/payments")
        ? json({ reference: intent.payment_intent_id, redirectUrl: "https://example.invalid/r" }, 201)
        : json({ reference: intent.payment_intent_id, state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } }));

    const submitted = await svc.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, { getCredentials: async () => null });
    expect(submitted.state).toBe("provider_acknowledged");
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
    const afterSubmit = await intentRow(intent.payment_intent_id);
    expect(afterSubmit).toMatchObject({ state: "provider_acknowledged", provider_ref: intent.payment_intent_id, provider_status: null, provider_reported_amount_ore: null, provider_reported_currency: null, provider_status_updated_at: null });
    expect(afterSubmit.anomaly_flags).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(await eventTypes(intent.payment_intent_id)).toEqual(expect.arrayContaining(["submitted", "provider_acknowledged"]));

    // første webhook (før noen oppfrisking) avvises IKKE som stale og fyller status
    expect((await webhook(svc, intent.payment_intent_id, "AUTHORIZED")).status).toBe("processed");
    expect((await intentRow(intent.payment_intent_id)).provider_status).toBe("AUTHORIZED");
    // oppfrisking fyller beløp og valuta (fra den strenge getPayment-lesingen)
    await svc.refreshVippsPaymentState(TENANT, "business", intent.payment_intent_id);
    expect(await intentRow(intent.payment_intent_id)).toMatchObject({ provider_status: "AUTHORIZED", provider_reported_amount_ore: "10000", provider_reported_currency: "NOK" });
  });

  it("første oppfrisking alene fyller state og beløp når intet annet har kommet", async () => {
    const svc = realService();
    const intent = await newIntent(svc, "vipps");
    stubProvider((url, method) =>
      method === "POST" ? json({ reference: intent.payment_intent_id }, 201) : json({ reference: intent.payment_intent_id, state: "CREATED", amount: { currency: "NOK", value: 10_000 } }));
    await svc.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, { getCredentials: async () => null });
    expect((await intentRow(intent.payment_intent_id)).provider_status).toBeNull();
    await svc.refreshVippsPaymentState(TENANT, "business", intent.payment_intent_id);
    expect(await intentRow(intent.payment_intent_id)).toMatchObject({ provider_status: "CREATED", provider_reported_amount_ore: "10000" });
  });

  it("feil reference i svaret -> ukjent utfall (draft + flagg, ingen provider_ref); ikke-JSON 2xx likeså", async () => {
    const svc = realService();
    for (const [response, code] of [[() => json({ reference: "fin-pi-ANNEN" }, 201), "reference_mismatch"], [() => new Response("<html>ok</html>", { status: 200 }), "body_not_json"]] as const) {
      const intent = await newIntent(svc, "vipps");
      stubProvider(() => response());
      const err = await svc.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, { getCredentials: async () => null }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
      expect((err as Error).message).toBe(`outcome_unknown:provider_response_invalid:${code}`);
      const row = await intentRow(intent.payment_intent_id);
      expect(row.state).toBe("draft");
      expect(row.provider_ref).toBeNull();
      expect(row.anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
    }
  });
});

describe("FIX-2: Vipps capture/cancel/refund med minimal 2xx-kropp gir `applied`/`settled`-flyt", () => {
  for (const [label, body] of [["tomt objekt {}", {}], ["kun reference", null], ["annen kropp (aggregate)", { aggregate: { capturedAmount: { currency: "NOK", value: 10_000 } }, pspReference: "p" }]] as const) {
    it(`capture: 2xx med ${label} -> capturen er settled, captured-hendelse, intensjonen fullt oppgjort`, async () => {
      const svc = realService();
      const intent = await authorizedIntent(svc, 10_000);
      const capture = await draftCapture(svc, intent.payment_intent_id, 10_000);
      const calls = stubProvider(() => json(body === null ? { reference: intent.payment_intent_id } : body));
      const settled = await svc.submitVippsCapture(TENANT, "business", capture.capture_id);
      expect(settled.state).toBe("settled");
      expect(calls.filter((c) => c.endsWith("/capture"))).toHaveLength(1);
      expect((await captureRow(capture.capture_id)).anomaly_flags).toEqual([]);
      expect((await intentRow(intent.payment_intent_id)).state).toBe("settled");
      expect(await eventTypes(intent.payment_intent_id)).toEqual(expect.arrayContaining(["captured", "settled"]));
    });
  }

  it("delvis capture med minimal kropp: capturen settled, intensjonen forblir provider_acknowledged (ikke outcome_unknown)", async () => {
    const svc = realService();
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 4_000);
    stubProvider(() => json({}));
    expect((await svc.submitVippsCapture(TENANT, "business", capture.capture_id)).state).toBe("settled");
    expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged");
  });

  it("cancel: 2xx med {} -> intensjonen er cancelled", async () => {
    const svc = realService();
    const intent = await authorizedIntent(svc, 10_000);
    const calls = stubProvider(() => json({}));
    expect((await svc.cancelVippsPayment(TENANT, "business", intent.payment_intent_id)).state).toBe("cancelled");
    expect(calls.filter((c) => c.endsWith("/cancel"))).toHaveLength(1);
  });

  it("refusjon: 2xx med {} -> refusjonen er settled; retry gir ikke et nytt kall", async () => {
    const svc = realService();
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 10_000);
    stubProvider(() => json({}));
    await svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    const refund = await svc.createVippsRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 2_500 });
    const calls = stubProvider(() => json({}));
    expect((await svc.submitVippsRefund(TENANT, "business", refund.refund_id)).state).toBe("settled");
    expect((await svc.submitVippsRefund(TENANT, "business", refund.refund_id)).state).toBe("settled");
    expect(calls.filter((c) => c.endsWith("/refund"))).toHaveLength(1);
  });

  it("ekte feil gir fortsatt ukjent utfall: feil reference / ikke-JSON / liste -> capture flagget SUBMIT_OUTCOME_UNKNOWN, intensjonen urørt; retry gir samme (ikke et stille avvik)", async () => {
    const svc = realService();
    for (const [response, code] of [
      [() => json({ reference: "fin-pi-ANNEN" }), "reference_mismatch"], [() => new Response("<html>ok</html>", { status: 200 }), "body_not_json"], [() => json([]), "body_wrong_type"]
    ] as const) {
      const intent = await authorizedIntent(svc, 10_000);
      const capture = await draftCapture(svc, intent.payment_intent_id, 10_000);
      stubProvider(() => response());
      const err = await svc.submitVippsCapture(TENANT, "business", capture.capture_id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
      expect((err as Error).message).toBe(`outcome_unknown:provider_response_invalid:${code}`);
      expect((await captureRow(capture.capture_id)).anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
      expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged");
    }
  });
});

describe("FIX-2: Stripe-refusjon med minimal 2xx-kropp", () => {
  it("kropp {id, amount, currency} uten object/status/payment_intent -> provider_acknowledged med provider_ref; en senere oppfrisking med status succeeded avgjør til settled", async () => {
    const svc = realService();
    const intent = await settledStripeIntent(svc);
    const refund = await svc.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 2_500 });
    stubProvider(() => json({ id: "re_min1", amount: 2_500, currency: "nok" }));
    const acknowledged = await svc.submitStripeRefund(TENANT, "business", refund.refund_id);
    expect(acknowledged.state).toBe("provider_acknowledged");
    expect(acknowledged.provider_ref).toBe("re_min1");
    expect(acknowledged.anomaly_flags).not.toContain("REFUND_AMOUNT_CONFLICT");
    stubProvider(() => json({ id: "re_min1", object: "refund", amount: 2_500, currency: "nok", status: "succeeded", payment_intent: null }));
    expect((await svc.refreshStripeRefundState(TENANT, "business", refund.refund_id)).state).toBe("settled");
  });

  it("status: null og payment_intent: null -> provider_acknowledged (fallback), ikke ukjent utfall", async () => {
    const svc = realService();
    const intent = await settledStripeIntent(svc);
    const refund = await svc.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_000 });
    stubProvider(() => json({ id: "re_min2", object: "refund", amount: 1_000, currency: "nok", status: null, payment_intent: null, reason: null }));
    expect((await svc.submitStripeRefund(TENANT, "business", refund.refund_id)).state).toBe("provider_acknowledged");
  });

  it("ekte feil: id mangler / feil objekttype -> ukjent utfall", async () => {
    const svc = realService();
    for (const [body, code] of [[{ amount: 1_000, currency: "nok" }, "id_missing"], [{ id: "re_x", object: "charge", amount: 1_000, currency: "nok" }, "object_mismatch"]] as const) {
      const intent = await settledStripeIntent(svc);
      const refund = await svc.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_000 });
      stubProvider(() => json(body));
      const err = await svc.submitStripeRefund(TENANT, "business", refund.refund_id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
      expect((err as Error).message).toBe(`outcome_unknown:provider_response_invalid:${code}`);
    }
  });
});

// === FIX-4 =================================================================================================================================
describe("FIX-4: cancelVippsPayment slår kun opp credentials når intensjonen finnes hos Vipps og ikke er terminal", () => {
  const down = (): Promise<VippsCredentials | null> => Promise.reject(new Error("infisical_down"));
  for (const [label, creds] of [["credential-leverandøren kaster", down], ["credential mangler (null)", async () => null]] as const) {
    it(`aldri innsendt intensjon avbrytes lokalt uten credentials (${label}); credential-leverandøren kalles ikke`, async () => {
      let lookups = 0;
      const svc = fakeService(new VippsFake(), () => { lookups += 1; return creds(); });
      const intent = await newIntent(svc, "vipps");
      const out = await svc.cancelVippsPayment(TENANT, "business", intent.payment_intent_id);
      expect(out.state).toBe("cancelled");
      expect(lookups).toBe(0);
      expect(await eventTypes(intent.payment_intent_id)).toContain("cancelled");
    });
    it(`allerede terminal intensjon er en idempotent no-op uten credentials og uten leverandørkall (${label})`, async () => {
      let lookups = 0;
      const vipps = new VippsFake();
      const svc = fakeService(vipps, () => { lookups += 1; return creds(); });
      const intent = await newIntent(svc, "vipps");
      await adminPool.query("UPDATE payment_intents SET state = 'cancelled', provider_ref = $1 WHERE payment_intent_id = $1", [intent.payment_intent_id]);
      expect((await svc.cancelVippsPayment(TENANT, "business", intent.payment_intent_id)).state).toBe("cancelled");
      expect(lookups).toBe(0);
      expect(vipps.cancelCalls).toHaveLength(0);
    });
  }

  it("innsendt, ikke-terminal intensjon: credentials slås opp ÉN gang; en feil fra leverandøren er fortsatt fail-lukket (ingen leverandørkall); null = VippsCredentialsUnavailableError", async () => {
    let lookups = 0;
    const vipps = new VippsFake();
    const svcDown = fakeService(vipps, () => { lookups += 1; return down(); });
    const intent = await authorizedIntent(svcDown);
    await expect(svcDown.cancelVippsPayment(TENANT, "business", intent.payment_intent_id)).rejects.toThrow("infisical_down");
    expect(lookups).toBe(1);
    expect(vipps.cancelCalls).toHaveLength(0);
    expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged");
    const svcNull = fakeService(vipps, async () => null);
    await expect(svcNull.cancelVippsPayment(TENANT, "business", intent.payment_intent_id)).rejects.toBeInstanceOf(VippsCredentialsUnavailableError);
    const svcOk = fakeService(vipps);
    expect((await svcOk.cancelVippsPayment(TENANT, "business", intent.payment_intent_id)).state).toBe("cancelled");
    expect(vipps.cancelCalls).toHaveLength(1);
  });

  it("intensjon som ikke finnes eller ikke er Vipps gir de samme typede feilene som før (uten å spørre credential-leverandøren)", async () => {
    let lookups = 0;
    const svc = fakeService(new VippsFake(), () => { lookups += 1; return Promise.resolve(vippsCreds); });
    await expect(svc.cancelVippsPayment(TENANT, "business", "fin-pi-finnes-ikke")).rejects.toBeInstanceOf(PaymentIntentNotFoundError);
    const stripeIntent = await newIntent(svc, "stripe");
    await expect(svc.cancelVippsPayment(TENANT, "business", stripeIntent.payment_intent_id)).rejects.toBeInstanceOf(PaymentIntentNotVippsError);
    expect(lookups).toBe(0);
  });
});

// === FIX-7 =================================================================================================================================
describe("FIX-7: konflikthendelsen skrives også når PROVIDER_STATE_CONFLICT alt står fra en annen årsak", () => {
  it("flagget settes først av en annen årsak -> webhook TERMINATED etter delvis capture skriver likevel anomaly_flagged med captures-metadata; gjentakelse skriver ikke en til", async () => {
    const vipps = new VippsFake();
    const svc = fakeService(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 2_500);
    await svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    await adminPool.query(`UPDATE payment_intents SET anomaly_flags = '["PROVIDER_STATE_CONFLICT"]'::jsonb WHERE payment_intent_id = $1`, [intent.payment_intent_id]);
    expect(await conflictEvents(intent.payment_intent_id)).toHaveLength(0);

    expect((await webhook(svc, intent.payment_intent_id, "TERMINATED")).status).toBe("processed");
    const events = await conflictEvents(intent.payment_intent_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ reason: "provider_reported_TERMINATED", captures: "settled_captures" });
    expect(JSON.stringify(events[0])).not.toMatch(/2500|10000/); // kun kode, aldri beløp

    await webhook(svc, intent.payment_intent_id, "TERMINATED");
    vipps.paymentState = { state: "TERMINATED" };
    await svc.refreshVippsPaymentState(TENANT, "business", intent.payment_intent_id);
    expect(await conflictEvents(intent.payment_intent_id)).toHaveLength(1); // samme årsak = én hendelse
    expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged"); // aldri cancelled
  });
});

// === FIX-9 =================================================================================================================================
describe("FIX-9: capture-reservasjonen tar intensjonen i FOR SHARE (lås-rekkefølge intensjon -> capture)", () => {
  it("mens intensjonen er låst FOR UPDATE av en annen transaksjon venter reservasjonen: ingen leverandørkall og capture-raden er IKKE låst; ved frigivelse fullføres capturen", async () => {
    const vipps = new VippsFake();
    const svc = fakeService(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 4_000);
    const holder = await adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM payment_intents WHERE payment_intent_id = $1 FOR UPDATE", [intent.payment_intent_id]);
      const pending = svc.submitVippsCapture(TENANT, "business", capture.capture_id);
      await sleep(400);
      expect(vipps.captureCalls).toHaveLength(0); // reservasjonen venter på intensjonslåsen (uten FOR SHARE ville den gått rett til leverandøren)
      await adminPool.query("SELECT 1 FROM vipps_captures WHERE capture_id = $1 FOR UPDATE NOWAIT", [capture.capture_id]); // kaster 55P03 hvis prepare alt har låst capture-raden (feil rekkefølge)
      expect((await captureRow(capture.capture_id)).state).toBe("draft");
      await holder.query("COMMIT");
      expect((await pending).state).toBe("settled");
      expect(vipps.captureCalls).toHaveLength(1);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("flere samtidige reservasjoner av ULIKE captures på samme intensjon blokkerer ikke hverandre (FOR SHARE er delt) og gir ingen deadlock", async () => {
    const vipps = new VippsFake();
    const svc = fakeService(vipps);
    for (let round = 0; round < 8; round++) {
      const intent = await authorizedIntent(svc, 10_000);
      const captures = await Promise.all([1_000, 2_000, 3_000].map((amount) => draftCapture(svc, intent.payment_intent_id, amount)));
      const results = await Promise.allSettled(captures.map((c) => svc.submitVippsCapture(TENANT, "business", c.capture_id)));
      for (const r of results) expect(r.status, JSON.stringify(r)).toBe("fulfilled");
      expect((await intentRow(intent.payment_intent_id)).state).toBe("provider_acknowledged"); // 6 000 av 10 000
    }
  });

  it("samtidig cancel og capture, 60 runder: aldri `cancelled` med oppgjort capture, aldri deadlock (leverandør som godtar capture etter cancel = verste tilfelle)", async () => {
    const vipps = new VippsFake();
    const svc = fakeService(vipps);
    let cancelled = 0;
    let captured = 0;
    const violations: string[] = [];
    for (let round = 0; round < 60; round++) {
      const intent = await authorizedIntent(svc, 10_000);
      const capture = await draftCapture(svc, intent.payment_intent_id, 10_000);
      const [cancelResult, captureResult] = await Promise.allSettled([
        svc.cancelVippsPayment(TENANT, "business", intent.payment_intent_id),
        svc.submitVippsCapture(TENANT, "business", capture.capture_id)
      ]);
      for (const r of [cancelResult, captureResult]) if (r.status === "rejected") expect(String((r.reason as Error).message), `runde ${round}`).not.toMatch(/deadlock/i);
      const row = await intentRow(intent.payment_intent_id);
      const cap = await captureRow(capture.capture_id);
      if (row.state === "cancelled") cancelled += 1;
      if (cap.state === "settled") captured += 1;
      if (row.state === "cancelled" && cap.state !== "draft" && cap.state !== "failed" && cap.state !== "cancelled") violations.push(`runde ${round}: intent=${row.state} capture=${cap.state} flags=${row.anomaly_flags.join(",")}`);
    }
    expect(violations).toEqual([]);
    expect(cancelled + captured).toBeGreaterThan(0); // proben ser faktisk begge utfallene (ikke en tom kjøring)
  }, 120_000);
});

// === FIX-10: testhull (M19, M01) ===========================================================================================================
describe("FIX-10 / M19: createVippsRefund avgjør nøkkelen FØR tilstanden (som Stripe-refusjonen)", () => {
  it("identisk replay på en intensjon som ikke lenger er settled returnerer raden; samme nøkkel med en ANNEN intensjon i ikke-oppgjort tilstand = IdempotencyKeyConflictError", async () => {
    const svc = fakeService(new VippsFake());
    const mk = async (state: string): Promise<PaymentIntent> => {
      const intent = await newIntent(svc, "vipps");
      await adminPool.query("UPDATE payment_intents SET state = $2, provider_ref = $1, provider_status = 'AUTHORIZED' WHERE payment_intent_id = $1", [intent.payment_intent_id, state]);
      return intent;
    };
    const settled = await mk("settled");
    const notSettled = await mk("provider_acknowledged");
    const key = `k-${randomUUID()}`;
    const first = await svc.createVippsRefund(TENANT, "business", { idempotency_key: key, payment_intent_id: settled.payment_intent_id, amount_ore: 500 });
    await adminPool.query("UPDATE payment_intents SET state = 'failed' WHERE payment_intent_id = $1", [settled.payment_intent_id]);
    const replay = await svc.createVippsRefund(TENANT, "business", { idempotency_key: key, payment_intent_id: settled.payment_intent_id, amount_ore: 500 });
    expect(replay.refund_id).toBe(first.refund_id);
    const conflict = await svc.createVippsRefund(TENANT, "business", { idempotency_key: key, payment_intent_id: notSettled.payment_intent_id, amount_ore: 500 }).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(IdempotencyKeyConflictError);
  });
});

describe("FIX-10 / M01: submitVippsCapture.apply tar intensjonslåsen FØRST (før capture-låsen)", () => {
  it("mens leverandørkallet pågår (porten holder det) og en annen transaksjon tar intensjonslåsen, venter apply UTEN å ha låst capture-raden", async () => {
    const vipps = new VippsFake();
    vipps.gate = new Gate();
    const svc = fakeService(vipps);
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 4_000);
    const pending = svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    const t0 = Date.now();
    while (vipps.captureCalls.length < 1) {
      if (Date.now() - t0 > 8_000) throw new Error("no_provider_call");
      await sleep(10);
    }
    const holder = await adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM payment_intents WHERE payment_intent_id = $1 FOR UPDATE", [intent.payment_intent_id]);
      vipps.gate.open(); // leverandørkallet er ferdig; apply starter og må vente på intensjonslåsen
      await sleep(400);
      await adminPool.query("SELECT 1 FROM vipps_captures WHERE capture_id = $1 FOR UPDATE NOWAIT", [capture.capture_id]); // kaster 55P03 hvis apply tok capture-låsen først
      await holder.query("COMMIT");
      expect((await pending).state).toBe("settled");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });
});

// === FIX-10: kjøretidsprobe utvidet til FinanceService (Vipps-cancel/capture/refund, Stripe-refusjon) ==================================================
describe("FIX-10 / kjøretidsprobe: credential-oppslag og leverandørkall holder verken transaksjon eller radlås (FinanceService)", () => {
  interface Probe { idleInTransaction: number; rowLockFree: boolean }
  const observed: Array<{ op: string; probe: Probe }> = [];
  /** Raden som alltid låses i proben (intensjonen) + valgfri barn-rad (capture/refusjon) i `childTable`. */
  let childTable: "vipps_captures" | "vipps_refunds" | "stripe_refunds" | null = null;
  let childColumn = "";
  let lockedId = "";
  let childId = "";
  async function probe(): Promise<Probe> {
    const idle = (await adminPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = $1 AND state LIKE 'idle in transaction%'", [APP_ROLE])).rows[0] as { n: number };
    const client = await adminPool.connect();
    let rowLockFree = true;
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM payment_intents WHERE payment_intent_id = $1 FOR UPDATE NOWAIT", [lockedId]);
      if (childTable !== null) await client.query(`SELECT 1 FROM ${childTable} WHERE ${childColumn} = $1 FOR UPDATE NOWAIT`, [childId]);
    } catch {
      rowLockFree = false;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    return { idleInTransaction: idle.n, rowLockFree };
  }
  const record = async (op: string): Promise<void> => { observed.push({ op, probe: await probe() }); };
  const CLEAN: Probe = { idleInTransaction: 0, rowLockFree: true };

  class ProbingVipps extends VippsFake {
    override async capturePayment(input: Parameters<VippsFake["capturePayment"]>[0]) { await record("vipps.capturePayment"); return super.capturePayment(input); }
    override async cancelPayment(reference: string, key?: string) { await record("vipps.cancelPayment"); return super.cancelPayment(reference, key); }
    override async refundPayment(input: Parameters<VippsFake["refundPayment"]>[0]) { await record("vipps.refundPayment"); return super.refundPayment(input); }
  }
  class ProbingStripe extends StripeFake {
    override async createRefund(input: Parameters<StripeFake["createRefund"]>[0]) { await record("stripe.createRefund"); return super.createRefund(input); }
  }

  it("negativ kontroll: proben SER en holdt radlås og en åpen app-transaksjon", async () => {
    const svc = fakeService(new VippsFake());
    const intent = await newIntent(svc, "vipps");
    childTable = null; lockedId = intent.payment_intent_id;
    const holder = await adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM payment_intents WHERE payment_intent_id = $1 FOR UPDATE", [intent.payment_intent_id]);
      expect((await probe()).rowLockFree).toBe(false);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const appTx = await appPool.connect();
    try {
      await appTx.query("BEGIN");
      await appTx.query("SELECT 1");
      expect((await probe()).idleInTransaction).toBeGreaterThanOrEqual(1);
    } finally {
      await appTx.query("ROLLBACK");
      appTx.release();
    }
    expect(await probe()).toEqual(CLEAN);
  });

  it("Vipps cancelVippsPayment, submitVippsCapture og submitVippsRefund + Stripe submitStripeRefund: credential-oppslaget OG leverandørkallet står uten åpen tx og uten radlås", async () => {
    const vipps = new ProbingVipps();
    const stripe = new ProbingStripe();
    const svc = new FinanceService(
      appPool, undefined,
      { getCredentials: async () => { await record("stripe.getCredentials"); return stripeCreds; } }, () => stripe, undefined, undefined,
      { getCredentials: async () => { await record("vipps.getCredentials"); return vippsCreds; } }, () => vipps, () => WEBHOOK_SECRET, () => TENANT
    );
    // Vipps cancel
    const cancelIntent = await authorizedIntent(svc, 10_000);
    childTable = null; lockedId = cancelIntent.payment_intent_id;
    await svc.cancelVippsPayment(TENANT, "business", cancelIntent.payment_intent_id);
    // Vipps capture + refund (full capture -> settled -> refusjon)
    const intent = await authorizedIntent(svc, 10_000);
    const capture = await draftCapture(svc, intent.payment_intent_id, 10_000);
    childTable = "vipps_captures"; childColumn = "capture_id"; lockedId = intent.payment_intent_id; childId = capture.capture_id;
    await svc.submitVippsCapture(TENANT, "business", capture.capture_id);
    const vRefund = await svc.createVippsRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_000 });
    childTable = "vipps_refunds"; childColumn = "refund_id"; childId = vRefund.refund_id;
    await svc.submitVippsRefund(TENANT, "business", vRefund.refund_id);
    // Stripe refusjon
    const sIntent = await settledStripeIntent(svc);
    const sRefund = await svc.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: sIntent.payment_intent_id, amount_ore: 1_000 });
    childTable = "stripe_refunds"; childColumn = "refund_id"; lockedId = sIntent.payment_intent_id; childId = sRefund.refund_id;
    await svc.submitStripeRefund(TENANT, "business", sRefund.refund_id);

    const ops = observed.map((o) => o.op);
    for (const op of ["vipps.getCredentials", "vipps.cancelPayment", "vipps.capturePayment", "vipps.refundPayment", "stripe.getCredentials", "stripe.createRefund"]) expect(ops, op).toContain(op);
    expect(ops.filter((o) => o === "vipps.getCredentials").length).toBeGreaterThanOrEqual(3); // cancel, capture, refund
    for (const o of observed) expect(o.probe, o.op).toEqual(CLEAN);
  });
});
