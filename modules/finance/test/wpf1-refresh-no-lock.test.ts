import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { BankingService, FinanceService, type NeonomicsCredentials, type NeonomicsGateway } from "../src/index.ts";
import { Gate } from "./wpf1-fakes.ts";

/**
 * WP-F1 (D-453, JARVIS-019): leverandørlesing (`refresh*PaymentState`, `getNeonomicsPaymentAuthorizationUrl`) skjer UTEN åpen DB-transaksjon og UTEN radlås.
 * Beviset er målt fra innsiden av selve leverandørkallet: testdoblen sjekker mot ekte Postgres (a) at appens forbindelser ikke står `idle in transaction` og
 * (b) at `FOR UPDATE NOWAIT` på intensjonsraden lykkes (ingen lås holdes over nettverkskallet). Negativ kontroll viser at proben faktisk SER både lås og åpen tx.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-wpf1-nolock";
const APP_ROLE = "jarvis_wpf1_nolock";
const STRIPE_SECRET = "not-a-real-stripe-webhook-secret-fixture-nolock";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-nolock-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${APP_ROLE}`);
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 nolock', 'business')`);
  appPool = createPool({ ...base, user: APP_ROLE, password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

interface Probe { idleInTransaction: number; rowLockFree: boolean }

/** Kjøres fra INNSIDEN av leverandørkallet: er det en åpen app-transaksjon eller en radlås på intensjonen akkurat nå? */
async function probe(paymentIntentId: string): Promise<Probe> {
  const idle = (await adminPool.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = $1 AND state LIKE 'idle in transaction%'", [APP_ROLE]
  )).rows[0] as { n: number };
  const client = await adminPool.connect();
  let rowLockFree = true;
  try {
    await client.query("BEGIN");
    await client.query("SELECT 1 FROM payment_intents WHERE payment_intent_id = $1 FOR UPDATE NOWAIT", [paymentIntentId]);
  } catch {
    rowLockFree = false;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  return { idleInTransaction: idle.n, rowLockFree };
}

async function acknowledgedIntent(svc: FinanceService, provider: "stripe" | "vipps" | "neonomics", providerRef: string, status: string, extra: Record<string, unknown> = {}): Promise<string> {
  const intent = await svc.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "nolock", amount_ore: 10_000, vendor_name: `V ${randomUUID().slice(0, 6)}`, account_code: "kategori", provider, ...extra
  } as never);
  await adminPool.query(
    "UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = $2, provider_status = $3, provider_status_updated_at = now() - interval '1 hour' WHERE payment_intent_id = $1",
    [intent.payment_intent_id, providerRef, status]
  );
  return intent.payment_intent_id;
}

describe("A: negativ kontroll - proben ser faktisk en holdt lås og en åpen app-transaksjon", () => {
  it("holdt FOR UPDATE gir rowLockFree=false; en åpen app-transaksjon gir idleInTransaction >= 1", async () => {
    const svc = new FinanceService(appPool);
    const id = (await svc.createPaymentIntent(TENANT, "business", { idempotency_key: `idem-${randomUUID()}`, purpose: "kontroll", amount_ore: 100, vendor_name: "K", account_code: "kategori", provider: "stripe" } as never)).payment_intent_id;
    const holder = await adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM payment_intents WHERE payment_intent_id = $1 FOR UPDATE", [id]);
      expect((await probe(id)).rowLockFree).toBe(false);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await probe(id)).rowLockFree).toBe(true);

    const appTx = await appPool.connect();
    try {
      await appTx.query("BEGIN");
      await appTx.query("SELECT 1");
      expect((await probe(id)).idleInTransaction).toBeGreaterThanOrEqual(1);
    } finally {
      await appTx.query("ROLLBACK");
      appTx.release();
    }
    expect((await probe(id)).idleInTransaction).toBe(0);
  });
});

describe("B: Stripe/Vipps - oppfrisking holder verken transaksjon eller lås over leverandørkallet", () => {
  it("refreshStripePaymentState: leverandørlesingen skjer uten åpen app-tx og uten radlås, og utfallet anvendes etterpå", async () => {
    let observed: Probe | undefined;
    let id = "";
    const stripe = {
      getPaymentIntent: async (providerId: string) => {
        observed = await probe(id);
        return { id: providerId, object: "payment_intent" as const, amount: 10_000, currency: "nok", status: "succeeded", metadata: {} };
      }
    };
    const svc = new FinanceService(appPool, undefined, { getCredentials: async () => ({ secretKey: "sk_test_fixture_not_real" }) }, () => stripe as never);
    id = await acknowledgedIntent(svc, "stripe", `pi_nolock_${randomUUID().slice(0, 8)}`, "requires_payment_method");
    const refreshed = await svc.refreshStripePaymentState(TENANT, "business", id);
    expect(observed).toEqual({ idleInTransaction: 0, rowLockFree: true });
    expect(refreshed.state).toBe("settled");
    expect(refreshed.provider_status).toBe("succeeded");
  });

  it("refreshVippsPaymentState: samme garanti", async () => {
    let observed: Probe | undefined;
    let id = "";
    const vipps = {
      getPayment: async (reference: string) => {
        observed = await probe(id);
        return { reference, state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } };
      }
    };
    const svc = new FinanceService(
      appPool, undefined, undefined, undefined, undefined, undefined,
      { getCredentials: async () => ({ clientId: "c", clientSecret: "s-fixture", subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" as const }) }, () => vipps as never
    );
    id = await acknowledgedIntent(svc, "vipps", `fin-pi-nolock-${randomUUID().slice(0, 8)}`, "CREATED");
    const refreshed = await svc.refreshVippsPaymentState(TENANT, "business", id);
    expect(observed).toEqual({ idleInTransaction: 0, rowLockFree: true });
    expect(refreshed.provider_status).toBe("AUTHORIZED");
  });

  it("en webhook-hendelse som oppstår MENS leverandørlesingen pågår blokkeres ikke av oppfriskingen - og en eldre lesing overskriver aldri den nyere tilstanden", async () => {
    const gate = new Gate();
    let inFlight!: () => void;
    const started = new Promise<void>((resolve) => { inFlight = resolve; });
    const stripe = {
      getPaymentIntent: async (providerId: string) => {
        inFlight();
        await gate.promise; // lesingen henger hos leverandøren
        return { id: providerId, object: "payment_intent" as const, amount: 10_000, currency: "nok", status: "requires_payment_method", metadata: {} };
      }
    };
    const svc = new FinanceService(
      appPool, undefined, { getCredentials: async () => ({ secretKey: "sk_test_fixture_not_real" }) }, () => stripe as never, () => STRIPE_SECRET, () => TENANT
    );
    const ref = `pi_race_${randomUUID().slice(0, 8)}`;
    const id = await acknowledgedIntent(svc, "stripe", ref, "requires_payment_method");

    const refresh = svc.refreshStripePaymentState(TENANT, "business", id);
    await started;
    // hendelsen er NYERE enn lesingen (oppstod etter at lesingen startet) og anvendes mens lesingen fortsatt henger
    const raw = Buffer.from(JSON.stringify({
      id: `evt_${randomUUID().slice(0, 12)}`, type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000) + 5,
      data: { object: { id: ref, object: "payment_intent", amount: 10_000, currency: "nok", status: "succeeded" } }
    }));
    const t = Math.floor(Date.now() / 1000);
    const header = `t=${t},v1=${createHmac("sha256", STRIPE_SECRET).update(`${t}.${raw.toString("utf8")}`, "utf8").digest("hex")}`;
    const timeout = new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 8_000));
    const webhook = await Promise.race([svc.ingestStripeWebhookEvent(raw, header), timeout]);
    expect(webhook).not.toBe("blocked"); // ingen radlås holdes over leverandørkallet
    expect((webhook as { status: string }).status).toBe("processed");

    gate.open();
    const refreshed = await refresh;
    // den eldre lesingen ('requires_payment_method') ble forkastet som foreldet - tilstanden er den nyere hendelsens
    expect(refreshed.state).toBe("settled");
    expect(refreshed.provider_status).toBe("succeeded");
    const row = (await adminPool.query("SELECT state, provider_status FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as { state: string; provider_status: string };
    expect(row).toEqual({ state: "settled", provider_status: "succeeded" });
  });

  it("aldri innsendt intensjon (ingen provider_ref): ingen leverandørkall og ingen credential-oppslag", async () => {
    let calls = 0;
    const svc = new FinanceService(
      appPool, undefined, { getCredentials: async () => { calls += 1; return { secretKey: "sk_test_fixture_not_real" }; } },
      () => ({ getPaymentIntent: async () => { calls += 1; throw new Error("skal ikke kalles"); } }) as never
    );
    const draft = await svc.createPaymentIntent(TENANT, "business", { idempotency_key: `idem-${randomUUID()}`, purpose: "draft", amount_ore: 100, vendor_name: "D", account_code: "kategori", provider: "stripe" } as never);
    const result = await svc.refreshStripePaymentState(TENANT, "business", draft.payment_intent_id);
    expect(result.state).toBe("draft");
    expect(calls).toBe(0);
  });
});

describe("C: Neonomics - oppfrisking og SCA-URL uten åpen transaksjon", () => {
  /** Minimal bankgateway: kun det samtykke-/konto-/betalingsflyten trenger; alt annet kaster. */
  function bankGateway(onRead: () => Promise<void>): NeonomicsGateway {
    return new Proxy({}, {
      get: (_t, name: string | symbol) => {
        if (typeof name !== "string" || name === "then") return undefined;
        switch (name) {
          case "createSession": return async (bankId: string) => ({ sessionId: `sess-${bankId}-${randomUUID()}` });
          case "getConsentUrl": return async (sessionId: string, redirectUrl: string) => ({ url: `https://bank.example.test/sca?session=${sessionId}&redirect=${encodeURIComponent(redirectUrl)}` });
          case "listAccounts": return async () => [{ id: "prov-acc-1", accountName: "Konto", accountNumber: "12345678903", currency: "NOK", accountType: "checking" }];
          case "getPayment": return async (_sessionId: string, paymentId: string) => { await onRead(); return { id: paymentId, status: "ACSC" }; };
          case "getPaymentAuthorizeUrl": return async (_sessionId: string, paymentId: string) => { await onRead(); return { url: `https://bank.example.test/pay?payment=${paymentId}` }; };
          default: return async () => { throw new Error(`unexpected_gateway_call:${name}`); };
        }
      }
    }) as unknown as NeonomicsGateway;
  }
  const credentials: NeonomicsCredentials = { clientId: "fake-client", clientSecret: "fake-secret-fixture", deviceId: "11111111-2222-3333-4444-555555555555", environment: "sandbox" };

  it("refreshNeonomicsPaymentState og getNeonomicsPaymentAuthorizationUrl: banklesingen holder verken tx eller lås", async () => {
    const observed: Probe[] = [];
    let id = "";
    const gateway = bankGateway(async () => { observed.push(await probe(id)); });
    const provider = { getCredentials: async () => credentials };
    const banking = new BankingService(appPool, provider, () => gateway);
    const svc = new FinanceService(appPool, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, provider, () => gateway);

    const consent = await banking.createConsent(TENANT, "business", { bank_id: "dnb-no", bank_name: "DNB" });
    const { callback_state } = await banking.getConsentAuthorizationUrl(TENANT, "business", consent.consent_id, "https://jarvis.internal/bank/callback");
    await banking.completeConsentCallback(TENANT, "business", consent.consent_id, callback_state);
    await banking.syncAccounts(TENANT, "business", consent.consent_id);
    const account = (await banking.listBankAccounts(TENANT, "business")).find((a) => a.consent_id === consent.consent_id)!;

    id = await acknowledgedIntent(svc, "neonomics", `neo-pay-${randomUUID().slice(0, 8)}`, "PDNG", { vendor_provider_ref: "98765432101", counter_account_code: account.bank_account_id });
    const refreshed = await svc.refreshNeonomicsPaymentState(TENANT, "business", id);
    expect(refreshed.state).toBe("settled");
    const { url } = await svc.getNeonomicsPaymentAuthorizationUrl(TENANT, "business", id, "https://jarvis.internal/bank/payment-callback");
    expect(url).toContain("bank.example.test/pay");
    expect(observed).toEqual([{ idleInTransaction: 0, rowLockFree: true }, { idleInTransaction: 0, rowLockFree: true }]);
  });
});
