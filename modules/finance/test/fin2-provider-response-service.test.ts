import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  AmbiguousProviderResponseError,
  BankingService,
  CardService,
  FinanceService,
  NeonomicsTransport,
  ProviderOutcomeUnknownError,
  StripeTransport,
  VippsTransport,
  WallesterTransport,
  type NeonomicsCredentials,
  type NeonomicsGateway,
  type PaymentIntent
} from "../src/index.ts";
const fixtureToken = (...parts: string[]): string => parts.join("-"); // fikstur-tokens bygges sammensatt ved kjøring (aldri en bokstavelig nøkkelform i kilden)

/**
 * WP-FIN2 K7 (D-486): et UGYLDIG 2xx-svar fra leverandøren (mangler id/beløp/valuta/status) gjennom de EKTE transportene og tjenestene: aldri en lagret «undefined» som provider-id,
 * aldri en `?? "PDNG"`-status; i stedet UKJENT utfall (`ProviderOutcomeUnknownError`, flagg, Stripe/Vipps tilbake til draft, Neonomics/Wallester blir stående uten leverandør-id). `fetch` er stubbet; mot ekte Postgres.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-fin2-resp";
const APP_ROLE = "jarvis_fin2_resp";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-resp-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${APP_ROLE}`);
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 response', 'business')`);
  appPool = createPool({ ...base, user: APP_ROLE, password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);
afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** Alle forespørsler: token-endepunkter gyldig, alt annet `body`. */
function stubFetch(body: unknown): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    if (/accesstoken\/get|openid-connect\/token/.test(String(url))) return jsonResponse({ access_token: fixtureToken("tok", "fixture"), expires_in: 3600 });
    return jsonResponse(body);
  });
  return { calls };
}

const intentRow = async (id: string) => (await adminPool.query("SELECT state, provider_ref, provider_status, anomaly_flags FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as {
  state: string; provider_ref: string | null; provider_status: string | null; anomaly_flags: string[];
};

async function newIntent(svc: FinanceService, provider: "stripe" | "vipps" | "neonomics", extra: Record<string, unknown> = {}): Promise<PaymentIntent> {
  return svc.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "FIN2 ugyldig svar", amount_ore: 10_000, vendor_name: `Lev ${randomUUID().slice(0, 6)}`, account_code: "kategori", provider, ...extra
  } as never);
}

describe("K7: ugyldig 2xx ved innsending = ukjent utfall, aldri en lagret «undefined»", () => {
  it("Stripe: svar uten id/status gir ProviderOutcomeUnknownError; intensjonen er tilbake i draft, flagget, provider_ref er NULL", async () => {
    const svc = new FinanceService(appPool, undefined, { getCredentials: async () => ({ secretKey: fixtureToken("sk", "fixture", "not", "a", "key") }) }, (c) => new StripeTransport(c.secretKey));
    const intent = await newIntent(svc, "stripe");
    stubFetch({ object: "payment_intent", amount: 10_000, currency: "nok" }); // id og status mangler
    const err = await svc.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, { getCredentials: async () => null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
    expect((err as Error).message).toBe("outcome_unknown:provider_response_invalid:id_missing");
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("draft"); // Stripe slår sammen gjentatte kall med samme Idempotency-Key
    expect(row.provider_ref).toBeNull();
    expect(row.provider_status).toBeNull();
    expect(row.anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
  });

  it("Vipps: svar uten `reference` (eller med en annen) gir ukjent utfall; ingen provider_ref lagres. (Fiks-runde 1, FIX-2: manglende state/beløp er IKKE lenger ukjent utfall - se fin2-vipps-ack-and-locks.test.ts)", async () => {
    const svc = new FinanceService(
      appPool, undefined, undefined, undefined, undefined, undefined,
      { getCredentials: async () => ({ clientId: "c", clientSecret: fixtureToken("s", "fixture"), subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" as const }) },
      (c) => new VippsTransport(c.clientId, c.clientSecret, c.subscriptionKey, c.merchantSerialNumber, c.environment)
    );
    const intent = await newIntent(svc, "vipps");
    stubFetch({ state: "CREATED", amount: { currency: "NOK", value: 10_000 } }); // reference mangler
    const err = await svc.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, { getCredentials: async () => null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
    expect((err as Error).message).toBe("outcome_unknown:provider_response_invalid:reference_missing");
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("draft");
    expect(row.provider_ref).toBeNull();
    expect(row.anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
  });

  it("Neonomics: svar uten betalings-id/status gir ukjent utfall; intensjonen blir stående `submitted` UTEN provider_ref (ikke «undefined») og ny innsending blokkeres", async () => {
    const credentials: NeonomicsCredentials = { clientId: "fake-client", clientSecret: fixtureToken("fake", "secret", "fixture"), deviceId: "11111111-2222-3333-4444-555555555555", environment: "sandbox" };
    const provider = { getCredentials: async () => credentials };
    // oppsett: samtykke + debitorkonto via en fake bankgateway (kun AIS-delen)
    const setupGateway = new Proxy({}, {
      get: (_t, name: string | symbol) => {
        if (typeof name !== "string" || name === "then") return undefined;
        if (name === "createSession") return async (bankId: string) => ({ sessionId: `sess-${bankId}-${randomUUID()}` });
        if (name === "getConsentUrl") return async () => ({ url: "https://bank.example.test/sca" });
        if (name === "listAccounts") return async () => [{ id: "prov-acc-1", accountName: "Konto", accountNumber: "12345678903", currency: "NOK", accountType: "checking" }];
        return async () => { throw new Error(`unexpected_gateway_call:${name}`); };
      }
    }) as unknown as NeonomicsGateway;
    const banking = new BankingService(appPool, provider, () => setupGateway);
    const consent = await banking.createConsent(TENANT, "business", { bank_id: "dnb-no", bank_name: "DNB" });
    const { callback_state } = await banking.getConsentAuthorizationUrl(TENANT, "business", consent.consent_id, "https://jarvis.internal/bank/callback");
    await banking.completeConsentCallback(TENANT, "business", consent.consent_id, callback_state);
    await banking.syncAccounts(TENANT, "business", consent.consent_id);
    const account = (await banking.listBankAccounts(TENANT, "business")).find((a) => a.consent_id === consent.consent_id)!;

    const svc = new FinanceService(
      appPool, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, provider,
      (c) => new NeonomicsTransport(c.clientId, c.clientSecret, c.deviceId, c.environment)
    );
    const intent = await newIntent(svc, "neonomics", { vendor_provider_ref: "98765432101", counter_account_code: account.bank_account_id });
    const fetchSpy = stubFetch({}); // verken id eller status
    const err = await svc.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, { getCredentials: async () => null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
    expect((err as Error).message).toBe("outcome_unknown:provider_response_invalid:id_missing");
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("submitted");
    expect(row.provider_ref).toBeNull(); // aldri strengen «undefined»
    expect(row.provider_status).toBeNull(); // aldri en stille «PDNG»
    expect(row.anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
    const payments = fetchSpy.calls.filter((u) => u.includes("domestic-transfer"));
    expect(payments).toHaveLength(1); // betalingen sendes ÉN gang
    const retry = await svc.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, { getCredentials: async () => null }).catch((e: unknown) => e);
    expect(retry).toBeInstanceOf(AmbiguousProviderResponseError);
    expect(fetchSpy.calls.filter((u) => u.includes("domestic-transfer"))).toHaveLength(1);
  });

  it("Wallester: createCard-svar uten id gir ukjent utfall + CARD_SUBMIT_OUTCOME_UNKNOWN; ingen provider_card_id lagres", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const { createRsaJwtSigner } = await import("../src/index.ts");
    const cards = new CardService(
      appPool,
      { getCredentials: async () => ({ baseUrl: "https://wallester.test", apiKey: fixtureToken("key", "fixture"), sign: createRsaJwtSigner(privateKey), accountId: "acc-1", environment: "sandbox" as const }) },
      (c) => new WallesterTransport(c.baseUrl, c.apiKey, c.sign, c.accountId), () => null, () => TENANT
    );
    const draft = await cards.createCard(TENANT, "business", { idempotency_key: `card-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual", currency: "EUR" });
    const fetchSpy = stubFetch({ status: "Active" }); // id mangler
    const err = await cards.submitCard(TENANT, "business", draft.card_id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
    expect((err as Error).message).toBe("outcome_unknown:provider_response_invalid:id_missing");
    const row = (await adminPool.query("SELECT provider_card_id, state, anomaly_flags FROM provider_cards WHERE card_id = $1", [draft.card_id])).rows[0] as { provider_card_id: string | null; state: string; anomaly_flags: string[] };
    expect(row.provider_card_id).toBeNull();
    expect(row.state).toBe("draft");
    expect(row.anomaly_flags).toContain("CARD_SUBMIT_OUTCOME_UNKNOWN");
    expect(fetchSpy.calls.filter((u) => u.endsWith("/v1/cards"))).toHaveLength(1);
  });
});

describe("K7: ugyldig 2xx ved LESING = typet feil uten flagg, og tilstanden røres ikke", () => {
  it("Stripe-oppfrisking med ugyldig svar kaster en typet feil; intensjonens tilstand og flagg er uendret", async () => {
    const svc = new FinanceService(appPool, undefined, { getCredentials: async () => ({ secretKey: fixtureToken("sk", "fixture", "not", "a", "key") }) }, (c) => new StripeTransport(c.secretKey));
    const intent = await newIntent(svc, "stripe");
    await adminPool.query("UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = 'pi_read', provider_status = 'requires_payment_method', provider_status_updated_at = now() - interval '1 hour' WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    const flagsBefore = (await intentRow(intent.payment_intent_id)).anomaly_flags;
    stubFetch({ object: "payment_intent", id: "pi_read", amount: -5, currency: "nok", status: "succeeded" });
    const err = await svc.refreshStripePaymentState(TENANT, "business", intent.payment_intent_id).catch((e: unknown) => e);
    expect((err as Error).message).toBe("provider_response_invalid:stripe.get_payment_intent:amount_negative");
    const row = await intentRow(intent.payment_intent_id);
    expect(row.state).toBe("provider_acknowledged");
    expect(row.provider_status).toBe("requires_payment_method");
    expect(row.anomaly_flags).toEqual(flagsBefore);
  });
});
