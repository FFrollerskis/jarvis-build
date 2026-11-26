import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ProviderResponseInvalidError } from "../src/provider-response.ts";
import { RefundNotFoundError, type PaymentIntent, type StripeRefund } from "../src/types.ts";
import { CardService } from "../src/card-service.ts";
import { FinanceService, type StripeCredentials, type StripeCredentialsProvider, type StripePaymentWriter } from "../src/service.ts";
import type { StripeBalanceObject, StripePaymentIntentObject, StripeRefundObject } from "../src/stripe-transport.ts";
import type { WallesterCredentials, WallesterGateway } from "../src/index.ts";

/**
 * WP-FIN2 K9 (D-486): småfunn fra revisjonen, hver for seg og mot ekte Postgres (app-rolle, RLS):
 *   (a) `card-service.ts` autorisasjonsoppslaget manglet `card_id`: et oppgjør på kort B som pekte på kort A sin autorisasjon ble lenket dit (og kunne gi DUPLICATE_ECONOMIC_EFFECT/CARD_AUTH_SETTLEMENT_CONFLICT mot feil kort),
 *   (b) avviksflagg-hjelperne (`appendChainAnomalyFlags`/`appendAnomalyFlags`/`appendVippsAnomalyFlags`, og `appendBankAnomalyFlags` av samme funnklasse) hadde ikke `tenant_id`-predikat,
 *   (c) Stripe-refusjon manglet oppfriskingssti (`getRefund` ble aldri kalt): `refreshStripeRefundState` i tre faser, med i `syncPendingStripePayments`.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT_A = "tenant-fin2-k9-a";
const TENANT_B = "tenant-fin2-k9-b";
const TENANT_C = "tenant-fin2-k9-c";
const APP_ROLE = "jarvis_fin2_k9";
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-k9-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${APP_ROLE}`);
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'K9 A', 'business'), ('${TENANT_B}', 'K9 B', 'business'), ('${TENANT_C}', 'K9 C', 'business')`);
  appPool = createPool({ ...base, user: APP_ROLE, password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

// ===========================================================================
// K9a: autorisasjonsoppslaget har card_id
// ===========================================================================

describe("K9a: oppgjør lenkes kun mot autorisasjoner på SAMME kort", () => {
  const creds: WallesterCredentials = { baseUrl: "https://wallester.invalid", apiKey: "fixture-key", sign: () => "sig", accountId: "wacc-1", environment: "sandbox" };
  const authFor = (cardId: string, id: string) => ({ id, cardId, status: "approved" as const, amountOre: 5_000, currency: "EUR", merchantName: "Kafe", merchantCategoryCode: "5812", channel: "pos" as const, declineReason: null, authorizedAt: "2026-11-01T10:00:00Z" });
  const txFor = (cardId: string, id: string, authorizationId: string | null) => ({ id, cardId, authorizationId, type: "purchase" as const, amountOre: 5_000, currency: "EUR", merchantName: "Kafe", merchantCategoryCode: "5812", channel: "pos" as const, transactionAt: "2026-11-01T10:05:00Z", settledAt: "2026-11-02T10:00:00Z" });
  const authsByProviderCard = new Map<string, ReturnType<typeof authFor>[]>();
  const txsByProviderCard = new Map<string, ReturnType<typeof txFor>[]>();
  let counter = 0;
  const gateway = {
    createCard: async () => ({ id: `wcard-k9a-${++counter}-${randomUUID().slice(0, 6)}`, status: "active", maskedCardNumber: "…1111", accountId: "wacc-1", tokenizationStatus: null }),
    listAuthorizations: async (providerCardId: string) => ({ items: authsByProviderCard.get(providerCardId) ?? [], nextPageToken: null }),
    listTransactions: async (providerCardId: string) => ({ items: txsByProviderCard.get(providerCardId) ?? [], nextPageToken: null })
  } as unknown as WallesterGateway;
  let cards: CardService;
  beforeAll(() => { cards = new CardService(appPool, { getCredentials: async () => creds }, () => gateway, () => null, () => TENANT_A); });

  async function submittedCard(): Promise<{ cardId: string; providerCardId: string }> {
    const draft = await cards.createCard(TENANT_A, "business", { idempotency_key: `k-${randomUUID()}`, name: "K9a", purpose: "P", card_type: "virtual", currency: "EUR" });
    const submitted = await cards.submitCard(TENANT_A, "business", draft.card_id);
    return { cardId: draft.card_id, providerCardId: submitted.provider_card_id! };
  }
  const txRow = async (providerTxId: string) => (await adminPool.query("SELECT authorization_id, anomaly_flags FROM card_transactions WHERE tenant_id = $1 AND provider_transaction_id = $2", [TENANT_A, providerTxId])).rows[0] as { authorization_id: string | null; anomaly_flags: string[] };

  it("et oppgjør på kort B som peker på kort A sin autorisasjon lenkes IKKE (ingen kryss-kort-lenke, ingen flagg mot feil kort)", async () => {
    const a = await submittedCard();
    const b = await submittedCard();
    const authId = `auth-${randomUUID().slice(0, 8)}`;
    authsByProviderCard.set(a.providerCardId, [authFor(a.providerCardId, authId)]);
    await cards.syncAuthorizations(TENANT_A, "business", a.cardId);
    const crossTx = `tx-cross-${randomUUID().slice(0, 8)}`;
    txsByProviderCard.set(b.providerCardId, [txFor(b.providerCardId, crossTx, authId)]);
    await cards.syncTransactions(TENANT_A, "business", b.cardId);
    const cross = await txRow(crossTx);
    expect(cross.authorization_id).toBeNull();
    expect(cross.anomaly_flags).not.toContain("DUPLICATE_ECONOMIC_EFFECT");
    expect(cross.anomaly_flags).not.toContain("CARD_AUTH_SETTLEMENT_CONFLICT");
  });

  it("kontroll: samme oppgjør på SAMME kort lenkes til autorisasjonen, og et andre oppgjør mot den gir DUPLICATE_ECONOMIC_EFFECT", async () => {
    const a = await submittedCard();
    const authId = `auth-${randomUUID().slice(0, 8)}`;
    authsByProviderCard.set(a.providerCardId, [authFor(a.providerCardId, authId)]);
    await cards.syncAuthorizations(TENANT_A, "business", a.cardId);
    const first = `tx-own-1-${randomUUID().slice(0, 8)}`;
    const second = `tx-own-2-${randomUUID().slice(0, 8)}`;
    txsByProviderCard.set(a.providerCardId, [txFor(a.providerCardId, first, authId)]);
    await cards.syncTransactions(TENANT_A, "business", a.cardId);
    expect((await txRow(first)).authorization_id).not.toBeNull();
    txsByProviderCard.set(a.providerCardId, [txFor(a.providerCardId, first, authId), txFor(a.providerCardId, second, authId)]);
    await cards.syncTransactions(TENANT_A, "business", a.cardId);
    const dup = await txRow(second);
    expect(dup.authorization_id).not.toBeNull();
    expect(dup.anomaly_flags).toContain("DUPLICATE_ECONOMIC_EFFECT");
  });
});

// ===========================================================================
// K9b: tenant-predikat i avviksflagg-hjelperne
// ===========================================================================

type FlagHelpers = {
  appendAnomalyFlags(c: pg.PoolClient, tenantId: string, table: string, idColumn: string, id: string, flags: readonly string[]): Promise<void>;
  appendChainAnomalyFlags(c: pg.PoolClient, tenantId: string, table: string, idColumn: string, id: string, flags: readonly string[]): Promise<void>;
};

describe("K9b: avviksflagg-hjelperne rører aldri en rad i en annen tenant", () => {
  const WEBHOOK_SECRET = ["whsec", "fixture", "fin2", "k9"].join("_");
  const credentials: StripeCredentialsProvider = { async getCredentials(): Promise<StripeCredentials | null> { return { secretKey: ["sk", "test", "fixture"].join("_") }; } };
  const writer: StripePaymentWriter = {
    createPaymentIntent: async (i: { amountOre: number; currency: string; metadata: Record<string, string> }): Promise<StripePaymentIntentObject> => ({ id: `pi_k9b_${randomUUID().slice(0, 8)}`, object: "payment_intent", amount: i.amountOre, currency: i.currency.toLowerCase(), status: "requires_payment_method", metadata: i.metadata }),
    getPaymentIntent: async (id: string): Promise<StripePaymentIntentObject> => ({ id, object: "payment_intent", amount: 10_000, currency: "nok", status: "requires_payment_method", metadata: {} }),
    createRefund: async (): Promise<StripeRefundObject> => { throw new Error("not_used"); },
    getRefund: async (): Promise<StripeRefundObject> => { throw new Error("not_used"); },
    getBalance: async (): Promise<StripeBalanceObject> => { throw new Error("not_used"); }
  };
  let svc: FinanceService;
  let helpers: FlagHelpers;
  beforeAll(() => {
    svc = new FinanceService(appPool, undefined, credentials, () => writer, () => WEBHOOK_SECRET, () => TENANT_A);
    helpers = svc as unknown as FlagHelpers;
  });
  const intent = (tenant: string): Promise<PaymentIntent> => svc.createPaymentIntent(tenant, "business", { idempotency_key: `idem-${randomUUID()}`, purpose: "K9b", amount_ore: 10_000, vendor_name: "Kunde AS", account_code: "stripe-category", provider: "stripe" });
  const flagsOf = async (id: string): Promise<string[]> => ((await adminPool.query("SELECT anomaly_flags FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as { anomaly_flags: string[] }).anomaly_flags;

  /** Admin-forbindelse (omgår RLS): beviser at PREDIKATET i selve SQL-en holder, ikke bare at RLS skjuler raden. */
  async function withAdmin<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await adminPool.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  it("appendAnomalyFlags: feil tenant = ingen endring; riktig tenant = flagget settes", async () => {
    const other = await intent(TENANT_B);
    await withAdmin((c) => helpers.appendAnomalyFlags(c, TENANT_A, "payment_intents", "payment_intent_id", other.payment_intent_id, ["WEBHOOK_STATE_CONFLICT"]));
    expect(await flagsOf(other.payment_intent_id)).not.toContain("WEBHOOK_STATE_CONFLICT");
    await withAdmin((c) => helpers.appendAnomalyFlags(c, TENANT_B, "payment_intents", "payment_intent_id", other.payment_intent_id, ["WEBHOOK_STATE_CONFLICT"]));
    expect(await flagsOf(other.payment_intent_id)).toContain("WEBHOOK_STATE_CONFLICT");
  });

  it("appendChainAnomalyFlags: feil tenant = ingen endring; riktig tenant = flagget settes", async () => {
    const other = await intent(TENANT_C);
    await withAdmin((c) => helpers.appendChainAnomalyFlags(c, TENANT_A, "payment_intents", "payment_intent_id", other.payment_intent_id, ["SUBMIT_OUTCOME_UNKNOWN"]));
    expect(await flagsOf(other.payment_intent_id)).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    await withAdmin((c) => helpers.appendChainAnomalyFlags(c, TENANT_C, "payment_intents", "payment_intent_id", other.payment_intent_id, ["SUBMIT_OUTCOME_UNKNOWN"]));
    expect(await flagsOf(other.payment_intent_id)).toContain("SUBMIT_OUTCOME_UNKNOWN");
  });

  it("kildevakt: ALLE `UPDATE ... SET anomaly_flags` i modules/finance/src har `tenant_id = $n` (også Vipps- og bank-hjelperne som ikke kan eksemplifiseres billig), med negativ kontroll", async () => {
    const offenders = await untenantedAnomalyUpdates();
    expect(offenders).toEqual([]);
    expect(untenanted("UPDATE ${table} SET anomaly_flags = (SELECT 1) WHERE ${idColumn} = $1")).toHaveLength(1); // negativ kontroll: det gamle mønsteret fanges
    expect(untenanted("UPDATE ${table} SET anomaly_flags = (SELECT 1) WHERE tenant_id = $3 AND ${idColumn} = $1")).toHaveLength(0);
    expect(untenanted("UPDATE t SET updated_at = now() WHERE id = $1")).toHaveLength(0); // uten anomaly_flags er ikke vaktens sak
  });
});

/** Alle mal-literaler (backtick-strenger) i en kilde som oppdaterer `anomaly_flags` uten `tenant_id = $n`. */
function untenanted(src: string): string[] {
  const hits: string[] = [];
  for (const m of `\`${src}\``.matchAll(/`([^`]*)`/g)) {
    const t = m[1]!;
    if (/UPDATE[\s\S]*anomaly_flags/.test(t) && !/tenant_id\s*=\s*\$\d/.test(t)) hits.push(t.slice(0, 80));
  }
  return hits;
}
async function untenantedAnomalyUpdates(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const offenders: string[] = [];
  for (const name of (await readdir(SRC)).filter((n) => n.endsWith(".ts"))) {
    const src = await readFile(join(SRC, name), "utf8");
    for (const m of src.matchAll(/`([^`]*)`/g)) {
      const t = m[1]!;
      if (/UPDATE[\s\S]*anomaly_flags/.test(t) && !/tenant_id\s*=\s*\$\d/.test(t)) offenders.push(`${name}: ${t.slice(0, 80)}`);
    }
  }
  return offenders;
}

// ===========================================================================
// K9c: oppfrisking av Stripe-refusjon
// ===========================================================================

describe("K9c: refreshStripeRefundState (tre faser) og sveipet", () => {
  const WEBHOOK_SECRET = ["whsec", "fixture", "fin2", "k9c"].join("_");
  const credentials: StripeCredentialsProvider = { async getCredentials(): Promise<StripeCredentials | null> { return { secretKey: ["sk", "test", "fixture"].join("_") }; } };
  let tenant = TENANT_A;
  class Writer implements StripePaymentWriter {
    getRefundCalls: string[] = [];
    onGetRefund: (id: string) => Promise<StripeRefundObject> = async (id) => ({ id, object: "refund", amount: 4_000, currency: "nok", status: "pending", payment_intent: "pi_x", reason: null });
    onGetPaymentIntent: (id: string) => Promise<StripePaymentIntentObject> = async (id) => ({ id, object: "payment_intent", amount: 10_000, currency: "nok", status: "succeeded", metadata: {} });
    async createPaymentIntent(i: { amountOre: number; currency: string; metadata: Record<string, string> }): Promise<StripePaymentIntentObject> {
      return { id: `pi_k9c_${randomUUID().slice(0, 8)}`, object: "payment_intent", amount: i.amountOre, currency: i.currency.toLowerCase(), status: "requires_payment_method", metadata: i.metadata };
    }
    async getPaymentIntent(id: string): Promise<StripePaymentIntentObject> { return this.onGetPaymentIntent(id); }
    async createRefund(i: { stripePaymentIntentId: string; amountOre: number }): Promise<StripeRefundObject> {
      return { id: `re_k9c_${randomUUID().slice(0, 8)}`, object: "refund", amount: i.amountOre, currency: "nok", status: "pending", payment_intent: i.stripePaymentIntentId, reason: null };
    }
    async getRefund(id: string): Promise<StripeRefundObject> { this.getRefundCalls.push(id); return this.onGetRefund(id); }
    async getBalance(): Promise<StripeBalanceObject> { throw new Error("not_used"); }
  }
  let writer: Writer;
  let svc: FinanceService;
  const fresh = (t = TENANT_A): void => { tenant = t; writer = new Writer(); svc = new FinanceService(appPool, undefined, credentials, () => writer, () => WEBHOOK_SECRET, () => tenant); };

  /** Betalt (settled) Stripe-intensjon + en innsendt refusjon som venter hos leverandøren (`pending` -> provider_acknowledged). */
  async function pendingRefund(amountOre = 4_000): Promise<{ intent: PaymentIntent; refund: StripeRefund }> {
    const draft = await svc.createPaymentIntent(tenant, "business", { idempotency_key: `idem-${randomUUID()}`, purpose: "K9c", amount_ore: 10_000, vendor_name: "Kunde AS", account_code: "stripe-category", provider: "stripe" });
    const submitted = await svc.submitPaymentIntent(tenant, "business", draft.payment_intent_id, {} as never);
    const settled = await svc.refreshStripePaymentState(tenant, "business", submitted.payment_intent_id);
    expect(settled.state).toBe("settled");
    const created = await svc.createStripeRefund(tenant, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: settled.payment_intent_id, amount_ore: amountOre });
    const refund = await svc.submitStripeRefund(tenant, "business", created.refund_id);
    expect(refund.state).toBe("provider_acknowledged");
    expect(refund.provider_ref).toBeTruthy();
    return { intent: settled, refund };
  }
  const refundOut = (id: string, over: Partial<StripeRefundObject>): StripeRefundObject => ({ id, object: "refund", amount: 4_000, currency: "nok", status: "pending", payment_intent: "pi_x", reason: null, ...over });

  beforeAll(() => fresh());

  it("succeeded -> settled (med settled_at); pending -> uendret; failed/canceled -> failed/cancelled", async () => {
    const ok = await pendingRefund();
    writer.onGetRefund = async (id) => refundOut(id, { status: "succeeded" });
    const settled = await svc.refreshStripeRefundState(tenant, "business", ok.refund.refund_id);
    expect(settled.state).toBe("settled");
    expect(settled.settled_at).not.toBeNull();

    const waiting = await pendingRefund();
    writer.onGetRefund = async (id) => refundOut(id, { status: "pending" });
    expect((await svc.refreshStripeRefundState(tenant, "business", waiting.refund.refund_id)).state).toBe("provider_acknowledged");

    const bad = await pendingRefund();
    writer.onGetRefund = async (id) => refundOut(id, { status: "failed" });
    expect((await svc.refreshStripeRefundState(tenant, "business", bad.refund.refund_id)).state).toBe("failed");

    const gone = await pendingRefund();
    writer.onGetRefund = async (id) => refundOut(id, { status: "canceled" });
    expect((await svc.refreshStripeRefundState(tenant, "business", gone.refund.refund_id)).state).toBe("cancelled");
  });

  it("tre faser: fra INNSIDEN av getRefund står ingen app-forbindelse idle-in-transaction og raden er ikke radlåst", async () => {
    const r = await pendingRefund();
    let probe: { idle: number; free: boolean } | null = null;
    writer.onGetRefund = async (id) => {
      const idle = ((await adminPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = $1 AND state LIKE 'idle in transaction%'", [APP_ROLE])).rows[0] as { n: number }).n;
      const c = await adminPool.connect();
      let free = true;
      try { await c.query("BEGIN"); await c.query("SELECT 1 FROM stripe_refunds WHERE refund_id = $1 FOR UPDATE NOWAIT", [r.refund.refund_id]); } catch { free = false; } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
      probe = { idle, free };
      return refundOut(id, { status: "succeeded" });
    };
    await svc.refreshStripeRefundState(tenant, "business", r.refund.refund_id);
    expect(probe).toEqual({ idle: 0, free: true });
  });

  it("svar for et ANNET objekt anvendes aldri (id-mismatch = typet lesefeil, tilstanden står)", async () => {
    const r = await pendingRefund();
    writer.onGetRefund = async () => refundOut("re_someone_else", { status: "succeeded" });
    await expect(svc.refreshStripeRefundState(tenant, "business", r.refund.refund_id)).rejects.toThrow(ProviderResponseInvalidError);
    expect((await svc.getStripeRefund(tenant, "business", r.refund.refund_id))?.state).toBe("provider_acknowledged");
  });

  it("beløps-/valutaekko som avviker gir REFUND_AMOUNT_CONFLICT på refusjonen og betalingen (aldri stille)", async () => {
    const r = await pendingRefund();
    writer.onGetRefund = async (id) => refundOut(id, { status: "succeeded", amount: 3_999 });
    const refreshed = await svc.refreshStripeRefundState(tenant, "business", r.refund.refund_id);
    expect(refreshed.anomaly_flags).toContain("REFUND_AMOUNT_CONFLICT");
    expect((await svc.getPaymentIntent(tenant, "business", r.intent.payment_intent_id))?.anomaly_flags).toContain("REFUND_AMOUNT_CONFLICT");
  });

  it("allerede avsluttet lokalt og leverandøren sier noe annet = WEBHOOK_STATE_CONFLICT, tilstanden endres ikke (samme regler som webhooken)", async () => {
    const r = await pendingRefund();
    writer.onGetRefund = async (id) => refundOut(id, { status: "succeeded" });
    await svc.refreshStripeRefundState(tenant, "business", r.refund.refund_id);
    writer.onGetRefund = async (id) => refundOut(id, { status: "failed" });
    const after = await svc.refreshStripeRefundState(tenant, "business", r.refund.refund_id);
    expect(after.state).toBe("settled");
    expect(after.anomaly_flags).toContain("WEBHOOK_STATE_CONFLICT");
  });

  it("ukjent refusjon -> RefundNotFoundError; en annen tenants refusjon er usynlig; en refusjon uten leverandørreferanse kaller ikke leverandøren", async () => {
    await expect(svc.refreshStripeRefundState(tenant, "business", "fin-rf-does-not-exist")).rejects.toThrow(RefundNotFoundError);
    const r = await pendingRefund();
    await expect(svc.refreshStripeRefundState(TENANT_B, "business", r.refund.refund_id)).rejects.toThrow(RefundNotFoundError);
    const draftIntent = await svc.createPaymentIntent(tenant, "business", { idempotency_key: `idem-${randomUUID()}`, purpose: "K9c-draft", amount_ore: 10_000, vendor_name: "Kunde AS", account_code: "stripe-category", provider: "stripe" });
    const submitted = await svc.submitPaymentIntent(tenant, "business", draftIntent.payment_intent_id, {} as never);
    await svc.refreshStripePaymentState(tenant, "business", submitted.payment_intent_id);
    const draftRefund = await svc.createStripeRefund(tenant, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: submitted.payment_intent_id, amount_ore: 1_000 });
    writer.getRefundCalls.length = 0;
    expect((await svc.refreshStripeRefundState(tenant, "business", draftRefund.refund_id)).state).toBe("draft");
    expect(writer.getRefundCalls).toEqual([]);
  });

  it("sveipet (syncPendingStripePayments) oppfrisker ventende refusjoner med feilisolasjon: én som feiler velter ikke de andre", async () => {
    fresh(TENANT_C);
    const good = await pendingRefund();
    const broken = await pendingRefund();
    const done = await pendingRefund();
    writer.onGetRefund = async (id) => {
      if (id === broken.refund.provider_ref) throw new Error("provider_down");
      return refundOut(id, { status: id === done.refund.provider_ref ? "failed" : "succeeded" });
    };
    const result = await svc.syncPendingStripePayments(TENANT_C, "business");
    expect(result).toEqual({ synced: 2, failed: 1 });
    expect((await svc.getStripeRefund(TENANT_C, "business", good.refund.refund_id))?.state).toBe("settled");
    expect((await svc.getStripeRefund(TENANT_C, "business", done.refund.refund_id))?.state).toBe("failed");
    expect((await svc.getStripeRefund(TENANT_C, "business", broken.refund.refund_id))?.state).toBe("provider_acknowledged");
  });
});
