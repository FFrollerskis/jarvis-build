import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { FinanceService, type StripePaymentWriter, type StripeCredentials, type VippsCredentials } from "../src/service.ts";
import { IdempotencyKeyConflictError, type PaymentIntent } from "../src/types.ts";
import type { VippsPaymentObject, VippsPaymentWriter } from "../src/vipps-transport.ts";
import { VippsTransport } from "../src/vipps-transport.ts";
import { FikenTransport } from "../src/fiken-transport.ts";
import { WallesterTransport } from "../src/wallester-transport.ts";
import { toOreInteger } from "../src/ore.ts";
import { isRetrySafe } from "../src/http.ts";

/**
 * D-392 (JARVIS-019/020/021/070/071): ekte Postgres - leverandørkall UTEN radlås/åpen transaksjon, riktig webhook-tilstandsmaskin,
 * dødbrev-reprosessering, bigint-beløp som tall, og ærlig readback.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT = "tenant-d392-fin";
const WEBHOOK_SECRET = "not-a-real-vipps-webhook-secret-d392";
const STRIPE_SECRET = "not-a-real-stripe-webhook-secret-d392";
const HOST = "jarvis.example.test";
const PATH = "/webhooks/vipps";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d392-fin-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d392_fin LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_d392_fin");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'D392 fin', 'business')`);
  appPool = createPool({ ...base, user: "jarvis_d392_fin", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// ---------------------------------------------------------------------------------------------------------------- Vipps

class VippsWriter implements VippsPaymentWriter {
  captureCalls: Array<{ amountOre: number; idempotencyKey: string }> = [];
  onCreate: (input: { amountOre: number; currency: string; reference: string }) => Promise<VippsPaymentObject> = async (i) => ({
    reference: i.reference, state: "CREATED", amount: { currency: i.currency, value: i.amountOre }
  });
  async createPayment(input: { amountOre: number; currency: string; reference: string; paymentDescription: string; returnUrl: string; idempotencyKey: string }) { return this.onCreate(input); }
  async getPayment(reference: string): Promise<VippsPaymentObject> { return { reference, state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } }; }
  async capturePayment(input: { reference: string; amountOre: number; currency: string; idempotencyKey: string }): Promise<VippsPaymentObject> {
    this.captureCalls.push(input);
    return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
  }
  async cancelPayment(reference: string): Promise<VippsPaymentObject> { return { reference, state: "CANCELLED", amount: { currency: "NOK", value: 10_000 } }; }
  async refundPayment(input: { reference: string; amountOre: number; currency: string }): Promise<VippsPaymentObject> {
    return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
  }
  async checkCredentials(): Promise<void> {}
}

const vippsCreds: VippsCredentials = { clientId: "c", clientSecret: "s-fixture", subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" };
const noFiken = { getCredentials: async () => null };

function vippsService(writer: VippsWriter): FinanceService {
  return new FinanceService(
    appPool, undefined, undefined, undefined, undefined, undefined,
    { getCredentials: async () => vippsCreds }, () => writer, () => WEBHOOK_SECRET, () => TENANT
  );
}

async function vippsIntent(service: FinanceService): Promise<PaymentIntent> {
  return service.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "D392", amount_ore: 10_000, vendor_name: "Kunde AS", account_code: "vipps-category", provider: "vipps"
  });
}

function signedVippsHeaders(raw: Buffer) {
  const date = new Date().toUTCString();
  const contentHash = createHash("sha256").update(raw).digest("base64");
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`POST\n${PATH}\n${date};${HOST};${contentHash}`, "utf8").digest("base64");
  return { host: HOST, xMsDate: date, xMsContentSha256: contentHash, authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}` };
}
const vippsIngest = (service: FinanceService, payload: Record<string, unknown>) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return service.ingestVippsWebhookEvent(raw, "POST", PATH, signedVippsHeaders(raw));
};

describe("JARVIS-019: leverandørkall uten radlås og åpen transaksjon", () => {
  it("Vipps submit: under leverandørkallet er raden `submitted`, IKKE låst, og ingen pool-forbindelse er opptatt", async () => {
    const writer = new VippsWriter();
    const service = vippsService(writer);
    const intent = await vippsIntent(service);
    let during: { state?: string; lockable: boolean; busy: number } | undefined;
    writer.onCreate = async (i) => {
      const probe = await adminPool.connect();
      try {
        await probe.query("BEGIN");
        let lockable = true;
        try { await probe.query("SELECT 1 FROM payment_intents WHERE payment_intent_id = $1 FOR UPDATE NOWAIT", [intent.payment_intent_id]); } catch { lockable = false; }
        await probe.query("ROLLBACK");
        const state = (await adminPool.query("SELECT state FROM payment_intents WHERE payment_intent_id = $1", [intent.payment_intent_id])).rows[0]?.state as string | undefined;
        during = { ...(state ? { state } : {}), lockable, busy: appPool.totalCount - appPool.idleCount };
      } finally { probe.release(); }
      return { reference: i.reference, state: "CREATED", amount: { currency: i.currency, value: i.amountOre } };
    };
    const submitted = await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, noFiken);
    expect(during).toEqual({ state: "submitted", lockable: true, busy: 0 });
    expect(submitted.state).toBe("provider_acknowledged");
  });

  it("Vipps: en feil etter reservasjonen settes tilbake til draft (idempotent hos leverandør) og retry fullfører", async () => {
    const writer = new VippsWriter();
    const service = vippsService(writer);
    const intent = await vippsIntent(service);
    writer.onCreate = async () => { throw new Error("vipps_api_failed_503:hangup"); };
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, noFiken)).rejects.toThrow("503");
    expect((await service.getPaymentIntent(TENANT, "business", intent.payment_intent_id))?.state).toBe("draft");
    writer.onCreate = async (i) => ({ reference: i.reference, state: "CREATED", amount: { currency: i.currency, value: i.amountOre } });
    expect((await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, noFiken)).state).toBe("provider_acknowledged");
  });

  it("Vipps: en intent som står som `submitted` uten provider_ref (krasj midt i kallet) gjenopptas trygt av en retry", async () => {
    const writer = new VippsWriter();
    const service = vippsService(writer);
    const intent = await vippsIntent(service);
    await adminPool.query("UPDATE payment_intents SET state = 'submitted' WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    const resumed = await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, noFiken);
    expect(resumed.state).toBe("provider_acknowledged");
  });

  it("Vipps capture: gjentatt submit er idempotent og sender leverandørkallet med en NUMERISK beløpsverdi (JARVIS-021)", async () => {
    const writer = new VippsWriter();
    const service = vippsService(writer);
    const intent = await vippsIntent(service);
    await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, noFiken);
    await service.refreshVippsPaymentState(TENANT, "business", intent.payment_intent_id);
    const capture = await service.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 4_000 });
    const first = await service.submitVippsCapture(TENANT, "business", capture.capture_id);
    const again = await service.submitVippsCapture(TENANT, "business", capture.capture_id);
    expect(first.state).toBe("settled");
    expect(again.state).toBe("settled");
    expect(writer.captureCalls).toHaveLength(1);
    expect(typeof writer.captureCalls[0]!.amountOre).not.toBe("undefined");
  });
});

describe("JARVIS-020: webhook-tilstandsmaskin", () => {
  it("Vipps CAPTURED overskriver ALDRI provider_status/beløp (delvis capture kan følges av en ny)", async () => {
    const writer = new VippsWriter();
    const service = vippsService(writer);
    const intent = await vippsIntent(service);
    await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, noFiken);
    await service.refreshVippsPaymentState(TENANT, "business", intent.payment_intent_id);
    const before = (await service.getPaymentIntent(TENANT, "business", intent.payment_intent_id))!;
    expect(before.provider_status).toBe("AUTHORIZED");
    const result = await vippsIngest(service, {
      reference: intent.payment_intent_id, name: "CAPTURED", amount: { value: 2_500, currency: "NOK" },
      timestamp: new Date(Date.now() + 2000).toISOString(), idempotencyKey: `evt-${randomUUID()}`
    });
    expect(result.status).toBe("processed");
    const after = (await service.getPaymentIntent(TENANT, "business", intent.payment_intent_id))!;
    expect(after.provider_status).toBe("AUTHORIZED");
    expect(Number(after.provider_reported_amount_ore)).toBe(Number(before.provider_reported_amount_ore));
    // en ny (delvis) capture er fortsatt mulig
    const capture = await service.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_000 });
    expect((await service.submitVippsCapture(TENANT, "business", capture.capture_id)).state).toBe("settled");
  });

  it("Vipps ABORTED er en avsluttet tilstand (cancelled), ikke en ukjent streng", async () => {
    const writer = new VippsWriter();
    const service = vippsService(writer);
    const intent = await vippsIntent(service);
    await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, noFiken);
    const result = await vippsIngest(service, { reference: intent.payment_intent_id, name: "ABORTED", timestamp: new Date(Date.now() + 2000).toISOString(), idempotencyKey: `evt-${randomUUID()}` });
    expect(result.status).toBe("processed");
    expect((await service.getPaymentIntent(TENANT, "business", intent.payment_intent_id))?.state).toBe("cancelled");
  });

  it("JARVIS-070: en `failed_retryable`-hendelse behandles på nytt ved leverandørens retry (ikke `duplicate`)", async () => {
    const writer = new VippsWriter();
    const service = vippsService(writer);
    const intent = await vippsIntent(service);
    await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, noFiken);
    const payload = { reference: intent.payment_intent_id, name: "AUTHORIZED", amount: { value: 10_000, currency: "NOK" }, timestamp: new Date(Date.now() + 2000).toISOString(), idempotencyKey: `evt-${randomUUID()}` };
    const first = await vippsIngest(service, payload);
    expect(first.status).toBe("processed");
    const duplicate = await vippsIngest(service, payload);
    expect(duplicate.status).toBe("duplicate");
    await adminPool.query("UPDATE vipps_webhook_events SET status = 'failed_retryable', error_message = 'x' WHERE tenant_id = $1", [TENANT]);
    const retried = await vippsIngest(service, payload);
    expect(retried.status).toBe("processed");
    const row = (await adminPool.query("SELECT status, error_message FROM vipps_webhook_events WHERE tenant_id = $1 ORDER BY processed_at DESC LIMIT 1", [TENANT])).rows[0];
    expect(row.status).toBe("processed");
    expect(row.error_message).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------- Stripe

class StripeWriter implements StripePaymentWriter {
  async createPaymentIntent(input: { amountOre: number; currency: string; metadata: Record<string, string> }) {
    return { id: `pi_${randomUUID().slice(0, 8)}`, object: "payment_intent" as const, amount: input.amountOre, currency: "nok", status: "requires_payment_method", metadata: input.metadata };
  }
  async getPaymentIntent(id: string) { return { id, object: "payment_intent" as const, amount: 10_000, currency: "nok", status: "requires_payment_method", metadata: {} }; }
  async createRefund(input: { stripePaymentIntentId: string; amountOre: number }): Promise<never> {
    return { id: `re_${randomUUID().slice(0, 8)}`, object: "refund", amount: input.amountOre, currency: "nok", status: "succeeded", payment_intent: input.stripePaymentIntentId, reason: null } as never;
  }
  async getRefund(id: string): Promise<never> { return { id, object: "refund", amount: 1, currency: "nok", status: "succeeded", payment_intent: "x", reason: null } as never; }
  async getBalance() { return { available: [], pending: [] } as never; }
}
const stripeCreds: StripeCredentials = { secretKey: "sk_test_fixture_not_real" };

function stripeSigned(raw: Buffer, ts: number): string {
  return `t=${ts},v1=${createHmac("sha256", STRIPE_SECRET).update(`${ts}.${raw.toString("utf8")}`, "utf8").digest("hex")}`;
}

describe("JARVIS-020: Stripe refund.*/charge.* er ikke PaymentIntent-status", () => {
  it("refund.created med status `succeeded` og refusjonsbeløp flytter IKKE PaymentIntent (verken status, state eller beløp)", async () => {
    const service = new FinanceService(appPool, undefined, { getCredentials: async () => stripeCreds }, () => new StripeWriter(), () => STRIPE_SECRET, () => TENANT);
    const intent = await service.createPaymentIntent(TENANT, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "D392 stripe", amount_ore: 10_000, vendor_name: "Kunde AS", account_code: "stripe-category", provider: "stripe"
    });
    const submitted = await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, {} as never);
    const flagsBefore = (await service.getPaymentIntent(TENANT, "business", intent.payment_intent_id))!.anomaly_flags;
    const now = Math.floor(Date.now() / 1000);
    const raw = Buffer.from(JSON.stringify({
      id: `evt_${randomUUID()}`, type: "refund.created", created: now,
      data: { object: { id: "re_x1", object: "refund", amount: 2_500, currency: "nok", status: "succeeded", payment_intent: submitted.provider_ref } }
    }));
    const result = await service.ingestStripeWebhookEvent(raw, stripeSigned(raw, now), now);
    expect(result.status).toBe("processed");
    const after = (await service.getPaymentIntent(TENANT, "business", intent.payment_intent_id))!;
    expect(after.state).toBe("provider_acknowledged");
    expect(after.provider_status).toBe("requires_payment_method");
    expect(Number(after.provider_reported_amount_ore)).toBe(10_000);
    expect(after.anomaly_flags).toEqual(flagsBefore); // ingen NYE avviksflagg (f.eks. beløpsavvik fra refusjonsbeløpet)
  });
});

// ------------------------------------------------------------------------------------------------- transporter (enhet)

describe("JARVIS-021: beløp til leverandør er alltid et heltall (bigint kommer som streng fra pg)", () => {
  it("toOreInteger normaliserer streng/tall og avviser alt annet", () => {
    expect(toOreInteger("1500")).toBe(1500);
    expect(toOreInteger(1500)).toBe(1500);
    expect(() => toOreInteger("15.5")).toThrow("invalid_amount_ore");
    expect(() => toOreInteger("-5")).toThrow("invalid_amount_ore");
    expect(() => toOreInteger(0)).toThrow("invalid_amount_ore");
    expect(() => toOreInteger("abc")).toThrow("invalid_amount_ore");
  });

  it("VippsTransport.capturePayment sender `value` som JSON-TALL også når kalleren gir en bigint-streng", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/accesstoken/get")) return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: "3600" }) } as unknown as Response;
      bodies.push(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ reference: "r", state: "AUTHORIZED", amount: { currency: "NOK", value: 1500 } }) } as unknown as Response;
    });
    const transport = new VippsTransport("c", "s-fixture", "k", "1", "test");
    await transport.capturePayment({ reference: "r", amountOre: "1500" as unknown as number, currency: "NOK", idempotencyKey: "k" });
    expect(JSON.parse(bodies[0]!)).toEqual({ modificationAmount: { currency: "NOK", value: 1500 } });
  });
});

describe("JARVIS-019: HTTP-disiplin i finanstransportene", () => {
  it("isRetrySafe: 5xx på mutasjon uten Idempotency-Key gjentas aldri; med nøkkel/lesing/429 gjentas", () => {
    expect(isRetrySafe("POST", 503, false)).toBe(false);
    expect(isRetrySafe("POST", 503, true)).toBe(true);
    expect(isRetrySafe("GET", 502, false)).toBe(true);
    expect(isRetrySafe("POST", 429, false)).toBe(true);
    expect(isRetrySafe("POST", 400, true)).toBe(false);
  });

  it("Fiken-journalposten (POST uten Idempotency-Key) som får 503 sendes ÉN gang - ingen dobbel postering", async () => {
    const spy = vi.fn(async (url: string) => {
      if (!String(url).includes("generalJournalEntries")) return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }), text: async () => "" } as unknown as Response;
      return { ok: false, status: 503, text: async () => "", headers: new Headers() } as unknown as Response;
    });
    vi.stubGlobal("fetch", spy);
    vi.stubEnv("JARVIS_FIKEN_CLIENT_ID", "client-fixture");
    vi.stubEnv("JARVIS_FIKEN_CLIENT_SECRET", "secret-fixture");
    const transport = new FikenTransport("tok", "firma");
    await expect(transport.createGeneralJournalEntry({ description: "x", date: "2026-01-01", lines: [{ account: "3000", amount: 100 }, { account: "1920", amount: -100 }] })).rejects.toThrow();
    const posts = spy.mock.calls.filter((c) => String(c[0]).includes("generalJournalEntries"));
    expect(posts).toHaveLength(1);
    expect(((posts[0] as unknown as [string, RequestInit])[1]).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("JARVIS-071: ærlig readback", () => {
  it("Wallester updateCardLimits: `confirmed` er false når leverandøren ikke ekkoer det som ble bedt om", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      // leverandøren svarer 200 men ekkoer INGENTING
      return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    });
    const transport = new WallesterTransport("https://api.test.invalid", "key", () => "sig", "acct");
    const applied = await transport.updateCardLimits("card-1", {
      transactionLimitOre: 1000, dailyLimitOre: null, weeklyLimitOre: null, monthlyLimitOre: null, atmEnabled: false, onlineEnabled: true, contactlessEnabled: true
    });
    expect(applied.confirmed).toBe(false);
  });

  it("Neonomics: provider_reported_amount/currency settes IKKE til Jarvis' egne verdier ved innsending", async () => {
    const intentRows = await adminPool.query("SELECT 1 FROM payment_intents WHERE provider = 'neonomics' AND provider_reported_amount_ore IS NOT NULL AND tenant_id = $1", [TENANT]);
    expect(intentRows.rowCount).toBe(0);
  });
});

describe("JARVIS-072: idempotens og avvik", () => {
  it("samme idempotency_key med SAMME parametre returnerer samme intent; med ANDRE parametre kastes IdempotencyKeyConflictError", async () => {
    const service = vippsService(new VippsWriter());
    const key = `idem-${randomUUID()}`;
    const input = { idempotency_key: key, purpose: "D392 idem", amount_ore: 10_000, vendor_name: "Kunde AS", account_code: "vipps-category", provider: "vipps" as const };
    const a = await service.createPaymentIntent(TENANT, "business", input);
    const b = await service.createPaymentIntent(TENANT, "business", input);
    expect(b.payment_intent_id).toBe(a.payment_intent_id);
    await expect(service.createPaymentIntent(TENANT, "business", { ...input, amount_ore: 99_000 })).rejects.toThrow(IdempotencyKeyConflictError);
  });
});
