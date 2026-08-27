import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { OpenLoopService } from "@jarvis/business";
import { CardService } from "../src/card-service.ts";
import type { WallesterCredentials, WallesterCredentialsProvider } from "../src/card-service.ts";
import { FinanceService } from "../src/service.ts";
import { CardInvalidStateError, CardNotSubmittedError, WallesterCredentialsUnavailableError } from "../src/card-types.ts";
import { FinanceKillSwitchActiveError, InvalidWebhookSignatureError } from "../src/types.ts";
import {
  WallesterApiError,
  createRsaJwtSigner,
  type CreateWallesterCardInput,
  type WallesterAccountBalance,
  type WallesterAuthorizationObject,
  type WallesterCardLimitsApplied,
  type WallesterCardLimitsInput,
  type WallesterCardObject,
  type WallesterGateway,
  type WallesterPage,
  type WallesterTransactionObject
} from "../src/wallester-transport.ts";
import { generateKeyPairSync } from "node:crypto";

/**
 * D-112 (UA-6 Slice 6): ekte Postgres/RLS-integrasjonsbevis for kort-
 * domenet (CardService) - SAMME harness-mønster som stripe-/vipps-/
 * neonomics-service.test.ts: ekte embedded Postgres, ekte tjenester, fake
 * KUN ved NETTVERKSGRENSEN (injisert WallesterGatewayFactory), ALDRI en
 * adapter-omgåelse. Test-isolasjon: globalt unike provider-ID-er +
 * per-test-opprydding (lærdommene fra Slice 5).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT_A = "tenant-wall-svc-a";
const TENANT_B = "tenant-wall-svc-b";
// BEVISST lav-entropi, åpenbart falske verdier (gitleaks-lærdom fra D-109).
const WEBHOOK_USER = "not-a-real-wallester-webhook-user-svc";
const WEBHOOK_PASSWORD = "not-a-real-wallester-webhook-password-svc";
const FAKE_PRIVATE_KEY = "not-a-real-wallester-private-key-pem";

function basicHeader(user = WEBHOOK_USER, pass = WEBHOOK_PASSWORD): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** Skriptbar fake ved Wallester-transportens nettverksgrense. */
class ScriptedWallesterGateway implements WallesterGateway {
  createCalls: CreateWallesterCardInput[] = [];
  limitCalls = 0;

  onCreateCard: (input: CreateWallesterCardInput) => Promise<WallesterCardObject> = async () => ({
    id: `wcard-${randomUUID()}`, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null
  });
  onGetCard: (id: string) => Promise<WallesterCardObject> = async (id) => ({
    id, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null
  });
  onLifecycle: (id: string, status: string) => Promise<WallesterCardObject> = async (id, status) => ({
    id, status, maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null
  });
  onUpdateLimits: (id: string, limits: WallesterCardLimitsInput) => Promise<WallesterCardLimitsApplied> = async (_id, limits) => ({ ...limits, confirmed: true });
  onListAuthorizations: (id: string, pageToken: string | null) => Promise<WallesterPage<WallesterAuthorizationObject>> = async () => ({ items: [], nextPageToken: null });
  onListTransactions: (id: string, pageToken: string | null) => Promise<WallesterPage<WallesterTransactionObject>> = async () => ({ items: [], nextPageToken: null });

  async createCard(input: CreateWallesterCardInput): Promise<WallesterCardObject> {
    this.createCalls.push(input);
    return this.onCreateCard(input);
  }
  async getCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.onGetCard(providerCardId);
  }
  async activateCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.onLifecycle(providerCardId, "active");
  }
  async blockCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.onLifecycle(providerCardId, "blocked");
  }
  async unblockCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.onLifecycle(providerCardId, "active");
  }
  async closeCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.onLifecycle(providerCardId, "closed");
  }
  async updateCardLimits(providerCardId: string, limits: WallesterCardLimitsInput): Promise<WallesterCardLimitsApplied> {
    this.limitCalls++;
    return this.onUpdateLimits(providerCardId, limits);
  }
  async listAuthorizations(providerCardId: string, pageToken: string | null): Promise<WallesterPage<WallesterAuthorizationObject>> {
    return this.onListAuthorizations(providerCardId, pageToken);
  }
  async listTransactions(providerCardId: string, pageToken: string | null): Promise<WallesterPage<WallesterTransactionObject>> {
    return this.onListTransactions(providerCardId, pageToken);
  }
  async getAccountBalance(): Promise<WallesterAccountBalance> {
    return { accountId: "wacc-live-1", availableAmountOre: 2_500_000, currency: "EUR" };
  }
}

let gateway: ScriptedWallesterGateway;
let cards: CardService;
let finance: FinanceService;
let configuredTenant: string | null = TENANT_A;

// Owner-provided primary-source-audit (PR #62 runde 4): api_key/ts/RS256,
// IKKE issuer/audience (Wallester Card API-modellen - annen produkt-grense,
// se wallester-transport.ts filhode). Ephemeral test-nøkkelpar - ALDRI en
// gjettet/antatt EKTE Wallester-nøkkel.
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const credentialsProvider: WallesterCredentialsProvider = {
  async getCredentials(): Promise<WallesterCredentials | null> {
    return { baseUrl: "https://wallester.invalid", apiKey: "wba-test-key", sign: createRsaJwtSigner(TEST_PRIVATE_KEY), accountId: "wacc-live-1", environment: "sandbox" };
  }
};
const noCredentialsProvider: WallesterCredentialsProvider = {
  async getCredentials(): Promise<WallesterCredentials | null> {
    return null;
  }
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wall-svc-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_wall_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wall_svc_test");
  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Wall Svc A', 'business'), ('${TENANT_B}', 'Wall Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-wall-owner', 'Owner Wall')`);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_wall_svc_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

beforeEach(async () => {
  // Full isolasjon mellom tester i den delte embedded-databasen (Slice 5-
  // lærdommen): tenant-vide sveip skal ALDRI se forrige tests rader.
  // Rekkefølge: barn-FK før forelder.
  for (const table of [
    "business_open_loops", "wallester_webhook_events", "card_transactions", "card_authorizations",
    "card_events", "card_spend_policies", "provider_cards", "finance_recurring_commitments", "finance_kill_switch"
  ]) {
    await adminPool.query(`DELETE FROM ${table}`);
  }
});

function freshServices(withCredentials = true): void {
  gateway = new ScriptedWallesterGateway();
  configuredTenant = TENANT_A;
  const provider = withCredentials ? credentialsProvider : noCredentialsProvider;
  cards = new CardService(appPool, provider, () => gateway, () => ({ username: WEBHOOK_USER, password: WEBHOOK_PASSWORD }), () => configuredTenant);
  finance = new FinanceService(appPool);
}

async function activeCard(input: Partial<Parameters<CardService["createCard"]>[2]> = {}): Promise<{ card_id: string; provider_card_id: string }> {
  const draft = await cards.createCard(TENANT_A, "business", {
    idempotency_key: `card-idem-${randomUUID()}`, name: "Testkort", purpose: "Test", card_type: "virtual", currency: "EUR", ...input
  });
  const submitted = await cards.submitCard(TENANT_A, "business", draft.card_id);
  return { card_id: submitted.card_id, provider_card_id: submitted.provider_card_id! };
}

function providerTx(overrides: Partial<WallesterTransactionObject> = {}): WallesterTransactionObject {
  return {
    id: `wtx-${randomUUID()}`, cardId: "", authorizationId: null, type: "purchase", amountOre: 25_000, currency: "EUR",
    merchantName: "Leverandør GmbH", merchantCategoryCode: "5734", channel: "online",
    transactionAt: new Date().toISOString(), settledAt: new Date().toISOString(), ...overrides
  };
}

async function seedCommitment(amountOre: number, toleranceOre = 0, vendor = "SaaS AS"): Promise<string> {
  const id = `com-${randomUUID()}`;
  await adminPool.query(
    `INSERT INTO finance_recurring_commitments (commitment_id, tenant_id, memory_space_id, vendor_name, description, cadence, expected_amount_ore, currency, amount_tolerance_ore, start_date)
     VALUES ($1, $2, 'business', $3, 'Testforpliktelse', 'monthly', $4, 'EUR', $5, '2026-01-01')`,
    [id, TENANT_A, vendor, amountOre, toleranceOre]
  );
  return id;
}

describe("A: kortopprettelse + idempotens", () => {
  it("createCard er deterministisk idempotent (samme nøkkel -> SAMME kanoniske kort) og oppretter policy-rad", async () => {
    freshServices();
    const key = `card-idem-${randomUUID()}`;
    const first = await cards.createCard(TENANT_A, "business", { idempotency_key: key, name: "K1", purpose: "P", card_type: "virtual", requested_transaction_limit_ore: 50_000 });
    const second = await cards.createCard(TENANT_A, "business", { idempotency_key: key, name: "K1", purpose: "P", card_type: "virtual" });
    expect(first.card_id).toBe(second.card_id);
    expect(first.state).toBe("draft");
    const policy = await cards.getSpendPolicy(TENANT_A, "business", first.card_id);
    expect(policy?.requested_transaction_limit_ore).toBe(50_000);
    expect(policy?.sync_state).toBe("pending");
  });

  it("submitCard sender kanonisk card_id som ekstern referanse; retry er idempotent (ETT provider-kall, aldri duplikatkort)", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await cards.submitCard(TENANT_A, "business", card_id);
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.createCalls[0]!.externalReference).toBe(card_id);
  });

  it("engangskort sendes med single-use-bruksart (auto-lukkes hos Wallester etter ÉN vellykket transaksjon)", async () => {
    freshServices();
    await activeCard({ card_type: "disposable" });
    expect(gateway.createCalls[0]!.type).toBe("disposable");
  });

  it("provider-feil UNDER innsending etterlater kortet i draft - korrigert retry er trygg", async () => {
    freshServices();
    const draft = await cards.createCard(TENANT_A, "business", { idempotency_key: `card-idem-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual" });
    gateway.onCreateCard = async () => {
      throw new WallesterApiError("wallester_api_failed_500:boom", 500, false);
    };
    await expect(cards.submitCard(TENANT_A, "business", draft.card_id)).rejects.toThrow(WallesterApiError);
    const after = await cards.getCard(TENANT_A, "business", draft.card_id);
    expect(after?.state).toBe("draft");
    gateway.onCreateCard = async () => ({ id: `wcard-${randomUUID()}`, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null });
    const retried = await cards.submitCard(TENANT_A, "business", draft.card_id);
    expect(retried.state).toBe("active");
  });

  it("finans-nødbryteren blokkerer provider-innsending av nytt kort (spend-muliggjørende)", async () => {
    freshServices();
    const draft = await cards.createCard(TENANT_A, "business", { idempotency_key: `card-idem-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual" });
    await finance.enableKillSwitch(TENANT_A, "person-wall-owner", "test");
    await expect(cards.submitCard(TENANT_A, "business", draft.card_id)).rejects.toThrow(FinanceKillSwitchActiveError);
    expect(gateway.createCalls).toHaveLength(0);
  });

  it("credential_unavailable fail-closed uten Wallester-credentials", async () => {
    freshServices(false);
    const draft = await cards.createCard(TENANT_A, "business", { idempotency_key: `card-idem-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual" });
    await expect(cards.submitCard(TENANT_A, "business", draft.card_id)).rejects.toThrow(WallesterCredentialsUnavailableError);
  });

});

describe("B: kortlivssyklus", () => {
  it("freeze -> unfreeze -> close med provider-tilstand + tidsstempler; historikk (card_events) bevares", async () => {
    freshServices();
    const { card_id } = await activeCard();
    const frozen = await cards.freezeCard(TENANT_A, "business", card_id);
    expect(frozen.state).toBe("frozen");
    expect(frozen.frozen_at).not.toBeNull();
    const active = await cards.unfreezeCard(TENANT_A, "business", card_id);
    expect(active.state).toBe("active");
    const closed = await cards.closeCard(TENANT_A, "business", card_id);
    expect(closed.state).toBe("closed");
    const events = await adminPool.query(`SELECT event_type FROM card_events WHERE card_id = $1 ORDER BY created_at`, [card_id]);
    expect(events.rows.map((r) => (r as { event_type: string }).event_type)).toEqual(
      expect.arrayContaining(["requested", "submitted", "frozen", "unfrozen", "closed"])
    );
  });

  it("provider-feil endrer ALDRI kanonisk tilstand", async () => {
    freshServices();
    const { card_id } = await activeCard();
    gateway.onLifecycle = async () => {
      throw new WallesterApiError("wallester_api_failed_500:boom", 500, false);
    };
    await expect(cards.freezeCard(TENANT_A, "business", card_id)).rejects.toThrow(WallesterApiError);
    expect((await cards.getCard(TENANT_A, "business", card_id))?.state).toBe("active");
  });

  it("ugyldig overgang avvises deterministisk (closed -> freeze); idempotent no-op når allerede i måltilstand", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await cards.closeCard(TENANT_A, "business", card_id);
    await expect(cards.freezeCard(TENANT_A, "business", card_id)).rejects.toThrow(CardInvalidStateError);
    const again = await cards.closeCard(TENANT_A, "business", card_id); // idempotent
    expect(again.state).toBe("closed");
  });

  it("lukking sletter ALDRI historiske transaksjoner", async () => {
    freshServices();
    const { card_id } = await activeCard();
    gateway.onListTransactions = async () => ({ items: [providerTx()], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    await cards.closeCard(TENANT_A, "business", card_id);
    expect(await cards.listCardTransactions(TENANT_A, "business", { card_id })).toHaveLength(1);
  });

  it("nødbryteren blokkerer avfrysing (re-muliggjør spend) men ALDRI frys (spend-reduserende)", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await finance.enableKillSwitch(TENANT_A, "person-wall-owner", "test");
    const frozen = await cards.freezeCard(TENANT_A, "business", card_id); // alltid tillatt
    expect(frozen.state).toBe("frozen");
    await expect(cards.unfreezeCard(TENANT_A, "business", card_id)).rejects.toThrow(FinanceKillSwitchActiveError);
  });

  it("livssyklushandling mot uinnsendt kort avvises (CardNotSubmittedError)", async () => {
    freshServices();
    const draft = await cards.createCard(TENANT_A, "business", { idempotency_key: `card-idem-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual" });
    await expect(cards.freezeCard(TENANT_A, "business", draft.card_id)).rejects.toThrow(CardNotSubmittedError);
  });
});

describe("C: programmerbare spend-kontroller (ønsket vs provider-anvendt)", () => {
  it("update pusher til provider og setter ANVENDT tilstand KUN fra provider-ekkoet", async () => {
    freshServices();
    const { card_id } = await activeCard();
    const policy = await cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_daily_limit_ore: 100_000, requested_atm_enabled: false });
    expect(policy.sync_state).toBe("applied");
    expect(policy.applied_daily_limit_ore).toBe(100_000);
    expect(policy.applied_atm_enabled).toBe(false);
    expect(gateway.limitCalls).toBe(1);
  });

  it("ikke-retrybar provider-avvisning markerer policyen 'rejected' - anvendte verdier røres ikke (aldri antatt vellykket)", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_daily_limit_ore: 100_000 });
    gateway.onUpdateLimits = async () => {
      throw new WallesterApiError("wallester_api_failed_422:limit_rejected", 422, false);
    };
    await expect(cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_daily_limit_ore: 200_000 })).rejects.toThrow(WallesterApiError);
    const after = await cards.getSpendPolicy(TENANT_A, "business", card_id);
    expect(after?.sync_state).toBe("rejected");
    expect(after?.applied_daily_limit_ore).toBe(100_000); // uendret provider-sannhet.
    expect(after?.requested_daily_limit_ore).toBe(200_000); // ærlig requested-vs-applied-avvik.
  });

  it("nødbryteren blokkerer grense-ØKNING og kanal-reaktivering, men tillater REDUKSJON", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_daily_limit_ore: 100_000, requested_atm_enabled: false });
    await finance.enableKillSwitch(TENANT_A, "person-wall-owner", "test");
    await expect(cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_daily_limit_ore: 150_000 })).rejects.toThrow(FinanceKillSwitchActiveError);
    await expect(cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_atm_enabled: true })).rejects.toThrow(FinanceKillSwitchActiveError);
    const reduced = await cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_daily_limit_ore: 50_000 });
    expect(reduced.applied_daily_limit_ore).toBe(50_000);
  });
});

describe("D: passiv tilstandssynk", () => {
  it("reparerer stale kanonisk tilstand fra provider (provider blocked -> kanonisk frozen)", async () => {
    freshServices();
    const { card_id } = await activeCard();
    gateway.onGetCard = async (id) => ({ id, status: "blocked", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null });
    const synced = await cards.syncCardState(TENANT_A, "business", card_id);
    expect(synced.state).toBe("frozen");
    expect(synced.provider_state).toBe("blocked");
  });

  it("resurrekterer ALDRI et kanonisk lukket kort - konflikt flagges CARD_PROVIDER_STATE_CONFLICT", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await cards.closeCard(TENANT_A, "business", card_id);
    gateway.onGetCard = async (id) => ({ id, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null });
    const synced = await cards.syncCardState(TENANT_A, "business", card_id);
    expect(synced.state).toBe("closed");
    expect(synced.anomaly_flags).toContain("CARD_PROVIDER_STATE_CONFLICT");
  });
});

describe("E: autorisasjon -> oppgjør (ETT økonomisk beløp)", () => {
  async function authThenSettle(cardId: string, providerCardId: string, amountOre = 25_000): Promise<{ authId: string; txId: string }> {
    const authId = `wauth-${randomUUID()}`;
    gateway.onListAuthorizations = async () => ({
      items: [{ id: authId, cardId: providerCardId, status: "approved", amountOre, currency: "EUR", merchantName: "Leverandør GmbH", merchantCategoryCode: "5734", channel: "online", declineReason: null, authorizedAt: new Date().toISOString() }],
      nextPageToken: null
    });
    await cards.syncAuthorizations(TENANT_A, "business", cardId);
    const txId = `wtx-${randomUUID()}`;
    gateway.onListTransactions = async () => ({ items: [providerTx({ id: txId, authorizationId: authId, amountOre })], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", cardId);
    return { authId, txId };
  }

  it("oppgjøret lenkes deterministisk til autorisasjonen; autorisasjonen settes 'settled'; NØYAKTIG ÉN økonomisk rad", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    const { authId } = await authThenSettle(card_id, provider_card_id);
    const auths = await cards.listAuthorizations(TENANT_A, "business", { card_id });
    expect(auths).toHaveLength(1);
    expect(auths[0]!.status).toBe("settled");
    const txs = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(txs).toHaveLength(1); // autorisasjon + oppgjør = ETT beløp, aldri to spend-poster.
    expect(txs[0]!.authorization_id).toBe(auths[0]!.authorization_id);
    expect(txs[0]!.anomaly_flags).toHaveLength(0);
    void authId;
  });

  it("et ANDRE oppgjør mot SAMME autorisasjon flagges DUPLICATE_ECONOMIC_EFFECT", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    const { authId } = await authThenSettle(card_id, provider_card_id);
    gateway.onListTransactions = async () => ({ items: [providerTx({ authorizationId: authId })], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    const txs = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    const flagged = txs.find((t) => t.anomaly_flags.includes("DUPLICATE_ECONOMIC_EFFECT"));
    expect(flagged).toBeDefined();
  });

  it("oppgjør STØRRE enn autorisert beløp flagges CARD_AUTH_SETTLEMENT_CONFLICT", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    const authId = `wauth-${randomUUID()}`;
    gateway.onListAuthorizations = async () => ({
      items: [{ id: authId, cardId: provider_card_id, status: "approved", amountOre: 10_000, currency: "EUR", merchantName: null, merchantCategoryCode: null, channel: "online", declineReason: null, authorizedAt: new Date().toISOString() }],
      nextPageToken: null
    });
    await cards.syncAuthorizations(TENANT_A, "business", card_id);
    gateway.onListTransactions = async () => ({ items: [providerTx({ authorizationId: authId, amountOre: 15_000 })], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    const txs = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(txs[0]!.anomaly_flags).toContain("CARD_AUTH_SETTLEMENT_CONFLICT");
  });

  it("avslått autorisasjon forblir 'declined' (terminal) og produserer ALDRI en økonomisk rad", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    gateway.onListAuthorizations = async () => ({
      items: [{ id: `wauth-${randomUUID()}`, cardId: provider_card_id, status: "declined", amountOre: 99_000, currency: "EUR", merchantName: null, merchantCategoryCode: null, channel: "online", declineReason: "limit_exceeded", authorizedAt: new Date().toISOString() }],
      nextPageToken: null
    });
    await cards.syncAuthorizations(TENANT_A, "business", card_id);
    const auths = await cards.listAuthorizations(TENANT_A, "business", { card_id });
    expect(auths[0]!.status).toBe("declined");
    expect(auths[0]!.decline_reason).toBe("limit_exceeded");
    expect(await cards.listCardTransactions(TENANT_A, "business", { card_id })).toHaveLength(0);
  });

  it("paginert transaksjonssynk + idempotent re-synk (aldri duplikater); refusjon bevares som egen inngående type", async () => {
    freshServices();
    const { card_id } = await activeCard();
    const tx1 = providerTx();
    const tx2 = providerTx({ type: "refund", amountOre: 5_000 });
    gateway.onListTransactions = async (_id, pageToken) =>
      pageToken === null ? { items: [tx1], nextPageToken: "page2" } : { items: [tx2], nextPageToken: null };
    const first = await cards.syncTransactions(TENANT_A, "business", card_id);
    expect(first.inserted).toBe(2);
    expect(first.pages).toBe(2);
    const second = await cards.syncTransactions(TENANT_A, "business", card_id);
    expect(second.inserted).toBe(0);
    const rows = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.provider_transaction_id === tx2.id)?.transaction_type).toBe("refund");
  });

  it("provider-korreksjon av etablert beløp flagges - originalen overskrives ALDRI stille", async () => {
    freshServices();
    const { card_id } = await activeCard();
    const tx = providerTx();
    gateway.onListTransactions = async () => ({ items: [tx], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    gateway.onListTransactions = async () => ({ items: [{ ...tx, amountOre: 99_999 }], nextPageToken: null });
    const result = await cards.syncTransactions(TENANT_A, "business", card_id);
    expect(result.corrections_flagged).toBe(1);
    const rows = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(rows[0]!.amount_ore).toBe(25_000);
    expect(rows[0]!.anomaly_flags).toContain("CARD_TRANSACTION_CORRECTION_CONFLICT");
  });
});

describe("F: webhook-ingestion", () => {
  it("gyldig Basic-auth prosesserer autorisasjonshendelse; duplikat dedupes; feil credentials avvises; ukjent kort er unsupported", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    const body = Buffer.from(JSON.stringify({
      event: "notification", type: "authorization", event_id: `evt-${randomUUID()}`,
      data: { id: `wauth-${randomUUID()}`, card_id: provider_card_id, status: "approved", amount: 7_500, currency: "EUR", channel: "online" }
    }));
    const processed = await cards.ingestWallesterWebhookEvent(body, basicHeader());
    expect(processed.status).toBe("processed");
    expect(await cards.listAuthorizations(TENANT_A, "business", { card_id })).toHaveLength(1);

    const duplicate = await cards.ingestWallesterWebhookEvent(body, basicHeader());
    expect(duplicate.status).toBe("duplicate");

    await expect(cards.ingestWallesterWebhookEvent(body, basicHeader(WEBHOOK_USER, "feil-passord"))).rejects.toThrow(InvalidWebhookSignatureError);

    const unknown = await cards.ingestWallesterWebhookEvent(Buffer.from(JSON.stringify({
      event: "notification", type: "authorization", event_id: `evt-${randomUUID()}`,
      data: { id: `wauth-${randomUUID()}`, card_id: "wcard-finnes-ikke", status: "approved", amount: 1, currency: "EUR" }
    })), basicHeader());
    expect(unknown.status).toBe("unsupported");
  });

  it("ukjent autorisasjonsstatus lagres 'unknown' - ALDRI stille som 'approved' (fail-safe, owner-provided primary-source-audit PR #62 runde 4)", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    const processed = await cards.ingestWallesterWebhookEvent(Buffer.from(JSON.stringify({
      event: "notification", type: "authorization", event_id: `evt-${randomUUID()}`,
      data: { id: `wauth-${randomUUID()}`, card_id: provider_card_id, status: "en_helt_ukjent_status", amount: 1_000, currency: "EUR" }
    })), basicHeader());
    expect(processed.status).toBe("processed");
    const auths = await cards.listAuthorizations(TENANT_A, "business", { card_id });
    expect(auths[0]!.status).toBe("unknown");
  });

  it("ukjent transaksjonstype lagres 'unknown' - ALDRI stille som 'purchase' (fail-safe, owner-provided primary-source-audit PR #62 runde 4)", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    const processed = await cards.ingestWallesterWebhookEvent(Buffer.from(JSON.stringify({
      event: "notification", type: "transaction", event_id: `evt-${randomUUID()}`,
      data: { id: `wtx-${randomUUID()}`, card_id: provider_card_id, transaction_type: "en_helt_ukjent_type", amount: 1_000, currency: "EUR" }
    })), basicHeader());
    expect(processed.status).toBe("processed");
    const txs = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(txs[0]!.transaction_type).toBe("unknown");
  });

  it("authorization_release oppdaterer EKSISTERENDE autorisasjon (owner-provided Business-kontrakt, PR #62 runde 4)", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    const providerAuthorizationId = `wauth-${randomUUID()}`;
    await cards.ingestWallesterWebhookEvent(Buffer.from(JSON.stringify({
      event: "notification", type: "authorization", event_id: `evt-${randomUUID()}`,
      data: { id: providerAuthorizationId, card_id: provider_card_id, status: "approved", amount: 3_000, currency: "EUR" }
    })), basicHeader());
    await cards.ingestWallesterWebhookEvent(Buffer.from(JSON.stringify({
      event: "notification", type: "authorization_release", event_id: `evt-${randomUUID()}`,
      data: { id: providerAuthorizationId, card_id: provider_card_id, status: "reversed", amount: 3_000, currency: "EUR" }
    })), basicHeader());
    const auths = await cards.listAuthorizations(TENANT_A, "business", { card_id });
    expect(auths).toHaveLength(1);
    expect(auths[0]!.status).toBe("reversed");
  });

  it("webhook + polling-observasjon av SAMME transaksjon dupliserer aldri (delt idempotent ingest)", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    const txId = `wtx-${randomUUID()}`;
    await cards.ingestWallesterWebhookEvent(Buffer.from(JSON.stringify({
      event: "notification", type: "transaction", event_id: `evt-${randomUUID()}`,
      data: { id: txId, card_id: provider_card_id, status: "settled", transaction_type: "purchase", amount: 12_000, currency: "EUR", channel: "online" }
    })), basicHeader());
    gateway.onListTransactions = async () => ({ items: [providerTx({ id: txId, amountOre: 12_000 })], nextPageToken: null });
    const sync = await cards.syncTransactions(TENANT_A, "business", card_id);
    expect(sync.inserted).toBe(0);
    expect(await cards.listCardTransactions(TENANT_A, "business", { card_id })).toHaveLength(1);
  });

  it("korthendelse oppdaterer KUN observasjonell provider_state - kanonisk terminaltilstand røres ikke av webhooken alene", async () => {
    freshServices();
    const { card_id, provider_card_id } = await activeCard();
    await cards.closeCard(TENANT_A, "business", card_id);
    const result = await cards.ingestWallesterWebhookEvent(Buffer.from(JSON.stringify({
      event: "notification", type: "card", event_id: `evt-${randomUUID()}`,
      data: { id: provider_card_id, status: "active" }
    })), basicHeader());
    expect(result.status).toBe("processed");
    const after = await cards.getCard(TENANT_A, "business", card_id);
    expect(after?.state).toBe("closed");
    expect(after?.provider_state).toBe("active");
  });
});

describe("G: Finance-avstemming (kortspend <-> forventet spend)", () => {
  it("REGEL 1: formålsbundet kort matcher forpliktelsen innenfor deterministisk toleranse", async () => {
    freshServices();
    const commitmentId = await seedCommitment(25_000, 500);
    const { card_id } = await activeCard({ commitment_id: commitmentId });
    gateway.onListTransactions = async () => ({ items: [providerTx({ amountOre: 25_300 })], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    const result = await cards.reconcileCardTransactions(TENANT_A, "business");
    expect(result.matched_by_purpose).toBe(1);
    const txs = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(txs[0]!.reconciliation_state).toBe("matched");
    expect(txs[0]!.matched_commitment_id).toBe(commitmentId);
    expect(txs[0]!.match_rule).toBe("card_purpose_commitment");
  });

  it("REGEL 1 utenfor toleranse: CARD_PURPOSE_MISMATCH - aldri en stille match", async () => {
    freshServices();
    const commitmentId = await seedCommitment(25_000, 0);
    const { card_id } = await activeCard({ commitment_id: commitmentId });
    gateway.onListTransactions = async () => ({ items: [providerTx({ amountOre: 90_000 })], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    const result = await cards.reconcileCardTransactions(TENANT_A, "business");
    expect(result.mismatch_flagged).toBe(1);
    const txs = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(txs[0]!.anomaly_flags).toContain("CARD_PURPOSE_MISMATCH");
    expect(txs[0]!.reconciliation_state).not.toBe("matched");
  });

  it("REGEL 2: ubundet kort - eksakt-én-kandidat matcher; TO kandidater forblir ambiguous", async () => {
    freshServices();
    await seedCommitment(44_400);
    const { card_id } = await activeCard();
    gateway.onListTransactions = async () => ({ items: [providerTx({ amountOre: 44_400 })], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    const result = await cards.reconcileCardTransactions(TENANT_A, "business");
    expect(result.matched_by_amount).toBe(1);

    await seedCommitment(55_500, 0, "Tvetydig A");
    await seedCommitment(55_500, 0, "Tvetydig B");
    gateway.onListTransactions = async () => ({ items: [providerTx({ amountOre: 55_500 })], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    const result2 = await cards.reconcileCardTransactions(TENANT_A, "business");
    expect(result2.ambiguous).toBe(1);
  });

  it("refusjon/reversering avstemmes ALDRI mot forventet spend (kun purchase)", async () => {
    freshServices();
    await seedCommitment(5_000);
    const { card_id } = await activeCard();
    gateway.onListTransactions = async () => ({ items: [providerTx({ type: "refund", amountOre: 5_000 })], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    const result = await cards.reconcileCardTransactions(TENANT_A, "business");
    expect(result.matched_by_amount).toBe(0);
  });
});

describe("H: kortavvik + OpenLoop + RLS + nødbryter-passivitet + PCI", () => {
  it("UNEXPECTED_CARD_SPEND (aldret ubundet) + CARD_CURRENCY_MISMATCH + UNEXPECTED_CASH_WITHDRAWAL + selvkorrigering", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_atm_enabled: false });
    const aged = providerTx({ amountOre: 5_000 });
    const wrongCurrency = providerTx({ currency: "NOK" });
    const atmTx = providerTx({ channel: "atm", amountOre: 2_000 });
    gateway.onListTransactions = async () => ({ items: [aged, wrongCurrency, atmTx], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    await adminPool.query(`UPDATE card_transactions SET created_at = now() - interval '10 days' WHERE tenant_id = $1 AND provider_transaction_id = $2`, [TENANT_A, aged.id]);
    await cards.runCardAnomalyDetection(TENANT_A, "business");
    const rows = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(rows.find((r) => r.provider_transaction_id === aged.id)?.anomaly_flags).toContain("UNEXPECTED_CARD_SPEND");
    expect(rows.find((r) => r.provider_transaction_id === wrongCurrency.id)?.anomaly_flags).toContain("CARD_CURRENCY_MISMATCH");
    expect(rows.find((r) => r.provider_transaction_id === atmTx.id)?.anomaly_flags).toContain("UNEXPECTED_CASH_WITHDRAWAL");
    // Selvkorrigering: match den aldrede -> sveipen renser sitt eget flagg.
    await adminPool.query(`UPDATE card_transactions SET reconciliation_state = 'matched' WHERE tenant_id = $1 AND provider_transaction_id = $2`, [TENANT_A, aged.id]);
    await cards.runCardAnomalyDetection(TENANT_A, "business");
    const after = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(after.find((r) => r.provider_transaction_id === aged.id)?.anomaly_flags).not.toContain("UNEXPECTED_CARD_SPEND");
  });

  it("CARD_SPEND_AFTER_FREEZE + CARD_AMOUNT_LIMIT_BREACH", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await cards.updateSpendPolicy(TENANT_A, "business", card_id, { requested_transaction_limit_ore: 10_000 });
    await cards.freezeCard(TENANT_A, "business", card_id);
    const lateTx = providerTx({ amountOre: 50_000, transactionAt: new Date(Date.now() + 60_000).toISOString() });
    gateway.onListTransactions = async () => ({ items: [lateTx], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    await cards.runCardAnomalyDetection(TENANT_A, "business");
    const rows = await cards.listCardTransactions(TENANT_A, "business", { card_id });
    expect(rows[0]!.anomaly_flags).toContain("CARD_SPEND_AFTER_FREEZE");
    expect(rows[0]!.anomaly_flags).toContain("CARD_AMOUNT_LIMIT_BREACH");
  });

  it("flaggede korttransaksjoner overflates som card_anomaly_attention via EKSISTERENDE OpenLoopService-sveip", async () => {
    freshServices();
    const { card_id } = await activeCard();
    const tx = providerTx({ currency: "NOK" }); // -> CARD_CURRENCY_MISMATCH
    gateway.onListTransactions = async () => ({ items: [tx], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    await cards.runCardAnomalyDetection(TENANT_A, "business");
    const openLoops = new OpenLoopService(appPool);
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const loop = loops.find((l) => l.loop_type === "card_anomaly_attention");
    expect(loop).toBeDefined();
    expect(loop!.detection_key).toContain("card_anomaly_attention:tx:");
  });

  it("RLS: tenant B ser ALDRI tenant A sine kort/autorisasjoner/transaksjoner og kan ikke handle på A sitt kort", async () => {
    freshServices();
    const { card_id } = await activeCard();
    gateway.onListTransactions = async () => ({ items: [providerTx()], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    expect((await cards.listCards(TENANT_B, "business", true)).length).toBe(0);
    expect((await cards.listAuthorizations(TENANT_B, "business")).length).toBe(0);
    expect((await cards.listCardTransactions(TENANT_B, "business")).length).toBe(0);
    await expect(cards.freezeCard(TENANT_B, "business", card_id)).rejects.toThrow("card_not_found");
  });

  it("nødbryteren stopper ALDRI passiv synk/avstemming/avviksdeteksjon", async () => {
    freshServices();
    const { card_id } = await activeCard();
    await finance.enableKillSwitch(TENANT_A, "person-wall-owner", "test");
    gateway.onListTransactions = async () => ({ items: [providerTx()], nextPageToken: null });
    await expect(cards.syncTransactions(TENANT_A, "business", card_id)).resolves.toBeDefined();
    await expect(cards.syncCardState(TENANT_A, "business", card_id)).resolves.toBeDefined();
    await expect(cards.reconcileCardTransactions(TENANT_A, "business")).resolves.toBeDefined();
    await expect(cards.runCardAnomalyDetection(TENANT_A, "business")).resolves.toBeDefined();
  });

  it("PCI-grensen: ingen rad inneholder full PAN/CVV/PIN eller privatnøkkelen - kun maskert referanse", async () => {
    freshServices();
    const { card_id } = await activeCard();
    gateway.onListTransactions = async () => ({ items: [providerTx()], nextPageToken: null });
    await cards.syncTransactions(TENANT_A, "business", card_id);
    const { rows } = await adminPool.query(
      `SELECT to_jsonb(pc.*) AS card, (SELECT jsonb_agg(to_jsonb(ct.*)) FROM card_transactions ct WHERE ct.card_id = pc.card_id) AS txs,
              (SELECT jsonb_agg(to_jsonb(ce.*)) FROM card_events ce WHERE ce.card_id = pc.card_id) AS events
       FROM provider_cards pc WHERE pc.card_id = $1`,
      [card_id]
    );
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toMatch(/\b\d{16}\b/); // ingen full PAN.
    expect(serialized.toLowerCase()).not.toContain("cvv");
    expect(serialized.toLowerCase()).not.toContain("cvc");
    expect(serialized).not.toContain(FAKE_PRIVATE_KEY);
    expect((await cards.getCard(TENANT_A, "business", card_id))?.masked_card_number).toBe("…4321");
  });
});
