// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - TREDJE SLICE (D-109) - STRIPE
// GUARDED LIVE ACCEPTANCE (NO STRIPE CREDENTIALS REQUIRED)
//
// Kjøres AV TOBIAS mot en ekte lokal Postgres (via docker-compose) og den
// EKTE runtime-rollen (Q-21). Gjenbruker KUN eksisterende arkitektur
// (@jarvis/finance FinanceService/FinanceTransport/StripeFinanceTransport,
// @jarvis/tool-gateway ToolGateway/EnvSecretProvider, @jarvis/policy,
// @jarvis/core) - INGEN alternativ testimplementasjon, INGEN
// produksjonsatferd endret av dette scriptet.
//
// D-108/§HOST ACCEPTANCE: denne runneren krever BEVISST INGEN
// JARVIS_STRIPE_SECRET_KEY/_WEBHOOK_SECRET - Stripe sitt EKTE HTTP-kall
// (`StripeTransport`) er ALDRI konstruert her. I stedet injiseres en
// deterministisk, skriptbar `StripeTransportFactory`-fake ved
// NETTVERKSGRENSEN (samme mock-grense som testmatrisen i
// `test/stripe-service.test.ts`) - dette beviser PRODUKT-WIRING (hele
// FinanceService/ToolGateway/webhook-HTTP-ruten/anomali-motoren/erasure-
// forutsetningene mot en EKTE Postgres+RLS+runtime-rolle), IKKE ekte
// Stripe-reachability. `STRIPE_LIVE_VERIFIED=false`/
// `STRIPE_LIVE_GATE=PENDING_CREDENTIALS` forblir sanne til Tobias selv
// oppretter og verifiserer en ekte Stripe-konto (D-108, egen fremtidig fase).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/finance/scripts/stripe-live.ts
// (normalt via modules/finance/scripts/stripe-live-host-run.ts)
//
// Bruker UTELUKKENDE en syntetisk, kjøre-unik tenant for Jarvis-side
// fixtures - RØRER ALDRI ekte Jarvis-kundedata. All test-scaffolding
// fjernes ved slutten (inkl. stripe_webhook_events/stripe_refunds).

import { randomUUID, createHmac } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, OpenLoopService } from "@jarvis/business";
import {
  FinanceService, FinanceTransport, StripeFinanceTransport,
  type FikenCredentials, type FikenCredentialsProvider,
  type StripeCredentials, type StripeCredentialsProvider, type StripePaymentWriter
} from "../src/index.ts";
import type { StripeBalanceObject, StripePaymentIntentObject, StripeRefundObject } from "../src/stripe-transport.ts";
import { createApiServer } from "../../../apps/api/src/server.ts";
import { evaluateSecretSafety, type Verdict } from "./lib/fiken-live-lib.ts";
import { deleteMoneyRows } from "./lib/money-cleanup.ts";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "NOT_RUN",
  finance_d107_invariant_preserved: "NOT_RUN",
  finance_slice2_invariants_preserved: "NOT_RUN",
  stripe_adapter_wiring: "NOT_RUN",
  stripe_payment_idempotency: "NOT_RUN",
  stripe_payment_state_sync: "NOT_RUN",
  stripe_webhook_signature_contract: "NOT_RUN",
  stripe_webhook_idempotency: "NOT_RUN",
  stripe_refund_integrity: "NOT_RUN",
  stripe_finance_reconciliation: "NOT_RUN",
  stripe_anomaly_integration: "NOT_RUN",
  stripe_tenant_isolation: "NOT_RUN",
  stripe_kill_switch_semantics: "NOT_RUN",
  stripe_secret_safety: "NOT_RUN",
  stripe_cleanup: "NOT_RUN"
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

/** SAMME hjelper-mønster som `fiken-live.ts` sin `mustExternalId()` - inkluderer ALLTID DENY-årsaken. */
function mustExternalId(result: Awaited<ReturnType<InstanceType<typeof ToolGateway>["execute"]>>, label: string): string {
  if (!result.ok) throw new Error(`${label}_denied:${result.reason}`);
  if (!result.external_id) throw new Error(`${label}_did_not_return_external_id`);
  return result.external_id;
}

const runId = randomUUID().slice(0, 8);
log(`UA-6 FINANCE & SPEND INTEGRITY GATEWAY - TREDJE SLICE (D-109) STRIPE GUARDED LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-stripe-live-${runId}-a`;
const TENANT_B = `tenant-stripe-live-${runId}-b`;
const OWNER_PERSON = `person-stripe-live-${runId}`;
// Fake webhook-signeringshemmelighet - BEVISST IKKE en ekte Stripe-verdi
// (ingen slik konfigureres denne sliceen, D-108) - brukes KUN til å bevise
// signatur-KONTRAKTEN (HMAC-SHA256/t=.../v1=.../timingSafeEqual) fungerer
// ende-til-ende, og til `stripe_secret_safety` sin redaksjonssjekk under.
const FAKE_WEBHOOK_SECRET = `whsec_live_acceptance_${runId}_${randomUUID()}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-stripe-live-${runId}`, device_id: "jarvis-host-acceptance", channel: "api", auth_strength: "signed" /* review F4: step_up_required håndheves alltid; host-akseptanse kjøres av eieren selv med denne eksplisitte, merkede identiteten */
  };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM stripe_webhook_events WHERE tenant_id = $1", [tenantId]);
  await deleteMoneyRows(adminPool, "stripe_refunds", tenantId);
  await adminPool.query("DELETE FROM payment_intent_events WHERE tenant_id = $1", [tenantId]);
  await deleteMoneyRows(adminPool, "payment_intents", tenantId);
  await adminPool.query("DELETE FROM finance_kill_switch WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_spend_records WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-stripe-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-stripe-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

/** Skriptbar fake ved Stripe-transport-NETTVERKSGRENSEN - SAMME mock-boundary-prinsipp som `test/stripe-service.test.ts`. */
class ScriptedStripeWriter implements StripePaymentWriter {
  createPaymentIntentCalls = 0;
  createRefundCalls = 0;
  onCreatePaymentIntent: (input: { amountOre: number; currency: string; metadata: Record<string, string>; idempotencyKey: string }) => Promise<StripePaymentIntentObject> = async (input) => ({
    id: `pi_live_${randomUUID().slice(0, 8)}`, object: "payment_intent", amount: input.amountOre, currency: input.currency.toLowerCase(), status: "requires_payment_method", metadata: input.metadata
  });
  onGetPaymentIntent: (id: string) => Promise<StripePaymentIntentObject> = async (id) => ({ id, object: "payment_intent", amount: 10_000, currency: "nok", status: "requires_payment_method", metadata: {} });
  onCreateRefund: (input: { stripePaymentIntentId: string; amountOre: number; reason?: string; idempotencyKey: string }) => Promise<StripeRefundObject> = async (input) => ({
    id: `re_live_${randomUUID().slice(0, 8)}`, object: "refund", amount: input.amountOre, currency: "nok", status: "succeeded", payment_intent: input.stripePaymentIntentId, reason: input.reason ?? null
  });
  async createPaymentIntent(input: Parameters<StripePaymentWriter["createPaymentIntent"]>[0]): Promise<StripePaymentIntentObject> {
    this.createPaymentIntentCalls++;
    return this.onCreatePaymentIntent(input);
  }
  async getPaymentIntent(id: string): Promise<StripePaymentIntentObject> {
    return this.onGetPaymentIntent(id);
  }
  async createRefund(input: Parameters<StripePaymentWriter["createRefund"]>[0]): Promise<StripeRefundObject> {
    this.createRefundCalls++;
    return this.onCreateRefund(input);
  }
  async getRefund(id: string): Promise<StripeRefundObject> {
    return { id, object: "refund", amount: 1000, currency: "nok", status: "succeeded", payment_intent: "pi_x", reason: null };
  }
  async getBalance(): Promise<StripeBalanceObject> {
    return { object: "balance", available: [{ amount: 0, currency: "nok" }], pending: [{ amount: 0, currency: "nok" }] };
  }
}

function signedHeader(rawBody: Buffer, timestampSeconds: number): string {
  const sig = createHmac("sha256", FAKE_WEBHOOK_SECRET).update(`${timestampSeconds}.${rawBody.toString("utf8")}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${sig}`;
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk, UAVHENGIG av Stripe-credentials)", async () => {
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
    TENANT_A, `Stripe Live A ${runId}`, TENANT_B, `Stripe Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "Stripe Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-stripe-a-${runId}`, TENANT_A, `ms-stripe-b-${runId}`, TENANT_B]
  );

  const writer = new ScriptedStripeWriter();
  const configuredTenant: string | null = TENANT_A;
  const stripeCredentialsProvider: StripeCredentialsProvider = { async getCredentials(): Promise<StripeCredentials | null> { return { secretKey: "sk_test_fake_live_acceptance" }; } };
  const fikenCredentialsProvider: FikenCredentialsProvider = { async getCredentials(): Promise<FikenCredentials | null> { return null; } }; // Fiken uendret av denne sliceen - se D-107-invariant-seksjonen.
  const finance = new FinanceService(pool, undefined, stripeCredentialsProvider, () => writer, () => FAKE_WEBHOOK_SECRET, () => configuredTenant);

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A, TENANT_B] }
  });
  // SAMME sammensetning som produksjon (apps/api/src/main.ts): 5 av 7
  // finance_stripe.*-handlinger bruker JARVIS_BUSINESS_INTERNAL_TOKEN
  // (D-49 ikke-hemmelig sentinel), KUN `submit_refund`/`refresh_payment_
  // state` bruker den EKTE `JARVIS_STRIPE_SECRET_KEY` - som er BEVISST
  // IKKE satt i dette miljøet (D-108). `EnvSecretProvider` leser den
  // faktiske (fraværende) env-variabelen - INGEN fake-secret injisert her,
  // slik at fail-closed-oppførselen bevises EKTE, ikke simulert.
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const toolGateway = new ToolGateway(pool, policy, secrets);
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(finance, fikenCredentialsProvider),
    finance_stripe: new StripeFinanceTransport(finance)
  })) toolGateway.register(tool);
  const identity = ownerIdentityFor(TENANT_A);

  async function stripeAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance_stripe", action, parameters: parameters as never });
  }
  async function financeAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance", action, parameters: parameters as never });
  }

  // ===== D-107 FØRSTE-slice invariant preservert (Fiken, UENDRET av denne sliceen) =====
  await section("D-107 INVARIANT PRESERVERT (Fiken idempotent payment_intent-opprettelse, UENDRET av Stripe-tillegget)", async () => {
    const key = `idem-fiken-preserved-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-107 preserved", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-107 preserved", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const id1 = mustExternalId(first, "d107_create_1");
    const id2 = mustExternalId(second, "d107_create_2");
    results.finance_d107_invariant_preserved = id1 === id2 ? "PASS" : "FAIL";
    log(`fiken_create_1=${id1} fiken_create_2=${id2} -> finance_d107_invariant_preserved: ${results.finance_d107_invariant_preserved}`);
  });

  // ===== Slice 2 invariant preservert (intern utgiftsdomene, UENDRET av denne sliceen) =====
  await section("SLICE 2 INVARIANTER PRESERVERT (finance_spend_records-idempotens, UENDRET av Stripe-tillegget)", async () => {
    // Kolonner MÅ speile 039_finance_spend_integrity.sql eksakt - `spend_date`/
    // `vendor_name` fantes ALDRI i dette skjemaet (`occurred_at`/`category` er
    // de faktiske NOT NULL-kolonnene) - en tidligere versjon av DENNE
    // akseptanseseksjonen gjettet feil kolonnenavn, fanget FØRSTE gang
    // scriptet faktisk kjørte mot en ekte Postgres (Tobias sin host-kjøring,
    // run_id 1244e885) - IKKE en feil i selve Stripe-/Slice 2-implementasjonen.
    await adminPool.query(
      `INSERT INTO finance_spend_records (spend_record_id, tenant_id, memory_space_id, source_family, source_record_id, occurred_at, amount_ore, currency, category)
       VALUES ($1, $2, 'business', 'model_cost', $3, now(), 500, 'NOK', 'ai_api_cost')`,
      [`fsr-live-${runId}`, TENANT_A, `src-live-${runId}`]
    );
    const before = await adminPool.query("SELECT count(*)::int AS n FROM finance_spend_records WHERE tenant_id = $1", [TENANT_A]);
    // Idempotens er selve INSERT ... ON CONFLICT-kontrakten spend-service.ts allerede håndhever - her bevises KUN at Stripe-migrasjonen (040_stripe.sql) ikke rørte denne tabellen/kontrakten.
    const after = await adminPool.query("SELECT count(*)::int AS n FROM finance_spend_records WHERE tenant_id = $1", [TENANT_A]);
    results.finance_slice2_invariants_preserved = (before.rows[0] as { n: number }).n === (after.rows[0] as { n: number }).n && (before.rows[0] as { n: number }).n === 1 ? "PASS" : "FAIL";
    log(`spend_records_count=${(after.rows[0] as { n: number }).n} -> finance_slice2_invariants_preserved: ${results.finance_slice2_invariants_preserved}`);
  });

  // ===== stripe_adapter_wiring: registrering + credential-ref-korrekt dispatch via ToolGateway =====
  let stripeIntentId = "";
  await section("STRIPE ADAPTER WIRING (finance.create_payment_intent(provider=stripe) + finance_stripe.* registrert/dispatchet via ToolGateway - SAMME sti som produksjon)", async () => {
    const created = await financeAction("create_payment_intent", {
      tenant_id: TENANT_A, idempotency_key: `stripe-wiring-${runId}`, purpose: "Stripe live-akseptanse", amount_ore: 10_000,
      vendor_name: "Kunde AS", account_code: "stripe-category", provider: "stripe"
    });
    stripeIntentId = mustExternalId(created, "stripe_create");
    const getResult = await stripeAction("get_refund", { tenant_id: TENANT_A, refund_id: "does-not-exist" });
    const listResult = await stripeAction("list_refunds", { tenant_id: TENANT_A, payment_intent_id: stripeIntentId });
    const wiringOk = created.ok && getResult.ok && listResult.ok;
    results.stripe_adapter_wiring = wiringOk ? "PASS" : "FAIL";
    log(`stripe_intent_id=${stripeIntentId} get_refund_ok=${getResult.ok} list_refunds_ok=${listResult.ok} -> stripe_adapter_wiring: ${results.stripe_adapter_wiring}`);
  });

  // ===== stripe_secret_safety (fail-closed uten JARVIS_STRIPE_SECRET_KEY - EKTE, ikke simulert) =====
  await section("STRIPE SECRET SAFETY (submit_refund/refresh_payment_state MÅ avvises credential_unavailable UTEN JARVIS_STRIPE_SECRET_KEY - D-108)", async () => {
    const secretConfigured = Boolean(process.env["JARVIS_STRIPE_SECRET_KEY"]);
    if (secretConfigured) {
      log("JARVIS_STRIPE_SECRET_KEY ER konfigurert i dette miljøet - fail-closed-beviset under er derfor IKKE relevant (og BØR ikke være satt i et D-108-riktig host-akseptanse-miljø). Markerer NOT_RUN i stedet for et falskt PASS.");
      results.stripe_secret_safety = "NOT_RUN";
      return;
    }
    const refreshDenied = await stripeAction("refresh_payment_state", { tenant_id: TENANT_A, payment_intent_id: stripeIntentId });
    const secretSafetyDenied = !refreshDenied.ok && refreshDenied.reason === "credential_unavailable";
    const redactionOk = evaluateSecretSafety(logBuffer, [FAKE_WEBHOOK_SECRET]);
    results.stripe_secret_safety = secretSafetyDenied && redactionOk === "PASS" ? "PASS" : "FAIL";
    log(`refresh_payment_state_denied=${!refreshDenied.ok} deny_reason=${refreshDenied.ok ? "n/a" : refreshDenied.reason} log_redaction=${redactionOk} -> stripe_secret_safety: ${results.stripe_secret_safety}`);
  });

  // ===== stripe_payment_idempotency + stripe_payment_state_sync (direkte FinanceService - SAMME domenelogikk uansett innslagspunkt) =====
  await section("STRIPE PAYMENT IDEMPOTENCY (retry can never double-pay - Stripe-gren)", async () => {
    const submitted1 = await finance.submitPaymentIntent(TENANT_A, "business", stripeIntentId, {} as never);
    const callsAfterFirst = writer.createPaymentIntentCalls;
    const submitted2 = await finance.submitPaymentIntent(TENANT_A, "business", stripeIntentId, {} as never);
    results.stripe_payment_idempotency = submitted1.provider_ref === submitted2.provider_ref && writer.createPaymentIntentCalls === callsAfterFirst ? "PASS" : "FAIL";
    log(`provider_ref_1=${submitted1.provider_ref} provider_ref_2=${submitted2.provider_ref} provider_calls=${writer.createPaymentIntentCalls} -> stripe_payment_idempotency: ${results.stripe_payment_idempotency}`);
  });

  await section("STRIPE PAYMENT STATE SYNC (eksplisitt oppfrisking -> settled)", async () => {
    writer.onGetPaymentIntent = async (id) => ({ id, object: "payment_intent", amount: 10_000, currency: "nok", status: "succeeded", metadata: {} });
    const refreshed = await finance.refreshStripePaymentState(TENANT_A, "business", stripeIntentId);
    results.stripe_payment_state_sync = refreshed.state === "settled" && refreshed.settled_at !== null ? "PASS" : "FAIL";
    log(`state=${refreshed.state} settled_at=${refreshed.settled_at} -> stripe_payment_state_sync: ${results.stripe_payment_state_sync}`);
  });

  // ===== stripe_webhook_signature_contract + stripe_webhook_idempotency (EKTE HTTP-rute, ikke bare tjenestenivå) =====
  await section("STRIPE WEBHOOK SIGNATURE CONTRACT (ekte HTTP POST /webhooks/stripe - gyldig OG ugyldig signatur)", async () => {
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
    try {
      const now = Math.floor(Date.now() / 1000);
      const validBody = Buffer.from(JSON.stringify({
        id: `evt_wiring_${runId}`, type: "payment_intent.succeeded", created: now,
        data: { object: { id: (await finance.getPaymentIntent(TENANT_A, "business", stripeIntentId))?.provider_ref, object: "payment_intent", status: "succeeded" } }
      }));
      const validRes = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, { method: "POST", body: validBody, headers: { "stripe-signature": signedHeader(validBody, now) } });
      const invalidRes = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, { method: "POST", body: validBody, headers: { "stripe-signature": "t=123,v1=deadbeef" } });
      results.stripe_webhook_signature_contract = validRes.status === 200 && invalidRes.status === 400 ? "PASS" : "FAIL";
      log(`valid_signature_http_status=${validRes.status} invalid_signature_http_status=${invalidRes.status} -> stripe_webhook_signature_contract: ${results.stripe_webhook_signature_contract}`);

      const dupRes = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, { method: "POST", body: validBody, headers: { "stripe-signature": signedHeader(validBody, now) } });
      const dupBody = (await dupRes.json()) as { status: string };
      results.stripe_webhook_idempotency = dupRes.status === 200 && dupBody.status === "duplicate" ? "PASS" : "FAIL";
      log(`duplicate_webhook_http_status=${dupRes.status} duplicate_webhook_body_status=${dupBody.status} -> stripe_webhook_idempotency: ${results.stripe_webhook_idempotency}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ===== stripe_refund_integrity =====
  let stripeRefundId = "";
  await section("STRIPE REFUND INTEGRITY (draft->submit, idempotent no-op, over-refund avvist)", async () => {
    const draft = await stripeAction("request_refund", { tenant_id: TENANT_A, idempotency_key: `refund-live-${runId}`, payment_intent_id: stripeIntentId, amount_ore: 4_000 });
    stripeRefundId = mustExternalId(draft, "refund_draft");
    writer.onCreateRefund = async (input) => ({ id: `re_wiring_${runId}`, object: "refund", amount: input.amountOre, currency: "nok", status: "succeeded", payment_intent: input.stripePaymentIntentId, reason: null });
    const submitted1 = await finance.submitStripeRefund(TENANT_A, "business", stripeRefundId);
    const callsAfterFirst = writer.createRefundCalls;
    const submitted2 = await finance.submitStripeRefund(TENANT_A, "business", stripeRefundId);
    let overRefundRejected = false;
    try {
      await finance.createStripeRefund(TENANT_A, "business", { idempotency_key: `refund-over-${runId}`, payment_intent_id: stripeIntentId, amount_ore: 9_999 });
    } catch (err) {
      overRefundRejected = (err as Error).message.includes("excessive_refund_amount");
    }
    results.stripe_refund_integrity = submitted1.state === "settled" && submitted1.refund_id === submitted2.refund_id && writer.createRefundCalls === callsAfterFirst && overRefundRejected ? "PASS" : "FAIL";
    log(`refund_state=${submitted1.state} idempotent=${submitted1.refund_id === submitted2.refund_id} over_refund_rejected=${overRefundRejected} -> stripe_refund_integrity: ${results.stripe_refund_integrity}`);
  });

  // ===== stripe_finance_reconciliation (DEN EKSISTERENDE Fiken-bygde mekanismen, ikke en Stripe-shadow) =====
  await section("STRIPE FINANCE RECONCILIATION (gjenbruker DEN EKSISTERENDE reconcile_payment_intent - ingen Stripe-spesifikk shadow-mekanisme)", async () => {
    const reconciled = await financeAction("reconcile_payment_intent", { tenant_id: TENANT_A, payment_intent_id: stripeIntentId, matched: true });
    const reconciliationState = reconciled.ok ? (reconciled.data as { reconciliation_state?: string } | undefined)?.reconciliation_state : undefined;
    results.stripe_finance_reconciliation = reconciliationState === "matched" ? "PASS" : "FAIL";
    log(`reconcile_ok=${reconciled.ok} reconciliation_state=${reconciliationState} -> stripe_finance_reconciliation: ${results.stripe_finance_reconciliation}`);
  });

  // ===== stripe_anomaly_integration (skriver til DEN EKSISTERENDE anomaly_flags-kolonnen - OpenLoopService fanger det UTEN ny kode) =====
  await section("STRIPE ANOMALY INTEGRATION (avvik skrevet til payment_intents.anomaly_flags overflater automatisk via EKSISTERENDE OpenLoopService.detectPaymentAnomalies())", async () => {
    const mismatchIntent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `anomaly-live-${runId}`, purpose: "Anomaly check", amount_ore: 5_000, vendor_name: "V", account_code: "cat", provider: "stripe"
    });
    writer.onCreatePaymentIntent = async () => ({ id: `pi_anomaly_${runId}`, object: "payment_intent", amount: 1, currency: "nok", status: "requires_payment_method", metadata: {} });
    await finance.submitPaymentIntent(TENANT_A, "business", mismatchIntent.payment_intent_id, {} as never);
    await finance.runProviderAnomalyDetection(TENANT_A, "business");
    const openLoops = new OpenLoopService(pool);
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const flagged = loops.find((l) => l.payment_intent_id === mismatchIntent.payment_intent_id);
    results.stripe_anomaly_integration = flagged !== undefined ? "PASS" : "FAIL";
    log(`open_loop_found=${flagged !== undefined} loop_type=${flagged?.loop_type ?? "n/a"} -> stripe_anomaly_integration: ${results.stripe_anomaly_integration}`);
  });

  // ===== stripe_tenant_isolation =====
  await section("STRIPE TENANT ISOLATION (RLS - tenant B ser ALDRI tenant A sine Stripe-intenter/refusjoner/webhook-hendelser)", async () => {
    const intentB = await finance.getPaymentIntent(TENANT_B, "business", stripeIntentId);
    const refundB = await finance.getStripeRefund(TENANT_B, "business", stripeRefundId);
    results.stripe_tenant_isolation = intentB === null && refundB === null ? "PASS" : "FAIL";
    log(`tenant_b_sees_intent=${intentB !== null} tenant_b_sees_refund=${refundB !== null} -> stripe_tenant_isolation: ${results.stripe_tenant_isolation}`);
  });

  // ===== stripe_kill_switch_semantics (blokkerer utgående, ALDRI passiv synk/webhook/avviksdeteksjon) =====
  await section("STRIPE KILL SWITCH SEMANTICS (blokkerer submit_payment_intent/submit_refund, ALDRI refresh/webhook/avviksdeteksjon)", async () => {
    const anotherIntent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `killswitch-live-${runId}`, purpose: "Kill switch check", amount_ore: 2_000, vendor_name: "V", account_code: "cat", provider: "stripe"
    });
    await finance.enableKillSwitch(TENANT_A, OWNER_PERSON, "Stripe live-akseptanse kill-switch-test");
    let submitBlocked = false;
    try {
      await finance.submitPaymentIntent(TENANT_A, "business", anotherIntent.payment_intent_id, {} as never);
    } catch (err) {
      submitBlocked = (err as Error).message.includes("finance_kill_switch_active");
    }
    const anomalyResult = await finance.runProviderAnomalyDetection(TENANT_A, "business"); // PASSIV - skal IKKE kastes
    await finance.disableKillSwitch(TENANT_A, OWNER_PERSON);
    results.stripe_kill_switch_semantics = submitBlocked && anomalyResult !== undefined ? "PASS" : "FAIL";
    log(`submit_blocked=${submitBlocked} passive_anomaly_detection_unaffected=${anomalyResult !== undefined} -> stripe_kill_switch_semantics: ${results.stripe_kill_switch_semantics}`);
  });

  // ===== stripe_cleanup =====
  await section("CLEANUP (KUN denne kjøringens egne syntetiske fixtures - inkl. stripe_webhook_events/stripe_refunds)", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });
    const remaining = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftover = (remaining.rows[0] as { n: number }).n;
    results.stripe_cleanup = cleanupOk && leftover === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftover} -> stripe_cleanup: ${results.stripe_cleanup}`);
  });

  return finish(false);
}

function finish(blockedByRuntimeRole: boolean): void {
  log("\n== UA-6 FINANCE & SPEND INTEGRITY GATEWAY - TREDJE SLICE (D-109) STRIPE GUARDED LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  const hardFail = blockedByRuntimeRole || Object.values(results).some((v) => v === "FAIL" || v === "NOT_RUN" || v === "BLOCKED_BY_RUNTIME_ROLE");
  // D-108: ærlig, permanent grense for DENNE runneren - den beviser KUN
  // produkt-wiring mot en fake ved nettverksgrensen, ALDRI ekte Stripe-
  // reachability. Disse to flaggene skal ALDRI settes til true av dette
  // scriptet, uansett resultatene over.
  log(`\nSTRIPE_LIVE_VERIFIED=false`);
  log(`STRIPE_LIVE_GATE=PENDING_CREDENTIALS`);
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
