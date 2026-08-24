// UA-6 FINANCE & SPEND INTEGRITY GATEWAY (D-107) - LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot en ekte lokal Postgres (via docker-compose) og,
// dersom konfigurert, mot Fiken (P0 regnskapsconnector). Gjenbruker KUN
// eksisterende arkitektur (@jarvis/finance FinanceService/FinanceTransport/
// FikenTransport, @jarvis/tool-gateway ToolGateway/EnvSecretProvider,
// @jarvis/policy, @jarvis/core) - INGEN alternativ testimplementasjon,
// INGEN produksjonsatferd endret av dette scriptet.
//
// FIKEN HAR INGEN DOKUMENTERT SANDBOX/TEST-MODUS (i motsetning til Stripe) -
// et ekte `submit_payment_intent`-kall poster en PERMANENT regnskapspost i
// Tobias sin virkelige Fiken-konto. Denne runneren forsøker derfor ALDRI et
// ekte skrivekall med mindre `JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE=
// true` er EKSPLISITT satt (fiken-live-lib.ts) - default er en ren LESE-
// basert reachability-probe (`listCompanies()`, ZERO mutasjon). Hele
// Payment/Spend Intent-domenet (idempotens/validering/kill switch/state
// machine/avstemming/tenant-isolasjon) bevises FULLT ut mot en EKTE lokal
// Postgres uansett - dette er den JARVIS_CANONICAL kjernen (D-107), IKKE
// avhengig av Fiken i det hele tatt.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/finance/scripts/fiken-live.ts
// (normalt via modules/finance/scripts/fiken-live-host-run.ts)
//
// Bruker UTELUKKENDE en syntetisk, kjøre-unik tenant for Jarvis-side
// fixtures - RØRER ALDRI ekte Jarvis-kundedata. All test-scaffolding
// fjernes ved slutten.

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider } from "@jarvis/business";
import { FinanceService, FinanceTransport, type FikenCredentials, type FikenCredentialsProvider } from "../src/index.ts";
import { FikenTransport } from "../src/fiken-transport.ts";
import { checkRequiredEnv, computeHardFail, evaluateSecretSafety, isLiveWriteOptedIn, type Verdict } from "./lib/fiken-live-lib.ts";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "NOT_RUN",
  finance_live_env_safe: "NOT_RUN",
  finance_live_db_idempotency: "NOT_RUN",
  finance_live_db_validation: "NOT_RUN",
  finance_live_db_kill_switch: "NOT_RUN",
  finance_live_db_state_machine: "NOT_RUN",
  finance_live_db_reconciliation: "NOT_RUN",
  finance_live_db_tenant_isolation: "NOT_RUN",
  finance_live_provider_auth: "NOT_RUN",
  finance_live_provider_read: "NOT_RUN",
  finance_live_provider_write: "NOT_RUN",
  finance_live_secret_safety: "NOT_RUN",
  finance_live_cleanup: "NOT_RUN"
};
const diagnostics: Record<string, string> = {};

const logBuffer: string[] = [];
function log(msg: string): void {
  logBuffer.push(msg);
  console.log(msg);
}

/** `external_id` finnes kun på `ok:true`-varianten av `ToolResult` - denne hjelperen kaster tydelig i stedet for å anta at et forutgående `create_payment_intent`-kall lyktes. Inkluderer ALLTID den faktiske `ToolGateway`-DENY-årsaken (f.eks. `credential_unavailable`) i feilmeldingen - en generisk "did_not_return_external_id" uten årsak skjulte tidligere en reell secret-provider-wiring-defekt i dette scriptet (D-107 host-fix). */
function mustExternalId(result: Awaited<ReturnType<InstanceType<typeof ToolGateway>["execute"]>>, label: string): string {
  if (!result.ok) throw new Error(`${label}_denied:${result.reason}`);
  if (!result.external_id) throw new Error(`${label}_did_not_return_external_id`);
  return result.external_id;
}

async function section<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  log(`\n== ${name} ==`);
  try {
    return await fn();
  } catch (err) {
    log(`${name}: UVENTET FEIL - ${(err as Error).message.slice(0, 200)}`);
    return undefined;
  }
}

const runId = randomUUID().slice(0, 8);
log(`UA-6 FINANCE & SPEND INTEGRITY GATEWAY (D-107) LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-finance-live-${runId}-a`;
const TENANT_B = `tenant-finance-live-${runId}-b`;
const OWNER_PERSON = `person-finance-live-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-finance-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
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
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-finance-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-finance-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk, UAVHENGIG av Fiken-credentials)", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish(true);
  }

  const envCheck = checkRequiredEnv(process.env as Record<string, string | undefined>);
  let refreshToken = "";
  let companySlug = "";
  await section("ENV-PREKSJEKK (kun tilstedeværelse - ALDRI verdi printet)", async () => {
    results.finance_live_env_safe = envCheck.configured ? "PASS" : "BLOCKED_NO_CREDENTIALS";
    if (!envCheck.configured) {
      log(`finance_live_env_safe=BLOCKED_NO_CREDENTIALS missing_env_vars=${envCheck.missing.join(",")} - Fiken-reachability/skriving hoppes over (JARVIS_CANONICAL Payment/Spend Intent-domenet bevises likevel FULLT ut under, uavhengig av Fiken).`);
      return;
    }
    refreshToken = process.env["JARVIS_FIKEN_REFRESH_TOKEN"] ?? "";
    companySlug = process.env["JARVIS_FIKEN_COMPANY_SLUG"] ?? "";
    log("finance_live_env_safe=PASS (alle fire påkrevde variabler tilstede - ingen verdi logget)");
  });

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `Finance Live A ${runId}`, TENANT_B, `Finance Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "Finance Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-fin-a-${runId}`, TENANT_A, `ms-fin-b-${runId}`, TENANT_B]
  );

  const fikenCredentialsProvider: FikenCredentialsProvider = {
    async getCredentials(): Promise<FikenCredentials | null> {
      if (!envCheck.configured) return null;
      return { refreshToken, companySlug };
    }
  };
  const finance = new FinanceService(pool);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
  });
  // D-107 HOST-FIX: 9 av 10 finance.*-handlinger bruker credential_ref
  // JARVIS_BUSINESS_INTERNAL_TOKEN - en BEVISST ikke-hemmelig sentinel
  // (D-49, `BusinessInternalSecretProvider`), ALDRI satt i .env. Kun
  // `submit_payment_intent` bruker en ekte Fiken-secret (via EnvSecretProvider).
  // MÅ speile EKSAKT samme sammensetning som produksjonens ToolGateway-wiring
  // (apps/api/src/main.ts / worker-main.ts: `FallbackSecretProvider(env,
  // BusinessInternalSecretProvider)`) - en bar `EnvSecretProvider` alene
  // fikk tidligere `credential_unavailable` for HVERT internt finance-kall,
  // siden JARVIS_BUSINESS_INTERNAL_TOKEN korrekt aldri er en ekte secret.
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const toolGateway = new ToolGateway(pool, policy, secrets);
  for (const tool of firstWaveTools({ finance: new FinanceTransport(finance, fikenCredentialsProvider) })) toolGateway.register(tool);
  const identity = ownerIdentityFor(TENANT_A);

  async function financeAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance", action, parameters: parameters as never });
  }

  // ===== JARVIS_CANONICAL Payment/Spend Intent-domenet (D-107) - bevises HELT UAVHENGIG av Fiken =====
  await section("IDEMPOTENS (akseptansekriterium 1 - retry can never double-pay, via ToolGateway - SAMME sti som produksjon)", async () => {
    const key = `idem-live-${runId}`;
    const first = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "Live-akseptanse", amount_ore: 5000, vendor_name: "Test AS", account_code: "6540" });
    const second = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: key, purpose: "Live-akseptanse", amount_ore: 5000, vendor_name: "Test AS", account_code: "6540" });
    const firstId = mustExternalId(first, "idempotency_create_1");
    const secondId = mustExternalId(second, "idempotency_create_2");
    const all = await finance.listPaymentIntents(TENANT_A, "business");
    const dupCount = all.filter((i) => i.idempotency_key === key).length;
    results.finance_live_db_idempotency = firstId === secondId && dupCount === 1 ? "PASS" : "FAIL";
    log(`create_1_id=${firstId} create_2_id=${secondId} rows_with_key=${dupCount} -> finance_live_db_idempotency: ${results.finance_live_db_idempotency}`);
  });

  await section("DETERMINISTISK VALIDERING (akseptansekriterium 3)", async () => {
    const badAmount = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: `bad-amt-${runId}`, purpose: "x", amount_ore: -1, vendor_name: "x", account_code: "6540" });
    const badAccount = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: `bad-acc-${runId}`, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "abc" });
    results.finance_live_db_validation = !badAmount.ok && !badAccount.ok ? "PASS" : "FAIL";
    log(`bad_amount_ok=${badAmount.ok} bad_account_ok=${badAccount.ok} -> finance_live_db_validation: ${results.finance_live_db_validation}`);
  });

  let killSwitchIntentId = "";
  await section("FINANS-NØDBRYTER (akseptansekriterium 5 - deterministisk håndhevet)", async () => {
    const created = await financeAction("create_payment_intent", {
      tenant_id: TENANT_A, idempotency_key: `ks-${runId}`, purpose: "Nødbryter-test", amount_ore: 1000, vendor_name: "x",
      vendor_provider_ref: "fake-contact", account_code: "6540", counter_account_code: "1920"
    });
    killSwitchIntentId = mustExternalId(created, "kill_switch_create");
    await financeAction("enable_kill_switch", { tenant_id: TENANT_A, actor_person_id: OWNER_PERSON, reason: "live-akseptanse" });
    const blocked = await financeAction("submit_payment_intent", { tenant_id: TENANT_A, payment_intent_id: killSwitchIntentId, actor_person_id: OWNER_PERSON });
    const stillDraft = await finance.getPaymentIntent(TENANT_A, "business", killSwitchIntentId);
    await financeAction("disable_kill_switch", { tenant_id: TENANT_A, actor_person_id: OWNER_PERSON });
    results.finance_live_db_kill_switch = !blocked.ok && stillDraft?.state === "draft" ? "PASS" : "FAIL";
    log(`submit_blocked_ok=${blocked.ok} state_after=${stillDraft?.state} -> finance_live_db_kill_switch: ${results.finance_live_db_kill_switch}`);
  });

  await section("STATE MACHINE (draft -> cancelled, ugyldig overgang avvist)", async () => {
    const created = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: `sm-${runId}`, purpose: "x", amount_ore: 500, vendor_name: "x", account_code: "6540" });
    const createdId = mustExternalId(created, "state_machine_create");
    const cancelled = await financeAction("cancel_payment_intent", { tenant_id: TENANT_A, payment_intent_id: createdId });
    const invalidSettle = await financeAction("settle_payment_intent", { tenant_id: TENANT_A, payment_intent_id: createdId });
    results.finance_live_db_state_machine = cancelled.ok && !invalidSettle.ok ? "PASS" : "FAIL";
    log(`cancel_ok=${cancelled.ok} settle_after_cancel_ok=${invalidSettle.ok} (skal være false) -> finance_live_db_state_machine: ${results.finance_live_db_state_machine}`);
  });

  await section("AVSTEMMING (akseptansekriterium 2)", async () => {
    const created = await financeAction("create_payment_intent", { tenant_id: TENANT_A, idempotency_key: `rec-${runId}`, purpose: "x", amount_ore: 500, vendor_name: "x", account_code: "6540" });
    const createdId = mustExternalId(created, "reconciliation_create");
    const mismatched = await financeAction("reconcile_payment_intent", { tenant_id: TENANT_A, payment_intent_id: createdId, matched: false });
    results.finance_live_db_reconciliation = mismatched.ok ? "PASS" : "FAIL";
    log(`reconcile_ok=${mismatched.ok} -> finance_live_db_reconciliation: ${results.finance_live_db_reconciliation}`);
  });

  await section("TENANT-ISOLASJON (RLS)", async () => {
    const listB = await finance.listPaymentIntents(TENANT_B, "business");
    results.finance_live_db_tenant_isolation = listB.length === 0 ? "PASS" : "FAIL";
    log(`tenant_b_payment_intents=${listB.length} -> finance_live_db_tenant_isolation: ${results.finance_live_db_tenant_isolation}`);
  });

  // ===== Fiken reachability (KUN dersom credentials konfigurert - ALDRI en skriving med mindre eksplisitt opt-in) =====
  if (envCheck.configured) {
    await section("FIKEN REACHABILITY (listCompanies() - ZERO mutasjon, samme klient som produksjon)", async () => {
      try {
        const transport = new FikenTransport(refreshToken, companySlug);
        const companies = await transport.listCompanies();
        results.finance_live_provider_auth = "PASS";
        results.finance_live_provider_read = "PASS";
        diagnostics["finance_live_fiken_company_count"] = String(companies.length);
        log(`fiken_list_companies_ok=true company_count=${companies.length} -> provider_auth/provider_read: PASS`);
      } catch (err) {
        results.finance_live_provider_auth = "FAIL";
        results.finance_live_provider_read = "FAIL";
        log(`fiken_list_companies_ok=false error=${(err as Error).message.slice(0, 200)} -> provider_auth/provider_read: FAIL`);
      }
    });
    if (isLiveWriteOptedIn(process.env as Record<string, string | undefined>) && killSwitchIntentId) {
      log("\nJARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE=true - EKTE submit_payment_intent-forsøk (poster en PERMANENT regnskapspost i Tobias sin virkelige Fiken-konto) er BEVISST IKKE implementert i denne sliceen (krever en Fiken-kontakt-ID/motkonto Tobias selv må oppgi interaktivt - se D-107). finance_live_provider_write forblir NO_DATA.");
    } else {
      log(`\nfinance_live_provider_write=NO_DATA (JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE ikke satt til "true" - INGEN ekte skriving mot Fiken forsøkt, per design. Fiken har ingen dokumentert sandbox/test-modus.)`);
    }
  } else {
    log("\nFiken-credentials ikke konfigurert - provider_auth/provider_read/provider_write forblir NO_DATA (IKKE en implementasjonsfeil).");
  }

  await section("CLEANUP (KUN denne kjøringens egne syntetiske fixtures)", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });
    const remaining = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftover = (remaining.rows[0] as { n: number }).n;
    results.finance_live_cleanup = cleanupOk && leftover === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftover} -> finance_live_cleanup: ${results.finance_live_cleanup}`);
  });

  results.finance_live_secret_safety = evaluateSecretSafety(logBuffer, [refreshToken, process.env["JARVIS_FIKEN_CLIENT_SECRET"] ?? ""]);
  return finish(false);
}

function finish(blockedByRuntimeRole: boolean): void {
  log("\n== UA-6 FINANCE & SPEND INTEGRITY GATEWAY (D-107) LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);

  const hardFail = blockedByRuntimeRole || computeHardFail(results);
  const fikenCredentialsConfigured = results.finance_live_env_safe === "PASS";
  const fikenLiveVerified = fikenCredentialsConfigured && results.finance_live_provider_auth === "PASS" && results.finance_live_provider_read === "PASS";

  log(`\nrun_id=${runId} fiken_credentials_configured=${fikenCredentialsConfigured} FIKEN_LIVE_VERIFIED=${fikenLiveVerified} JARVIS_CANONICAL_DOMAIN_VERIFIED=${!hardFail} hard_fail=${hardFail}`);
  if (!fikenCredentialsConfigured && !blockedByRuntimeRole) {
    log("Fiken-credentials er IKKE konfigurert ennå - dette er FORVENTET FØR Tobias fullfører OAuth-oppsettet (se .env.example). Payment/Spend Intent-domenet (JARVIS_CANONICAL) er likevel FULLT ut bevist mot ekte Postgres over.");
  }
  if (hardFail) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
