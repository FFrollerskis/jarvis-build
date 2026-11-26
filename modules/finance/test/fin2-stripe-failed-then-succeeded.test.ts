import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { PaymentIntent } from "../src/types.ts";
import { FinanceService, type StripeCredentials, type StripeCredentialsProvider, type StripePaymentWriter } from "../src/service.ts";
import { PAYMENT_INTENT_TRANSITIONS, canTransitionPaymentIntent } from "../src/state-machine.ts";
import type { StripeBalanceObject, StripePaymentIntentObject, StripeRefundObject } from "../src/stripe-transport.ts";

/**
 * WP-FIN2 K6 (D-486, JARVIS-020-resten): Stripe `payment_intent.payment_failed` gjør Jarvis-intensjonen terminal (`failed`), men Stripe sier selv at et mislykket forsøk
 * lar PaymentIntent-objektet stå i `requires_payment_method` - kunden kan prøve igjen, og et senere `payment_intent.succeeded` er normalt. Da blir hendelsen `WEBHOOK_STATE_CONFLICT`
 * og en BETALT betaling står som `failed` i Jarvis (kilde: Stripe-dokumentasjonen om PaymentIntent-livssyklusen, lest som søkeutdrag - `unverified` til siden er lest i sin helhet).
 *
 * Eieren har IKKE valgt å endre tilstandsmaskinen (terminalreglene), så WP-FIN2 gjør bare det som er trygt uten hans valg:
 *   (i)  LÅSER dagens oppførsel (tilstand blir `failed`, flagget settes, hendelsen er `processed`, `PAYMENT_INTENT_TRANSITIONS.failed` er tom),
 *   (ii) skriver en `payment_intent_events`-rad `anomaly_flagged` med årsak `provider_succeeded_after_local_failed` (KUN status/id - aldri beløp/feiltekst) i tillegg til flagget, slik at
 *        det synes i betalingens historikk og ikke bare som et flagg,
 *   (iii) selve tilstandsendringen er DEFERRED (Q-forslag i rapporten/runbooken).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT_A = "tenant-fin2-k6-a";
const TENANT_B = "tenant-fin2-k6-b";
const WEBHOOK_SECRET = ["whsec", "fixture", "fin2", "k6"].join("_");
const REASON = "provider_succeeded_after_local_failed";

class ScriptedWriter implements StripePaymentWriter {
  getPaymentIntentCalls: string[] = [];
  onCreate: (input: { amountOre: number; currency: string; metadata: Record<string, string> }) => Promise<StripePaymentIntentObject> = async (input) => ({
    id: `pi_k6_${randomUUID().slice(0, 8)}`, object: "payment_intent", amount: input.amountOre, currency: input.currency.toLowerCase(), status: "requires_payment_method", metadata: input.metadata
  });
  onGet: (id: string) => Promise<StripePaymentIntentObject> = async (id) => ({ id, object: "payment_intent", amount: 10_000, currency: "nok", status: "requires_payment_method", metadata: {} });
  async createPaymentIntent(input: { amountOre: number; currency: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<StripePaymentIntentObject> { return this.onCreate(input); }
  async getPaymentIntent(id: string): Promise<StripePaymentIntentObject> { this.getPaymentIntentCalls.push(id); return this.onGet(id); }
  async createRefund(): Promise<StripeRefundObject> { throw new Error("not_used"); }
  async getRefund(): Promise<StripeRefundObject> { throw new Error("not_used"); }
  async getBalance(): Promise<StripeBalanceObject> { throw new Error("not_used"); }
}

let writer: ScriptedWriter;
let service: FinanceService;
let configuredTenant = TENANT_A;
const credentials: StripeCredentialsProvider = { async getCredentials(): Promise<StripeCredentials | null> { return { secretKey: ["sk", "test", "fixture"].join("_") }; } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-k6-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_fin2_k6 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fin2_k6");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'K6 A', 'business'), ('${TENANT_B}', 'K6 B', 'business')`);
  appPool = createPool({ ...base, user: "jarvis_fin2_k6", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function fresh(tenant = TENANT_A): void {
  writer = new ScriptedWriter();
  configuredTenant = tenant;
  service = new FinanceService(appPool, undefined, credentials, () => writer, () => WEBHOOK_SECRET, () => configuredTenant);
}

async function submittedIntent(tenant = TENANT_A): Promise<PaymentIntent> {
  const draft = await service.createPaymentIntent(tenant, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "Stripe K6", amount_ore: 10_000, vendor_name: "Kunde AS", account_code: "stripe-category", provider: "stripe"
  });
  return service.submitPaymentIntent(tenant, "business", draft.payment_intent_id, {} as never);
}

const signed = (body: Buffer, ts: number): string => `t=${ts},v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${body.toString("utf8")}`, "utf8").digest("hex")}`;
async function deliver(type: string, providerRef: string, status: string, created: number, extra: Record<string, unknown> = {}): Promise<{ status: string; eventId?: string }> {
  const body = Buffer.from(JSON.stringify({ id: `evt_k6_${randomUUID()}`, type, created, data: { object: { id: providerRef, object: "payment_intent", amount: 10_000, currency: "nok", status, ...extra } } }));
  return service.ingestStripeWebhookEvent(body, signed(body, created), created);
}
const failedEvent = (ref: string, created: number) => deliver("payment_intent.payment_failed", ref, "requires_payment_method", created, { last_payment_error: { message: "Kortet ble avvist (fixture-tekst som aldri skal inn i hendelsen)" } });
const succeededEvent = (ref: string, created: number) => deliver("payment_intent.succeeded", ref, "succeeded", created);

/** `reason = null`: ALLE avviks-hendelser med en `reason` (opprettelsestidens `anomaly_flagged`-rad har ingen `reason` og telles ikke). */
async function anomalyEvents(tenant: string, paymentIntentId: string, reason: string | null = REASON): Promise<Array<{ summary: string; metadata: Record<string, unknown>; actor_person_id: string | null }>> {
  const { rows } = await adminPool.query(
    `SELECT summary, metadata, actor_person_id FROM payment_intent_events WHERE tenant_id = $1 AND payment_intent_id = $2 AND event_type = 'anomaly_flagged'
       AND (CASE WHEN $3::text IS NULL THEN metadata ? 'reason' ELSE metadata->>'reason' = $3::text END) ORDER BY created_at`, [tenant, paymentIntentId, reason]
  );
  return rows as Array<{ summary: string; metadata: Record<string, unknown>; actor_person_id: string | null }>;
}
const reread = async (tenant: string, id: string) => (await service.getPaymentIntent(tenant, "business", id))!;
const now = (): number => Math.floor(Date.now() / 1000);

describe("K6 (i): dagens oppførsel er LÅST - failed forblir terminal, flagget settes, ingen tilstandsmaskin-endring", () => {
  beforeAll(() => fresh());

  it("payment_failed -> failed; et senere succeeded blir WEBHOOK_STATE_CONFLICT og tilstanden står (hendelsen er processed)", async () => {
    const submitted = await submittedIntent();
    const t = now();
    expect((await failedEvent(submitted.provider_ref!, t)).status).toBe("processed");
    const failed = await reread(TENANT_A, submitted.payment_intent_id);
    expect(failed.state).toBe("failed");
    expect(failed.anomaly_flags ?? []).not.toContain("WEBHOOK_STATE_CONFLICT");

    expect((await succeededEvent(submitted.provider_ref!, t + 5)).status).toBe("processed");
    const after = await reread(TENANT_A, submitted.payment_intent_id);
    expect(after.state).toBe("failed"); // Q-forslag K6: IKKE endret uten eierens valg
    expect(after.anomaly_flags).toContain("WEBHOOK_STATE_CONFLICT");
    expect(after.provider_status).toBe("requires_payment_method"); // konflikten returnerer FØR raden skrives: leverandørens nyere status lagres ikke på raden - kun flagget (og, etter K6, hendelsen under) bærer den
    expect(after.settled_at ?? null).toBeNull();
  });

  it("tilstandsmaskinen er uendret: failed er terminal (en endring krever eierens valg og må endre denne testen bevisst)", () => {
    expect(PAYMENT_INTENT_TRANSITIONS.failed).toEqual([]);
    expect(PAYMENT_INTENT_TRANSITIONS.settled).toEqual([]);
    expect(PAYMENT_INTENT_TRANSITIONS.cancelled).toEqual([]);
    expect(canTransitionPaymentIntent("failed", "settled")).toBe(false);
    expect(canTransitionPaymentIntent("failed", "provider_acknowledged")).toBe(false);
  });
});

describe("K6 (ii): failed -> succeeded gir en anomaly_flagged-hendelse i betalingens historikk (årsak provider_succeeded_after_local_failed, kun status/id)", () => {
  beforeAll(() => fresh());

  it("webhook: nøyaktig én hendelse med årsak, leverandørstatus og kilde-hendelsens id - uten beløp, valuta eller feiltekst", async () => {
    const submitted = await submittedIntent();
    const t = now();
    await failedEvent(submitted.provider_ref!, t);
    const success = await succeededEvent(submitted.provider_ref!, t + 5);
    const events = await anomalyEvents(TENANT_A, submitted.payment_intent_id);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.metadata).toEqual({ anomaly_flags: ["WEBHOOK_STATE_CONFLICT"], reason: REASON, provider_status: "succeeded", source_event_id: success.eventId });
    expect(e.actor_person_id).toBeNull();
    const text = JSON.stringify(e);
    for (const forbidden of ["10000", "10_000", "nok", "NOK", "avvist", "fixture-tekst", "amount", "currency", "last_payment_error", "pi_k6_"]) expect(text, forbidden).not.toContain(forbidden);
  });

  it("kun første gang: en ny succeeded-hendelse (annen id) og samme hendelse på nytt gir ikke flere rader", async () => {
    const submitted = await submittedIntent();
    const t = now();
    await failedEvent(submitted.provider_ref!, t);
    const first = await deliver("payment_intent.succeeded", submitted.provider_ref!, "succeeded", t + 5);
    await deliver("payment_intent.succeeded", submitted.provider_ref!, "succeeded", t + 6);
    const body = Buffer.from(JSON.stringify({ id: first.eventId, type: "payment_intent.succeeded", created: t + 5, data: { object: { id: submitted.provider_ref, object: "payment_intent", amount: 10_000, currency: "nok", status: "succeeded" } } }));
    expect((await service.ingestStripeWebhookEvent(body, signed(body, t + 5), t + 5)).status).toBe("duplicate");
    expect(await anomalyEvents(TENANT_A, submitted.payment_intent_id)).toHaveLength(1);
  });

  it("oppfriskingsstien (refreshStripePaymentState) gir samme årsak med source_event_id = null, og skriver aldri tilstand", async () => {
    const submitted = await submittedIntent();
    const t = now();
    await failedEvent(submitted.provider_ref!, t);
    writer.onGet = async (id) => ({ id, object: "payment_intent", amount: 10_000, currency: "nok", status: "succeeded", metadata: {} });
    const refreshed = await service.refreshStripePaymentState(TENANT_A, "business", submitted.payment_intent_id);
    expect(refreshed.state).toBe("failed");
    expect(refreshed.anomaly_flags).toContain("WEBHOOK_STATE_CONFLICT");
    const events = await anomalyEvents(TENANT_A, submitted.payment_intent_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({ anomaly_flags: ["WEBHOOK_STATE_CONFLICT"], reason: REASON, provider_status: "succeeded", source_event_id: null });
    await service.refreshStripePaymentState(TENANT_A, "business", submitted.payment_intent_id); // en ny oppfrisking støyer ikke
    expect(await anomalyEvents(TENANT_A, submitted.payment_intent_id)).toHaveLength(1);
  });
});

describe("K6: årsaken er smal - andre utfall får den ikke, og et nytt mislykket forsøk er ingen konflikt", () => {
  beforeAll(() => fresh());

  it("settled + sen canceled flagges som før (WEBHOOK_STATE_CONFLICT) men gir IKKE denne årsaken", async () => {
    const submitted = await submittedIntent();
    const t = now();
    await succeededEvent(submitted.provider_ref!, t);
    await deliver("payment_intent.canceled", submitted.provider_ref!, "canceled", t + 5);
    const after = await reread(TENANT_A, submitted.payment_intent_id);
    expect(after.state).toBe("settled");
    expect(after.anomaly_flags).toContain("WEBHOOK_STATE_CONFLICT");
    expect(await anomalyEvents(TENANT_A, submitted.payment_intent_id, REASON)).toHaveLength(0);
  });

  it("failed + et NYTT payment_failed (kunden prøvde igjen og feilet igjen) er ingen konflikt: ingen flagg, ingen hendelse", async () => {
    const submitted = await submittedIntent();
    const t = now();
    await failedEvent(submitted.provider_ref!, t);
    await failedEvent(submitted.provider_ref!, t + 5);
    const after = await reread(TENANT_A, submitted.payment_intent_id);
    expect(after.state).toBe("failed");
    expect(after.anomaly_flags ?? []).not.toContain("WEBHOOK_STATE_CONFLICT");
    expect(await anomalyEvents(TENANT_A, submitted.payment_intent_id, null)).toHaveLength(0);
  });

  it("failed + en ELDRE succeeded-hendelse (stale) endrer ingenting og gir ingen hendelse", async () => {
    const submitted = await submittedIntent();
    const t = now();
    await failedEvent(submitted.provider_ref!, t);
    await succeededEvent(submitted.provider_ref!, t - 60);
    expect(await anomalyEvents(TENANT_A, submitted.payment_intent_id, null)).toHaveLength(0);
    expect((await reread(TENANT_A, submitted.payment_intent_id)).state).toBe("failed");
  });
});

describe("K6: oppdagelsesgrensen er dokumentert og låst - oppfriskingssveipet leser IKKE failed-intensjoner", () => {
  beforeAll(() => fresh(TENANT_B));

  it("syncPendingStripePayments tar kun provider_acknowledged; en failed-intensjon leses ikke på nytt (kun webhook/manuell oppfrisking avdekker succeeded-etter-failed)", async () => {
    const submitted = await submittedIntent(TENANT_B);
    await failedEvent(submitted.provider_ref!, now());
    writer.getPaymentIntentCalls.length = 0;
    await expect(service.syncPendingStripePayments(TENANT_B, "business")).resolves.toEqual({ synced: 0, failed: 0 });
    expect(writer.getPaymentIntentCalls).toEqual([]);
  });
});
