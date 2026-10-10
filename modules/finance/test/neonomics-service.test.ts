import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { FinanceService } from "../src/service.ts";
import type { NeonomicsCredentials, NeonomicsCredentialsProvider } from "../src/service.ts";
import { BankingService, LARGE_DEBIT_THRESHOLD_ORE } from "../src/banking-service.ts";
import {
  BankAccountNotFoundError,
  BankCallbackStateMismatchError,
  BankConsentNotActiveError,
  NeonomicsCredentialsUnavailableError
} from "../src/banking-types.ts";
import type { BankConsent, BankTransaction } from "../src/banking-types.ts";
import { FinanceKillSwitchActiveError, InvalidWebhookSignatureError, type PaymentIntent } from "../src/types.ts";
import {
  NeonomicsConsentRequiredError,
  type NeonomicsAccount,
  type NeonomicsBalance,
  type NeonomicsBank,
  type NeonomicsGateway,
  type NeonomicsPaymentObject,
  type NeonomicsTransaction,
  type NeonomicsTransactionPage,
  type InitiateNeonomicsPaymentInput
} from "../src/neonomics-transport.ts";

/**
 * D-111 (UA-6 Slice 5): ekte Postgres/RLS-integrasjonsbevis for open-
 * banking-domenet (BankingService + FinanceService sin Neonomics-PIS-gren)
 * - SAMME harness-mønster som stripe-/vipps-service.test.ts: ekte embedded
 * Postgres, ekte tjenester, fake KUN ved NETTVERKSGRENSEN (injisert
 * NeonomicsGatewayFactory), ALDRI en adapter-omgåelse.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT_A = "tenant-neo-svc-a";
const TENANT_B = "tenant-neo-svc-b";
// BEVISST lav-entropi, åpenbart falsk verdi (gitleaks-lærdom fra D-109).
const WEBHOOK_API_KEY = "not-a-real-neonomics-webhook-api-key-svc";

/** Skriptbar fake ved Neonomics-transportens nettverksgrense. */
class ScriptedNeonomicsGateway implements NeonomicsGateway {
  initiateCalls: InitiateNeonomicsPaymentInput[] = [];
  sessionCounter = 0;

  onListBanks: () => Promise<NeonomicsBank[]> = async () => [{ id: "dnb-no", bankDisplayName: "DNB", countryCode: "NO" }];
  onListAccounts: (sessionId: string) => Promise<NeonomicsAccount[]> = async () => [
    { id: "prov-acc-1", accountName: "Bedriftskonto", accountNumber: "12345678903", currency: "NOK", accountType: "checking" }
  ];
  onGetBalances: (accountId: string) => Promise<NeonomicsBalance[]> = async () => [
    { type: "booked", amountOre: 1_500_000, currency: "NOK", referenceDate: "2026-08-26" },
    { type: "available", amountOre: 1_400_000, currency: "NOK", referenceDate: "2026-08-26" }
  ];
  onListTransactions: (accountId: string, pageToken: string | null) => Promise<NeonomicsTransactionPage> = async () => ({ transactions: [], nextPageToken: null });
  onInitiatePayment: (input: InitiateNeonomicsPaymentInput) => Promise<NeonomicsPaymentObject> = async () => ({ id: `neo-pay-${randomUUID()}`, status: "PDNG" });
  onGetPayment: (paymentId: string) => Promise<NeonomicsPaymentObject> = async (paymentId) => ({ id: paymentId, status: "PDNG" });

  async listBanks(): Promise<NeonomicsBank[]> {
    return this.onListBanks();
  }
  async createSession(bankId: string): Promise<{ sessionId: string }> {
    this.sessionCounter++;
    // Globalt unik per prosess: bank_consents har UNIQUE (tenant_id, provider,
    // provider_session_id) og radene overlever på tvers av tester i delt DB.
    return { sessionId: `sess-${bankId}-${randomUUID()}` };
  }
  async getConsentUrl(sessionId: string, redirectUrl: string): Promise<{ url: string }> {
    return { url: `https://bank.example.test/sca?session=${sessionId}&redirect=${encodeURIComponent(redirectUrl)}` };
  }
  async listAccounts(sessionId: string): Promise<NeonomicsAccount[]> {
    return this.onListAccounts(sessionId);
  }
  async getBalances(_sessionId: string, accountId: string): Promise<NeonomicsBalance[]> {
    return this.onGetBalances(accountId);
  }
  async listTransactions(_sessionId: string, accountId: string, pageToken: string | null): Promise<NeonomicsTransactionPage> {
    return this.onListTransactions(accountId, pageToken);
  }
  async initiateDomesticPayment(input: InitiateNeonomicsPaymentInput): Promise<NeonomicsPaymentObject> {
    this.initiateCalls.push(input);
    return this.onInitiatePayment(input);
  }
  async getPaymentAuthorizeUrl(_sessionId: string, paymentId: string, redirectUrl: string): Promise<{ url: string }> {
    return { url: `https://bank.example.test/sca-payment?payment=${paymentId}&redirect=${encodeURIComponent(redirectUrl)}` };
  }
  async getPayment(_sessionId: string, paymentId: string): Promise<NeonomicsPaymentObject> {
    return this.onGetPayment(paymentId);
  }
}

let gateway: ScriptedNeonomicsGateway;
let banking: BankingService;
let finance: FinanceService;
let configuredTenant: string | null = TENANT_A;

const credentialsProvider: NeonomicsCredentialsProvider = {
  async getCredentials(): Promise<NeonomicsCredentials | null> {
    return { clientId: "fake-client", clientSecret: "fake-secret-fixture", deviceId: "11111111-2222-3333-4444-555555555555", environment: "sandbox" };
  }
};
const noCredentialsProvider: NeonomicsCredentialsProvider = {
  async getCredentials(): Promise<NeonomicsCredentials | null> {
    return null;
  }
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-neo-svc-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_neo_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_neo_svc_test");
  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Neo Svc A', 'business'), ('${TENANT_B}', 'Neo Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-neo-owner', 'Owner Neo')`);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_neo_svc_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(async () => {
  // Full isolasjon mellom tester: tenant-vide sveip (avstemming/avviks-
  // deteksjon/betalingssynk) skal ALDRI se forrige tests rader i den delte
  // embedded-databasen. adminPool = test-fixture-manipulasjon (RLS-bypass).
  // Rekkefølge: barn-FK før forelder (samme regel som erasure-planen).
  // WP-F1 (review M-F3, migrasjon 101): sendte penge-rader (payment_intents/stripe_refunds/vipps_*) slettes kun i en erasure-transaksjon - fixturen rydder derfor i én transaksjon med
  // SAMME transaksjonslokale GUC som `ErasureService` setter (forsvinner ved COMMIT, gjelder kun disse DELETE-ene).
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jarvis.erasure_in_progress', 'true', true)");
    for (const table of [
      "bank_transactions", "bank_account_balances", "bank_accounts", "bank_consents",
      "neonomics_webhook_events", "stripe_refunds", "vipps_refunds",
      "payment_intent_events", "payment_intents"
    ]) {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
});

function freshServices(withCredentials = true): void {
  gateway = new ScriptedNeonomicsGateway();
  configuredTenant = TENANT_A;
  const provider = withCredentials ? credentialsProvider : noCredentialsProvider;
  banking = new BankingService(appPool, provider, () => gateway);
  finance = new FinanceService(
    appPool, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    provider, () => gateway, () => WEBHOOK_API_KEY, () => configuredTenant
  );
}

/** Full samtykke-flyt til 'active' - gjenbrukt av nesten alle seksjonene. */
async function activeConsent(tenant = TENANT_A): Promise<BankConsent> {
  const consent = await banking.createConsent(tenant, "business", { bank_id: "dnb-no", bank_name: "DNB" });
  const { callback_state } = await banking.getConsentAuthorizationUrl(tenant, "business", consent.consent_id, "https://jarvis.internal/bank/callback");
  return banking.completeConsentCallback(tenant, "business", consent.consent_id, callback_state);
}

async function syncedAccountId(tenant = TENANT_A): Promise<{ consent: BankConsent; bankAccountId: string }> {
  const consent = await activeConsent(tenant);
  await banking.syncAccounts(tenant, "business", consent.consent_id);
  const accounts = await banking.listBankAccounts(tenant, "business");
  const account = accounts.find((a) => a.consent_id === consent.consent_id);
  if (!account) throw new Error("test_setup_no_account");
  return { consent, bankAccountId: account.bank_account_id };
}

function providerTx(overrides: Partial<NeonomicsTransaction> = {}): NeonomicsTransaction {
  return {
    id: `prov-tx-${randomUUID()}`, status: "booked", amountOre: 25_000, direction: "debit", currency: "NOK",
    bookingDate: "2026-08-25", valueDate: "2026-08-25", counterpartyName: "Leverandør AS",
    referenceText: "Faktura 42", bankTransactionCode: "PMNT", ...overrides
  };
}

describe("A: samtykke-livssyklus", () => {
  it("create -> authorization_required -> active via korrekt callback-state", async () => {
    freshServices();
    const consent = await banking.createConsent(TENANT_A, "business", { bank_id: "dnb-no", bank_name: "DNB" });
    expect(consent.state).toBe("created");
    expect(consent.provider_session_id).toMatch(/^sess-dnb-no-/);

    const { url, callback_state } = await banking.getConsentAuthorizationUrl(TENANT_A, "business", consent.consent_id, "https://jarvis.internal/bank/callback");
    expect(url).toContain("bank.example.test/sca");
    const afterUrl = await banking.getConsent(TENANT_A, "business", consent.consent_id);
    expect(afterUrl?.state).toBe("authorization_required");

    const active = await banking.completeConsentCallback(TENANT_A, "business", consent.consent_id, callback_state);
    expect(active.state).toBe("active");
    expect(active.authorized_at).not.toBeNull();
    expect(active.callback_state).toBeNull(); // state konsumert - replay-vern.
  });

  it("avviser feil callback-state (CSRF) fail-closed", async () => {
    freshServices();
    const consent = await banking.createConsent(TENANT_A, "business", { bank_id: "dnb-no" });
    await banking.getConsentAuthorizationUrl(TENANT_A, "business", consent.consent_id, "https://jarvis.internal/bank/callback");
    await expect(banking.completeConsentCallback(TENANT_A, "business", consent.consent_id, "feil-state-verdi")).rejects.toThrow(BankCallbackStateMismatchError);
  });

  it("avviser REPLAYET callback (state allerede konsumert)", async () => {
    freshServices();
    const consent = await banking.createConsent(TENANT_A, "business", { bank_id: "dnb-no" });
    const { callback_state } = await banking.getConsentAuthorizationUrl(TENANT_A, "business", consent.consent_id, "https://jarvis.internal/bank/callback");
    await banking.completeConsentCallback(TENANT_A, "business", consent.consent_id, callback_state);
    await expect(banking.completeConsentCallback(TENANT_A, "business", consent.consent_id, callback_state)).rejects.toThrow(BankCallbackStateMismatchError);
  });

  it("revoke setter revoked + revoked_at; verifyConsent mot 1426 markerer 'expired'", async () => {
    freshServices();
    const consent = await activeConsent();
    const revoked = await banking.markConsentState(TENANT_A, "business", consent.consent_id, "revoked");
    expect(revoked.state).toBe("revoked");
    expect(revoked.revoked_at).not.toBeNull();

    const consent2 = await activeConsent();
    gateway.onListAccounts = async () => {
      throw new NeonomicsConsentRequiredError(consent2.provider_session_id!);
    };
    const expired = await banking.verifyConsent(TENANT_A, "business", consent2.consent_id);
    expect(expired.state).toBe("expired");
  });

  it("AIS-kall mot ikke-aktivt samtykke avvises BankConsentNotActiveError", async () => {
    freshServices();
    const consent = await banking.createConsent(TENANT_A, "business", { bank_id: "dnb-no" });
    await expect(banking.syncAccounts(TENANT_A, "business", consent.consent_id)).rejects.toThrow(BankConsentNotActiveError);
  });

  it("credential_unavailable fail-closed uten Neonomics-credentials", async () => {
    freshServices(false);
    await expect(banking.listBanks(TENANT_A)).rejects.toThrow(NeonomicsCredentialsUnavailableError);
  });
});

describe("B: kontodiscovery/-synk", () => {
  it("oppdager kontoer idempotent (rekjøring dupliserer aldri) og maskerer kontoidentifikatoren", async () => {
    freshServices();
    const consent = await activeConsent();
    const first = await banking.syncAccounts(TENANT_A, "business", consent.consent_id);
    expect(first.discovered).toBe(1);
    const second = await banking.syncAccounts(TENANT_A, "business", consent.consent_id);
    expect(second.discovered).toBe(0);
    expect(second.updated).toBe(1);
    const accounts = await banking.listBankAccounts(TENANT_A, "business");
    const account = accounts.find((a) => a.consent_id === consent.consent_id)!;
    expect(account.account_identifier_masked).toBe("…8903 (11)");
    expect(account.account_identifier_masked).not.toContain("1234567"); // aldri full identifikator.
  });

  it("konto som forsvinner hos provider inaktiveres (aldri slettes)", async () => {
    freshServices();
    const consent = await activeConsent();
    await banking.syncAccounts(TENANT_A, "business", consent.consent_id);
    gateway.onListAccounts = async () => [];
    const result = await banking.syncAccounts(TENANT_A, "business", consent.consent_id);
    expect(result.deactivated).toBe(1);
    const all = await banking.listBankAccounts(TENANT_A, "business", true);
    expect(all.some((a) => a.consent_id === consent.consent_id && !a.active)).toBe(true);
  });

  it("1426 under kontosynk mapper samtykket til 'expired' og kaster BankConsentNotActiveError", async () => {
    freshServices();
    const consent = await activeConsent();
    gateway.onListAccounts = async () => {
      throw new NeonomicsConsentRequiredError(consent.provider_session_id!);
    };
    await expect(banking.syncAccounts(TENANT_A, "business", consent.consent_id)).rejects.toThrow(BankConsentNotActiveError);
    const after = await banking.getConsent(TENANT_A, "business", consent.consent_id);
    expect(after?.state).toBe("expired");
  });
});

describe("C: saldo-synk", () => {
  it("bevarer flere saldotyper eksakt i øre (aldri kollapset, aldri flyttall)", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const result = await banking.syncBalances(TENANT_A, "business", bankAccountId);
    expect(result.observed).toBe(2);
    const balances = await banking.listBalances(TENANT_A, "business", bankAccountId);
    const types = balances.map((b) => b.balance_type).sort();
    expect(types).toEqual(["available", "booked"]);
    expect(Number(balances.find((b) => b.balance_type === "booked")!.amount_ore)).toBe(1_500_000);
  });
});

describe("D: transaksjonssynk", () => {
  it("første synk + idempotent re-synk + paginering", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const tx1 = providerTx();
    const tx2 = providerTx({ direction: "credit", amountOre: 99_900, counterpartyName: "Kunde AS" });
    gateway.onListTransactions = async (_acc, pageToken) =>
      pageToken === null ? { transactions: [tx1], nextPageToken: "page2" } : { transactions: [tx2], nextPageToken: null };
    const first = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    expect(first.inserted).toBe(2);
    expect(first.pages).toBe(2);
    const second = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    expect(second.inserted).toBe(0); // idempotent - null duplikater.
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    expect(rows).toHaveLength(2);
    // Retning eksplisitt bevart - kredit tvinges ALDRI inn i en spend-modell.
    expect(rows.find((r) => r.provider_transaction_id === tx2.id)?.direction).toBe("credit");
  });

  it("pending -> booked-overgang på SAMME rad (stabil provider-ID)", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const pending = providerTx({ status: "pending", bookingDate: null });
    gateway.onListTransactions = async () => ({ transactions: [pending], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    gateway.onListTransactions = async () => ({ transactions: [{ ...pending, status: "booked", bookingDate: "2026-08-26" }], nextPageToken: null });
    const result = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    expect(result.transitioned).toBe(1);
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("booked");
  });

  it("provider-korreksjon av BOOKET beløp flagges - etablert beløp overskrives ALDRI stille", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const tx = providerTx();
    gateway.onListTransactions = async () => ({ transactions: [tx], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    gateway.onListTransactions = async () => ({ transactions: [{ ...tx, amountOre: 99_999 }], nextPageToken: null });
    const result = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    expect(result.corrections_flagged).toBe(1);
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    expect(Number(rows[0]!.amount_ore)).toBe(25_000); // originalen bevart.
    expect(rows[0]!.anomaly_flags).toContain("BANK_TRANSACTION_CORRECTION_CONFLICT");
  });
});

describe("E: PIS-betalingsinitiering (FinanceService)", () => {
  async function neonomicsIntent(bankAccountId: string, overrides: Record<string, unknown> = {}): Promise<PaymentIntent> {
    return finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "Bankbetaling leverandør", amount_ore: 25_000,
      vendor_name: "Leverandør AS", vendor_provider_ref: "98765432101", account_code: "bank-leverandor",
      counter_account_code: bankAccountId, provider: "neonomics", ...overrides
    } as Parameters<FinanceService["createPaymentIntent"]>[2]);
  }

  it("initierer via aktivt samtykke - provider_acknowledged, ALDRI antatt oppgjort; endToEndReference = payment_intent_id", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const intent = await neonomicsIntent(bankAccountId);
    const submitted = await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    expect(submitted.state).toBe("provider_acknowledged");
    expect(submitted.provider_status).toBe("PDNG");
    expect(submitted.settled_at).toBeNull();
    expect(gateway.initiateCalls).toHaveLength(1);
    expect(gateway.initiateCalls[0]!.endToEndReference).toBe(intent.payment_intent_id);
    expect(gateway.initiateCalls[0]!.debtorAccountId).toBe("prov-acc-1");
  });

  it("retry kan aldri dobbelt-betale (idempotent no-op etter innsending)", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const intent = await neonomicsIntent(bankAccountId);
    await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    expect(gateway.initiateCalls).toHaveLength(1);
  });

  it("D-392: nettverksfeil/tidsavbrudd UNDER initiering = utfall ukjent: intensjonen forblir `submitted`, og retry sender ALDRI en ny bankbetaling", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const intent = await neonomicsIntent(bankAccountId);
    gateway.onInitiatePayment = async () => {
      throw new Error("network_timeout_simulated");
    };
    await expect(finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null })).rejects.toThrow("network_timeout_simulated");
    const after = await finance.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after?.state).toBe("submitted");
    expect(after?.provider_ref).toBeNull();
    gateway.onInitiatePayment = async () => ({ id: "neo-pay-retry", status: "PDNG" });
    await expect(finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null }))
      .rejects.toThrow("submit_outcome_unknown_reconcile_required");
    expect(gateway.initiateCalls).toHaveLength(1);
  });

  it("D-392: tydelig avvisning (4xx) UNDER initiering etterlater draft - korrigert retry er trygg og gjenbruker samme deterministiske referanse", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const intent = await neonomicsIntent(bankAccountId);
    gateway.onInitiatePayment = async () => {
      throw Object.assign(new Error("neonomics_api_error_400:bad_request"), { httpStatus: 400 });
    };
    await expect(finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null })).rejects.toThrow("bad_request");
    const after = await finance.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after?.state).toBe("draft");
    gateway.onInitiatePayment = async () => ({ id: "neo-pay-retry", status: "PDNG" });
    await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    expect(gateway.initiateCalls[0]!.endToEndReference).toBe(gateway.initiateCalls[1]!.endToEndReference);
  });

  it("debitor-konto MÅ tilhøre tenanten og være aktiv; samtykket MÅ være aktivt", async () => {
    freshServices();
    const intent = await neonomicsIntent("bank-ac-finnes-ikke");
    await expect(finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null })).rejects.toThrow(BankAccountNotFoundError);

    const { consent, bankAccountId } = await syncedAccountId();
    await banking.markConsentState(TENANT_A, "business", consent.consent_id, "revoked");
    const intent2 = await neonomicsIntent(bankAccountId);
    await expect(finance.submitPaymentIntent(TENANT_A, "business", intent2.payment_intent_id, { getCredentials: async () => null })).rejects.toThrow(BankConsentNotActiveError);
  });

  it("finans-nødbryteren blokkerer bankbetalinger (aktiv økonomisk handling)", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const intent = await neonomicsIntent(bankAccountId);
    await finance.enableKillSwitch(TENANT_A, "person-neo-owner", "test");
    try {
      await expect(finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null })).rejects.toThrow(FinanceKillSwitchActiveError);
      expect(gateway.initiateCalls).toHaveLength(0);
      // Passiv integritet upåvirket: avstemming/avviksdeteksjon kjører fortsatt.
      await expect(banking.reconcileBankTransactions(TENANT_A, "business")).resolves.toBeDefined();
      await expect(banking.runBankAnomalyDetection(TENANT_A, "business")).resolves.toBeDefined();
    } finally {
      await finance.disableKillSwitch(TENANT_A, "person-neo-owner");
    }
  });

  it("SCA-URL for initiert betaling hentes eksplisitt (bruker-handling - aldri autonom fullføring)", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const intent = await neonomicsIntent(bankAccountId);
    await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    const { url } = await finance.getNeonomicsPaymentAuthorizationUrl(TENANT_A, "business", intent.payment_intent_id, "https://jarvis.internal/bank/payment-callback");
    expect(url).toContain("sca-payment");
  });
});

describe("F: betalingsstatus-synk + webhook", () => {
  async function submittedIntent(): Promise<{ intent: PaymentIntent; bankAccountId: string }> {
    const { bankAccountId } = await syncedAccountId();
    const intent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "Statustest", amount_ore: 25_000,
      vendor_name: "Leverandør AS", vendor_provider_ref: "98765432101", account_code: "bank-status",
      counter_account_code: bankAccountId, provider: "neonomics"
    });
    const submitted = await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    return { intent: submitted, bankAccountId };
  }

  it("KUN ACSC mapper til settled - ACCP/PDNG forblir provider_acknowledged (accepted != settled)", async () => {
    freshServices();
    const { intent } = await submittedIntent();
    gateway.onGetPayment = async (id) => ({ id, status: "ACCP" });
    let refreshed = await finance.refreshNeonomicsPaymentState(TENANT_A, "business", intent.payment_intent_id);
    expect(refreshed.state).toBe("provider_acknowledged");
    expect(refreshed.provider_status).toBe("ACCP");
    gateway.onGetPayment = async (id) => ({ id, status: "ACSC" });
    refreshed = await finance.refreshNeonomicsPaymentState(TENANT_A, "business", intent.payment_intent_id);
    expect(refreshed.state).toBe("settled");
  });

  it("RJCT -> failed; terminal tilstand bevares mot sene motstridende statuser (flagges, aldri overskrevet)", async () => {
    freshServices();
    const { intent } = await submittedIntent();
    gateway.onGetPayment = async (id) => ({ id, status: "RJCT" });
    const failed = await finance.refreshNeonomicsPaymentState(TENANT_A, "business", intent.payment_intent_id);
    expect(failed.state).toBe("failed");
    gateway.onGetPayment = async (id) => ({ id, status: "ACSC" });
    const after = await finance.refreshNeonomicsPaymentState(TENANT_A, "business", intent.payment_intent_id);
    expect(after.state).toBe("failed"); // terminal bevart.
    expect(after.anomaly_flags).toContain("WEBHOOK_STATE_CONFLICT");
  });

  it("webhook: gyldig API-nøkkel prosesserer, duplikat dedupes, feil nøkkel avvises, ukjent betaling er unsupported", async () => {
    freshServices();
    const { intent } = await submittedIntent();
    const body = Buffer.from(JSON.stringify({ paymentId: intent.provider_ref, status: "ACSC" }));
    const processed = await finance.ingestNeonomicsWebhookEvent(body, WEBHOOK_API_KEY);
    expect(processed.status).toBe("processed");
    const after = await finance.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after?.state).toBe("settled");

    const duplicate = await finance.ingestNeonomicsWebhookEvent(body, WEBHOOK_API_KEY);
    expect(duplicate.status).toBe("duplicate");

    await expect(finance.ingestNeonomicsWebhookEvent(body, "feil-noekkel")).rejects.toThrow(InvalidWebhookSignatureError);

    const unknown = await finance.ingestNeonomicsWebhookEvent(Buffer.from(JSON.stringify({ paymentId: "finnes-ikke", status: "ACSC" })), WEBHOOK_API_KEY);
    expect(unknown.status).toBe("unsupported");
  });

  it("webhook mot en intent i ANNEN tenant enn konfigurert: fail-closed PROVIDER_OBJECT_TENANT_CONFLICT (RLS er primærvokteren)", async () => {
    freshServices();
    const { intent } = await submittedIntent();
    configuredTenant = TENANT_B; // webhooken ruter nå til B - intentens rad (A) er utenfor B sitt RLS-synsfelt.
    const result = await finance.ingestNeonomicsWebhookEvent(Buffer.from(JSON.stringify({ paymentId: intent.provider_ref, status: "ACSC" })), WEBHOOK_API_KEY);
    // RLS skjuler raden for tenant B -> unsupported (STERKERE enn app-sjekken alene - samme bevis som Stripe/Vipps-suitene).
    expect(result.status).toBe("unsupported");
    configuredTenant = TENANT_A;
    const after = await finance.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after?.state).toBe("provider_acknowledged"); // urørt.
  });

  it("worker-sveipen synker ikke-terminale betalinger", async () => {
    freshServices();
    const { intent } = await submittedIntent();
    gateway.onGetPayment = async (id) => ({ id, status: "ACSC" });
    const result = await finance.syncPendingNeonomicsPayments(TENANT_A, "business");
    expect(result.synced).toBeGreaterThanOrEqual(1);
    const after = await finance.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(after?.state).toBe("settled");
  });
});

describe("G: avstemming (bank <-> intent)", () => {
  it("REGEL 1: provider-referanse i reference_text matcher deterministisk + lenker intent (matched)", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const intent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "Avstemmingstest", amount_ore: 25_000,
      vendor_name: "Leverandør AS", vendor_provider_ref: "98765432101", account_code: "bank-avstem",
      counter_account_code: bankAccountId, provider: "neonomics"
    });
    await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    gateway.onListTransactions = async () => ({
      transactions: [providerTx({ referenceText: `Betaling ${intent.payment_intent_id}` })], nextPageToken: null
    });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const result = await banking.reconcileBankTransactions(TENANT_A, "business");
    expect(result.matched_by_reference).toBe(1);
    const txRows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    const matched = txRows.find((t) => t.matched_payment_intent_id === intent.payment_intent_id) as BankTransaction;
    expect(matched.reconciliation_state).toBe("matched");
    expect(matched.match_rule).toBe("provider_reference");
    const intentAfter = await finance.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(intentAfter?.reconciliation_state).toBe("matched");
  });

  it("REGEL 1 med beløpsavvik: PAYMENT_BANK_TRANSACTION_MISMATCH - aldri en stille match", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    const intent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "Mismatch-test", amount_ore: 25_000,
      vendor_name: "Leverandør AS", vendor_provider_ref: "98765432101", account_code: "bank-mismatch",
      counter_account_code: bankAccountId, provider: "neonomics"
    });
    await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    gateway.onListTransactions = async () => ({
      transactions: [providerTx({ amountOre: 30_000, referenceText: `Betaling ${intent.payment_intent_id}` })], nextPageToken: null
    });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const result = await banking.reconcileBankTransactions(TENANT_A, "business");
    expect(result.mismatch_flagged).toBe(1);
    const txRows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    expect(txRows[0]!.anomaly_flags).toContain("PAYMENT_BANK_TRANSACTION_MISMATCH");
    expect(txRows[0]!.reconciliation_state).not.toBe("matched");
  });

  it("REGEL 2: eksakt-én-kandidat på beløp+valuta+datovindu matcher; TO kandidater forblir ambiguous", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    // Én Stripe-intent (annen provider - regelen er provider-nøytral på intent-siden).
    const intent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "Vindustest", amount_ore: 44_400,
      vendor_name: "Vindu AS", account_code: "9999", provider: "stripe"
    });
    // adminPool (RLS-bypass) for test-fixture-manipulasjon - SAMME lærdom
    // som stripe-suiten (appPool-tilkoblinger deler ikke set_config).
    await adminPool.query(`UPDATE payment_intents SET state = 'provider_acknowledged', submitted_at = '2026-08-25T10:00:00Z' WHERE payment_intent_id = $1`, [intent.payment_intent_id]);
    gateway.onListTransactions = async () => ({ transactions: [providerTx({ amountOre: 44_400, referenceText: "uten referanse" })], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const result = await banking.reconcileBankTransactions(TENANT_A, "business");
    expect(result.matched_by_amount_date).toBe(1);

    // To identiske kandidater -> ambiguous.
    for (const key of ["a", "b"]) {
      const dup = await finance.createPaymentIntent(TENANT_A, "business", {
        idempotency_key: `idem-amb-${key}-${randomUUID()}`, purpose: `Tvetydig ${key}`, amount_ore: 55_500,
        vendor_name: "Tvetydig AS", account_code: "9999", provider: "stripe"
      });
      await adminPool.query(`UPDATE payment_intents SET state = 'provider_acknowledged', submitted_at = '2026-08-25T10:00:00Z' WHERE payment_intent_id = $1`, [dup.payment_intent_id]);
    }
    gateway.onListTransactions = async () => ({ transactions: [providerTx({ amountOre: 55_500, referenceText: "ogsaa uten referanse" })], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const result2 = await banking.reconcileBankTransactions(TENANT_A, "business");
    expect(result2.ambiguous).toBe(1);
  });
});

describe("H: bank-avviksdeteksjon + tenant-isolasjon", () => {
  it("UNMATCHED_BANK_DEBIT/CREDIT (aldret) + UNEXPECTED_LARGE_DEBIT + selvkorrigering", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    gateway.onListTransactions = async () => ({
      transactions: [
        providerTx({ amountOre: 5_000 }),
        providerTx({ direction: "credit", amountOre: 7_000 }),
        providerTx({ amountOre: LARGE_DEBIT_THRESHOLD_ORE })
      ],
      nextPageToken: null
    });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    // Aldre transaksjonene forbi UNMATCHED_FLAG_AGE_DAYS (adminPool - test-fixture-manipulasjon).
    await adminPool.query(`UPDATE bank_transactions SET created_at = now() - interval '10 days' WHERE tenant_id = $1`, [TENANT_A]);
    const result = await banking.runBankAnomalyDetection(TENANT_A, "business");
    expect(result.transaction_flags_added).toBe(3);
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    const flags = rows.flatMap((r) => [...r.anomaly_flags]);
    expect(flags).toContain("UNMATCHED_BANK_DEBIT");
    expect(flags).toContain("UNMATCHED_BANK_CREDIT");
    expect(flags).toContain("UNEXPECTED_LARGE_DEBIT");
    // Selvkorrigering: match alle -> sveipen renser sine egne flagg.
    await adminPool.query(`UPDATE bank_transactions SET reconciliation_state = 'matched' WHERE tenant_id = $1`, [TENANT_A]);
    const second = await banking.runBankAnomalyDetection(TENANT_A, "business");
    expect(second.flags_cleared).toBe(3);
  });

  it("RLS: tenant B ser ALDRI tenant A sine samtykker/kontoer/transaksjoner", async () => {
    freshServices();
    const { bankAccountId } = await syncedAccountId();
    gateway.onListTransactions = async () => ({ transactions: [providerTx()], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    expect((await banking.listConsents(TENANT_B, "business")).length).toBe(0);
    expect((await banking.listBankAccounts(TENANT_B, "business", true)).length).toBe(0);
    expect((await banking.listBankTransactions(TENANT_B, "business")).length).toBe(0);
    // Tenant B kan heller ikke initiere betaling fra A sin konto (RLS skjuler raden).
    const intentB = await finance.createPaymentIntent(TENANT_B, "business", {
      idempotency_key: `idem-${randomUUID()}`, purpose: "Kryss-tenant-forsøk", amount_ore: 100,
      vendor_name: "X", vendor_provider_ref: "1", account_code: "x", counter_account_code: bankAccountId, provider: "neonomics"
    });
    await expect(finance.submitPaymentIntent(TENANT_B, "business", intentB.payment_intent_id, { getCredentials: async () => null })).rejects.toThrow(BankAccountNotFoundError);
  });

  it("secret-sikkerhet: samtykke-/kontorader inneholder aldri client secret eller SCA-materiale", async () => {
    freshServices();
    const consent = await activeConsent();
    const { rows } = await adminPool.query(`SELECT to_jsonb(bc.*) AS row FROM bank_consents bc WHERE consent_id = $1`, [consent.consent_id]);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("fake-secret-fixture");
    expect(serialized).not.toContain("fake-client");
  });
});
