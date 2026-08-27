// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - SJETTE SLICE (D-112) - WALLESTER
// PROGRAMMABLE CARDS GUARDED LIVE ACCEPTANCE (NO WALLESTER CREDENTIALS REQUIRED)
//
// Kjøres AV TOBIAS mot en ekte lokal Postgres (via docker-compose) og den
// EKTE runtime-rollen (Q-21). Gjenbruker KUN eksisterende arkitektur
// (@jarvis/finance CardService/FinanceService/BankingService/
// WallesterFinanceTransport, @jarvis/tool-gateway ToolGateway/
// EnvSecretProvider, @jarvis/business OpenLoopService, @jarvis/policy,
// @jarvis/core) - INGEN alternativ testimplementasjon, INGEN
// produksjonsatferd endret av dette scriptet.
//
// D-108/§27: denne runneren krever BEVISST INGEN JARVIS_WALLESTER_*-
// credentials - Wallester sitt EKTE HTTP-kall (`WallesterTransport`) er
// ALDRI konstruert her. I stedet injiseres en deterministisk, skriptbar
// `WallesterGatewayFactory`-fake ved NETTVERKSGRENSEN (samme mock-grense
// som testmatrisen i `test/wallester-service.test.ts`) - dette beviser
// PRODUKT-WIRING, IKKE ekte Wallester-reachability.
// `WALLESTER_LIVE_VERIFIED=false`/`WALLESTER_LIVE_GATE=PENDING_CREDENTIALS`
// forblir sanne til Tobias selv oppretter og verifiserer en ekte
// Wallester Business-konto med API-tilgang (D-108).
//
// SANNTIDSAUTORISASJON (§10, korrigert owner-provided primary-source-audit,
// PR #62 runde 4): `wallester_realtime_authorization_policy` rapporteres
// `NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API`. TO DISTINKTE
// Wallester-API-produkter er nå owner-provided bekreftet: Wallester
// Business (det VALGTE produktet, api-frontend.wallester.com) dokumenterer
// INGEN synkron decision-request-kapabilitet; Wallester Card API
// (api-doc.wallester.com, IKKE det valgte produktet) gjør det. Dette er en
// ærlig produkt-VALG-begrensning, IKKE lenger en uverifisert kapabilitet -
// IKKE implementert mot en gjettet kontrakt for en direkte finansiell
// autorisasjonsbeslutning (D-41 anti-gjetting) - Jarvis uttrykker policy
// GJENNOM de provider-anvendte grensene + frys inntil videre.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/finance/scripts/wallester-live.ts
// (normalt via modules/finance/scripts/wallester-live-host-run.ts)
//
// Bruker UTELUKKENDE en syntetisk, kjøre-unik tenant for Jarvis-side
// fixtures - RØRER ALDRI ekte Jarvis-kundedata. All test-scaffolding
// fjernes ved slutten (inkl. provider_cards/card_spend_policies/
// card_events/card_authorizations/card_transactions/wallester_webhook_events).

import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, OpenLoopService } from "@jarvis/business";
import {
  BankingService, CardService, FinanceService, FinanceTransport, NeonomicsFinanceTransport, StripeFinanceTransport,
  VippsFinanceTransport, WallesterFinanceTransport,
  type CreateWallesterCardInput,
  type FikenCredentials, type FikenCredentialsProvider,
  type NeonomicsCredentials, type NeonomicsCredentialsProvider,
  type StripeCredentials, type StripeCredentialsProvider, type StripePaymentWriter,
  type VippsCredentials, type VippsCredentialsProvider,
  type WallesterCredentials, type WallesterCredentialsProvider
} from "../src/index.ts";
import type { StripePaymentIntentObject, StripeRefundObject } from "../src/stripe-transport.ts";
import type { VippsPaymentObject, VippsPaymentWriter } from "../src/vipps-transport.ts";
import type {
  InitiateNeonomicsPaymentInput, NeonomicsAccount, NeonomicsBalance, NeonomicsBank,
  NeonomicsGateway, NeonomicsPaymentObject, NeonomicsTransaction, NeonomicsTransactionPage
} from "../src/neonomics-transport.ts";
import { buildWallesterBusinessJwt, createRsaJwtSigner } from "../src/wallester-transport.ts";
import type {
  WallesterAccountBalance, WallesterAuthorizationObject, WallesterCardLimitsApplied, WallesterCardLimitsInput,
  WallesterCardObject, WallesterGateway, WallesterPage, WallesterTransactionObject
} from "../src/wallester-transport.ts";
import { createApiServer } from "../../../apps/api/src/server.ts";
import { evaluateSecretSafety } from "./lib/fiken-live-lib.ts";

const results: Record<string, string> = {
  q21_runtime_role_safe: "NOT_RUN",
  finance_d107_invariant_preserved: "NOT_RUN",
  finance_slice2_invariants_preserved: "NOT_RUN",
  stripe_slice3_invariants_preserved: "NOT_RUN",
  vipps_slice4_invariants_preserved: "NOT_RUN",
  neonomics_slice5_invariants_preserved: "NOT_RUN",
  // Owner-provided primary-source-audit (PR #62 runde 4): bekrefter det
  // valgte Wallester Business-produktets api_key/ts/RS256/Bearer-
  // autentiseringskontrakt (verifisert via wallester-transport.test.ts
  // sitt vi.stubGlobal-wire-nivå-bevis, IKKE nettverksreachability).
  wallester_business_auth_contract: "NOT_RUN",
  wallester_adapter_wiring: "NOT_RUN",
  wallester_card_creation_idempotency: "NOT_RUN",
  wallester_card_lifecycle: "NOT_RUN",
  wallester_spend_controls: "NOT_RUN",
  wallester_card_state_sync: "NOT_RUN",
  wallester_authorization_settlement: "NOT_RUN",
  wallester_transaction_idempotency: "NOT_RUN",
  wallester_webhook_auth_contract: "NOT_RUN",
  wallester_webhook_idempotency: "NOT_RUN",
  wallester_finance_reconciliation: "NOT_RUN",
  wallester_anomaly_integration: "NOT_RUN",
  wallester_openloop_integration: "NOT_RUN",
  wallester_tenant_isolation: "NOT_RUN",
  wallester_kill_switch_semantics: "NOT_RUN",
  wallester_secret_safety: "NOT_RUN",
  wallester_pci_boundary: "NOT_RUN",
  // §10/§27, korrigert owner-provided primary-source-audit (PR #62 runde 4):
  // det VALGTE produktet er Wallester Business, som IKKE dokumenterer en
  // synkron decision-request-kapabilitet (den finnes i Wallester Card API -
  // en ANNEN, IKKE-valgt produkt-grense). Ærlig produkt-begrensning for det
  // valgte produktet - IKKE en feil, IKKE lenger "uverifisert" (begge
  // produktenes kapabilitet er nå owner-provided bekreftet distinkt).
  wallester_realtime_authorization_policy: "NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API",
  wallester_cleanup: "NOT_RUN"
};

const logBuffer: string[] = [];
function log(msg: string): void {
  logBuffer.push(msg);
  console.log(msg);
}

async function section<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  log(`\n== ${name} ==`);
  try {
    return await fn();
  } catch (err) {
    log(`${name}: UVENTET FEIL - ${(err as Error).message.slice(0, 300)}`);
    return undefined;
  }
}

function mustExternalId(result: Awaited<ReturnType<InstanceType<typeof ToolGateway>["execute"]>>, label: string): string {
  if (!result.ok) throw new Error(`${label}_denied:${result.reason}`);
  if (!result.external_id) throw new Error(`${label}_did_not_return_external_id`);
  return result.external_id;
}

const runId = randomUUID().slice(0, 8);
log(`UA-6 FINANCE & SPEND INTEGRITY GATEWAY - SJETTE SLICE (D-112) WALLESTER GUARDED LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-wallester-live-${runId}-a`;
const TENANT_B = `tenant-wallester-live-${runId}-b`;
const OWNER_PERSON = `person-wallester-live-${runId}`;
// Fake webhook-Basic-credentials - BEVISST IKKE ekte Wallester-verdier
// (ingen slike konfigureres denne sliceen, D-108) - brukes KUN til å
// bevise autentiserings-KONTRAKTEN (HTTP Basic, konstant-tid) ende-til-
// ende, og til `wallester_secret_safety` sin redaksjonssjekk under.
const FAKE_WEBHOOK_USER = `wallester-live-user-${runId}`;
const FAKE_WEBHOOK_PASSWORD = `wallester-live-acceptance-${runId}-${randomUUID()}`;
const FAKE_PRIVATE_KEY = `wallester-live-fake-key-${runId}`;
const WEBHOOK_PATH = "/webhooks/wallester";

function basicHeader(user = FAKE_WEBHOOK_USER, pass = FAKE_WEBHOOK_PASSWORD): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-wallester-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  // Barn-FK før forelder: kortdomenet (043) + bankdomenet (042).
  await adminPool.query("DELETE FROM wallester_webhook_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM card_transactions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM card_authorizations WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM card_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM card_spend_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM provider_cards WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM bank_transactions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM bank_account_balances WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM bank_accounts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM bank_consents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM neonomics_webhook_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM vipps_webhook_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM vipps_captures WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM vipps_refunds WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM stripe_webhook_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM stripe_refunds WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM payment_intent_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM payment_intents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_recurring_commitments WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_kill_switch WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_spend_records WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-wallester-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-wallester-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

/** Skriptbar fake ved Wallester-transport-NETTVERKSGRENSEN - SAMME mock-boundary-prinsipp som `test/wallester-service.test.ts`. */
class ScriptedWallesterGateway implements WallesterGateway {
  createCalls: CreateWallesterCardInput[] = [];

  onCreateCard: (input: CreateWallesterCardInput) => Promise<WallesterCardObject> = async () => ({
    id: `wcard-${randomUUID()}`, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null
  });
  onGetCard: (id: string) => Promise<WallesterCardObject> = async (id) => ({
    id, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null
  });
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
    return { id: providerCardId, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null };
  }
  async blockCard(providerCardId: string): Promise<WallesterCardObject> {
    return { id: providerCardId, status: "blocked", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null };
  }
  async unblockCard(providerCardId: string): Promise<WallesterCardObject> {
    return { id: providerCardId, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null };
  }
  async closeCard(providerCardId: string): Promise<WallesterCardObject> {
    return { id: providerCardId, status: "closed", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null };
  }
  async updateCardLimits(_providerCardId: string, limits: WallesterCardLimitsInput): Promise<WallesterCardLimitsApplied> {
    return { ...limits, confirmed: true };
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

/** Minimal Neonomics-fake KUN for neonomics_slice5_invariants_preserved-seksjonen - Neonomics-implementasjonen selv er UENDRET av denne sliceen. */
class ScriptedNeonomicsGateway implements NeonomicsGateway {
  async listBanks(): Promise<NeonomicsBank[]> {
    return [{ id: "dnb-no", bankDisplayName: "DNB", countryCode: "NO" }];
  }
  async createSession(bankId: string): Promise<{ sessionId: string }> {
    return { sessionId: `sess-${bankId}-${randomUUID()}` };
  }
  async getConsentUrl(sessionId: string, redirectUrl: string): Promise<{ url: string }> {
    return { url: `https://bank.example.test/sca?session=${sessionId}&redirect=${encodeURIComponent(redirectUrl)}` };
  }
  async listAccounts(): Promise<NeonomicsAccount[]> {
    return [{ id: "prov-acc-slice5", accountName: "Bedriftskonto", accountNumber: "12345678903", currency: "NOK", accountType: "checking" }];
  }
  async getBalances(): Promise<NeonomicsBalance[]> {
    return [];
  }
  async listTransactions(): Promise<NeonomicsTransactionPage> {
    return { transactions: [] as NeonomicsTransaction[], nextPageToken: null };
  }
  async initiateDomesticPayment(input: InitiateNeonomicsPaymentInput): Promise<NeonomicsPaymentObject> {
    return { id: `neo-pay-slice5-${input.endToEndReference}`, status: "PDNG" };
  }
  async getPaymentAuthorizeUrl(_s: string, paymentId: string): Promise<{ url: string }> {
    return { url: `https://bank.example.test/sca-payment?payment=${paymentId}` };
  }
  async getPayment(_s: string, paymentId: string): Promise<NeonomicsPaymentObject> {
    return { id: paymentId, status: "PDNG" };
  }
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk, UAVHENGIG av Wallester-credentials)", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    for (const key of Object.keys(results)) {
      if (results[key] !== "NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API") results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    }
    return finish(true);
  }

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `Wallester Live A ${runId}`, TENANT_B, `Wallester Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "Wallester Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-wallester-a-${runId}`, TENANT_A, `ms-wallester-b-${runId}`, TENANT_B]
  );

  const gateway = new ScriptedWallesterGateway();
  const neoGateway = new ScriptedNeonomicsGateway();
  const configuredTenant: string | null = TENANT_A;
  const wallesterCredentialsProvider: WallesterCredentialsProvider = {
    async getCredentials(): Promise<WallesterCredentials | null> {
      // Owner-provided primary-source-audit (PR #62 runde 4): api_key/ts,
      // IKKE issuer/audience (Wallester Card API-modellen - annen
      // produkt-grense). `sign` er en fake her - den EKTE
      // `WallesterTransport` konstrueres uansett ALDRI i dette scriptet
      // (D-108, se filhode).
      return { baseUrl: "https://wallester.invalid", apiKey: "fake-api-key-live", accountId: "wacc-live-1", sign: () => `fake-sig-${FAKE_PRIVATE_KEY}`, environment: "sandbox" };
    }
  };
  const neonomicsCredentialsProvider: NeonomicsCredentialsProvider = {
    async getCredentials(): Promise<NeonomicsCredentials | null> {
      return { clientId: "fake-client-live", clientSecret: `fake-neonomics-secret-${runId}`, deviceId: "11111111-2222-3333-4444-555555555555", environment: "sandbox" };
    }
  };
  const fikenCredentialsProvider: FikenCredentialsProvider = { async getCredentials(): Promise<FikenCredentials | null> { return null; } };
  const stripeWriter: StripePaymentWriter = {
    async createPaymentIntent(input): Promise<StripePaymentIntentObject> {
      return { id: `pi_slice3_${runId}`, object: "payment_intent", amount: input.amountOre, currency: input.currency.toLowerCase(), status: "requires_payment_method", metadata: input.metadata };
    },
    async getPaymentIntent(id): Promise<StripePaymentIntentObject> {
      return { id, object: "payment_intent", amount: 1000, currency: "nok", status: "requires_payment_method", metadata: {} };
    },
    async createRefund(input): Promise<StripeRefundObject> {
      return { id: `re_slice3_${runId}`, object: "refund", amount: input.amountOre, currency: "nok", status: "succeeded", payment_intent: input.stripePaymentIntentId, reason: null };
    },
    async getRefund(id): Promise<StripeRefundObject> {
      return { id, object: "refund", amount: 1000, currency: "nok", status: "succeeded", payment_intent: "pi_x", reason: null };
    }
  };
  const stripeCredentialsProvider: StripeCredentialsProvider = { async getCredentials(): Promise<StripeCredentials | null> { return { secretKey: "sk_test_fake_slice3_preserved" }; } };
  let vippsCreatePaymentCalls = 0;
  const vippsWriter: VippsPaymentWriter = {
    async createPayment(input): Promise<VippsPaymentObject> {
      vippsCreatePaymentCalls++;
      return { reference: input.reference, state: "CREATED", amount: { currency: input.currency, value: input.amountOre } };
    },
    async getPayment(reference): Promise<VippsPaymentObject> {
      return { reference, state: "CREATED", amount: { currency: "NOK", value: 10_000 } };
    },
    async capturePayment(input): Promise<VippsPaymentObject> {
      return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
    },
    async cancelPayment(reference): Promise<VippsPaymentObject> {
      return { reference, state: "CANCELLED", amount: { currency: "NOK", value: 10_000 } };
    },
    async refundPayment(input): Promise<VippsPaymentObject> {
      return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
    }
  };
  const vippsCredentialsProvider: VippsCredentialsProvider = {
    async getCredentials(): Promise<VippsCredentials | null> {
      return { clientId: "fake-client-live", clientSecret: "fake-vipps-secret-live", subscriptionKey: "fake-sub-live", merchantSerialNumber: "000000", environment: "test" };
    }
  };
  const finance = new FinanceService(
    pool, undefined, stripeCredentialsProvider, () => stripeWriter, () => null, () => configuredTenant,
    vippsCredentialsProvider, () => vippsWriter, () => null, () => configuredTenant,
    neonomicsCredentialsProvider, () => neoGateway, () => null, () => configuredTenant
  );
  const banking = new BankingService(pool, neonomicsCredentialsProvider, () => neoGateway);
  const cardService = new CardService(pool, wallesterCredentialsProvider, () => gateway, () => ({ username: FAKE_WEBHOOK_USER, password: FAKE_WEBHOOK_PASSWORD }), () => configuredTenant);

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A, TENANT_B] }
  });
  // SAMME sammensetning som produksjon: provider-berørende
  // `finance_wallester.*`-handlinger bruker den EKTE
  // `JARVIS_WALLESTER_PRIVATE_KEY_PEM` - som er BEVISST IKKE satt i dette
  // miljøet (D-108). `EnvSecretProvider` leser den faktiske (fraværende)
  // env-variabelen - fail-closed-oppførselen bevises EKTE, ikke simulert.
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const toolGateway = new ToolGateway(pool, policy, secrets);
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(finance, fikenCredentialsProvider),
    finance_stripe: new StripeFinanceTransport(finance),
    finance_vipps: new VippsFinanceTransport(finance),
    finance_neonomics: new NeonomicsFinanceTransport(banking, finance),
    finance_wallester: new WallesterFinanceTransport(cardService)
  })) toolGateway.register(tool);
  const identity = ownerIdentityFor(TENANT_A);

  async function wallesterAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance_wallester", action, parameters: parameters as never });
  }
  async function financeAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance", action, parameters: parameters as never });
  }
  async function newActiveCard(input: Record<string, unknown> = {}): Promise<{ card_id: string; provider_card_id: string }> {
    const draft = await cardService.createCard(TENANT_A, "business", {
      idempotency_key: `card-idem-${runId}-${randomUUID()}`, name: "Live-kort", purpose: "Live-akseptanse", card_type: "virtual", currency: "EUR",
      ...(input as object)
    });
    const submitted = await cardService.submitCard(TENANT_A, "business", draft.card_id);
    return { card_id: submitted.card_id, provider_card_id: submitted.provider_card_id! };
  }
  function liveTx(overrides: Record<string, unknown> = {}): WallesterTransactionObject {
    return {
      id: `wtx-${runId}-${randomUUID()}`, cardId: "", authorizationId: null, type: "purchase", amountOre: 25_000, currency: "EUR",
      merchantName: "Leverandør GmbH", merchantCategoryCode: "5734", channel: "online",
      transactionAt: new Date().toISOString(), settledAt: new Date().toISOString(), ...(overrides as object)
    };
  }

  // ===== Slice-invarianter preservert (Fiken/Slice2/Stripe/Vipps/Neonomics UENDRET) =====
  await section("D-107 INVARIANT PRESERVERT (Fiken idempotent payment_intent-opprettelse, UENDRET av Wallester-tillegget)", async () => {
    const key = `idem-fiken-preserved-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-107 preserved", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-107 preserved", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const id1 = mustExternalId(first, "d107_create_1");
    const id2 = mustExternalId(second, "d107_create_2");
    results.finance_d107_invariant_preserved = id1 === id2 ? "PASS" : "FAIL";
    log(`fiken_create_1=${id1} fiken_create_2=${id2} -> finance_d107_invariant_preserved: ${results.finance_d107_invariant_preserved}`);
  });

  await section("SLICE 2 INVARIANTER PRESERVERT (finance_spend_records uendret av Wallester-migrasjonen)", async () => {
    await adminPool.query(
      `INSERT INTO finance_spend_records (spend_record_id, tenant_id, memory_space_id, source_family, source_record_id, occurred_at, amount_ore, currency, category)
       VALUES ($1, $2, 'business', 'model_cost', $3, now(), 500, 'NOK', 'ai_api_cost')`,
      [`fsr-wallester-live-${runId}`, TENANT_A, `src-wallester-live-${runId}`]
    );
    const count = await adminPool.query("SELECT count(*)::int AS n FROM finance_spend_records WHERE tenant_id = $1", [TENANT_A]);
    results.finance_slice2_invariants_preserved = (count.rows[0] as { n: number }).n === 1 ? "PASS" : "FAIL";
    log(`spend_records_count=${(count.rows[0] as { n: number }).n} -> finance_slice2_invariants_preserved: ${results.finance_slice2_invariants_preserved}`);
  });

  await section("SLICE 3 INVARIANTER PRESERVERT (Stripe-grenen: idempotent opprettelse+submit, UENDRET av Wallester-tillegget)", async () => {
    const key = `idem-stripe-preserved-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-109 preserved", amount_ore: 1000, vendor_name: "x", account_code: "stripe-cat", provider: "stripe" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-109 preserved", amount_ore: 1000, vendor_name: "x", account_code: "stripe-cat", provider: "stripe" });
    const id1 = mustExternalId(first, "d109_create_1");
    const id2 = mustExternalId(second, "d109_create_2");
    const submitted = await finance.submitPaymentIntent(TENANT_A, "business", id1, {} as never);
    results.stripe_slice3_invariants_preserved = id1 === id2 && submitted.state === "provider_acknowledged" && submitted.provider_ref === `pi_slice3_${runId}` ? "PASS" : "FAIL";
    log(`stripe_create_idempotent=${id1 === id2} stripe_submit_state=${submitted.state} -> stripe_slice3_invariants_preserved: ${results.stripe_slice3_invariants_preserved}`);
  });

  await section("SLICE 4 INVARIANTER PRESERVERT (Vipps-grenen: idempotent opprettelse+submit, UENDRET av Wallester-tillegget)", async () => {
    const key = `idem-vipps-preserved-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-110 preserved", amount_ore: 1000, vendor_name: "x", account_code: "vipps-cat", provider: "vipps" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-110 preserved", amount_ore: 1000, vendor_name: "x", account_code: "vipps-cat", provider: "vipps" });
    const id1 = mustExternalId(first, "d110_create_1");
    const id2 = mustExternalId(second, "d110_create_2");
    const submitted1 = await finance.submitPaymentIntent(TENANT_A, "business", id1, {} as never);
    const submitted2 = await finance.submitPaymentIntent(TENANT_A, "business", id1, {} as never);
    results.vipps_slice4_invariants_preserved =
      id1 === id2 && submitted1.state === "provider_acknowledged" && submitted1.provider_ref === submitted2.provider_ref && vippsCreatePaymentCalls === 1 ? "PASS" : "FAIL";
    log(`vipps_create_idempotent=${id1 === id2} vipps_submit_state=${submitted1.state} vipps_provider_calls=${vippsCreatePaymentCalls} -> vipps_slice4_invariants_preserved: ${results.vipps_slice4_invariants_preserved}`);
  });

  await section("SLICE 5 INVARIANTER PRESERVERT (Neonomics-grenen: samtykke->konto->idempotent PIS-submit, UENDRET av Wallester-tillegget)", async () => {
    const consent = await banking.createConsent(TENANT_A, "business", { bank_id: "dnb-no", bank_name: "DNB" });
    const { callback_state } = await banking.getConsentAuthorizationUrl(TENANT_A, "business", consent.consent_id, "https://jarvis.internal/bank/callback");
    const active = await banking.completeConsentCallback(TENANT_A, "business", consent.consent_id, callback_state);
    await banking.syncAccounts(TENANT_A, "business", consent.consent_id);
    const account = (await banking.listBankAccounts(TENANT_A, "business")).find((a) => a.consent_id === consent.consent_id);
    const intent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `idem-neo-preserved-${runId}`, purpose: "D-111 preserved", amount_ore: 1000, vendor_name: "x",
      vendor_provider_ref: "98765432101", account_code: "neo-cat", counter_account_code: account!.bank_account_id, provider: "neonomics"
    });
    const submitted1 = await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    const submitted2 = await finance.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, { getCredentials: async () => null });
    results.neonomics_slice5_invariants_preserved =
      active.state === "active" && submitted1.state === "provider_acknowledged" && submitted1.provider_ref === submitted2.provider_ref ? "PASS" : "FAIL";
    log(`neo_consent_state=${active.state} neo_submit_state=${submitted1.state} neo_idempotent=${submitted1.provider_ref === submitted2.provider_ref} -> neonomics_slice5_invariants_preserved: ${results.neonomics_slice5_invariants_preserved}`);
  });

  // ===== wallester_adapter_wiring =====
  let wiringCardId = "";
  await section("WALLESTER ADAPTER WIRING (finance_wallester.* registrert/dispatchet via ToolGateway)", async () => {
    const created = await wallesterAction("create_card", {
      tenant_id: TENANT_A, idempotency_key: `wiring-${runId}`, name: "Wiring-kort", purpose: "Wiring", card_type: "virtual", currency: "EUR"
    });
    wiringCardId = mustExternalId(created, "wallester_create_card");
    const listResult = await wallesterAction("list_cards", { tenant_id: TENANT_A });
    const txResult = await wallesterAction("list_card_transactions", { tenant_id: TENANT_A });
    results.wallester_adapter_wiring = created.ok && listResult.ok && txResult.ok ? "PASS" : "FAIL";
    log(`card_id=${wiringCardId} list_cards_ok=${listResult.ok} list_card_transactions_ok=${txResult.ok} -> wallester_adapter_wiring: ${results.wallester_adapter_wiring}`);
  });

  // ===== wallester_business_auth_contract =====
  await section("WALLESTER BUSINESS AUTH CONTRACT (owner-provided primary-source-audit, PR #62 runde 4: api_key/ts-claims, RS256, Bearer - IKKE issuer/audience/sub/exp/rbh)", async () => {
    // Ephemeral test-nøkkelpar (byggeordrens eksplisitte instruks: ALDRI en
    // gjettet/antatt EKTE Wallester-nøkkel her - kun for å bevise at
    // `createRsaJwtSigner`/`buildWallesterBusinessJwt` PRODUSERER den
    // dokumenterte wire-formen, IKKE reell Wallester-reachability).
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sign = createRsaJwtSigner(privateKey.export({ type: "pkcs1", format: "pem" }).toString());
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const jwt = buildWallesterBusinessJwt({ apiKey: "wba-live-test-key", sign, nowEpochSeconds });
    const parts = jwt.split(".");
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const headerOk = header["alg"] === "RS256" && header["typ"] === "JWT";
    const payloadOk = payload["api_key"] === "wba-live-test-key" && payload["ts"] === nowEpochSeconds;
    const noCardApiClaims = !("iss" in payload) && !("aud" in payload) && !("sub" in payload) && !("exp" in payload) && !("rbh" in payload);
    const threeParts = parts.length === 3;
    results.wallester_business_auth_contract = headerOk && payloadOk && noCardApiClaims && threeParts ? "PASS" : "FAIL";
    log(`header_alg_typ_ok=${headerOk} payload_api_key_ts_ok=${payloadOk} no_card_api_claims=${noCardApiClaims} jwt_three_parts=${threeParts} -> wallester_business_auth_contract: ${results.wallester_business_auth_contract}`);
  });

  // ===== wallester_secret_safety (fail-closed uten JARVIS_WALLESTER_PRIVATE_KEY_PEM - EKTE, ikke simulert) =====
  await section("WALLESTER SECRET SAFETY (provider-berørende finance_wallester.* MÅ avvises credential_unavailable UTEN JARVIS_WALLESTER_PRIVATE_KEY_PEM - D-108)", async () => {
    const secretConfigured = Boolean(process.env["JARVIS_WALLESTER_PRIVATE_KEY_PEM"]);
    if (secretConfigured) {
      log("JARVIS_WALLESTER_PRIVATE_KEY_PEM ER konfigurert i dette miljøet - fail-closed-beviset under er derfor IKKE relevant. Markerer NOT_RUN i stedet for et falskt PASS.");
      results.wallester_secret_safety = "NOT_RUN";
      return;
    }
    const submitDenied = await wallesterAction("submit_card", { tenant_id: TENANT_A, card_id: wiringCardId });
    const secretSafetyDenied = !submitDenied.ok && submitDenied.reason === "credential_unavailable";
    const redactionOk = evaluateSecretSafety(logBuffer, [FAKE_WEBHOOK_PASSWORD, FAKE_PRIVATE_KEY]);
    results.wallester_secret_safety = secretSafetyDenied && redactionOk === "PASS" ? "PASS" : "FAIL";
    log(`submit_card_denied=${!submitDenied.ok} deny_reason=${submitDenied.ok ? "n/a" : submitDenied.reason} log_redaction=${redactionOk} -> wallester_secret_safety: ${results.wallester_secret_safety}`);
  });

  // ===== wallester_card_creation_idempotency =====
  let cardId = "";
  let providerCardId = "";
  await section("WALLESTER CARD CREATION IDEMPOTENCY (retry kan aldri skape duplikatkort; kanonisk card_id er provider-ekstern referanse)", async () => {
    const key = `card-idem-main-${runId}`;
    const d1 = await cardService.createCard(TENANT_A, "business", { idempotency_key: key, name: "Hovedkort", purpose: "Live", card_type: "virtual", currency: "EUR", requested_transaction_limit_ore: 100_000 });
    const d2 = await cardService.createCard(TENANT_A, "business", { idempotency_key: key, name: "Hovedkort", purpose: "Live", card_type: "virtual" });
    const s1 = await cardService.submitCard(TENANT_A, "business", d1.card_id);
    const s2 = await cardService.submitCard(TENANT_A, "business", d1.card_id);
    cardId = s1.card_id;
    providerCardId = s1.provider_card_id!;
    results.wallester_card_creation_idempotency =
      d1.card_id === d2.card_id && s1.provider_card_id === s2.provider_card_id && gateway.createCalls.length === 1 && gateway.createCalls[0]!.externalReference === cardId
        ? "PASS" : "FAIL";
    log(`draft_idempotent=${d1.card_id === d2.card_id} provider_calls=${gateway.createCalls.length} external_ref_is_card_id=${gateway.createCalls[0]?.externalReference === cardId} -> wallester_card_creation_idempotency: ${results.wallester_card_creation_idempotency}`);
  });

  // ===== wallester_card_lifecycle =====
  await section("WALLESTER CARD LIFECYCLE (freeze -> unfreeze -> close; historikk bevares; ugyldig overgang avvises)", async () => {
    const { card_id } = await newActiveCard();
    const frozen = await cardService.freezeCard(TENANT_A, "business", card_id);
    const unfrozen = await cardService.unfreezeCard(TENANT_A, "business", card_id);
    const closed = await cardService.closeCard(TENANT_A, "business", card_id);
    let invalidRejected = false;
    try {
      await cardService.freezeCard(TENANT_A, "business", card_id);
    } catch (err) {
      invalidRejected = (err as Error).name === "CardInvalidStateError";
    }
    const events = await adminPool.query(`SELECT count(*)::int AS n FROM card_events WHERE card_id = $1`, [card_id]);
    results.wallester_card_lifecycle =
      frozen.state === "frozen" && unfrozen.state === "active" && closed.state === "closed" && invalidRejected && (events.rows[0] as { n: number }).n >= 5 ? "PASS" : "FAIL";
    log(`frozen=${frozen.state} unfrozen=${unfrozen.state} closed=${closed.state} invalid_rejected=${invalidRejected} audit_events=${(events.rows[0] as { n: number }).n} -> wallester_card_lifecycle: ${results.wallester_card_lifecycle}`);
  });

  // ===== wallester_spend_controls =====
  await section("WALLESTER SPEND CONTROLS (ØNSKET vs PROVIDER-ANVENDT - anvendt settes KUN fra provider-ekko)", async () => {
    const policy = await cardService.updateSpendPolicy(TENANT_A, "business", cardId, {
      requested_daily_limit_ore: 200_000, requested_monthly_limit_ore: 1_000_000, requested_atm_enabled: false, requested_online_enabled: true
    });
    results.wallester_spend_controls =
      policy.sync_state === "applied" && policy.applied_daily_limit_ore === 200_000 && policy.applied_monthly_limit_ore === 1_000_000 && policy.applied_atm_enabled === false
        ? "PASS" : "FAIL";
    log(`sync_state=${policy.sync_state} applied_daily=${policy.applied_daily_limit_ore} applied_atm=${policy.applied_atm_enabled} -> wallester_spend_controls: ${results.wallester_spend_controls}`);
  });

  // ===== wallester_card_state_sync =====
  await section("WALLESTER CARD STATE SYNC (passiv reparasjon fra provider; lukket kort resurrekteres ALDRI - konflikt flagges)", async () => {
    gateway.onGetCard = async (id) => ({ id, status: "blocked", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null });
    const repaired = await cardService.syncCardState(TENANT_A, "business", cardId);
    const repairedOk = repaired.state === "frozen" && repaired.provider_state === "blocked";
    gateway.onGetCard = async (id) => ({ id, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null });
    await cardService.syncCardState(TENANT_A, "business", cardId); // tilbake til active for videre seksjoner.
    const { card_id: closedCardId } = await newActiveCard();
    await cardService.closeCard(TENANT_A, "business", closedCardId);
    const conflicted = await cardService.syncCardState(TENANT_A, "business", closedCardId);
    const conflictOk = conflicted.state === "closed" && conflicted.anomaly_flags.includes("CARD_PROVIDER_STATE_CONFLICT");
    results.wallester_card_state_sync = repairedOk && conflictOk ? "PASS" : "FAIL";
    log(`repaired_frozen=${repairedOk} closed_conflict_flagged=${conflictOk} -> wallester_card_state_sync: ${results.wallester_card_state_sync}`);
  });

  // ===== wallester_authorization_settlement =====
  await section("WALLESTER AUTHORIZATION->SETTLEMENT (deterministisk lenking - ETT økonomisk beløp, aldri to spend-poster; avslag gir ingen økonomisk rad)", async () => {
    const authId = `wauth-${runId}-1`;
    gateway.onListAuthorizations = async () => ({
      items: [
        { id: authId, cardId: providerCardId, status: "approved", amountOre: 25_000, currency: "EUR", merchantName: "Leverandør GmbH", merchantCategoryCode: "5734", channel: "online", declineReason: null, authorizedAt: new Date().toISOString() },
        { id: `wauth-${runId}-declined`, cardId: providerCardId, status: "declined", amountOre: 99_000, currency: "EUR", merchantName: null, merchantCategoryCode: null, channel: "online", declineReason: "limit_exceeded", authorizedAt: new Date().toISOString() }
      ],
      nextPageToken: null
    });
    await cardService.syncAuthorizations(TENANT_A, "business", cardId);
    gateway.onListTransactions = async () => ({ items: [liveTx({ authorizationId: authId })], nextPageToken: null });
    await cardService.syncTransactions(TENANT_A, "business", cardId);
    const auths = await cardService.listAuthorizations(TENANT_A, "business", { card_id: cardId });
    const settledAuth = auths.find((a) => a.provider_authorization_id === authId);
    const declinedAuth = auths.find((a) => a.provider_authorization_id === `wauth-${runId}-declined`);
    const txs = await cardService.listCardTransactions(TENANT_A, "business", { card_id: cardId });
    results.wallester_authorization_settlement =
      settledAuth?.status === "settled" && declinedAuth?.status === "declined" && txs.length === 1 && txs[0]!.authorization_id === settledAuth!.authorization_id && txs[0]!.anomaly_flags.length === 0
        ? "PASS" : "FAIL";
    log(`auth_settled=${settledAuth?.status} declined_terminal=${declinedAuth?.status} economic_rows=${txs.length} linked=${txs[0]?.authorization_id === settledAuth?.authorization_id} -> wallester_authorization_settlement: ${results.wallester_authorization_settlement}`);
  });

  // ===== wallester_transaction_idempotency =====
  await section("WALLESTER TRANSACTION IDEMPOTENCY (re-synk dupliserer aldri; korreksjon flagges - originalen bevares)", async () => {
    const tx = liveTx();
    gateway.onListTransactions = async () => ({ items: [tx], nextPageToken: null });
    const first = await cardService.syncTransactions(TENANT_A, "business", cardId);
    const second = await cardService.syncTransactions(TENANT_A, "business", cardId);
    gateway.onListTransactions = async () => ({ items: [{ ...tx, amountOre: 99_999 }], nextPageToken: null });
    const corrected = await cardService.syncTransactions(TENANT_A, "business", cardId);
    const row = (await cardService.listCardTransactions(TENANT_A, "business", { card_id: cardId })).find((r) => r.provider_transaction_id === tx.id);
    results.wallester_transaction_idempotency =
      first.inserted === 1 && second.inserted === 0 && corrected.corrections_flagged === 1 && row?.amount_ore === 25_000 && row.anomaly_flags.includes("CARD_TRANSACTION_CORRECTION_CONFLICT")
        ? "PASS" : "FAIL";
    log(`first_inserted=${first.inserted} resync_inserted=${second.inserted} correction_flagged=${corrected.corrections_flagged} original_preserved=${row?.amount_ore === 25_000} -> wallester_transaction_idempotency: ${results.wallester_transaction_idempotency}`);
  });

  // ===== wallester_webhook_auth_contract + wallester_webhook_idempotency (EKTE HTTP-rute) =====
  await section("WALLESTER WEBHOOK AUTH CONTRACT + IDEMPOTENCY (ekte HTTP POST /webhooks/wallester - gyldig Basic, ugyldig og duplisert)", async () => {
    const server = createApiServer({
      identity: { resolveIdentity: async () => ({ ok: false, reason: "not_used" }) } as never,
      sessions: {} as never, conversation: {} as never, policy, worker: {} as never,
      finance: { service: finance, cards: cardService }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const host = `127.0.0.1:${port}`;
    try {
      // Owner-provided Business-konvolutt (PR #62 runde 4): `event`
      // (konstant "notification") DISTINKT fra `type` (klassifikatoren)
      // - IKKE lenger et punktum-separert "authorization.approved"-felt.
      const body = JSON.stringify({
        event: "notification", type: "authorization", event_id: `evt-live-${runId}`,
        data: { id: `wauth-${runId}-wh`, card_id: providerCardId, status: "approved", amount: 7_500, currency: "EUR", channel: "online" }
      });
      const validRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body, headers: { authorization: basicHeader() } });
      const invalidRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body, headers: { authorization: basicHeader(FAKE_WEBHOOK_USER, "feil-passord-live") } });
      results.wallester_webhook_auth_contract = validRes.status === 200 && invalidRes.status === 401 ? "PASS" : "FAIL";
      log(`valid_auth_http_status=${validRes.status} invalid_auth_http_status=${invalidRes.status} -> wallester_webhook_auth_contract: ${results.wallester_webhook_auth_contract}`);

      const dupRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body, headers: { authorization: basicHeader() } });
      const dupBody = (await dupRes.json()) as { status: string };
      results.wallester_webhook_idempotency = dupRes.status === 200 && dupBody.status === "duplicate" ? "PASS" : "FAIL";
      log(`duplicate_event_http_status=${dupRes.status} duplicate_event_body_status=${dupBody.status} -> wallester_webhook_idempotency: ${results.wallester_webhook_idempotency}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ===== wallester_finance_reconciliation =====
  await section("WALLESTER FINANCE RECONCILIATION (formålsbundet kort <-> forpliktelse; tvetydige forblir uløste - aldri gjettet)", async () => {
    const commitmentId = `com-wallester-live-${runId}`;
    await adminPool.query(
      `INSERT INTO finance_recurring_commitments (commitment_id, tenant_id, memory_space_id, vendor_name, description, cadence, expected_amount_ore, currency, amount_tolerance_ore, start_date)
       VALUES ($1, $2, 'business', 'SaaS AS', 'Live-forpliktelse', 'monthly', 33300, 'EUR', 0, '2026-01-01')`,
      [commitmentId, TENANT_A]
    );
    const { card_id: boundCardId } = await newActiveCard({ commitment_id: commitmentId });
    gateway.onListTransactions = async () => ({ items: [liveTx({ amountOre: 33_300 })], nextPageToken: null });
    await cardService.syncTransactions(TENANT_A, "business", boundCardId);
    const result = await cardService.reconcileCardTransactions(TENANT_A, "business");
    const matchedRow = (await cardService.listCardTransactions(TENANT_A, "business", { card_id: boundCardId }))[0];
    // Tvetydighet: TO forpliktelser med samme beløp -> ubundet korts transaksjon forblir ambiguous.
    for (const suffix of ["amb-a", "amb-b"]) {
      await adminPool.query(
        `INSERT INTO finance_recurring_commitments (commitment_id, tenant_id, memory_space_id, vendor_name, description, cadence, expected_amount_ore, currency, amount_tolerance_ore, start_date)
         VALUES ($1, $2, 'business', $3, 'Tvetydig', 'monthly', 55500, 'EUR', 0, '2026-01-01')`,
        [`com-${suffix}-${runId}`, TENANT_A, `Tvetydig ${suffix}`]
      );
    }
    gateway.onListTransactions = async () => ({ items: [liveTx({ amountOre: 55_500 })], nextPageToken: null });
    await cardService.syncTransactions(TENANT_A, "business", cardId);
    const result2 = await cardService.reconcileCardTransactions(TENANT_A, "business");
    results.wallester_finance_reconciliation =
      result.matched_by_purpose >= 1 && matchedRow?.reconciliation_state === "matched" && matchedRow.matched_commitment_id === commitmentId && result2.ambiguous >= 1
        ? "PASS" : "FAIL";
    log(`matched_by_purpose=${result.matched_by_purpose} matched_commitment=${matchedRow?.matched_commitment_id === commitmentId} ambiguous=${result2.ambiguous} -> wallester_finance_reconciliation: ${results.wallester_finance_reconciliation}`);
  });

  // ===== wallester_anomaly_integration =====
  let anomalyTxId = "";
  await section("WALLESTER ANOMALY INTEGRATION (CARD_CURRENCY_MISMATCH + UNEXPECTED_CASH_WITHDRAWAL; deteksjonen er selv-korrigerende)", async () => {
    const wrongCurrency = liveTx({ currency: "NOK" });
    const atmTx = liveTx({ channel: "atm", amountOre: 2_000 });
    anomalyTxId = wrongCurrency.id;
    gateway.onListTransactions = async () => ({ items: [wrongCurrency, atmTx], nextPageToken: null });
    await cardService.syncTransactions(TENANT_A, "business", cardId);
    await cardService.updateSpendPolicy(TENANT_A, "business", cardId, { requested_atm_enabled: false });
    await cardService.runCardAnomalyDetection(TENANT_A, "business");
    const rows = await cardService.listCardTransactions(TENANT_A, "business", { card_id: cardId });
    const currencyFlagged = rows.find((r) => r.provider_transaction_id === wrongCurrency.id)?.anomaly_flags.includes("CARD_CURRENCY_MISMATCH") ?? false;
    const atmFlagged = rows.find((r) => r.provider_transaction_id === atmTx.id)?.anomaly_flags.includes("UNEXPECTED_CASH_WITHDRAWAL") ?? false;
    results.wallester_anomaly_integration = currencyFlagged && atmFlagged ? "PASS" : "FAIL";
    log(`currency_mismatch_flagged=${currencyFlagged} atm_flagged=${atmFlagged} -> wallester_anomaly_integration: ${results.wallester_anomaly_integration}`);
  });

  // ===== wallester_openloop_integration =====
  await section("WALLESTER OPENLOOP INTEGRATION (card_anomaly_attention via EKSISTERENDE OpenLoopService-sveip)", async () => {
    const openLoops = new OpenLoopService(pool);
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const anomalyRow = (await cardService.listCardTransactions(TENANT_A, "business", { card_id: cardId })).find((r) => r.provider_transaction_id === anomalyTxId);
    const loop = loops.find((l) => l.loop_type === "card_anomaly_attention" && l.detection_key === `card_anomaly_attention:tx:${anomalyRow?.card_transaction_id}`);
    results.wallester_openloop_integration = loop !== undefined ? "PASS" : "FAIL";
    log(`loop_found=${loop !== undefined} -> wallester_openloop_integration: ${results.wallester_openloop_integration}`);
  });

  // ===== wallester_tenant_isolation =====
  await section("WALLESTER TENANT ISOLATION (RLS - tenant B ser ALDRI tenant A sine kort/autorisasjoner/transaksjoner og kan ikke handle på dem)", async () => {
    const cardsB = await cardService.listCards(TENANT_B, "business", true);
    const authsB = await cardService.listAuthorizations(TENANT_B, "business");
    const txsB = await cardService.listCardTransactions(TENANT_B, "business");
    let crossTenantRejected = false;
    try {
      await cardService.freezeCard(TENANT_B, "business", cardId);
    } catch (err) {
      crossTenantRejected = (err as Error).name === "CardNotFoundError";
    }
    results.wallester_tenant_isolation = cardsB.length === 0 && authsB.length === 0 && txsB.length === 0 && crossTenantRejected ? "PASS" : "FAIL";
    log(`tenant_b_cards=${cardsB.length} tenant_b_auths=${authsB.length} tenant_b_txs=${txsB.length} cross_tenant_action_rejected=${crossTenantRejected} -> wallester_tenant_isolation: ${results.wallester_tenant_isolation}`);
  });

  // ===== wallester_kill_switch_semantics =====
  await section("WALLESTER KILL SWITCH SEMANTICS (blokkerer submit/unfreeze/grense-ØKNING; PASSIV synk/avstemming/avviksdeteksjon fortsetter)", async () => {
    const draft = await cardService.createCard(TENANT_A, "business", { idempotency_key: `killswitch-${runId}`, name: "KS-kort", purpose: "KS", card_type: "virtual" });
    await cardService.freezeCard(TENANT_A, "business", cardId);
    await finance.enableKillSwitch(TENANT_A, OWNER_PERSON, "Wallester live-akseptanse kill-switch-test");
    let submitBlocked = false;
    try {
      await cardService.submitCard(TENANT_A, "business", draft.card_id);
    } catch (err) {
      submitBlocked = (err as Error).message.includes("finance_kill_switch_active");
    }
    let unfreezeBlocked = false;
    try {
      await cardService.unfreezeCard(TENANT_A, "business", cardId);
    } catch (err) {
      unfreezeBlocked = (err as Error).message.includes("finance_kill_switch_active");
    }
    let increaseBlocked = false;
    try {
      await cardService.updateSpendPolicy(TENANT_A, "business", cardId, { requested_daily_limit_ore: 999_999_999 });
    } catch (err) {
      increaseBlocked = (err as Error).message.includes("finance_kill_switch_active");
    }
    gateway.onListTransactions = async () => ({ items: [], nextPageToken: null });
    const passiveSync = await cardService.syncTransactions(TENANT_A, "business", cardId);
    const passiveReconcile = await cardService.reconcileCardTransactions(TENANT_A, "business");
    const passiveAnomaly = await cardService.runCardAnomalyDetection(TENANT_A, "business");
    await finance.disableKillSwitch(TENANT_A, OWNER_PERSON);
    await cardService.unfreezeCard(TENANT_A, "business", cardId);
    results.wallester_kill_switch_semantics =
      submitBlocked && unfreezeBlocked && increaseBlocked && passiveSync !== undefined && passiveReconcile !== undefined && passiveAnomaly !== undefined ? "PASS" : "FAIL";
    log(`submit_blocked=${submitBlocked} unfreeze_blocked=${unfreezeBlocked} limit_increase_blocked=${increaseBlocked} passive_ok=${passiveSync !== undefined && passiveReconcile !== undefined && passiveAnomaly !== undefined} -> wallester_kill_switch_semantics: ${results.wallester_kill_switch_semantics}`);
  });

  // ===== wallester_pci_boundary =====
  await section("WALLESTER PCI BOUNDARY (ingen rå PAN/CVV/PIN eller privatnøkkel i noen kanonisk rad - kun maskert referanse)", async () => {
    const { rows } = await adminPool.query(
      `SELECT to_jsonb(pc.*) AS card,
              (SELECT jsonb_agg(to_jsonb(ct.*)) FROM card_transactions ct WHERE ct.tenant_id = pc.tenant_id) AS txs,
              (SELECT jsonb_agg(to_jsonb(ca.*)) FROM card_authorizations ca WHERE ca.tenant_id = pc.tenant_id) AS auths,
              (SELECT jsonb_agg(to_jsonb(ce.*)) FROM card_events ce WHERE ce.tenant_id = pc.tenant_id) AS events
       FROM provider_cards pc WHERE pc.tenant_id = $1`,
      [TENANT_A]
    );
    const serialized = JSON.stringify(rows);
    const noPan = !/\b\d{16}\b/.test(serialized);
    const noCvv = !serialized.toLowerCase().includes("cvv") && !serialized.toLowerCase().includes("cvc");
    const noKey = !serialized.includes(FAKE_PRIVATE_KEY);
    const maskedOnly = serialized.includes("…4321");
    results.wallester_pci_boundary = noPan && noCvv && noKey && maskedOnly ? "PASS" : "FAIL";
    log(`no_pan=${noPan} no_cvv=${noCvv} no_private_key=${noKey} masked_reference_present=${maskedOnly} -> wallester_pci_boundary: ${results.wallester_pci_boundary}`);
  });

  log(`\nwallester_realtime_authorization_policy=NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API (owner-provided primary-source-audit, PR #62 runde 4: Wallester Business dokumenterer INGEN synkron decision-request-kapabilitet - den finnes i Wallester Card API, en ANNEN, IKKE-valgt produkt-grense - IKKE implementert mot en gjettet kontrakt for det valgte produktet)`);

  // ===== wallester_cleanup =====
  await section("CLEANUP (KUN denne kjøringens egne syntetiske fixtures - inkl. alle 043-korttabellene)", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });
    const remaining = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftover = (remaining.rows[0] as { n: number }).n;
    results.wallester_cleanup = cleanupOk && leftover === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftover} -> wallester_cleanup: ${results.wallester_cleanup}`);
  });

  return finish(false);
}

function finish(blockedByRuntimeRole: boolean): void {
  log("\n== UA-6 FINANCE & SPEND INTEGRITY GATEWAY - SJETTE SLICE (D-112) WALLESTER GUARDED LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  // NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API er en ÆRLIG
  // produkt-valg-begrensning (§10/§27, korrigert owner-provided
  // primary-source-audit PR #62 runde 4) - aldri en feil. Alt annet enn
  // PASS/NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API feiler hardt.
  const hardFail = blockedByRuntimeRole || Object.values(results).some((v) => v !== "PASS" && v !== "NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API");
  // D-108: ærlig, permanent grense for DENNE runneren - den beviser KUN
  // produkt-wiring mot en fake ved nettverksgrensen, ALDRI ekte Wallester-
  // reachability. WALLESTER_LIVE_VERIFIED/WALLESTER_LIVE_GATE skal ALDRI
  // endres av dette scriptet, uansett resultatene over.
  log(`\nWALLESTER_IMPLEMENTATION_COMPLETE=${!hardFail}`);
  log(`WALLESTER_LIVE_VERIFIED=false`);
  log(`WALLESTER_LIVE_GATE=PENDING_CREDENTIALS`);
  log(`run_id=${runId}`);
  log(`hard_fail=${hardFail}`);
  if (hardFail) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
