import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import {
  CaptureAlreadySubmittedError,
  ExcessiveCaptureAmountError,
  ExcessiveRefundAmountError,
  FinanceKillSwitchActiveError,
  InvalidWebhookSignatureError,
  PaymentIntentNotAuthorizedError,
  PaymentIntentNotSettledError,
  PaymentIntentNotVippsError,
  VippsCredentialsUnavailableError,
  VippsTenantNotConfiguredError,
  type PaymentIntent
} from "../src/types.ts";
import {
  FinanceService,
  type VippsCredentials,
  type VippsCredentialsProvider
} from "../src/service.ts";
import type { VippsPaymentObject, VippsPaymentWriter } from "../src/vipps-transport.ts";
import type { VippsWebhookRequestHeaders } from "../src/vipps-webhook.ts";

/**
 * D-110 (UA-6 Slice 4): ekte Postgres/RLS-integrasjonsbevis for Vipps-
 * grenen av `FinanceService` - SAMME harness-mønster som
 * `stripe-service.test.ts` (D-109): ekte embedded Postgres, ekte
 * `FinanceService`, mock KUN ved NETTVERKSGRENSEN (injisert
 * `VippsTransportFactory`-fake), ALDRI en adapter-omgåelse.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT_A = "tenant-vipps-svc-a";
const TENANT_B = "tenant-vipps-svc-b";
// BEVISST lav-entropi, åpenbart falsk verdi (gitleaks-lærdom fra D-109).
const WEBHOOK_SECRET = "not-a-real-vipps-webhook-secret-svc";
const HOST = "jarvis.example.test";
const PATH = "/webhooks/vipps";

/** Skriptbar fake ved Vipps-transportens nettverksgrense. */
class ScriptedVippsWriter implements VippsPaymentWriter {
  createPaymentCalls: Array<{ amountOre: number; currency: string; reference: string; paymentDescription: string; returnUrl: string; idempotencyKey: string }> = [];
  captureCalls: Array<{ reference: string; amountOre: number; currency: string; idempotencyKey: string }> = [];
  cancelCalls: Array<{ reference: string; idempotencyKey: string }> = [];
  refundCalls: Array<{ reference: string; amountOre: number; currency: string; idempotencyKey: string }> = [];

  onCreatePayment: (input: { amountOre: number; currency: string; reference: string }) => Promise<VippsPaymentObject> = async (input) => ({
    reference: input.reference, state: "CREATED", amount: { currency: input.currency, value: input.amountOre }
  });
  onGetPayment: (reference: string) => Promise<VippsPaymentObject> = async (reference) => ({
    reference, state: "CREATED", amount: { currency: "NOK", value: 10_000 }
  });
  onCapture: (input: { reference: string; amountOre: number; currency: string }) => Promise<VippsPaymentObject> = async (input) => ({
    reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre }
  });
  onCancel: (reference: string) => Promise<VippsPaymentObject> = async (reference) => ({
    reference, state: "CANCELLED", amount: { currency: "NOK", value: 10_000 }
  });
  onRefund: (input: { reference: string; amountOre: number; currency: string }) => Promise<VippsPaymentObject> = async (input) => ({
    reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre }
  });

  async createPayment(input: { amountOre: number; currency: string; reference: string; paymentDescription: string; returnUrl: string; idempotencyKey: string }): Promise<VippsPaymentObject> {
    this.createPaymentCalls.push(input);
    return this.onCreatePayment(input);
  }
  async getPayment(reference: string): Promise<VippsPaymentObject> {
    return this.onGetPayment(reference);
  }
  async capturePayment(input: { reference: string; amountOre: number; currency: string; idempotencyKey: string }): Promise<VippsPaymentObject> {
    this.captureCalls.push(input);
    return this.onCapture(input);
  }
  async cancelPayment(reference: string, idempotencyKey: string): Promise<VippsPaymentObject> {
    this.cancelCalls.push({ reference, idempotencyKey });
    return this.onCancel(reference);
  }
  async refundPayment(input: { reference: string; amountOre: number; currency: string; idempotencyKey: string }): Promise<VippsPaymentObject> {
    this.refundCalls.push(input);
    return this.onRefund(input);
  }
}

let writer: ScriptedVippsWriter;
let service: FinanceService;
let configuredTenant: string | null = TENANT_A;

const vippsCredentialsProvider: VippsCredentialsProvider = {
  async getCredentials(): Promise<VippsCredentials | null> {
    return { clientId: "fake-client", clientSecret: "fake-secret-fixture", subscriptionKey: "fake-sub-key", merchantSerialNumber: "123456", environment: "test" };
  }
};
const noVippsCredentialsProvider: VippsCredentialsProvider = {
  async getCredentials(): Promise<VippsCredentials | null> {
    return null;
  }
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-vipps-svc-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_vipps_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_vipps_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Vipps Svc A', 'business'), ('${TENANT_B}', 'Vipps Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-vipps-owner', 'Owner One')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_vipps_svc_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

function freshService(withCredentials = true): void {
  writer = new ScriptedVippsWriter();
  configuredTenant = TENANT_A;
  service = new FinanceService(
    appPool, undefined, undefined, undefined, undefined, undefined,
    withCredentials ? vippsCredentialsProvider : noVippsCredentialsProvider,
    () => writer,
    () => WEBHOOK_SECRET,
    () => configuredTenant
  );
}

async function createVippsIntent(overrides: Partial<Parameters<FinanceService["createPaymentIntent"]>[2]> = {}, tenant = TENANT_A): Promise<PaymentIntent> {
  return service.createPaymentIntent(tenant, "business", {
    idempotency_key: `idem-${randomUUID()}`,
    purpose: "Vipps test-salg",
    amount_ore: 10_000,
    vendor_name: "Kunde AS",
    account_code: "vipps-category",
    provider: "vipps",
    ...overrides
  });
}

const dummyFikenProvider = { getCredentials: async () => null };

async function submitIntent(intent: PaymentIntent): Promise<PaymentIntent> {
  return service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, dummyFikenProvider);
}

/** Setter provider_status='AUTHORIZED' via den EKTE refresh-stien (aldri en rå DB-manipulasjon for selve overgangen som testes). */
async function authorizeIntent(intent: PaymentIntent): Promise<PaymentIntent> {
  writer.onGetPayment = async (reference) => ({ reference, state: "AUTHORIZED", amount: { currency: "NOK", value: Number(intent.amount_ore) } });
  return service.refreshVippsPaymentState(TENANT_A, "business", intent.payment_intent_id);
}

async function settleViaFullCapture(intent: PaymentIntent): Promise<PaymentIntent> {
  await authorizeIntent(intent);
  const capture = await service.createVippsCapture(TENANT_A, "business", {
    idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: Number(intent.amount_ore)
  });
  await service.submitVippsCapture(TENANT_A, "business", capture.capture_id);
  return (await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id))!;
}

function vippsEventBuffer(payload: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

function signedVippsHeaders(rawBody: Buffer, secret = WEBHOOK_SECRET): VippsWebhookRequestHeaders {
  const date = new Date().toUTCString();
  const contentHash = createHash("sha256").update(rawBody).digest("base64");
  const signedPayload = `POST\n${PATH}\n${date};${HOST};${contentHash}`;
  const signature = createHmac("sha256", secret).update(signedPayload, "utf8").digest("base64");
  return { host: HOST, xMsDate: date, xMsContentSha256: contentHash, authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}` };
}

async function ingest(payload: Record<string, unknown>, secret = WEBHOOK_SECRET): Promise<{ status: string; eventId?: string }> {
  const raw = vippsEventBuffer(payload);
  return service.ingestVippsWebhookEvent(raw, "POST", PATH, signedVippsHeaders(raw, secret));
}

describe("PAYMENT: opprettelse og innsending", () => {
  it("oppretter en Vipps-intent og sender den - CREATED er en VENTER-PÅ-BRUKER-tilstand, aldri antatt suksess", async () => {
    freshService();
    const intent = await createVippsIntent();
    expect(intent.provider).toBe("vipps");
    expect(intent.state).toBe("draft");

    const submitted = await submitIntent(intent);
    expect(submitted.state).toBe("provider_acknowledged");
    expect(submitted.provider_status).toBe("CREATED"); // brukerinteraksjons-steget er SANNFERDIG modellert
    expect(submitted.provider_ref).toBe(intent.payment_intent_id); // reference == Jarvis sin egen id
    expect(writer.createPaymentCalls).toHaveLength(1);
    expect(writer.createPaymentCalls[0]!.idempotencyKey).toBe(`vipps-submit:${intent.payment_intent_id}`);
    expect(writer.createPaymentCalls[0]!.currency).toBe("NOK"); // store bokstaver - INGEN Stripe-små-bokstav-konvertering
  });

  it("idempotent submit-retry kaller ALDRI Vipps på nytt", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    const again = await submitIntent(intent);
    expect(again.state).toBe("provider_acknowledged");
    expect(writer.createPaymentCalls).toHaveLength(1);
  });

  it("nettverksfeil under submit etterlater raden i draft - retry gjenbruker SAMME deterministiske idempotens-nøkkel", async () => {
    freshService();
    const intent = await createVippsIntent();
    writer.onCreatePayment = async () => {
      throw new Error("vipps_api_failed_503:socket_hangup");
    };
    await expect(submitIntent(intent)).rejects.toThrow("vipps_api_failed_503");
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.state).toBe("draft");

    writer.onCreatePayment = async (input) => ({ reference: intent.payment_intent_id, state: "CREATED", amount: { currency: input.currency, value: input.amountOre } });
    await submitIntent(intent);
    expect(writer.createPaymentCalls.map((c) => c.idempotencyKey)).toEqual([
      `vipps-submit:${intent.payment_intent_id}`, `vipps-submit:${intent.payment_intent_id}`
    ]);
  });

  it("manglende credentials feiler fail-closed med VippsCredentialsUnavailableError", async () => {
    freshService(false);
    const intent = await createVippsIntent();
    await expect(submitIntent(intent)).rejects.toThrow(VippsCredentialsUnavailableError);
  });

  it("kill switch blokkerer submit deterministisk", async () => {
    freshService();
    const intent = await createVippsIntent();
    await service.enableKillSwitch(TENANT_A, "person-vipps-owner", "test-stopp");
    await expect(submitIntent(intent)).rejects.toThrow(FinanceKillSwitchActiveError);
    expect(writer.createPaymentCalls).toHaveLength(0);
    await service.disableKillSwitch(TENANT_A, "person-vipps-owner");
  });

  it("Vipps-spesifikke handlinger avviser en Fiken-intent (PaymentIntentNotVippsError)", async () => {
    freshService();
    const fikenIntent = await service.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "Fiken-post", amount_ore: 500,
      vendor_name: "Leverandør", account_code: "4000"
    });
    await expect(service.refreshVippsPaymentState(TENANT_A, "business", fikenIntent.payment_intent_id)).rejects.toThrow(PaymentIntentNotVippsError);
  });
});

describe("STATE: synkronisering og ordens-vokter", () => {
  it("refresh oppdaterer provider_status CREATED -> AUTHORIZED uten å røre Jarvis-state (fortsatt provider_acknowledged)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    const refreshed = await authorizeIntent(intent);
    expect(refreshed.provider_status).toBe("AUTHORIZED");
    expect(refreshed.state).toBe("provider_acknowledged"); // AUTHORIZED er reservasjon, IKKE oppgjør
  });

  it("TERMINATED mappes til cancelled (avbrutt før autorisering)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    writer.onGetPayment = async (reference) => ({ reference, state: "TERMINATED", amount: { currency: "NOK", value: 10_000 } });
    const refreshed = await service.refreshVippsPaymentState(TENANT_A, "business", intent.payment_intent_id);
    expect(refreshed.state).toBe("cancelled");
    expect(refreshed.provider_status).toBe("TERMINATED"); // den EKSAKTE provider-tilstanden er aldri tapt
  });

  it("EXPIRED mappes til cancelled", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    writer.onGetPayment = async (reference) => ({ reference, state: "EXPIRED", amount: { currency: "NOK", value: 10_000 } });
    const refreshed = await service.refreshVippsPaymentState(TENANT_A, "business", intent.payment_intent_id);
    expect(refreshed.state).toBe("cancelled");
  });

  it("en ELDRE webhook-hendelse overskriver ALDRI en nyere allerede-lagret provider-tilstand (stale_event)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent); // provider_status_updated_at = nå

    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    const result = await ingest({ reference: intent.payment_intent_id, name: "CREATED", amount: { value: 10_000, currency: "NOK" }, timestamp: oldTimestamp, idempotencyKey: `evt-${randomUUID()}` });
    expect(result.status).toBe("processed"); // hendelsen er registrert/behandlet - men utfallet var stale
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.provider_status).toBe("AUTHORIZED"); // IKKE rullet tilbake til CREATED
  });

  it("en sen kanselleringshendelse mot en allerede settled intent flagges PROVIDER_STATE_CONFLICT - terminal tilstand bevares", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    const settled = await settleViaFullCapture(intent);
    expect(settled.state).toBe("settled");

    const result = await ingest({ reference: intent.payment_intent_id, name: "TERMINATED", timestamp: new Date(Date.now() + 5000).toISOString(), idempotencyKey: `evt-${randomUUID()}` });
    expect(result.status).toBe("processed");
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.state).toBe("settled"); // ALDRI overskrevet
    expect(after!.anomaly_flags).toContain("PROVIDER_STATE_CONFLICT");
  });
});

describe("CAPTURE: integritet", () => {
  it("full capture oppgjør intensjonen (settled) og logger 'captured'-event", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);

    const capture = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 10_000
    });
    expect(capture.state).toBe("draft");
    const submitted = await service.submitVippsCapture(TENANT_A, "business", capture.capture_id);
    expect(submitted.state).toBe("settled");
    expect(writer.captureCalls).toHaveLength(1);
    expect(writer.captureCalls[0]!.idempotencyKey).toBe(`vipps-capture:${capture.capture_id}`);

    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.state).toBe("settled");
    const events = await service.listEvents(TENANT_A, "business", intent.payment_intent_id);
    expect(events.some((e) => e["event_type"] === "captured")).toBe(true);
  });

  it("delvis capture etterlater intensjonen økonomisk uavklart (provider_acknowledged) - materielt ulike tilstander kollapses ALDRI", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);

    const partial = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 4_000
    });
    await service.submitVippsCapture(TENANT_A, "business", partial.capture_id);
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.state).toBe("provider_acknowledged"); // 4000 av 10000 - IKKE settled

    // Resten fanges - NÅ er den settled.
    const rest = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 6_000
    });
    await service.submitVippsCapture(TENANT_A, "business", rest.capture_id);
    const final = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(final!.state).toBe("settled");
  });

  it("over-capture avvises deterministisk FØR noe Vipps-kall (ExcessiveCaptureAmountError)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    await expect(service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 10_001
    })).rejects.toThrow(ExcessiveCaptureAmountError);
    expect(writer.captureCalls).toHaveLength(0);
  });

  it("duplisert capture-submit-retry er en idempotent no-op (ett Vipps-kall, ett 'captured'-event)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    const capture = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 10_000
    });
    await service.submitVippsCapture(TENANT_A, "business", capture.capture_id);
    await service.submitVippsCapture(TENANT_A, "business", capture.capture_id);
    expect(writer.captureCalls).toHaveLength(1);
    const events = await service.listEvents(TENANT_A, "business", intent.payment_intent_id);
    expect(events.filter((e) => e["event_type"] === "captured")).toHaveLength(1);
  });

  it("capture-opprettelse med samme idempotency_key returnerer eksisterende rad uendret", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    const key = `cap-${randomUUID()}`;
    const first = await service.createVippsCapture(TENANT_A, "business", { idempotency_key: key, payment_intent_id: intent.payment_intent_id, amount_ore: 3_000 });
    const second = await service.createVippsCapture(TENANT_A, "business", { idempotency_key: key, payment_intent_id: intent.payment_intent_id, amount_ore: 3_000 });
    expect(second.capture_id).toBe(first.capture_id);
  });

  it("capture mot en betaling som IKKE er AUTHORIZED (fortsatt CREATED) avvises (PaymentIntentNotAuthorizedError)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent); // provider_status=CREATED - bruker har IKKE bekreftet ennå
    const capture = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 10_000
    });
    await expect(service.submitVippsCapture(TENANT_A, "business", capture.capture_id)).rejects.toThrow(PaymentIntentNotAuthorizedError);
    expect(writer.captureCalls).toHaveLength(0);
  });

  it("kill switch blokkerer capture-submit (aktiv økonomisk handling)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    const capture = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 10_000
    });
    await service.enableKillSwitch(TENANT_A, "person-vipps-owner", "test-stopp");
    await expect(service.submitVippsCapture(TENANT_A, "business", capture.capture_id)).rejects.toThrow(FinanceKillSwitchActiveError);
    await service.disableKillSwitch(TENANT_A, "person-vipps-owner");
  });

  it("submit av en allerede terminal (failed) capture kaster CaptureAlreadySubmittedError", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    const capture = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_000
    });
    await adminPool.query(`UPDATE vipps_captures SET state = 'failed', failed_at = now() WHERE capture_id = $1`, [capture.capture_id]);
    await expect(service.submitVippsCapture(TENANT_A, "business", capture.capture_id)).rejects.toThrow(CaptureAlreadySubmittedError);
  });
});

describe("CANCEL: semantikk", () => {
  it("kansellering FØR innsending er reint lokal (intet Vipps-kall)", async () => {
    freshService();
    const intent = await createVippsIntent();
    const cancelled = await service.cancelVippsPayment(TENANT_A, "business", intent.payment_intent_id);
    expect(cancelled.state).toBe("cancelled");
    expect(writer.cancelCalls).toHaveLength(0);
  });

  it("kansellering ETTER autorisering kaller Vipps og frigjør reservasjonen", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    const cancelled = await service.cancelVippsPayment(TENANT_A, "business", intent.payment_intent_id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.provider_status).toBe("CANCELLED");
    expect(writer.cancelCalls).toHaveLength(1);
    expect(writer.cancelCalls[0]!.idempotencyKey).toBe(`vipps-cancel:${intent.payment_intent_id}`);
  });

  it("kansellering av en allerede terminal intent er en idempotent no-op (intet nytt Vipps-kall)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    await service.cancelVippsPayment(TENANT_A, "business", intent.payment_intent_id);
    const again = await service.cancelVippsPayment(TENANT_A, "business", intent.payment_intent_id);
    expect(again.state).toBe("cancelled");
    expect(writer.cancelCalls).toHaveLength(1);
  });

  it("kill switch blokkerer provider-kansellering (aktiv handling mot leverandøren)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await service.enableKillSwitch(TENANT_A, "person-vipps-owner", "test-stopp");
    await expect(service.cancelVippsPayment(TENANT_A, "business", intent.payment_intent_id)).rejects.toThrow(FinanceKillSwitchActiveError);
    await service.disableKillSwitch(TENANT_A, "person-vipps-owner");
  });
});

describe("REFUND: integritet", () => {
  it("full refusjon mot en oppgjort betaling settles synkront", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await settleViaFullCapture(intent);

    const refund = await service.createVippsRefund(TENANT_A, "business", {
      idempotency_key: `ref-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 10_000
    });
    expect(refund.state).toBe("draft");
    const submitted = await service.submitVippsRefund(TENANT_A, "business", refund.refund_id);
    expect(submitted.state).toBe("settled");
    expect(writer.refundCalls).toHaveLength(1);
    expect(writer.refundCalls[0]!.idempotencyKey).toBe(`vipps-refund:${refund.refund_id}`);
  });

  it("refusjon mot en IKKE-oppgjort betaling avvises (PaymentIntentNotSettledError)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await expect(service.createVippsRefund(TENANT_A, "business", {
      idempotency_key: `ref-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_000
    })).rejects.toThrow(PaymentIntentNotSettledError);
  });

  it("delvis refusjon + aggregat over-refusjon avvises deterministisk", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await settleViaFullCapture(intent);

    const partial = await service.createVippsRefund(TENANT_A, "business", {
      idempotency_key: `ref-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 7_000
    });
    await service.submitVippsRefund(TENANT_A, "business", partial.refund_id);
    await expect(service.createVippsRefund(TENANT_A, "business", {
      idempotency_key: `ref-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 3_001
    })).rejects.toThrow(ExcessiveRefundAmountError);
    // nøyaktig resten er OK
    const rest = await service.createVippsRefund(TENANT_A, "business", {
      idempotency_key: `ref-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 3_000
    });
    expect(rest.state).toBe("draft");
  });

  it("duplisert refund-submit-retry er idempotent (ett Vipps-kall)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await settleViaFullCapture(intent);
    const refund = await service.createVippsRefund(TENANT_A, "business", {
      idempotency_key: `ref-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 5_000
    });
    await service.submitVippsRefund(TENANT_A, "business", refund.refund_id);
    await service.submitVippsRefund(TENANT_A, "business", refund.refund_id);
    expect(writer.refundCalls).toHaveLength(1);
  });

  it("kill switch blokkerer refund-submit", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await settleViaFullCapture(intent);
    const refund = await service.createVippsRefund(TENANT_A, "business", {
      idempotency_key: `ref-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_000
    });
    await service.enableKillSwitch(TENANT_A, "person-vipps-owner", "test-stopp");
    await expect(service.submitVippsRefund(TENANT_A, "business", refund.refund_id)).rejects.toThrow(FinanceKillSwitchActiveError);
    await service.disableKillSwitch(TENANT_A, "person-vipps-owner");
  });
});

describe("EVENTS: webhook-innhenting", () => {
  it("en gyldig autentisk hendelse behandles og oppdaterer provider-tilstanden", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    const result = await ingest({
      reference: intent.payment_intent_id, name: "AUTHORIZED", amount: { value: 10_000, currency: "NOK" },
      timestamp: new Date().toISOString(), idempotencyKey: `evt-${randomUUID()}`
    });
    expect(result.status).toBe("processed");
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.provider_status).toBe("AUTHORIZED");
    expect(after!.latest_vipps_event_key).toBe(result.eventId);
  });

  it("ugyldig autentisering avvises fail-closed (InvalidWebhookSignatureError)", async () => {
    freshService();
    const raw = vippsEventBuffer({ reference: "fin-pi-x", name: "AUTHORIZED" });
    await expect(service.ingestVippsWebhookEvent(raw, "POST", PATH, signedVippsHeaders(raw, "wrong-secret-fixture"))).rejects.toThrow(InvalidWebhookSignatureError);
  });

  it("duplisert hendelse (samme dedup-nøkkel) undertrykkes", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    const idempotencyKey = `evt-${randomUUID()}`;
    const payload = { reference: intent.payment_intent_id, name: "AUTHORIZED", timestamp: new Date().toISOString(), idempotencyKey };
    expect((await ingest(payload)).status).toBe("processed");
    expect((await ingest(payload)).status).toBe("duplicate");
  });

  it("hendelse mot en referanse Jarvis aldri opprettet er 'unsupported' (aldri en krasj, aldri antatt behandlet)", async () => {
    freshService();
    const result = await ingest({ reference: `fin-pi-unknown-${randomUUID()}`, name: "AUTHORIZED", idempotencyKey: `evt-${randomUUID()}` });
    expect(result.status).toBe("unsupported");
  });

  it("hendelse mot et objekt som tilhører en ANNEN tenant behandles ALDRI mot feil tenant (RLS skjuler raden -> unsupported, sterkeste isolasjon)", async () => {
    freshService();
    // Opprett en intent i TENANT_B via adminPool (RLS-bypass for test-setup).
    const foreignId = `fin-pi-${randomUUID()}`;
    await adminPool.query(
      `INSERT INTO payment_intents (payment_intent_id, tenant_id, memory_space_id, idempotency_key, state, purpose, amount_ore, currency, vendor_name, account_code, provider, provider_ref)
       VALUES ($1, $2, 'business', $3, 'provider_acknowledged', 'Fremmed intent', 5000, 'NOK', 'X', 'cat', 'vipps', $1)`,
      [foreignId, TENANT_B, `idem-${randomUUID()}`]
    );
    // configuredTenant er TENANT_A - webhook-transaksjonen kjører under TENANT_A sin RLS-kontekst,
    // som ALDRI kan se TENANT_B sin rad (samme sterkere-enn-applikasjonssjekk-utfall som D-109 sin
    // tilsvarende test dokumenterte for Stripe - RLS er PRIMÆR-vokteren, app-sjekken er defensiv).
    const result = await ingest({ reference: foreignId, name: "AUTHORIZED", idempotencyKey: `evt-${randomUUID()}` });
    expect(result.status).toBe("unsupported");
  });

  it("CAPTURED-hendelse trigger aggregat-oppgjørs-reevaluering fra Jarvis sin EGEN bokføring", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    // Fang hele beløpet - MEN simulert at settlement-sjekken i submit-stien
    // "ikke rakk" (vi ruller staten tilbake for å bevise at webhook-stien
    // ALENE også kan fullføre oppgjøret).
    const capture = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 10_000
    });
    await service.submitVippsCapture(TENANT_A, "business", capture.capture_id);
    await adminPool.query(`UPDATE payment_intents SET state = 'provider_acknowledged', settled_at = NULL WHERE payment_intent_id = $1`, [intent.payment_intent_id]);

    const result = await ingest({ reference: intent.payment_intent_id, name: "CAPTURED", timestamp: new Date(Date.now() + 2000).toISOString(), idempotencyKey: `evt-${randomUUID()}` });
    expect(result.status).toBe("processed");
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.state).toBe("settled");
  });

  it("manglende webhook-secret feiler fail-closed", async () => {
    writer = new ScriptedVippsWriter();
    service = new FinanceService(appPool, undefined, undefined, undefined, undefined, undefined, vippsCredentialsProvider, () => writer, () => null, () => TENANT_A);
    const raw = vippsEventBuffer({ reference: "fin-pi-x", name: "AUTHORIZED" });
    await expect(service.ingestVippsWebhookEvent(raw, "POST", PATH, signedVippsHeaders(raw))).rejects.toThrow(VippsCredentialsUnavailableError);
  });

  it("manglende tenant-konfigurasjon feiler fail-closed", async () => {
    freshService();
    configuredTenant = null;
    const raw = vippsEventBuffer({ reference: "fin-pi-x", name: "AUTHORIZED" });
    await expect(service.ingestVippsWebhookEvent(raw, "POST", PATH, signedVippsHeaders(raw))).rejects.toThrow(VippsTenantNotConfiguredError);
  });

  it("hendelses-inspeksjon (getVippsWebhookEvent) leser tilbake status/utdrag", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    const idempotencyKey = `evt-${randomUUID()}`;
    await ingest({ reference: intent.payment_intent_id, name: "AUTHORIZED", amount: { value: 10_000, currency: "NOK" }, timestamp: new Date().toISOString(), idempotencyKey });
    const record = await service.getVippsWebhookEvent(TENANT_A, idempotencyKey);
    expect(record!.status).toBe("processed");
    expect(record!.event_name).toBe("AUTHORIZED");
    expect(record!.payment_intent_id).toBe(intent.payment_intent_id);
  });
});

describe("ANOMALIER + WORKER + RECONCILIATION", () => {
  it("PROVIDER_AMOUNT_MISMATCH/PROVIDER_CURRENCY_MISMATCH detekteres deterministisk", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await adminPool.query(
      `UPDATE payment_intents SET provider_reported_amount_ore = 9999, provider_reported_currency = 'EUR' WHERE payment_intent_id = $1`,
      [intent.payment_intent_id]
    );
    await service.runVippsProviderAnomalyDetection(TENANT_A, "business");
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.anomaly_flags).toContain("PROVIDER_AMOUNT_MISMATCH");
    expect(after!.anomaly_flags).toContain("PROVIDER_CURRENCY_MISMATCH");
  });

  it("EXPIRED_PAYMENT_WITH_ACTIVE_INTENT flagges for en CREATED-betaling eldre enn 24t", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await adminPool.query(
      `UPDATE payment_intents SET provider_status_updated_at = now() - interval '25 hours' WHERE payment_intent_id = $1`,
      [intent.payment_intent_id]
    );
    await service.runVippsProviderAnomalyDetection(TENANT_A, "business");
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.anomaly_flags).toContain("EXPIRED_PAYMENT_WITH_ACTIVE_INTENT");
  });

  it("avviksdeteksjonen er selv-korrigerende (flagg fjernes når årsaken er borte)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await adminPool.query(`UPDATE payment_intents SET provider_reported_amount_ore = 1 WHERE payment_intent_id = $1`, [intent.payment_intent_id]);
    await service.runVippsProviderAnomalyDetection(TENANT_A, "business");
    await adminPool.query(`UPDATE payment_intents SET provider_reported_amount_ore = 10000 WHERE payment_intent_id = $1`, [intent.payment_intent_id]);
    await service.runVippsProviderAnomalyDetection(TENANT_A, "business");
    const after = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after!.anomaly_flags).not.toContain("PROVIDER_AMOUNT_MISMATCH");
  });

  it("worker-sveipet synker alle provider_acknowledged Vipps-intents, feil på én velter ikke resten", async () => {
    freshService();
    const a = await createVippsIntent();
    const b = await createVippsIntent();
    await submitIntent(a);
    await submitIntent(b);
    writer.onGetPayment = async (reference) => {
      if (reference === a.payment_intent_id) throw new Error("vipps_api_failed_500:oops");
      return { reference, state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } };
    };
    const result = await service.syncPendingVippsPayments(TENANT_A, "business");
    expect(result.synced).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const afterB = await service.getPaymentIntent(TENANT_A, "business", b.payment_intent_id);
    expect(afterB!.provider_status).toBe("AUTHORIZED");
  });

  it("den EKSISTERENDE provider-nøytrale reconcile_payment_intent-stien virker uendret for Vipps-intents", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    const reconciled = await service.reconcilePaymentIntent(TENANT_A, "business", intent.payment_intent_id, false, undefined, "beløp avviker fra kontoutskrift");
    expect(reconciled.reconciliation_state).toBe("mismatched");
  });
});

describe("SECURITY: RLS/tenant-isolasjon", () => {
  it("TENANT_B kan aldri lese TENANT_A sine Vipps-captures/refunds (RLS)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    await authorizeIntent(intent);
    const capture = await service.createVippsCapture(TENANT_A, "business", {
      idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_000
    });
    const crossRead = await service.getVippsCapture(TENANT_B, "business", capture.capture_id);
    expect(crossRead).toBeNull();
    const crossList = await service.listVippsCaptures(TENANT_B, "business", intent.payment_intent_id);
    expect(crossList).toHaveLength(0);
  });

  it("webhook-hendelsesraden persisterer aldri sensitive nyttelast-felt (kun det trygge utdraget)", async () => {
    freshService();
    const intent = await createVippsIntent();
    await submitIntent(intent);
    const idempotencyKey = `evt-${randomUUID()}`;
    await ingest({
      reference: intent.payment_intent_id, name: "AUTHORIZED", amount: { value: 10_000, currency: "NOK" },
      timestamp: new Date().toISOString(), idempotencyKey,
      userDetails: { firstName: "Kari", mobileNumber: "4712345678" }
    });
    const { rows } = await adminPool.query(`SELECT payload_summary FROM vipps_webhook_events WHERE dedupe_key = $1`, [idempotencyKey]);
    expect(JSON.stringify(rows[0]!["payload_summary"])).not.toContain("4712345678");
  });
});
