// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - FEMTE SLICE (D-111) - NEONOMICS
// OPEN BANKING GUARDED LIVE ACCEPTANCE (NO NEONOMICS CREDENTIALS REQUIRED)
//
// Kjøres AV TOBIAS mot en ekte lokal Postgres (via docker-compose) og den
// EKTE runtime-rollen (Q-21). Gjenbruker KUN eksisterende arkitektur
// (@jarvis/finance FinanceService/BankingService/FinanceTransport/
// NeonomicsFinanceTransport, @jarvis/tool-gateway ToolGateway/
// EnvSecretProvider, @jarvis/business OpenLoopService, @jarvis/policy,
// @jarvis/core) - INGEN alternativ testimplementasjon, INGEN
// produksjonsatferd endret av dette scriptet.
//
// D-108/§: denne runneren krever BEVISST INGEN JARVIS_NEONOMICS_*-
// credentials - Neonomics sitt EKTE HTTP-kall (`NeonomicsTransport`) er
// ALDRI konstruert her. I stedet injiseres en deterministisk, skriptbar
// `NeonomicsGatewayFactory`-fake ved NETTVERKSGRENSEN (samme mock-grense
// som testmatrisen i `test/neonomics-service.test.ts`) - dette beviser
// PRODUKT-WIRING, IKKE ekte Neonomics-reachability.
// `NEONOMICS_LIVE_VERIFIED=false`/`NEONOMICS_LIVE_GATE=PENDING_CREDENTIALS`
// forblir sanne til Tobias selv oppretter og verifiserer en ekte
// Neonomics-konto (D-108).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/finance/scripts/neonomics-live.ts
// (normalt via modules/finance/scripts/neonomics-live-host-run.ts)
//
// Bruker UTELUKKENDE en syntetisk, kjøre-unik tenant for Jarvis-side
// fixtures - RØRER ALDRI ekte Jarvis-kundedata. All test-scaffolding
// fjernes ved slutten (inkl. bank_consents/bank_accounts/
// bank_account_balances/bank_transactions/neonomics_webhook_events).

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, OpenLoopService } from "@jarvis/business";
import {
  BankingService, FinanceService, FinanceTransport, NeonomicsFinanceTransport, StripeFinanceTransport, VippsFinanceTransport,
  type BankConsent,
  type FikenCredentials, type FikenCredentialsProvider,
  type NeonomicsCredentials, type NeonomicsCredentialsProvider,
  type StripeCredentials, type StripeCredentialsProvider, type StripePaymentWriter,
  type VippsCredentials, type VippsCredentialsProvider
} from "../src/index.ts";
import type { StripePaymentIntentObject, StripeRefundObject } from "../src/stripe-transport.ts";
import type { VippsPaymentObject, VippsPaymentWriter } from "../src/vipps-transport.ts";
import type {
  InitiateNeonomicsPaymentInput, NeonomicsAccount, NeonomicsBalance, NeonomicsBank,
  NeonomicsGateway, NeonomicsPaymentObject, NeonomicsTransaction, NeonomicsTransactionPage
} from "../src/neonomics-transport.ts";
import { createApiServer } from "../../../apps/api/src/server.ts";
import { evaluateSecretSafety, type Verdict } from "./lib/fiken-live-lib.ts";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "NOT_RUN",
  finance_d107_invariant_preserved: "NOT_RUN",
  finance_slice2_invariants_preserved: "NOT_RUN",
  stripe_slice3_invariants_preserved: "NOT_RUN",
  vipps_slice4_invariants_preserved: "NOT_RUN",
  neonomics_adapter_wiring: "NOT_RUN",
  neonomics_consent_lifecycle: "NOT_RUN",
  neonomics_account_sync: "NOT_RUN",
  neonomics_balance_sync: "NOT_RUN",
  neonomics_transaction_sync: "NOT_RUN",
  neonomics_transaction_idempotency: "NOT_RUN",
  neonomics_pending_booked_transition: "NOT_RUN",
  neonomics_payment_idempotency: "NOT_RUN",
  neonomics_payment_sca_state: "NOT_RUN",
  neonomics_payment_state_sync: "NOT_RUN",
  neonomics_payment_bank_linkage: "NOT_RUN",
  neonomics_finance_reconciliation: "NOT_RUN",
  neonomics_anomaly_integration: "NOT_RUN",
  neonomics_openloop_integration: "NOT_RUN",
  neonomics_tenant_isolation: "NOT_RUN",
  neonomics_kill_switch_semantics: "NOT_RUN",
  neonomics_secret_safety: "NOT_RUN",
  neonomics_cleanup: "NOT_RUN"
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
log(`UA-6 FINANCE & SPEND INTEGRITY GATEWAY - FEMTE SLICE (D-111) NEONOMICS GUARDED LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-neonomics-live-${runId}-a`;
const TENANT_B = `tenant-neonomics-live-${runId}-b`;
const OWNER_PERSON = `person-neonomics-live-${runId}`;
// Fake webhook-API-nøkkel - BEVISST IKKE en ekte Neonomics-verdi (ingen
// slik konfigureres denne sliceen, D-108) - brukes KUN til å bevise
// autentiserings-KONTRAKTEN (kunde-valgt API-nøkkel i `x-api-key`-headeren,
// konstant-tid-sammenlignet - Neonomics sin EGEN offisielle webhook-modell,
// IKKE HMAC) ende-til-ende, og til `neonomics_secret_safety` sin
// redaksjonssjekk under.
const FAKE_WEBHOOK_API_KEY = `neonomics-live-acceptance-${runId}-${randomUUID()}`;
const FAKE_CLIENT_SECRET = `fake-neonomics-secret-live-${runId}`;
const WEBHOOK_PATH = "/webhooks/neonomics";

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-neonomics-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  // Barn-FK før forelder: bank_transactions -> bank_accounts/payment_intents.
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
  await adminPool.query("DELETE FROM finance_kill_switch WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_spend_records WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-neonomics-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-neonomics-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

/** Skriptbar fake ved Neonomics-transport-NETTVERKSGRENSEN - SAMME mock-boundary-prinsipp som `test/neonomics-service.test.ts`. */
class ScriptedNeonomicsGateway implements NeonomicsGateway {
  initiateCalls: InitiateNeonomicsPaymentInput[] = [];

  onListBanks: () => Promise<NeonomicsBank[]> = async () => [{ id: "dnb-no", bankDisplayName: "DNB", countryCode: "NO" }];
  onListAccounts: (sessionId: string) => Promise<NeonomicsAccount[]> = async () => [
    { id: "prov-acc-live-1", accountName: "Bedriftskonto", accountNumber: "12345678903", currency: "NOK", accountType: "checking" }
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

// Dynamisk dato: REGEL 2 sitt datovindu (±RECONCILE_DATE_WINDOW_DAYS) må
// treffe uansett NÅR Tobias kjører akseptansen - aldri en hardkodet dato.
const TODAY = new Date().toISOString().slice(0, 10);

function providerTx(overrides: Partial<NeonomicsTransaction> = {}): NeonomicsTransaction {
  return {
    id: `prov-tx-live-${randomUUID()}`, status: "booked", amountOre: 25_000, direction: "debit", currency: "NOK",
    bookingDate: TODAY, valueDate: TODAY, counterpartyName: "Leverandør AS",
    referenceText: "Faktura 42", bankTransactionCode: "PMNT", ...overrides
  };
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk, UAVHENGIG av Neonomics-credentials)", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish(true);
  }

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `Neonomics Live A ${runId}`, TENANT_B, `Neonomics Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "Neonomics Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-neonomics-a-${runId}`, TENANT_A, `ms-neonomics-b-${runId}`, TENANT_B]
  );

  const gateway = new ScriptedNeonomicsGateway();
  const configuredTenant: string | null = TENANT_A;
  const neonomicsCredentialsProvider: NeonomicsCredentialsProvider = {
    async getCredentials(): Promise<NeonomicsCredentials | null> {
      return { clientId: "fake-client-live", clientSecret: FAKE_CLIENT_SECRET, deviceId: "11111111-2222-3333-4444-555555555555", environment: "sandbox" };
    }
  };
  const fikenCredentialsProvider: FikenCredentialsProvider = { async getCredentials(): Promise<FikenCredentials | null> { return null; } };
  // Stripe-/Vipps-faker KUN for de respektive slice-invariant-seksjonene -
  // Stripe-/Vipps-implementasjonene selv er UENDRET av denne sliceen.
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
    neonomicsCredentialsProvider, () => gateway, () => FAKE_WEBHOOK_API_KEY, () => configuredTenant
  );
  const banking = new BankingService(pool, neonomicsCredentialsProvider, () => gateway);

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A, TENANT_B] }
  });
  // SAMME sammensetning som produksjon: provider-berørende
  // `finance_neonomics.*`-handlinger bruker den EKTE
  // `JARVIS_NEONOMICS_CLIENT_SECRET` - som er BEVISST IKKE satt i dette
  // miljøet (D-108). `EnvSecretProvider` leser den faktiske (fraværende)
  // env-variabelen - fail-closed-oppførselen bevises EKTE, ikke simulert.
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const toolGateway = new ToolGateway(pool, policy, secrets);
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(finance, fikenCredentialsProvider),
    finance_stripe: new StripeFinanceTransport(finance),
    finance_vipps: new VippsFinanceTransport(finance),
    finance_neonomics: new NeonomicsFinanceTransport(banking, finance)
  })) toolGateway.register(tool);
  const identity = ownerIdentityFor(TENANT_A);

  async function neoAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance_neonomics", action, parameters: parameters as never });
  }
  async function financeAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance", action, parameters: parameters as never });
  }

  // ===== D-107-invariant preservert (Fiken, UENDRET av denne sliceen) =====
  await section("D-107 INVARIANT PRESERVERT (Fiken idempotent payment_intent-opprettelse, UENDRET av Neonomics-tillegget)", async () => {
    const key = `idem-fiken-preserved-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-107 preserved", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-107 preserved", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const id1 = mustExternalId(first, "d107_create_1");
    const id2 = mustExternalId(second, "d107_create_2");
    results.finance_d107_invariant_preserved = id1 === id2 ? "PASS" : "FAIL";
    log(`fiken_create_1=${id1} fiken_create_2=${id2} -> finance_d107_invariant_preserved: ${results.finance_d107_invariant_preserved}`);
  });

  // ===== Slice 2-invariant preservert =====
  await section("SLICE 2 INVARIANTER PRESERVERT (finance_spend_records uendret av Neonomics-migrasjonen)", async () => {
    await adminPool.query(
      `INSERT INTO finance_spend_records (spend_record_id, tenant_id, memory_space_id, source_family, source_record_id, occurred_at, amount_ore, currency, category)
       VALUES ($1, $2, 'business', 'model_cost', $3, now(), 500, 'NOK', 'ai_api_cost')`,
      [`fsr-neonomics-live-${runId}`, TENANT_A, `src-neonomics-live-${runId}`]
    );
    const count = await adminPool.query("SELECT count(*)::int AS n FROM finance_spend_records WHERE tenant_id = $1", [TENANT_A]);
    results.finance_slice2_invariants_preserved = (count.rows[0] as { n: number }).n === 1 ? "PASS" : "FAIL";
    log(`spend_records_count=${(count.rows[0] as { n: number }).n} -> finance_slice2_invariants_preserved: ${results.finance_slice2_invariants_preserved}`);
  });

  // ===== Slice 3-invariant preservert (Stripe, UENDRET av denne sliceen) =====
  await section("SLICE 3 INVARIANTER PRESERVERT (Stripe-grenen: idempotent opprettelse+submit, UENDRET av Neonomics-tillegget)", async () => {
    const key = `idem-stripe-preserved-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-109 preserved", amount_ore: 1000, vendor_name: "x", account_code: "stripe-cat", provider: "stripe" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-109 preserved", amount_ore: 1000, vendor_name: "x", account_code: "stripe-cat", provider: "stripe" });
    const id1 = mustExternalId(first, "d109_create_1");
    const id2 = mustExternalId(second, "d109_create_2");
    const submitted = await finance.submitPaymentIntent(TENANT_A, "business", id1, {} as never);
    results.stripe_slice3_invariants_preserved = id1 === id2 && submitted.state === "provider_acknowledged" && submitted.provider_ref === `pi_slice3_${runId}` ? "PASS" : "FAIL";
    log(`stripe_create_idempotent=${id1 === id2} stripe_submit_state=${submitted.state} -> stripe_slice3_invariants_preserved: ${results.stripe_slice3_invariants_preserved}`);
  });

  // ===== Slice 4-invariant preservert (Vipps, UENDRET av denne sliceen) =====
  await section("SLICE 4 INVARIANTER PRESERVERT (Vipps-grenen: idempotent opprettelse+submit, UENDRET av Neonomics-tillegget)", async () => {
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

  // ===== neonomics_consent_lifecycle =====
  let consent: BankConsent | undefined;
  await section("NEONOMICS CONSENT LIFECYCLE (create -> authorization_required -> active via korrekt callback-state; CSRF + replay avvist fail-closed)", async () => {
    const created = await banking.createConsent(TENANT_A, "business", { bank_id: "dnb-no", bank_name: "DNB" });
    const createdOk = created.state === "created" && created.provider_session_id !== null;
    const { url, callback_state } = await banking.getConsentAuthorizationUrl(TENANT_A, "business", created.consent_id, "https://jarvis.internal/bank/callback");
    const urlOk = url.includes("bank.example.test/sca");
    const afterUrl = await banking.getConsent(TENANT_A, "business", created.consent_id);
    const waitingOk = afterUrl?.state === "authorization_required";
    let csrfRejected = false;
    try {
      await banking.completeConsentCallback(TENANT_A, "business", created.consent_id, "feil-state-verdi");
    } catch (err) {
      csrfRejected = (err as Error).name === "BankCallbackStateMismatchError";
    }
    const active = await banking.completeConsentCallback(TENANT_A, "business", created.consent_id, callback_state);
    const activeOk = active.state === "active" && active.authorized_at !== null && active.callback_state === null;
    let replayRejected = false;
    try {
      await banking.completeConsentCallback(TENANT_A, "business", created.consent_id, callback_state);
    } catch (err) {
      replayRejected = (err as Error).name === "BankCallbackStateMismatchError";
    }
    consent = active;
    results.neonomics_consent_lifecycle = createdOk && urlOk && waitingOk && csrfRejected && activeOk && replayRejected ? "PASS" : "FAIL";
    log(`created_ok=${createdOk} sca_url_ok=${urlOk} waiting_ok=${waitingOk} csrf_rejected=${csrfRejected} active_ok=${activeOk} replay_rejected=${replayRejected} -> neonomics_consent_lifecycle: ${results.neonomics_consent_lifecycle}`);
  });
  if (!consent) return finish(false);

  // ===== neonomics_account_sync =====
  let bankAccountId = "";
  await section("NEONOMICS ACCOUNT SYNC (idempotent discovery - dupliserer aldri; kontoidentifikator maskeres, aldri lagret i klartekst-visning)", async () => {
    const first = await banking.syncAccounts(TENANT_A, "business", consent!.consent_id);
    const second = await banking.syncAccounts(TENANT_A, "business", consent!.consent_id);
    const accounts = await banking.listBankAccounts(TENANT_A, "business");
    const account = accounts.find((a) => a.consent_id === consent!.consent_id);
    if (!account) throw new Error("account_not_found_after_sync");
    bankAccountId = account.bank_account_id;
    const maskOk = account.account_identifier_masked === "…8903 (11)" && !account.account_identifier_masked.includes("1234567");
    results.neonomics_account_sync = first.discovered === 1 && second.discovered === 0 && second.updated === 1 && maskOk ? "PASS" : "FAIL";
    log(`first_discovered=${first.discovered} second_discovered=${second.discovered} second_updated=${second.updated} mask=${account.account_identifier_masked} -> neonomics_account_sync: ${results.neonomics_account_sync}`);
  });
  if (!bankAccountId) return finish(false);

  // ===== neonomics_balance_sync =====
  await section("NEONOMICS BALANCE SYNC (flere saldotyper bevart eksakt i øre - aldri kollapset, aldri flyttall)", async () => {
    const result = await banking.syncBalances(TENANT_A, "business", bankAccountId);
    const balances = await banking.listBalances(TENANT_A, "business", bankAccountId);
    const types = balances.map((b) => b.balance_type).sort();
    const bookedOk = Number(balances.find((b) => b.balance_type === "booked")?.amount_ore) === 1_500_000;
    results.neonomics_balance_sync = result.observed === 2 && types.join(",") === "available,booked" && bookedOk ? "PASS" : "FAIL";
    log(`observed=${result.observed} types=${types.join(",")} booked_ore_exact=${bookedOk} -> neonomics_balance_sync: ${results.neonomics_balance_sync}`);
  });

  // ===== neonomics_transaction_sync + idempotency =====
  const tx1 = providerTx();
  const tx2 = providerTx({ direction: "credit", amountOre: 99_900, counterpartyName: "Kunde AS" });
  await section("NEONOMICS TRANSACTION SYNC (paginert synk; retning debit/kredit bevart eksplisitt - kredit tvinges ALDRI inn i en spend-modell)", async () => {
    gateway.onListTransactions = async (_acc, pageToken) =>
      pageToken === null ? { transactions: [tx1], nextPageToken: "page2" } : { transactions: [tx2], nextPageToken: null };
    const first = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    const creditPreserved = rows.find((r) => r.provider_transaction_id === tx2.id)?.direction === "credit";
    results.neonomics_transaction_sync = first.inserted === 2 && first.pages === 2 && rows.length === 2 && creditPreserved ? "PASS" : "FAIL";
    log(`inserted=${first.inserted} pages=${first.pages} rows=${rows.length} credit_preserved=${creditPreserved} -> neonomics_transaction_sync: ${results.neonomics_transaction_sync}`);
  });

  await section("NEONOMICS TRANSACTION IDEMPOTENCY (re-synk dupliserer ALDRI - stabile provider-transaksjons-IDer)", async () => {
    const second = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    results.neonomics_transaction_idempotency = second.inserted === 0 && rows.length === 2 ? "PASS" : "FAIL";
    log(`resync_inserted=${second.inserted} rows=${rows.length} -> neonomics_transaction_idempotency: ${results.neonomics_transaction_idempotency}`);
  });

  // ===== neonomics_pending_booked_transition =====
  await section("NEONOMICS PENDING->BOOKED TRANSITION (overgang på SAMME rad - aldri duplikat; booket beløps-korreksjon flagges, overskrives aldri stille)", async () => {
    const pending = providerTx({ status: "pending", bookingDate: null });
    gateway.onListTransactions = async () => ({ transactions: [pending], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    gateway.onListTransactions = async () => ({ transactions: [{ ...pending, status: "booked", bookingDate: "2026-08-26" }], nextPageToken: null });
    const result = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    const row = rows.find((r) => r.provider_transaction_id === pending.id);
    const transitionOk = result.transitioned === 1 && row?.status === "booked";
    // Korreksjonsvern: booket beløp endres hos provider -> flagg, originalen bevart.
    gateway.onListTransactions = async () => ({ transactions: [{ ...pending, status: "booked", bookingDate: "2026-08-26", amountOre: 99_999 }], nextPageToken: null });
    const corrected = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const rowAfter = (await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId })).find((r) => r.provider_transaction_id === pending.id);
    const correctionOk = corrected.corrections_flagged === 1 && Number(rowAfter?.amount_ore) === 25_000 && (rowAfter?.anomaly_flags ?? []).includes("BANK_TRANSACTION_CORRECTION_CONFLICT");
    results.neonomics_pending_booked_transition = transitionOk && correctionOk ? "PASS" : "FAIL";
    log(`transitioned=${result.transitioned} status=${row?.status} correction_flagged=${correctionOk} -> neonomics_pending_booked_transition: ${results.neonomics_pending_booked_transition}`);
  });

  // ===== neonomics_adapter_wiring =====
  let neoIntentId = "";
  await section("NEONOMICS ADAPTER WIRING (finance.create_payment_intent(provider=neonomics) + finance_neonomics.* registrert/dispatchet via ToolGateway)", async () => {
    // BEVISST kjøre-unikt beløp (33_300 - ingen annen fixture bruker det):
    // REGEL 2 (beløp+datovindu) er tenant-vid, så et delt beløp kunne
    // amount-date-matche en ANNEN banktransaksjon til denne intenten og
    // ødelegge linkage-seksjonens «nøyaktig ÉN pengerad»-bevis.
    const created = await financeAction("create_payment_intent", {
      tenant_id: TENANT_A, idempotency_key: `neonomics-wiring-${runId}`, purpose: "Neonomics live-akseptanse", amount_ore: 33_300,
      vendor_name: "Leverandør AS", vendor_provider_ref: "98765432101", account_code: "bank-leverandor",
      counter_account_code: bankAccountId, provider: "neonomics"
    });
    neoIntentId = mustExternalId(created, "neonomics_create");
    const consents = await neoAction("list_consents", { tenant_id: TENANT_A });
    const txs = await neoAction("list_bank_transactions", { tenant_id: TENANT_A, bank_account_id: bankAccountId });
    const wiringOk = created.ok && consents.ok && txs.ok;
    results.neonomics_adapter_wiring = wiringOk ? "PASS" : "FAIL";
    log(`neonomics_intent_id=${neoIntentId} list_consents_ok=${consents.ok} list_bank_transactions_ok=${txs.ok} -> neonomics_adapter_wiring: ${results.neonomics_adapter_wiring}`);
  });
  if (!neoIntentId) return finish(false);

  // ===== neonomics_secret_safety (fail-closed uten JARVIS_NEONOMICS_CLIENT_SECRET - EKTE, ikke simulert) =====
  await section("NEONOMICS SECRET SAFETY (provider-berørende finance_neonomics.* MÅ avvises credential_unavailable UTEN JARVIS_NEONOMICS_CLIENT_SECRET - D-108)", async () => {
    const secretConfigured = Boolean(process.env["JARVIS_NEONOMICS_CLIENT_SECRET"]);
    if (secretConfigured) {
      log("JARVIS_NEONOMICS_CLIENT_SECRET ER konfigurert i dette miljøet - fail-closed-beviset under er derfor IKKE relevant. Markerer NOT_RUN i stedet for et falskt PASS.");
      results.neonomics_secret_safety = "NOT_RUN";
      return;
    }
    const syncDenied = await neoAction("sync_accounts", { tenant_id: TENANT_A, consent_id: consent!.consent_id });
    const secretSafetyDenied = !syncDenied.ok && syncDenied.reason === "credential_unavailable";
    const redactionOk = evaluateSecretSafety(logBuffer, [FAKE_WEBHOOK_API_KEY, FAKE_CLIENT_SECRET]);
    results.neonomics_secret_safety = secretSafetyDenied && redactionOk === "PASS" ? "PASS" : "FAIL";
    log(`sync_accounts_denied=${!syncDenied.ok} deny_reason=${syncDenied.ok ? "n/a" : syncDenied.reason} log_redaction=${redactionOk} -> neonomics_secret_safety: ${results.neonomics_secret_safety}`);
  });

  // ===== neonomics_payment_idempotency =====
  await section("NEONOMICS PAYMENT IDEMPOTENCY (retry can never double-pay - deterministisk endToEndReference = payment_intent_id)", async () => {
    const submitted1 = await finance.submitPaymentIntent(TENANT_A, "business", neoIntentId, { getCredentials: async () => null });
    const callsAfterFirst = gateway.initiateCalls.length;
    const submitted2 = await finance.submitPaymentIntent(TENANT_A, "business", neoIntentId, { getCredentials: async () => null });
    const e2eOk = gateway.initiateCalls[0]?.endToEndReference === neoIntentId;
    results.neonomics_payment_idempotency =
      submitted1.provider_ref === submitted2.provider_ref && gateway.initiateCalls.length === callsAfterFirst && callsAfterFirst === 1 && e2eOk ? "PASS" : "FAIL";
    log(`provider_ref_1=${submitted1.provider_ref} provider_ref_2=${submitted2.provider_ref} provider_calls=${gateway.initiateCalls.length} end_to_end_ref_is_intent_id=${e2eOk} -> neonomics_payment_idempotency: ${results.neonomics_payment_idempotency}`);
  });

  // ===== neonomics_payment_sca_state =====
  await section("NEONOMICS PAYMENT SCA STATE (PDNG = VENTER på bruker-SCA hos banken - ALDRI fabrikkert autonom fullføring; SCA-URL hentes eksplisitt)", async () => {
    const current = await finance.getPaymentIntent(TENANT_A, "business", neoIntentId);
    const waitingOk = current?.state === "provider_acknowledged" && current.provider_status === "PDNG" && current.settled_at === null;
    const { url } = await finance.getNeonomicsPaymentAuthorizationUrl(TENANT_A, "business", neoIntentId, "https://jarvis.internal/bank/payment-callback");
    const urlOk = url.includes("sca-payment");
    results.neonomics_payment_sca_state = waitingOk && urlOk ? "PASS" : "FAIL";
    log(`state=${current?.state} provider_status=${current?.provider_status} settled_at=${current?.settled_at} sca_url_ok=${urlOk} -> neonomics_payment_sca_state: ${results.neonomics_payment_sca_state}`);
  });

  // ===== neonomics_payment_state_sync (polling + EKTE HTTP webhook-kontrakt) =====
  await section("NEONOMICS PAYMENT STATE SYNC (ACCP forblir uavklart - accepted != settled; webhook: gyldig API-nøkkel prosesserer ACSC->settled, feil nøkkel 401, duplikat dedupes)", async () => {
    gateway.onGetPayment = async (id) => ({ id, status: "ACCP" });
    const refreshed = await finance.refreshNeonomicsPaymentState(TENANT_A, "business", neoIntentId);
    const accpOk = refreshed.state === "provider_acknowledged" && refreshed.provider_status === "ACCP";

    const server = createApiServer({
      identity: { resolveIdentity: async () => ({ ok: false, reason: "not_used" }) } as never,
      sessions: {} as never, conversation: {} as never, policy, worker: {} as never,
      // D-130/D-131 arkitekt-review-fikser: strukturelt paakrevd, ubrukt av dette host-scriptet.
      channelAuthority: {} as never,
      grants: {} as never,
      finance: { service: finance }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const host = `127.0.0.1:${port}`;
    try {
      const providerRef = (await finance.getPaymentIntent(TENANT_A, "business", neoIntentId))?.provider_ref;
      const body = JSON.stringify({ paymentId: providerRef, status: "ACSC" });
      const validRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body, headers: { "x-api-key": FAKE_WEBHOOK_API_KEY } });
      const invalidRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body, headers: { "x-api-key": "feil-noekkel-live" } });
      const dupRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body, headers: { "x-api-key": FAKE_WEBHOOK_API_KEY } });
      const dupBody = (await dupRes.json()) as { status: string };
      const after = await finance.getPaymentIntent(TENANT_A, "business", neoIntentId);
      const settledOk = after?.state === "settled";
      results.neonomics_payment_state_sync =
        accpOk && validRes.status === 200 && invalidRes.status === 401 && dupRes.status === 200 && dupBody.status === "duplicate" && settledOk ? "PASS" : "FAIL";
      log(`accp_stays_unsettled=${accpOk} valid_webhook_status=${validRes.status} invalid_api_key_status=${invalidRes.status} duplicate_status=${dupBody.status} settled_after_acsc=${settledOk} -> neonomics_payment_state_sync: ${results.neonomics_payment_state_sync}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ===== neonomics_payment_bank_linkage =====
  await section("NEONOMICS PAYMENT<->BANK LINKAGE (REGEL 1 provider-referanse: ETT økonomisk beløp, ALDRI duplikate pengerecords)", async () => {
    const linkTx = providerTx({ amountOre: 33_300, referenceText: `Betaling ${neoIntentId}` });
    gateway.onListTransactions = async () => ({ transactions: [linkTx], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    await banking.reconcileBankTransactions(TENANT_A, "business");
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    const linked = rows.filter((r) => r.matched_payment_intent_id === neoIntentId);
    const intentAfter = await finance.getPaymentIntent(TENANT_A, "business", neoIntentId);
    const linkOk = linked.length === 1 && linked[0]?.match_rule === "provider_reference" && linked[0]?.reconciliation_state === "matched";
    const intentOk = intentAfter?.reconciliation_state === "matched";
    const singleEconomicAmount = linked.length === 1 && Number(linked[0]?.amount_ore) === 33_300;
    results.neonomics_payment_bank_linkage = linkOk && intentOk && singleEconomicAmount ? "PASS" : "FAIL";
    log(`linked_rows=${linked.length} match_rule=${linked[0]?.match_rule} intent_reconciliation_state=${intentAfter?.reconciliation_state} single_economic_amount=${singleEconomicAmount} -> neonomics_payment_bank_linkage: ${results.neonomics_payment_bank_linkage}`);
  });

  // ===== neonomics_finance_reconciliation (REGEL 2 - provider-nøytral intent-side) =====
  await section("NEONOMICS FINANCE RECONCILIATION (REGEL 2 eksakt-én-kandidat beløp+valuta+datovindu; TO kandidater forblir ambiguous - aldri gjettet)", async () => {
    const windowIntent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `neonomics-window-${runId}`, purpose: "Vindustest", amount_ore: 44_400,
      vendor_name: "Vindu AS", account_code: "9999", provider: "stripe"
    });
    await adminPool.query(`UPDATE payment_intents SET state = 'provider_acknowledged', submitted_at = now() - interval '1 day' WHERE payment_intent_id = $1`, [windowIntent.payment_intent_id]);
    const windowTx = providerTx({ amountOre: 44_400, referenceText: "uten referanse" });
    gateway.onListTransactions = async () => ({ transactions: [windowTx], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    await banking.reconcileBankTransactions(TENANT_A, "business");
    const windowRow = (await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId })).find((r) => r.provider_transaction_id === windowTx.id);
    const ruleTwoOk = windowRow?.reconciliation_state === "matched" && windowRow.match_rule === "amount_date_window" && windowRow.matched_payment_intent_id === windowIntent.payment_intent_id;

    for (const key of ["a", "b"]) {
      const dup = await finance.createPaymentIntent(TENANT_A, "business", {
        idempotency_key: `neonomics-amb-${key}-${runId}`, purpose: `Tvetydig ${key}`, amount_ore: 55_500,
        vendor_name: "Tvetydig AS", account_code: "9999", provider: "stripe"
      });
      await adminPool.query(`UPDATE payment_intents SET state = 'provider_acknowledged', submitted_at = now() - interval '1 day' WHERE payment_intent_id = $1`, [dup.payment_intent_id]);
    }
    const ambTx = providerTx({ amountOre: 55_500, referenceText: "ogsaa uten referanse" });
    gateway.onListTransactions = async () => ({ transactions: [ambTx], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    await banking.reconcileBankTransactions(TENANT_A, "business");
    const ambRow = (await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId })).find((r) => r.provider_transaction_id === ambTx.id);
    const ambiguousOk = ambRow?.reconciliation_state === "ambiguous" && ambRow.matched_payment_intent_id === null;
    results.neonomics_finance_reconciliation = ruleTwoOk && ambiguousOk ? "PASS" : "FAIL";
    log(`rule2_matched=${ruleTwoOk} two_candidates_stay_ambiguous=${ambiguousOk} -> neonomics_finance_reconciliation: ${results.neonomics_finance_reconciliation}`);
  });

  // ===== neonomics_anomaly_integration =====
  const largeTx = providerTx({ amountOre: 1_000_000 });
  await section("NEONOMICS ANOMALY INTEGRATION (UNMATCHED_BANK_DEBIT/CREDIT aldret + UNEXPECTED_LARGE_DEBIT; deteksjonen er selv-korrigerende)", async () => {
    const smallDebit = providerTx({ amountOre: 5_000 });
    const smallCredit = providerTx({ direction: "credit", amountOre: 7_000 });
    gateway.onListTransactions = async () => ({ transactions: [smallDebit, smallCredit, largeTx], nextPageToken: null });
    await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    // Aldre KUN disse tre forbi UNMATCHED_FLAG_AGE_DAYS (adminPool = test-fixture-manipulasjon).
    await adminPool.query(`UPDATE bank_transactions SET created_at = now() - interval '10 days' WHERE tenant_id = $1 AND provider_transaction_id = ANY($2)`, [
      TENANT_A, [smallDebit.id, smallCredit.id, largeTx.id]
    ]);
    await banking.runBankAnomalyDetection(TENANT_A, "business");
    const rows = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    const debitFlags = rows.find((r) => r.provider_transaction_id === smallDebit.id)?.anomaly_flags ?? [];
    const creditFlags = rows.find((r) => r.provider_transaction_id === smallCredit.id)?.anomaly_flags ?? [];
    const largeFlags = rows.find((r) => r.provider_transaction_id === largeTx.id)?.anomaly_flags ?? [];
    const flagsOk = debitFlags.includes("UNMATCHED_BANK_DEBIT") && creditFlags.includes("UNMATCHED_BANK_CREDIT") && largeFlags.includes("UNEXPECTED_LARGE_DEBIT");
    // Selvkorrigering: match de to små -> deres flagg renses; den store forblir flagget (brukes av OpenLoop-seksjonen under).
    await adminPool.query(`UPDATE bank_transactions SET reconciliation_state = 'matched' WHERE tenant_id = $1 AND provider_transaction_id = ANY($2)`, [
      TENANT_A, [smallDebit.id, smallCredit.id]
    ]);
    await banking.runBankAnomalyDetection(TENANT_A, "business");
    const after = await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId });
    const cleared =
      (after.find((r) => r.provider_transaction_id === smallDebit.id)?.anomaly_flags ?? []).length === 0 &&
      (after.find((r) => r.provider_transaction_id === smallCredit.id)?.anomaly_flags ?? []).length === 0 &&
      (after.find((r) => r.provider_transaction_id === largeTx.id)?.anomaly_flags ?? []).includes("UNEXPECTED_LARGE_DEBIT");
    results.neonomics_anomaly_integration = flagsOk && cleared ? "PASS" : "FAIL";
    log(`flags_ok=${flagsOk} self_correction_ok=${cleared} -> neonomics_anomaly_integration: ${results.neonomics_anomaly_integration}`);
  });

  // ===== neonomics_openloop_integration =====
  await section("NEONOMICS OPENLOOP INTEGRATION (bank_transaction_unmatched + bank_consent_attention via EKSISTERENDE OpenLoopService-sveip)", async () => {
    const attentionConsent = await banking.createConsent(TENANT_A, "business", { bank_id: "dnb-no", bank_name: "DNB" });
    await banking.getConsentAuthorizationUrl(TENANT_A, "business", attentionConsent.consent_id, "https://jarvis.internal/bank/callback");
    const openLoops = new OpenLoopService(pool);
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const largeTxRow = (await banking.listBankTransactions(TENANT_A, "business", { bank_account_id: bankAccountId })).find((r) => r.provider_transaction_id === largeTx.id);
    const txLoop = loops.find((l) => l.loop_type === "bank_transaction_unmatched" && l.detection_key === `bank_transaction_unmatched:${largeTxRow?.bank_transaction_id}`);
    const consentLoop = loops.find((l) => l.loop_type === "bank_consent_attention" && l.detection_key === `bank_consent_attention:${attentionConsent.consent_id}`);
    results.neonomics_openloop_integration = txLoop !== undefined && txLoop.priority === "high" && consentLoop !== undefined ? "PASS" : "FAIL";
    log(`tx_loop_found=${txLoop !== undefined} tx_loop_priority=${txLoop?.priority ?? "n/a"} consent_loop_found=${consentLoop !== undefined} -> neonomics_openloop_integration: ${results.neonomics_openloop_integration}`);
  });

  // ===== neonomics_tenant_isolation =====
  await section("NEONOMICS TENANT ISOLATION (RLS - tenant B ser ALDRI tenant A sine samtykker/kontoer/transaksjoner, og kan ikke betale fra A sin konto)", async () => {
    const consentsB = await banking.listConsents(TENANT_B, "business");
    const accountsB = await banking.listBankAccounts(TENANT_B, "business", true);
    const txsB = await banking.listBankTransactions(TENANT_B, "business");
    const intentB = await finance.createPaymentIntent(TENANT_B, "business", {
      idempotency_key: `neonomics-cross-${runId}`, purpose: "Kryss-tenant-forsøk", amount_ore: 100,
      vendor_name: "X", vendor_provider_ref: "1", account_code: "x", counter_account_code: bankAccountId, provider: "neonomics"
    });
    let crossTenantRejected = false;
    try {
      await finance.submitPaymentIntent(TENANT_B, "business", intentB.payment_intent_id, { getCredentials: async () => null });
    } catch (err) {
      crossTenantRejected = (err as Error).name === "BankAccountNotFoundError";
    }
    results.neonomics_tenant_isolation = consentsB.length === 0 && accountsB.length === 0 && txsB.length === 0 && crossTenantRejected ? "PASS" : "FAIL";
    log(`tenant_b_consents=${consentsB.length} tenant_b_accounts=${accountsB.length} tenant_b_txs=${txsB.length} cross_tenant_payment_rejected=${crossTenantRejected} -> neonomics_tenant_isolation: ${results.neonomics_tenant_isolation}`);
  });

  // ===== neonomics_kill_switch_semantics =====
  await section("NEONOMICS KILL SWITCH SEMANTICS (blokkerer AKTIV betaling mot provider; PASSIV synk/avstemming/avviksdeteksjon fortsetter)", async () => {
    const anotherIntent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `neonomics-killswitch-${runId}`, purpose: "Kill switch check", amount_ore: 2_000,
      vendor_name: "V", vendor_provider_ref: "98765432101", account_code: "cat", counter_account_code: bankAccountId, provider: "neonomics"
    });
    await finance.enableKillSwitch(TENANT_A, OWNER_PERSON, "Neonomics live-akseptanse kill-switch-test");
    let submitBlocked = false;
    const callsBefore = gateway.initiateCalls.length;
    try {
      await finance.submitPaymentIntent(TENANT_A, "business", anotherIntent.payment_intent_id, { getCredentials: async () => null });
    } catch (err) {
      submitBlocked = (err as Error).message.includes("finance_kill_switch_active");
    }
    const noProviderCall = gateway.initiateCalls.length === callsBefore;
    // PASSIV integritet upåvirket av nødbryteren:
    gateway.onListTransactions = async () => ({ transactions: [], nextPageToken: null });
    const passiveSync = await banking.syncTransactions(TENANT_A, "business", bankAccountId);
    const passiveReconcile = await banking.reconcileBankTransactions(TENANT_A, "business");
    const passiveAnomaly = await banking.runBankAnomalyDetection(TENANT_A, "business");
    await finance.disableKillSwitch(TENANT_A, OWNER_PERSON);
    results.neonomics_kill_switch_semantics =
      submitBlocked && noProviderCall && passiveSync !== undefined && passiveReconcile !== undefined && passiveAnomaly !== undefined ? "PASS" : "FAIL";
    log(`submit_blocked=${submitBlocked} no_provider_call=${noProviderCall} passive_sync_ok=${passiveSync !== undefined} passive_reconcile_ok=${passiveReconcile !== undefined} passive_anomaly_ok=${passiveAnomaly !== undefined} -> neonomics_kill_switch_semantics: ${results.neonomics_kill_switch_semantics}`);
  });

  // ===== neonomics_cleanup =====
  await section("CLEANUP (KUN denne kjøringens egne syntetiske fixtures - inkl. bank_consents/bank_accounts/bank_account_balances/bank_transactions/neonomics_webhook_events)", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });
    const remaining = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftover = (remaining.rows[0] as { n: number }).n;
    results.neonomics_cleanup = cleanupOk && leftover === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftover} -> neonomics_cleanup: ${results.neonomics_cleanup}`);
  });

  return finish(false);
}

function finish(blockedByRuntimeRole: boolean): void {
  log("\n== UA-6 FINANCE & SPEND INTEGRITY GATEWAY - FEMTE SLICE (D-111) NEONOMICS GUARDED LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  const hardFail = blockedByRuntimeRole || Object.values(results).some((v) => v === "FAIL" || v === "NOT_RUN" || v === "BLOCKED_BY_RUNTIME_ROLE");
  // D-108: ærlig, permanent grense for DENNE runneren - den beviser KUN
  // produkt-wiring mot en fake ved nettverksgrensen, ALDRI ekte Neonomics-
  // reachability. NEONOMICS_LIVE_VERIFIED/NEONOMICS_LIVE_GATE skal ALDRI
  // endres av dette scriptet, uansett resultatene over.
  log(`\nNEONOMICS_IMPLEMENTATION_COMPLETE=${!hardFail}`);
  log(`NEONOMICS_LIVE_VERIFIED=false`);
  log(`NEONOMICS_LIVE_GATE=PENDING_CREDENTIALS`);
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
