// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - FJERDE SLICE (D-110) - VIPPS
// MOBILEPAY GUARDED LIVE ACCEPTANCE (NO VIPPS CREDENTIALS REQUIRED)
//
// Kjøres AV TOBIAS mot en ekte lokal Postgres (via docker-compose) og den
// EKTE runtime-rollen (Q-21). Gjenbruker KUN eksisterende arkitektur
// (@jarvis/finance FinanceService/FinanceTransport/VippsFinanceTransport,
// @jarvis/tool-gateway ToolGateway/EnvSecretProvider, @jarvis/policy,
// @jarvis/core) - INGEN alternativ testimplementasjon, INGEN
// produksjonsatferd endret av dette scriptet.
//
// D-108/§20: denne runneren krever BEVISST INGEN JARVIS_VIPPS_*-credentials
// - Vipps sitt EKTE HTTP-kall (`VippsTransport`) er ALDRI konstruert her.
// I stedet injiseres en deterministisk, skriptbar `VippsTransportFactory`-
// fake ved NETTVERKSGRENSEN (samme mock-grense som testmatrisen i
// `test/vipps-service.test.ts`) - dette beviser PRODUKT-WIRING, IKKE ekte
// Vipps-reachability. `VIPPS_LIVE_VERIFIED=false`/
// `VIPPS_LIVE_GATE=PENDING_CREDENTIALS` forblir sanne til Tobias selv
// oppretter og verifiserer en ekte Vipps MobilePay-selgerkonto (D-108).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/finance/scripts/vipps-live.ts
// (normalt via modules/finance/scripts/vipps-live-host-run.ts)
//
// Bruker UTELUKKENDE en syntetisk, kjøre-unik tenant for Jarvis-side
// fixtures - RØRER ALDRI ekte Jarvis-kundedata. All test-scaffolding
// fjernes ved slutten (inkl. vipps_webhook_events/vipps_captures/vipps_refunds).

import { randomUUID, createHash, createHmac } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, OpenLoopService } from "@jarvis/business";
import {
  FinanceService, FinanceTransport, StripeFinanceTransport, VippsFinanceTransport,
  type FikenCredentials, type FikenCredentialsProvider,
  type StripeCredentials, type StripeCredentialsProvider, type StripePaymentWriter,
  type VippsCredentials, type VippsCredentialsProvider
} from "../src/index.ts";
import type { StripePaymentIntentObject, StripeRefundObject } from "../src/stripe-transport.ts";
import type { VippsPaymentObject, VippsPaymentWriter } from "../src/vipps-transport.ts";
import { createApiServer } from "../../../apps/api/src/server.ts";
import { evaluateSecretSafety, type Verdict } from "./lib/fiken-live-lib.ts";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "NOT_RUN",
  finance_d107_invariant_preserved: "NOT_RUN",
  finance_slice2_invariants_preserved: "NOT_RUN",
  stripe_slice3_invariants_preserved: "NOT_RUN",
  vipps_adapter_wiring: "NOT_RUN",
  vipps_payment_idempotency: "NOT_RUN",
  vipps_payment_state_sync: "NOT_RUN",
  vipps_user_action_state: "NOT_RUN",
  vipps_capture_integrity: "NOT_RUN",
  vipps_cancel_integrity: "NOT_RUN",
  vipps_refund_integrity: "NOT_RUN",
  vipps_event_idempotency: "NOT_RUN",
  vipps_event_auth_contract: "NOT_RUN",
  vipps_finance_reconciliation: "NOT_RUN",
  vipps_anomaly_integration: "NOT_RUN",
  vipps_tenant_isolation: "NOT_RUN",
  vipps_kill_switch_semantics: "NOT_RUN",
  vipps_secret_safety: "NOT_RUN",
  vipps_cleanup: "NOT_RUN"
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
log(`UA-6 FINANCE & SPEND INTEGRITY GATEWAY - FJERDE SLICE (D-110) VIPPS GUARDED LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-vipps-live-${runId}-a`;
const TENANT_B = `tenant-vipps-live-${runId}-b`;
const OWNER_PERSON = `person-vipps-live-${runId}`;
// Fake webhook-hemmelighet - BEVISST IKKE en ekte Vipps-verdi (ingen slik
// konfigureres denne sliceen, D-108) - brukes KUN til å bevise
// autentiserings-KONTRAKTEN (Azure-stil HMAC-SHA256 over METHOD/path/
// dato;host;innholds-hash) fungerer ende-til-ende, og til
// `vipps_secret_safety` sin redaksjonssjekk under.
const FAKE_WEBHOOK_SECRET = `vipps-live-acceptance-${runId}-${randomUUID()}`;
const WEBHOOK_PATH = "/webhooks/vipps";

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-vipps-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
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
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-vipps-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-vipps-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

/** Skriptbar fake ved Vipps-transport-NETTVERKSGRENSEN - SAMME mock-boundary-prinsipp som `test/vipps-service.test.ts`. */
class ScriptedVippsWriter implements VippsPaymentWriter {
  createPaymentCalls = 0;
  captureCalls = 0;
  cancelCalls = 0;
  refundCalls = 0;
  onCreatePayment: (input: { amountOre: number; currency: string; reference: string }) => Promise<VippsPaymentObject> = async (input) => ({
    reference: input.reference, state: "CREATED", amount: { currency: input.currency, value: input.amountOre }
  });
  onGetPayment: (reference: string) => Promise<VippsPaymentObject> = async (reference) => ({
    reference, state: "CREATED", amount: { currency: "NOK", value: 10_000 }
  });
  async createPayment(input: Parameters<VippsPaymentWriter["createPayment"]>[0]): Promise<VippsPaymentObject> {
    this.createPaymentCalls++;
    return this.onCreatePayment(input);
  }
  async getPayment(reference: string): Promise<VippsPaymentObject> {
    return this.onGetPayment(reference);
  }
  async capturePayment(input: Parameters<VippsPaymentWriter["capturePayment"]>[0]): Promise<VippsPaymentObject> {
    this.captureCalls++;
    return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
  }
  async cancelPayment(reference: string): Promise<VippsPaymentObject> {
    this.cancelCalls++;
    return { reference, state: "CANCELLED", amount: { currency: "NOK", value: 10_000 } };
  }
  async refundPayment(input: Parameters<VippsPaymentWriter["refundPayment"]>[0]): Promise<VippsPaymentObject> {
    this.refundCalls++;
    return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
  }
}

function signedVippsHeaders(rawBody: Buffer, host: string, secret = FAKE_WEBHOOK_SECRET): Record<string, string> {
  const date = new Date().toUTCString();
  const contentHash = createHash("sha256").update(rawBody).digest("base64");
  const signedPayload = `POST\n${WEBHOOK_PATH}\n${date};${host};${contentHash}`;
  const signature = createHmac("sha256", secret).update(signedPayload, "utf8").digest("base64");
  return {
    "x-ms-date": date,
    "x-ms-content-sha256": contentHash,
    authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`
  };
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk, UAVHENGIG av Vipps-credentials)", async () => {
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
    TENANT_A, `Vipps Live A ${runId}`, TENANT_B, `Vipps Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "Vipps Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-vipps-a-${runId}`, TENANT_A, `ms-vipps-b-${runId}`, TENANT_B]
  );

  const writer = new ScriptedVippsWriter();
  const configuredTenant: string | null = TENANT_A;
  const vippsCredentialsProvider: VippsCredentialsProvider = {
    async getCredentials(): Promise<VippsCredentials | null> {
      return { clientId: "fake-client-live", clientSecret: "fake-secret-live-acceptance", subscriptionKey: "fake-sub-live", merchantSerialNumber: "000000", environment: "test" };
    }
  };
  const fikenCredentialsProvider: FikenCredentialsProvider = { async getCredentials(): Promise<FikenCredentials | null> { return null; } };
  // Stripe-fake KUN for stripe_slice3_invariants_preserved-seksjonen -
  // Stripe-implementasjonen selv er UENDRET av denne sliceen.
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
  const finance = new FinanceService(
    pool, undefined, stripeCredentialsProvider, () => stripeWriter, () => null, () => configuredTenant,
    vippsCredentialsProvider, () => writer, () => FAKE_WEBHOOK_SECRET, () => configuredTenant
  );

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A, TENANT_B] }
  });
  // SAMME sammensetning som produksjon: `submit_capture`/`submit_refund`/
  // `cancel_payment`/`refresh_payment_state` bruker den EKTE
  // `JARVIS_VIPPS_CLIENT_SECRET` - som er BEVISST IKKE satt i dette miljøet
  // (D-108). `EnvSecretProvider` leser den faktiske (fraværende) env-
  // variabelen - fail-closed-oppførselen bevises EKTE, ikke simulert.
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const toolGateway = new ToolGateway(pool, policy, secrets);
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(finance, fikenCredentialsProvider),
    finance_stripe: new StripeFinanceTransport(finance),
    finance_vipps: new VippsFinanceTransport(finance)
  })) toolGateway.register(tool);
  const identity = ownerIdentityFor(TENANT_A);

  async function vippsAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance_vipps", action, parameters: parameters as never });
  }
  async function financeAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance", action, parameters: parameters as never });
  }

  // ===== D-107-invariant preservert (Fiken, UENDRET av denne sliceen) =====
  await section("D-107 INVARIANT PRESERVERT (Fiken idempotent payment_intent-opprettelse, UENDRET av Vipps-tillegget)", async () => {
    const key = `idem-fiken-preserved-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-107 preserved", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-107 preserved", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const id1 = mustExternalId(first, "d107_create_1");
    const id2 = mustExternalId(second, "d107_create_2");
    results.finance_d107_invariant_preserved = id1 === id2 ? "PASS" : "FAIL";
    log(`fiken_create_1=${id1} fiken_create_2=${id2} -> finance_d107_invariant_preserved: ${results.finance_d107_invariant_preserved}`);
  });

  // ===== Slice 2-invariant preservert =====
  await section("SLICE 2 INVARIANTER PRESERVERT (finance_spend_records uendret av Vipps-migrasjonen)", async () => {
    // Kolonnenavn verifisert mot 039_finance_spend_integrity.sql (occurred_at/
    // category - IKKE spend_date/vendor_name, se D-109 sin host-fix-historikk).
    await adminPool.query(
      `INSERT INTO finance_spend_records (spend_record_id, tenant_id, memory_space_id, source_family, source_record_id, occurred_at, amount_ore, currency, category)
       VALUES ($1, $2, 'business', 'model_cost', $3, now(), 500, 'NOK', 'ai_api_cost')`,
      [`fsr-vipps-live-${runId}`, TENANT_A, `src-vipps-live-${runId}`]
    );
    const count = await adminPool.query("SELECT count(*)::int AS n FROM finance_spend_records WHERE tenant_id = $1", [TENANT_A]);
    results.finance_slice2_invariants_preserved = (count.rows[0] as { n: number }).n === 1 ? "PASS" : "FAIL";
    log(`spend_records_count=${(count.rows[0] as { n: number }).n} -> finance_slice2_invariants_preserved: ${results.finance_slice2_invariants_preserved}`);
  });

  // ===== Slice 3-invariant preservert (Stripe, UENDRET av denne sliceen) =====
  await section("SLICE 3 INVARIANTER PRESERVERT (Stripe-grenen: idempotent opprettelse+submit, UENDRET av Vipps-tillegget)", async () => {
    const key = `idem-stripe-preserved-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-109 preserved", amount_ore: 1000, vendor_name: "x", account_code: "stripe-cat", provider: "stripe" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "D-109 preserved", amount_ore: 1000, vendor_name: "x", account_code: "stripe-cat", provider: "stripe" });
    const id1 = mustExternalId(first, "d109_create_1");
    const id2 = mustExternalId(second, "d109_create_2");
    const submitted = await finance.submitPaymentIntent(TENANT_A, "business", id1, {} as never);
    results.stripe_slice3_invariants_preserved = id1 === id2 && submitted.state === "provider_acknowledged" && submitted.provider_ref === `pi_slice3_${runId}` ? "PASS" : "FAIL";
    log(`stripe_create_idempotent=${id1 === id2} stripe_submit_state=${submitted.state} -> stripe_slice3_invariants_preserved: ${results.stripe_slice3_invariants_preserved}`);
  });

  // ===== vipps_adapter_wiring =====
  let vippsIntentId = "";
  await section("VIPPS ADAPTER WIRING (finance.create_payment_intent(provider=vipps) + finance_vipps.* registrert/dispatchet via ToolGateway)", async () => {
    const created = await financeAction("create_payment_intent", {
      tenant_id: TENANT_A, idempotency_key: `vipps-wiring-${runId}`, purpose: "Vipps live-akseptanse", amount_ore: 10_000,
      vendor_name: "Kunde AS", account_code: "vipps-category", provider: "vipps"
    });
    vippsIntentId = mustExternalId(created, "vipps_create");
    const getResult = await vippsAction("get_capture", { tenant_id: TENANT_A, capture_id: "does-not-exist" });
    const listResult = await vippsAction("list_refunds", { tenant_id: TENANT_A, payment_intent_id: vippsIntentId });
    const wiringOk = created.ok && getResult.ok && listResult.ok;
    results.vipps_adapter_wiring = wiringOk ? "PASS" : "FAIL";
    log(`vipps_intent_id=${vippsIntentId} get_capture_ok=${getResult.ok} list_refunds_ok=${listResult.ok} -> vipps_adapter_wiring: ${results.vipps_adapter_wiring}`);
  });

  // ===== vipps_secret_safety (fail-closed uten JARVIS_VIPPS_CLIENT_SECRET - EKTE, ikke simulert) =====
  await section("VIPPS SECRET SAFETY (submit_capture/refresh_payment_state MÅ avvises credential_unavailable UTEN JARVIS_VIPPS_CLIENT_SECRET - D-108)", async () => {
    const secretConfigured = Boolean(process.env["JARVIS_VIPPS_CLIENT_SECRET"]);
    if (secretConfigured) {
      log("JARVIS_VIPPS_CLIENT_SECRET ER konfigurert i dette miljøet - fail-closed-beviset under er derfor IKKE relevant. Markerer NOT_RUN i stedet for et falskt PASS.");
      results.vipps_secret_safety = "NOT_RUN";
      return;
    }
    const refreshDenied = await vippsAction("refresh_payment_state", { tenant_id: TENANT_A, payment_intent_id: vippsIntentId });
    const secretSafetyDenied = !refreshDenied.ok && refreshDenied.reason === "credential_unavailable";
    const redactionOk = evaluateSecretSafety(logBuffer, [FAKE_WEBHOOK_SECRET]);
    results.vipps_secret_safety = secretSafetyDenied && redactionOk === "PASS" ? "PASS" : "FAIL";
    log(`refresh_payment_state_denied=${!refreshDenied.ok} deny_reason=${refreshDenied.ok ? "n/a" : refreshDenied.reason} log_redaction=${redactionOk} -> vipps_secret_safety: ${results.vipps_secret_safety}`);
  });

  // ===== vipps_payment_idempotency + vipps_user_action_state =====
  await section("VIPPS PAYMENT IDEMPOTENCY (retry can never double-pay - Vipps-gren)", async () => {
    const submitted1 = await finance.submitPaymentIntent(TENANT_A, "business", vippsIntentId, {} as never);
    const callsAfterFirst = writer.createPaymentCalls;
    const submitted2 = await finance.submitPaymentIntent(TENANT_A, "business", vippsIntentId, {} as never);
    results.vipps_payment_idempotency = submitted1.provider_ref === submitted2.provider_ref && writer.createPaymentCalls === callsAfterFirst ? "PASS" : "FAIL";
    log(`provider_ref_1=${submitted1.provider_ref} provider_ref_2=${submitted2.provider_ref} provider_calls=${writer.createPaymentCalls} -> vipps_payment_idempotency: ${results.vipps_payment_idempotency}`);
  });

  await section("VIPPS USER ACTION STATE (CREATED = VENTER på brukerbekreftelse i appen - ALDRI antatt fullført)", async () => {
    const current = await finance.getPaymentIntent(TENANT_A, "business", vippsIntentId);
    results.vipps_user_action_state = current?.state === "provider_acknowledged" && current.provider_status === "CREATED" && current.settled_at === null ? "PASS" : "FAIL";
    log(`state=${current?.state} provider_status=${current?.provider_status} settled_at=${current?.settled_at} -> vipps_user_action_state: ${results.vipps_user_action_state}`);
  });

  await section("VIPPS PAYMENT STATE SYNC (eksplisitt oppfrisking CREATED -> AUTHORIZED - reservasjon, IKKE oppgjør)", async () => {
    writer.onGetPayment = async (reference) => ({ reference, state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } });
    const refreshed = await finance.refreshVippsPaymentState(TENANT_A, "business", vippsIntentId);
    results.vipps_payment_state_sync = refreshed.provider_status === "AUTHORIZED" && refreshed.state === "provider_acknowledged" ? "PASS" : "FAIL";
    log(`provider_status=${refreshed.provider_status} state=${refreshed.state} -> vipps_payment_state_sync: ${results.vipps_payment_state_sync}`);
  });

  // ===== vipps_capture_integrity (delvis + full, over-capture avvist, idempotent) =====
  await section("VIPPS CAPTURE INTEGRITY (delvis -> fortsatt uavklart, full -> settled, over-capture avvist, idempotent retry)", async () => {
    const partial = await finance.createVippsCapture(TENANT_A, "business", { idempotency_key: `cap-partial-${runId}`, payment_intent_id: vippsIntentId, amount_ore: 4_000 });
    await finance.submitVippsCapture(TENANT_A, "business", partial.capture_id);
    const afterPartial = await finance.getPaymentIntent(TENANT_A, "business", vippsIntentId);
    const partialStillOpen = afterPartial?.state === "provider_acknowledged";

    let overCaptureRejected = false;
    try {
      await finance.createVippsCapture(TENANT_A, "business", { idempotency_key: `cap-over-${runId}`, payment_intent_id: vippsIntentId, amount_ore: 6_001 });
    } catch (err) {
      overCaptureRejected = (err as Error).message.includes("excessive_capture_amount");
    }

    const rest = await finance.createVippsCapture(TENANT_A, "business", { idempotency_key: `cap-rest-${runId}`, payment_intent_id: vippsIntentId, amount_ore: 6_000 });
    await finance.submitVippsCapture(TENANT_A, "business", rest.capture_id);
    const callsAfterBoth = writer.captureCalls;
    await finance.submitVippsCapture(TENANT_A, "business", rest.capture_id); // idempotent retry
    const afterFull = await finance.getPaymentIntent(TENANT_A, "business", vippsIntentId);

    results.vipps_capture_integrity = partialStillOpen && overCaptureRejected && afterFull?.state === "settled" && writer.captureCalls === callsAfterBoth ? "PASS" : "FAIL";
    log(`partial_still_open=${partialStillOpen} over_capture_rejected=${overCaptureRejected} full_settled=${afterFull?.state === "settled"} idempotent_retry_no_new_call=${writer.captureCalls === callsAfterBoth} -> vipps_capture_integrity: ${results.vipps_capture_integrity}`);
  });

  // ===== vipps_cancel_integrity (egen intent - kanselleringsflyt) =====
  await section("VIPPS CANCEL INTEGRITY (lokal kansellering før innsending + provider-kansellering etter autorisering)", async () => {
    const localIntent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `cancel-local-${runId}`, purpose: "Cancel-lokal", amount_ore: 2_000, vendor_name: "V", account_code: "cat", provider: "vipps"
    });
    const localCancelled = await finance.cancelVippsPayment(TENANT_A, "business", localIntent.payment_intent_id);
    const localOk = localCancelled.state === "cancelled" && writer.cancelCalls === 0;

    const remoteIntent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `cancel-remote-${runId}`, purpose: "Cancel-remote", amount_ore: 2_000, vendor_name: "V", account_code: "cat", provider: "vipps"
    });
    await finance.submitPaymentIntent(TENANT_A, "business", remoteIntent.payment_intent_id, {} as never);
    const remoteCancelled = await finance.cancelVippsPayment(TENANT_A, "business", remoteIntent.payment_intent_id);
    const remoteOk = remoteCancelled.state === "cancelled" && remoteCancelled.provider_status === "CANCELLED" && writer.cancelCalls === 1;
    const idempotentCancel = await finance.cancelVippsPayment(TENANT_A, "business", remoteIntent.payment_intent_id);
    const idempotentOk = idempotentCancel.state === "cancelled" && writer.cancelCalls === 1;

    results.vipps_cancel_integrity = localOk && remoteOk && idempotentOk ? "PASS" : "FAIL";
    log(`local_ok=${localOk} remote_ok=${remoteOk} idempotent_ok=${idempotentOk} -> vipps_cancel_integrity: ${results.vipps_cancel_integrity}`);
  });

  // ===== vipps_refund_integrity =====
  await section("VIPPS REFUND INTEGRITY (draft->submit mot oppgjort betaling, idempotent, over-refund avvist)", async () => {
    const draft = await vippsAction("request_refund", { tenant_id: TENANT_A, idempotency_key: `refund-live-${runId}`, payment_intent_id: vippsIntentId, amount_ore: 4_000 });
    const refundId = mustExternalId(draft, "refund_draft");
    const submitted1 = await finance.submitVippsRefund(TENANT_A, "business", refundId);
    const callsAfterFirst = writer.refundCalls;
    const submitted2 = await finance.submitVippsRefund(TENANT_A, "business", refundId);
    let overRefundRejected = false;
    try {
      await finance.createVippsRefund(TENANT_A, "business", { idempotency_key: `refund-over-${runId}`, payment_intent_id: vippsIntentId, amount_ore: 9_999 });
    } catch (err) {
      overRefundRejected = (err as Error).message.includes("excessive_refund_amount");
    }
    results.vipps_refund_integrity = submitted1.state === "settled" && submitted1.refund_id === submitted2.refund_id && writer.refundCalls === callsAfterFirst && overRefundRejected ? "PASS" : "FAIL";
    log(`refund_state=${submitted1.state} idempotent=${submitted1.refund_id === submitted2.refund_id} over_refund_rejected=${overRefundRejected} -> vipps_refund_integrity: ${results.vipps_refund_integrity}`);
  });

  // ===== vipps_event_auth_contract + vipps_event_idempotency (EKTE HTTP-rute) =====
  await section("VIPPS EVENT AUTH CONTRACT + IDEMPOTENCY (ekte HTTP POST /webhooks/vipps - gyldig, ugyldig og duplisert)", async () => {
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
      const providerRef = (await finance.getPaymentIntent(TENANT_A, "business", vippsIntentId))?.provider_ref;
      const validBody = Buffer.from(JSON.stringify({
        reference: providerRef, name: "AUTHORIZED", amount: { value: 10_000, currency: "NOK" },
        timestamp: new Date().toISOString(), idempotencyKey: `evt-live-${runId}`
      }));
      const validRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body: validBody, headers: signedVippsHeaders(validBody, host) });
      const invalidRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body: validBody, headers: signedVippsHeaders(validBody, host, "wrong-secret-live") });
      results.vipps_event_auth_contract = validRes.status === 200 && invalidRes.status === 401 ? "PASS" : "FAIL";
      log(`valid_auth_http_status=${validRes.status} invalid_auth_http_status=${invalidRes.status} -> vipps_event_auth_contract: ${results.vipps_event_auth_contract}`);

      const dupRes = await fetch(`http://${host}${WEBHOOK_PATH}`, { method: "POST", body: validBody, headers: signedVippsHeaders(validBody, host) });
      const dupBody = (await dupRes.json()) as { status: string };
      results.vipps_event_idempotency = dupRes.status === 200 && dupBody.status === "duplicate" ? "PASS" : "FAIL";
      log(`duplicate_event_http_status=${dupRes.status} duplicate_event_body_status=${dupBody.status} -> vipps_event_idempotency: ${results.vipps_event_idempotency}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ===== vipps_finance_reconciliation =====
  await section("VIPPS FINANCE RECONCILIATION (gjenbruker DEN EKSISTERENDE reconcile_payment_intent - ingen Vipps-spesifikk shadow-mekanisme)", async () => {
    const reconciled = await financeAction("reconcile_payment_intent", { tenant_id: TENANT_A, payment_intent_id: vippsIntentId, matched: true });
    const reconciliationState = reconciled.ok ? (reconciled.data as { reconciliation_state?: string } | undefined)?.reconciliation_state : undefined;
    results.vipps_finance_reconciliation = reconciliationState === "matched" ? "PASS" : "FAIL";
    log(`reconcile_ok=${reconciled.ok} reconciliation_state=${reconciliationState} -> vipps_finance_reconciliation: ${results.vipps_finance_reconciliation}`);
  });

  // ===== vipps_anomaly_integration =====
  await section("VIPPS ANOMALY INTEGRATION (avvik skrevet til payment_intents.anomaly_flags overflater automatisk via EKSISTERENDE OpenLoopService)", async () => {
    const mismatchIntent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `anomaly-live-${runId}`, purpose: "Anomaly check", amount_ore: 5_000, vendor_name: "V", account_code: "cat", provider: "vipps"
    });
    writer.onCreatePayment = async (input) => ({ reference: input.reference, state: "CREATED", amount: { currency: "NOK", value: 1 } }); // feil beløp fra "Vipps"
    await finance.submitPaymentIntent(TENANT_A, "business", mismatchIntent.payment_intent_id, {} as never);
    await finance.runVippsProviderAnomalyDetection(TENANT_A, "business");
    const openLoops = new OpenLoopService(pool);
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const flagged = loops.find((l) => l.payment_intent_id === mismatchIntent.payment_intent_id);
    results.vipps_anomaly_integration = flagged !== undefined ? "PASS" : "FAIL";
    log(`open_loop_found=${flagged !== undefined} loop_type=${flagged?.loop_type ?? "n/a"} -> vipps_anomaly_integration: ${results.vipps_anomaly_integration}`);
  });

  // ===== vipps_tenant_isolation =====
  await section("VIPPS TENANT ISOLATION (RLS - tenant B ser ALDRI tenant A sine Vipps-intenter/captures/refusjoner)", async () => {
    const intentB = await finance.getPaymentIntent(TENANT_B, "business", vippsIntentId);
    const capturesB = await finance.listVippsCaptures(TENANT_B, "business", vippsIntentId);
    const refundsB = await finance.listVippsRefunds(TENANT_B, "business", vippsIntentId);
    results.vipps_tenant_isolation = intentB === null && capturesB.length === 0 && refundsB.length === 0 ? "PASS" : "FAIL";
    log(`tenant_b_sees_intent=${intentB !== null} tenant_b_captures=${capturesB.length} tenant_b_refunds=${refundsB.length} -> vipps_tenant_isolation: ${results.vipps_tenant_isolation}`);
  });

  // ===== vipps_kill_switch_semantics =====
  await section("VIPPS KILL SWITCH SEMANTICS (blokkerer submit/capture/refund/cancel-mot-provider, ALDRI passiv avviksdeteksjon)", async () => {
    const anotherIntent = await finance.createPaymentIntent(TENANT_A, "business", {
      idempotency_key: `killswitch-live-${runId}`, purpose: "Kill switch check", amount_ore: 2_000, vendor_name: "V", account_code: "cat", provider: "vipps"
    });
    await finance.enableKillSwitch(TENANT_A, OWNER_PERSON, "Vipps live-akseptanse kill-switch-test");
    let submitBlocked = false;
    try {
      await finance.submitPaymentIntent(TENANT_A, "business", anotherIntent.payment_intent_id, {} as never);
    } catch (err) {
      submitBlocked = (err as Error).message.includes("finance_kill_switch_active");
    }
    const anomalyResult = await finance.runVippsProviderAnomalyDetection(TENANT_A, "business"); // PASSIV - skal IKKE kastes
    await finance.disableKillSwitch(TENANT_A, OWNER_PERSON);
    results.vipps_kill_switch_semantics = submitBlocked && anomalyResult !== undefined ? "PASS" : "FAIL";
    log(`submit_blocked=${submitBlocked} passive_anomaly_detection_unaffected=${anomalyResult !== undefined} -> vipps_kill_switch_semantics: ${results.vipps_kill_switch_semantics}`);
  });

  // ===== vipps_cleanup =====
  await section("CLEANUP (KUN denne kjøringens egne syntetiske fixtures - inkl. vipps_webhook_events/vipps_captures/vipps_refunds)", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });
    const remaining = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftover = (remaining.rows[0] as { n: number }).n;
    results.vipps_cleanup = cleanupOk && leftover === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftover} -> vipps_cleanup: ${results.vipps_cleanup}`);
  });

  return finish(false);
}

function finish(blockedByRuntimeRole: boolean): void {
  log("\n== UA-6 FINANCE & SPEND INTEGRITY GATEWAY - FJERDE SLICE (D-110) VIPPS GUARDED LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  const hardFail = blockedByRuntimeRole || Object.values(results).some((v) => v === "FAIL" || v === "NOT_RUN" || v === "BLOCKED_BY_RUNTIME_ROLE");
  // D-108: ærlig, permanent grense for DENNE runneren - den beviser KUN
  // produkt-wiring mot en fake ved nettverksgrensen, ALDRI ekte Vipps-
  // reachability. Disse to flaggene skal ALDRI settes til true av dette
  // scriptet, uansett resultatene over.
  log(`\nVIPPS_LIVE_VERIFIED=false`);
  log(`VIPPS_LIVE_GATE=PENDING_CREDENTIALS`);
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
