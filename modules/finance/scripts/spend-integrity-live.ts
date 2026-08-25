// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - ANDRE SLICE (Slice 2) - LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot en ekte lokal Postgres (via docker-compose). Gjenbruker
// KUN eksisterende arkitektur (@jarvis/finance SpendService/SpendTransport,
// @jarvis/business OpenLoopService, @jarvis/tool-gateway ToolGateway/
// EnvSecretProvider, @jarvis/core) - INGEN alternativ testimplementasjon,
// INGEN produksjonsatferd endret av dette scriptet. ZERO ekstern leverandør
// (ingen Fiken/Google Ads-credentials nødvendig - se D-108) - HELE denne
// akseptansen kjører KUN mot interne kilder Jarvis allerede eier
// (marketing_spend_events/cost_events).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/finance/scripts/spend-integrity-live.ts
// (normalt via modules/finance/scripts/spend-integrity-live-host-run.ts)
//
// Bruker UTELUKKENDE en syntetisk, kjøre-unik tenant for Jarvis-side
// fixtures - RØRER ALDRI ekte Jarvis-kundedata. All test-scaffolding
// fjernes ved slutten. Preserverer (re-verifiserer, kjører ALDRI om)
// den tidligere-beviste D-107 FØRSTE-slice Payment/Spend Intent-invarianten
// (idempotent opprettelse via FinanceService) parallelt med de ti nye
// Slice 2-markørene, som byggeordren §16 krever.

import { randomUUID } from "node:crypto";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { FinanceService, SpendService } from "../src/index.ts";
import { OpenLoopService } from "../../business/src/index.ts";

type Verdict = "PASS" | "FAIL" | "NOT_RUN";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "NOT_RUN",
  finance_d107_invariant_preserved: "NOT_RUN",
  finance_internal_spend_marketing_sync: "NOT_RUN",
  finance_internal_spend_model_cost_sync: "NOT_RUN",
  finance_internal_spend_idempotency: "NOT_RUN",
  finance_subscription_registry: "NOT_RUN",
  finance_procurement_registry: "NOT_RUN",
  finance_spend_anomaly_detection: "NOT_RUN",
  finance_spend_reconciliation: "NOT_RUN",
  finance_spend_openloop: "NOT_RUN",
  finance_spend_tenant_isolation: "NOT_RUN",
  finance_spend_cleanup: "NOT_RUN"
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

const runId = randomUUID().slice(0, 8);
log(`UA-6 FINANCE & SPEND INTEGRITY GATEWAY - ANDRE SLICE (Slice 2) LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-spend-live-${runId}-a`;
const TENANT_B = `tenant-spend-live-${runId}-b`;
const OWNER_PERSON = `person-spend-live-${runId}`;
let campaignId = "";

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_spend_records WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_recurring_commitments WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_procurement_items WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_spend_sync_cursors WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_spend_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_campaigns WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM cost_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM payment_intent_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM payment_intents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_kill_switch WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-spend-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-spend-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk)", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    for (const key of Object.keys(results)) results[key] = "FAIL";
    return finish(true);
  }

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `Spend Live A ${runId}`, TENANT_B, `Spend Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "Spend Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-spend-a-${runId}`, TENANT_A, `ms-spend-b-${runId}`, TENANT_B]
  );
  await adminPool.query("INSERT INTO marketing_campaigns (campaign_id, tenant_id, channel, name) VALUES ($1,$2,'google_ads',$3)", [
    `camp-spend-live-${runId}`, TENANT_A, `Spend Live Campaign ${runId}`
  ]);
  campaignId = `camp-spend-live-${runId}`;

  const finance = new FinanceService(pool);
  const spend = new SpendService(pool);
  const openLoops = new OpenLoopService(pool);

  // ===== D-107 FØRSTE-slice invariant preservert (byggeordrens §16-krav) =====
  await section("D-107 INVARIANT PRESERVERT (idempotent payment_intent-opprettelse, akseptansekriterium 1 - UENDRET av denne sliceen)", async () => {
    const key = `idem-spend-live-${runId}`;
    const first = await finance.createPaymentIntent(TENANT_A, "business", { idempotency_key: key, purpose: "D-107 preserved check", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    const second = await finance.createPaymentIntent(TENANT_A, "business", { idempotency_key: key, purpose: "D-107 preserved check", amount_ore: 1000, vendor_name: "x", account_code: "6540" });
    results.finance_d107_invariant_preserved = first.payment_intent_id === second.payment_intent_id ? "PASS" : "FAIL";
    log(`create_1_id=${first.payment_intent_id} create_2_id=${second.payment_intent_id} -> finance_d107_invariant_preserved: ${results.finance_d107_invariant_preserved}`);
  });

  // ===== §4/§16: markedsføringsutgifts-synk =====
  let marketingSpendRecordId = "";
  await section("MARKETING SPEND SYNC (§4 - inkrementell/retry-trygg/idempotent, ekte marketing_spend_events-kilde)", async () => {
    await adminPool.query(
      `INSERT INTO marketing_spend_events (spend_event_id, tenant_id, campaign_id, event_date, spend_amount_ore, currency, source_type)
       VALUES ($1, $2, $3, '2026-01-10'::date, 5000, 'NOK', 'manual')`,
      [`grw-se-live-${runId}`, TENANT_A, campaignId]
    );
    const first = await spend.syncMarketingSpend(TENANT_A, "business");
    const second = await spend.syncMarketingSpend(TENANT_A, "business");
    const records = await spend.listSpendRecords(TENANT_A, "business", { source_family: "marketing" });
    const record = records.find((r) => r.campaign_id === campaignId);
    marketingSpendRecordId = record?.spend_record_id ?? "";
    results.finance_internal_spend_marketing_sync = first.inserted >= 1 && second.scanned === 0 && record !== undefined ? "PASS" : "FAIL";
    log(`first_inserted=${first.inserted} second_scanned=${second.scanned} record_found=${record !== undefined} -> finance_internal_spend_marketing_sync: ${results.finance_internal_spend_marketing_sync}`);
  });

  // ===== §5/§16: AI/API-kostnadssynk =====
  await section("MODEL COST SYNC (§5 - append-only cost_events-kilde)", async () => {
    const { rows } = await adminPool.query(
      `INSERT INTO cost_events (tenant_id, kind, amount_ore, currency, provider, model) VALUES ($1, 'model:live-acceptance', 250, 'NOK', 'anthropic', 'claude') RETURNING cost_id`,
      [TENANT_A]
    );
    const costId = String((rows[0] as { cost_id: string }).cost_id);
    const first = await spend.syncModelCost(TENANT_A, "business");
    const second = await spend.syncModelCost(TENANT_A, "business");
    const records = await spend.listSpendRecords(TENANT_A, "business", { source_family: "model_cost" });
    const found = records.some((r) => r.source_record_id === costId);
    results.finance_internal_spend_model_cost_sync = first.inserted >= 1 && second.inserted === 0 && found ? "PASS" : "FAIL";
    log(`first_inserted=${first.inserted} second_inserted=${second.inserted} record_found=${found} -> finance_internal_spend_model_cost_sync: ${results.finance_internal_spend_model_cost_sync}`);
  });

  // ===== §3: kilde-idempotens på tvers av begge kilder =====
  await section("INTERNAL SPEND IDEMPOTENCY (§3 - repeated sync MUST NOT duplicate money)", async () => {
    const before = await spend.listSpendRecords(TENANT_A, "business", { limit: 200 });
    await spend.syncMarketingSpend(TENANT_A, "business");
    await spend.syncModelCost(TENANT_A, "business");
    const after = await spend.listSpendRecords(TENANT_A, "business", { limit: 200 });
    results.finance_internal_spend_idempotency = before.length === after.length && before.length >= 2 ? "PASS" : "FAIL";
    log(`records_before=${before.length} records_after=${after.length} -> finance_internal_spend_idempotency: ${results.finance_internal_spend_idempotency}`);
  });

  // ===== §6: abonnements-/gjentakende forpliktelses-register =====
  let commitmentId = "";
  await section("SUBSCRIPTION REGISTRY (§6 - CRUD + deterministiske state-overganger)", async () => {
    const commitment = await spend.createCommitment(TENANT_A, "business", {
      vendor_name: "Live Vendor", description: "Live acceptance subscription", cadence: "monthly", expected_amount_ore: 5000,
      amount_tolerance_ore: 100, source_mapping: { campaign_id: campaignId }, start_date: "2026-01-01"
    });
    commitmentId = commitment.commitment_id;
    const paused = await spend.pauseCommitment(TENANT_A, "business", commitmentId);
    const resumed = await spend.resumeCommitment(TENANT_A, "business", commitmentId);
    results.finance_subscription_registry = commitment.state === "active" && paused.state === "paused" && resumed.state === "active" ? "PASS" : "FAIL";
    log(`created_state=${commitment.state} paused_state=${paused.state} resumed_state=${resumed.state} -> finance_subscription_registry: ${results.finance_subscription_registry}`);
  });

  // ===== §7: anskaffelses-/forventet-utgifts-register =====
  let procurementId = "";
  await section("PROCUREMENT REGISTRY (§7 - lifecycle)", async () => {
    const item = await spend.createProcurementItem(TENANT_A, "business", {
      vendor_name: "Live Procurement Vendor", description: "Live acceptance procurement", expected_amount_ore: 10000,
      expected_date: "2020-01-01", expected_window_days: 1
    });
    procurementId = item.procurement_item_id;
    results.finance_procurement_registry = item.status === "expected" ? "PASS" : "FAIL";
    log(`created_status=${item.status} -> finance_procurement_registry: ${results.finance_procurement_registry}`);
  });

  // ===== §8: deterministisk avviksdeteksjon =====
  await section("SPEND ANOMALY DETECTION (§8 - MISSING_EXPECTED_SPEND på anskaffelsen, deterministisk SQL)", async () => {
    await spend.runAnomalyDetection(TENANT_A, "business");
    const updated = await spend.getProcurementItem(TENANT_A, "business", procurementId);
    results.finance_spend_anomaly_detection = updated?.anomaly_flags.includes("MISSING_EXPECTED_SPEND") ? "PASS" : "FAIL";
    log(`procurement_anomaly_flags=${JSON.stringify(updated?.anomaly_flags)} -> finance_spend_anomaly_detection: ${results.finance_spend_anomaly_detection}`);
  });

  // ===== §9: avstemming/matching =====
  await section("SPEND RECONCILIATION (§9 - deterministisk matching + manuell reconcile)", async () => {
    const matchResult = await spend.matchAndReconcile(TENANT_A, "business");
    let manualOk = false;
    if (marketingSpendRecordId) {
      const reconciled = await spend.reconcileSpendRecord(TENANT_A, "business", marketingSpendRecordId, true);
      manualOk = reconciled.reconciliation_state === "matched";
    }
    results.finance_spend_reconciliation = matchResult.matched >= 1 && manualOk ? "PASS" : "FAIL";
    log(`auto_matched=${matchResult.matched} manual_reconcile_ok=${manualOk} -> finance_spend_reconciliation: ${results.finance_spend_reconciliation}`);
  });

  // ===== §10: OpenLoop-surfacing =====
  await section("SPEND OPENLOOP (§10 - de fem nye loop_type-reglene surfacer via runSweep())", async () => {
    // Forpliktelsen opprettet over (start_date 2026-01-01, monthly) har et
    // `next_expected_charge_at` LANGT i fortiden ift. dagens dato - den
    // ALLEREDE kjørte runAnomalyDetection() over har derfor DETERMINISTISK
    // flagget den MISSING_EXPECTED_SPEND. Dette er den EKSAKTE, deterministiske
    // fixturen som skal produsere en `finance_recurring_charge_missing`-loop.
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const commitmentLoop = loops.find((l) => l.finance_recurring_commitment_id === commitmentId && l.loop_type === "finance_recurring_charge_missing");
    results.finance_spend_openloop = commitmentLoop !== undefined ? "PASS" : "FAIL";
    log(`finance_recurring_charge_missing_loop_found=${commitmentLoop !== undefined} commitment_id=${commitmentId} -> finance_spend_openloop: ${results.finance_spend_openloop}`);
  });

  // ===== §14: tenant-isolasjon =====
  await section("TENANT ISOLATION (RLS - tenant B ser ALDRI tenant A sine utgiftsposter/forpliktelser/anskaffelser)", async () => {
    const spendB = await spend.listSpendRecords(TENANT_B, "business");
    const commitmentsB = await spend.listCommitments(TENANT_B, "business");
    const procurementB = await spend.listProcurementItems(TENANT_B, "business");
    results.finance_spend_tenant_isolation = spendB.length === 0 && commitmentsB.length === 0 && procurementB.length === 0 ? "PASS" : "FAIL";
    log(`tenant_b_spend=${spendB.length} tenant_b_commitments=${commitmentsB.length} tenant_b_procurement=${procurementB.length} -> finance_spend_tenant_isolation: ${results.finance_spend_tenant_isolation}`);
  });

  // ===== §16: opprydding =====
  await section("CLEANUP (KUN denne kjøringens egne syntetiske fixtures)", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });
    const remaining = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftover = (remaining.rows[0] as { n: number }).n;
    results.finance_spend_cleanup = cleanupOk && leftover === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftover} -> finance_spend_cleanup: ${results.finance_spend_cleanup}`);
  });

  return finish(false);
}

function finish(blockedByRuntimeRole: boolean): void {
  log("\n== UA-6 FINANCE & SPEND INTEGRITY GATEWAY - ANDRE SLICE (Slice 2) LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  const hardFail = blockedByRuntimeRole || Object.values(results).some((v) => v === "FAIL" || v === "NOT_RUN");
  log(`\nrun_id=${runId}`);
  log(`hard_fail=${hardFail}`);
  if (hardFail) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
