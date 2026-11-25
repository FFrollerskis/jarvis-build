import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  BankingService,
  CardService,
  FinanceService,
  type NeonomicsCredentials,
  type NeonomicsGateway,
  type WallesterCredentials,
  type WallesterGateway
} from "../src/index.ts";

/**
 * WP-FIN2 K1(b) (D-486, JARVIS-019-resten): KJØRETIDSPROBE som `wpf1-refresh-no-lock.test.ts`, men for kort- og banktjenestene. Ledgerrad 019 sto med «Åpent: kort-/bank-/spend-tjenester ligger fortsatt i
 * transaksjon». Beviset er målt fra INNSIDEN av selve leverandørkallet mot ekte Postgres: (a) appens forbindelser står ikke `idle in transaction`, og (b) `FOR UPDATE NOWAIT` på raden tjenesten nettopp
 * låste lykkes (ingen radlås holdes over nettverkskallet). Dekker `CardService.{submitCard, lifecycleAction (activate/freeze/unfreeze/close), updateSpendPolicy, syncCardState, syncAuthorizations, syncTransactions}`
 * og `BankingService.{createConsent, getConsentAuthorizationUrl, verifyConsent, syncAccounts, syncBalances, syncTransactions}`. NEGATIV KONTROLL (A): proben SER faktisk både en holdt lås og en åpen app-transaksjon.
 * Kildevakten som låser det samme statisk: `fin2-no-provider-io-in-tx.test.ts`.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-fin2-nolock";
const APP_ROLE = "jarvis_fin2_nolock";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-nolock-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${APP_ROLE}`);
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 nolock', 'business')`);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ('person-fin2-nolock', 'Owner') ON CONFLICT DO NOTHING");
  appPool = createPool({ ...base, user: APP_ROLE, password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

interface Probe { idleInTransaction: number; rowLockFree: boolean }
/** Kjøres fra INNSIDEN av leverandørkallet: er det en åpen app-transaksjon, eller en radlås på raden som nettopp ble behandlet? `table`/`idColumn` er hvitelistet av kalleren. */
async function probe(table: "provider_cards" | "bank_consents" | "bank_accounts" | null, idColumn: string, id: string): Promise<Probe> {
  const idle = (await adminPool.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = $1 AND state LIKE 'idle in transaction%'", [APP_ROLE]
  )).rows[0] as { n: number };
  let rowLockFree = true;
  if (table !== null) {
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT 1 FROM ${table} WHERE ${idColumn} = $1 FOR UPDATE NOWAIT`, [id]);
    } catch {
      rowLockFree = false;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
  return { idleInTransaction: idle.n, rowLockFree };
}
const CLEAN: Probe = { idleInTransaction: 0, rowLockFree: true };

describe("A: negativ kontroll - proben ser faktisk en holdt lås og en åpen app-transaksjon", () => {
  it("holdt FOR UPDATE gir rowLockFree=false; åpen app-transaksjon gir idleInTransaction >= 1", async () => {
    const cards = new CardService(appPool);
    const card = await cards.createCard(TENANT, "business", { idempotency_key: `k-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual", currency: "EUR" });
    const holder = await adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM provider_cards WHERE card_id = $1 FOR UPDATE", [card.card_id]);
      expect((await probe("provider_cards", "card_id", card.card_id)).rowLockFree).toBe(false);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await probe("provider_cards", "card_id", card.card_id)).rowLockFree).toBe(true);
    const appTx = await appPool.connect();
    try {
      await appTx.query("BEGIN");
      await appTx.query("SELECT 1");
      expect((await probe(null, "", "")).idleInTransaction).toBeGreaterThanOrEqual(1);
    } finally {
      await appTx.query("ROLLBACK");
      appTx.release();
    }
    expect((await probe(null, "", "")).idleInTransaction).toBe(0);
  });
});

describe("B: CardService - leverandørkallet holder verken transaksjon eller radlås", () => {
  const creds: WallesterCredentials = { baseUrl: "https://wallester.invalid", apiKey: "fixture-key", sign: () => "sig", accountId: "wacc-1", environment: "sandbox" };
  const observed: Array<{ op: string; probe: Probe }> = [];
  let cardId = "";
  const record = async (op: string): Promise<void> => { observed.push({ op, probe: await probe("provider_cards", "card_id", cardId) }); };
  const card = (status: string) => ({ id: `wcard-${cardId}`, status, maskedCardNumber: "…4321", accountId: "wacc-1", tokenizationStatus: null });
  const gateway = {
    createCard: async () => { await record("createCard"); return card("active"); },
    getCard: async () => { await record("getCard"); return card("active"); },
    activateCard: async () => { await record("activateCard"); return card("active"); },
    blockCard: async () => { await record("blockCard"); return card("blocked"); },
    unblockCard: async () => { await record("unblockCard"); return card("active"); },
    closeCard: async () => { await record("closeCard"); return card("closed"); },
    updateCardLimits: async (_id: string, limits: object) => { await record("updateCardLimits"); return { ...limits, confirmed: true }; },
    listAuthorizations: async () => { await record("listAuthorizations"); return { items: [], nextPageToken: null }; },
    listTransactions: async () => { await record("listTransactions"); return { items: [], nextPageToken: null }; },
    getAccountBalance: async () => ({ accountId: "wacc-1", availableAmountOre: 1, currency: "EUR" })
  } as unknown as WallesterGateway;
  const cards = () => new CardService(appPool, { getCredentials: async () => creds }, () => gateway, () => null, () => TENANT);

  it("submitCard, freeze/unfreeze/activate/close (lifecycleAction), updateSpendPolicy, syncCardState, syncAuthorizations og syncTransactions: leverandørkallet står uten åpen tx og uten radlås", async () => {
    const svc = cards();
    const draft = await svc.createCard(TENANT, "business", { idempotency_key: `k-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual", currency: "EUR", requested_daily_limit_ore: 50_000 });
    cardId = draft.card_id;
    await svc.submitCard(TENANT, "business", cardId);
    await svc.freezeCard(TENANT, "business", cardId);
    await svc.unfreezeCard(TENANT, "business", cardId);
    await svc.updateSpendPolicy(TENANT, "business", cardId, { requested_daily_limit_ore: 40_000 });
    await svc.syncCardState(TENANT, "business", cardId);
    await svc.syncAuthorizations(TENANT, "business", cardId);
    await svc.syncTransactions(TENANT, "business", cardId);
    await svc.closeCard(TENANT, "business", cardId);
    // activateCard: et nytt kort som står i pending_provider
    const second = await svc.createCard(TENANT, "business", { idempotency_key: `k-${randomUUID()}`, name: "K2", purpose: "P", card_type: "virtual", currency: "EUR" });
    cardId = second.card_id;
    gateway.createCard = (async () => { await record("createCard#2"); return card("awaitingactivation"); }) as never;
    await svc.submitCard(TENANT, "business", cardId);
    await svc.activateCard(TENANT, "business", cardId);

    const ops = observed.map((o) => o.op);
    for (const op of ["createCard", "blockCard", "unblockCard", "updateCardLimits", "getCard", "listAuthorizations", "listTransactions", "closeCard", "createCard#2", "activateCard"]) expect(ops, op).toContain(op);
    for (const o of observed) expect(o.probe, o.op).toEqual(CLEAN);
  });

  it("en provider-feil i submitCard rydder uten å holde lås (siste probe er fortsatt ren)", async () => {
    const failing = { ...gateway, createCard: async () => { await record("createCard#fail"); throw Object.assign(new Error("wallester_api_failed_422:x"), { httpStatus: 422 }); } } as unknown as WallesterGateway;
    const svc = new CardService(appPool, { getCredentials: async () => creds }, () => failing, () => null, () => TENANT);
    const draft = await svc.createCard(TENANT, "business", { idempotency_key: `k-${randomUUID()}`, name: "K3", purpose: "P", card_type: "virtual", currency: "EUR" });
    cardId = draft.card_id;
    await expect(svc.submitCard(TENANT, "business", cardId)).rejects.toThrow("wallester_api_failed_422");
    expect(observed.find((o) => o.op === "createCard#fail")!.probe).toEqual(CLEAN);
  });
});

describe("C: BankingService - leverandørkallet holder verken transaksjon eller radlås", () => {
  const creds: NeonomicsCredentials = { clientId: "fake-client", clientSecret: "fake-secret-fixture", deviceId: "11111111-2222-3333-4444-555555555555", environment: "sandbox" };
  const observed: Array<{ op: string; probe: Probe }> = [];
  let consentId = "";
  let accountRowId = "";
  const record = async (op: string, table: "bank_consents" | "bank_accounts" | null = "bank_consents"): Promise<void> => {
    observed.push({ op, probe: await probe(table, table === "bank_accounts" ? "bank_account_id" : "consent_id", table === "bank_accounts" ? accountRowId : consentId) });
  };
  const gateway = {
    createSession: async (bankId: string) => { await record("createSession", null); return { sessionId: `sess-${bankId}-${randomUUID()}` }; },
    getConsentUrl: async () => { await record("getConsentUrl"); return { url: "https://bank.example.test/sca" }; },
    listAccounts: async () => { await record("listAccounts"); return [{ id: "prov-acc-1", accountName: "Konto", accountNumber: "12345678903", currency: "NOK", accountType: "checking" }]; },
    getBalances: async () => { await record("getBalances", "bank_accounts"); return [{ type: "closingBooked", amountOre: 1_000, currency: "NOK", referenceDate: null }]; },
    listTransactions: async () => { await record("listTransactions", "bank_accounts"); return { transactions: [], nextPageToken: null }; },
    listBanks: async () => []
  } as unknown as NeonomicsGateway;

  it("createConsent, getConsentAuthorizationUrl, verifyConsent, syncAccounts, syncBalances og syncTransactions: leverandørkallet står uten åpen tx og uten radlås", async () => {
    const svc = new BankingService(appPool, { getCredentials: async () => creds }, () => gateway);
    const consent = await svc.createConsent(TENANT, "business", { bank_id: "dnb-no", bank_name: "DNB" });
    consentId = consent.consent_id;
    const { callback_state } = await svc.getConsentAuthorizationUrl(TENANT, "business", consentId, "https://jarvis.internal/bank/callback");
    await svc.completeConsentCallback(TENANT, "business", consentId, callback_state);
    await svc.verifyConsent(TENANT, "business", consentId);
    await svc.syncAccounts(TENANT, "business", consentId);
    accountRowId = (await svc.listBankAccounts(TENANT, "business")).find((a) => a.consent_id === consentId)!.bank_account_id;
    await svc.syncBalances(TENANT, "business", accountRowId);
    await svc.syncTransactions(TENANT, "business", accountRowId);

    const ops = observed.map((o) => o.op);
    for (const op of ["createSession", "getConsentUrl", "listAccounts", "getBalances", "listTransactions"]) expect(ops, op).toContain(op);
    expect(ops.filter((o) => o === "listAccounts").length).toBeGreaterThanOrEqual(2); // verifyConsent + syncAccounts
    for (const o of observed) expect(o.probe, o.op).toEqual(CLEAN);
  });

  it("FinanceService-sveipene (Stripe/Vipps/Neonomics sync) bruker de samme tre fasene - dekket av wpf1-refresh-no-lock.test.ts; her kun at BankingService ikke røres av en tom kø", async () => {
    const svc = new FinanceService(appPool);
    await expect(svc.syncPendingStripePayments(TENANT, "business")).resolves.toEqual({ synced: 0, failed: 0 });
  });
});
