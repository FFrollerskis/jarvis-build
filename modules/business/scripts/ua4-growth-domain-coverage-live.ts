// UA-4 GROWTH -> BUSINESS DOMAIN COVERAGE INTEGRATION (D-78) - HOST LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose). Beviser at
// BUSINESS_DOMAIN_COVERAGE (@jarvis/business, business-brief.ts) faktisk
// rapporterer `marketing: "available"` NÅ som Native Jarvis Growth Core
// (D-74/D-75/D-76/D-77) finnes - uten aa kreve NOEN annonseplattform-
// credential, og uten aa regressere sales/product/finance/operations eller
// selskaps-tidslinjen.
//
// NO GOOGLE ADS, NO META ADS, NO GA4, NO LIVE ANNONSEPLATTFORM: dette
// scriptet krever INGEN annonseplattform-credential av noe slag - domene-
// kapabilitet (`status`) og ekstern leverandør-tilkobling
// (`live_provider_connected`) er BEVISST separate felt (D-78).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/ua4-growth-domain-coverage-live.ts
// (normalt via modules/business/scripts/ua4-growth-domain-coverage-host-run.ts,
// som bootstrapper workspacet/Docker/migrasjoner først)
//
// Bruker UTELUKKENDE syntetiske test-selskaper/kampanjer i en isolert,
// kjøre-unik tenant (tenant-ua4-domcov-live-<run_id>-a/-b) - RØRER ALDRI
// ekte kunde-/forretningsdata. All test-scaffolding fjernes ved slutten.

import { randomUUID } from "node:crypto";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { BUSINESS_DOMAIN_COVERAGE, BusinessService, generateWeeklyBrief, renderWeeklyBrief } from "@jarvis/business";
import { GrowthService } from "../../growth/src/service.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  ua4_growth_domain_available: "FAIL",
  ua4_growth_provider_independent: "FAIL",
  ua4_growth_business_brief: "FAIL",
  ua4_sales_coverage_unchanged: "FAIL",
  ua4_product_coverage_truthful: "FAIL",
  ua4_finance_coverage_truthful: "FAIL",
  ua4_operations_coverage_truthful: "FAIL",
  ua4_growth_timeline_regression: "FAIL",
  ua4_growth_domain_coverage_cleanup: "FAIL"
};
const diagnostics: Record<string, string> = {};

function log(msg: string): void {
  console.log(msg);
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
log(`UA-4 GROWTH -> BUSINESS DOMAIN COVERAGE LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-ua4-domcov-live-${runId}-a`;
const TENANT_B = `tenant-ua4-domcov-live-${runId}-b`; // urørt kontrast-tenant - beviser dekningen er arkitektur, ikke tenant-data

/** Samme FK-rekkefølge-lærdom (D-67/D-69/D-72) - vekst-/aktivitet-/selskap-barnetabeller FØR foreldretabeller. */
async function cleanupTenant(tenantId: string): Promise<void> {
  // `growth.createCampaign()` logger automatisk et `campaign_created`-event -
  // `marketing_campaign_events` maa slettes FØR `marketing_campaigns` (samme
  // FK-lærdom som D-67/D-69/D-72, fanget her av det ekte smoke-testede kjøret,
  // ikke antatt).
  await adminPool.query("DELETE FROM marketing_campaign_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_campaigns WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua4-domcov-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua4-domcov-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nKAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await section("MARKETING-DOMENE TILGJENGELIG (build-time-fakta, ALDRI en DB-spørring)", async () => {
    const marketing = BUSINESS_DOMAIN_COVERAGE.marketing;
    results.ua4_growth_domain_available = marketing.status === "available" && /Growth Core/.test(marketing.source) ? "PASS" : "FAIL";
    log(`marketing_status=${marketing.status} marketing_source=${marketing.source} -> ua4_growth_domain_available: ${results.ua4_growth_domain_available}`);
  });

  await section("LEVERANDØR-UAVHENGIGHET (domenekapabilitet != ekstern leverandør-tilkobling)", async () => {
    const providerEnvKeys = Object.keys(process.env).filter((k) => /GOOGLE_ADS|META_ADS|FACEBOOK_ADS|LINKEDIN_ADS|TIKTOK_ADS|_GA4_|SEARCH_CONSOLE/i.test(k));
    for (const key of providerEnvKeys) delete process.env[key];
    // `BUSINESS_DOMAIN_COVERAGE` er en ren, statisk kartlegging (ingen provider-SDK-import i
    // business-brief.ts i det hele tatt, strukturelt bevist i business-brief.test.ts §C) - denne
    // seksjonen sletter i tillegg eventuelle provider-env-variabler for aa bevise at fravær av
    // dem IKKE endrer resultatet.
    const marketing = BUSINESS_DOMAIN_COVERAGE.marketing;
    results.ua4_growth_provider_independent =
      marketing.live_provider_connected === false && marketing.status === "available" ? "PASS" : "FAIL";
    log(`ad_platform_provider_env_vars_unset=${providerEnvKeys.length} marketing_live_provider_connected=${marketing.live_provider_connected} -> ua4_growth_provider_independent: ${results.ua4_growth_provider_independent}`);
  });

  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-4 DomCov Live A ${runId}`, TENANT_B, `UA-4 DomCov Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [`person-ua4-domcov-${runId}`, "UA-4 DomCov Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [`person-ua4-domcov-${runId}`, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-ua4-domcov-a-${runId}`, TENANT_A, `ms-ua4-domcov-b-${runId}`, TENANT_B]
  );

  const business = new BusinessService(pool);
  const growth = new GrowthService(pool);
  let companyId = "";

  await section("EKTE FORRETNINGSDATA (selskap + aktivitet + kampanje) - beviser tidslinje/andre domener uendret", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: `DomCov Syntetisk AS ${runId}` });
    companyId = company.company_id;
    await business.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "DomCov-test-aktivitet for tidslinjen", company_id: companyId,
      source_type: "test", source_instance_id: "domcov-test", external_id: `domcov-${runId}`
    });
    await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: `DomCov Kampanje ${runId}` });
    log(`company_id=${companyId} campaign_created=true`);
  });

  await section("BUSINESS BRIEF (ukentlig) REFLEKTERER OPPDATERT DEKNING", async () => {
    const weeklyA = await generateWeeklyBrief(pool, TENANT_A, "business");
    const weeklyB = await generateWeeklyBrief(pool, TENANT_B, "business");
    const renderedA = renderWeeklyBrief(weeklyA);
    const marketingA = weeklyA.data_coverage.marketing;

    results.ua4_growth_business_brief =
      marketingA.status === "available" &&
      marketingA.live_provider_connected === false &&
      renderedA.includes("marketing: tilgjengelig") &&
      renderedA.includes("ingen live ekstern leverandør tilkoblet") &&
      JSON.stringify(weeklyA.data_coverage) === JSON.stringify(weeklyB.data_coverage) // arkitektur, ikke tenant-data
        ? "PASS" : "FAIL";
    log(`weekly_a_marketing_status=${marketingA.status} weekly_a_marketing_live_provider=${marketingA.live_provider_connected} coverage_identical_across_tenants=${JSON.stringify(weeklyA.data_coverage) === JSON.stringify(weeklyB.data_coverage)} -> ua4_growth_business_brief: ${results.ua4_growth_business_brief}`);

    results.ua4_sales_coverage_unchanged =
      weeklyA.data_coverage.sales.status === "available" && weeklyA.data_coverage.sales.source === "Business Graph/CRM" ? "PASS" : "FAIL";
    results.ua4_product_coverage_truthful = weeklyA.data_coverage.product.status === "not_integrated" ? "PASS" : "FAIL";
    results.ua4_finance_coverage_truthful = weeklyA.data_coverage.finance.status === "not_integrated" ? "PASS" : "FAIL";
    results.ua4_operations_coverage_truthful = weeklyA.data_coverage.operations.status === "not_integrated" ? "PASS" : "FAIL";
    log(
      `sales=${weeklyA.data_coverage.sales.status} product=${weeklyA.data_coverage.product.status} finance=${weeklyA.data_coverage.finance.status} operations=${weeklyA.data_coverage.operations.status} -> ` +
        `ua4_sales_coverage_unchanged: ${results.ua4_sales_coverage_unchanged} ua4_product_coverage_truthful: ${results.ua4_product_coverage_truthful} ua4_finance_coverage_truthful: ${results.ua4_finance_coverage_truthful} ua4_operations_coverage_truthful: ${results.ua4_operations_coverage_truthful}`
    );
  });

  await section("SELSKAPS-TIDSLINJE UENDRET ('Hva skjer med kunde X?' regresjon)", async () => {
    const timeline = await business.companyTimeline(TENANT_A, "business", companyId);
    results.ua4_growth_timeline_regression = timeline.length > 0 && timeline.some((t) => t.summary.includes("DomCov-test-aktivitet")) ? "PASS" : "FAIL";
    log(`timeline_entries=${timeline.length} -> ua4_growth_timeline_regression: ${results.ua4_growth_timeline_regression}`);
  });

  await section("CLEANUP", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [`person-ua4-domcov-${runId}`]).catch((err: unknown) => {
      cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`);
    });
    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.ua4_growth_domain_coverage_cleanup = cleanupOk && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftoverTenants} -> ua4_growth_domain_coverage_cleanup: ${results.ua4_growth_domain_coverage_cleanup}`);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-4 GROWTH -> BUSINESS DOMAIN COVERAGE LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

await selfHeal();

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
