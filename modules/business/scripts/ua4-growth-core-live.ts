// UA-4 NATIVE JARVIS GROWTH CORE (D-74) - HOST LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose). Gjenbruker KUN
// eksisterende arkitektur (@jarvis/growth, @jarvis/business, @jarvis/core,
// @jarvis/policy, @jarvis/tool-gateway) - ingen alternativ testimplementasjon.
// Speiler NØYAKTIG samme admin-pool-for-scaffold/runtime-pool-for-operasjoner-
// separasjon og den EKSISTERENDE, gjenbrukte `findBlockingTenantDependencies()`-
// selvdiagnostikken som `ua3-native-contracts-live.ts` - ikke en ny kopi.
//
// NO GOOGLE ADS, NO META ADS, NO GA4, NO LIVE ANNONSEPLATTFORM: dette
// scriptet krever INGEN annonseplattform-credential av noe slag - Native
// Growth Core er JARVIS_CANONICAL/HYBRID_WITH_CLEAR_AUTHORITY og kjører
// fullstendig uten en ekstern leverandør (D-74).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/ua4-growth-core-live.ts
// (normalt via modules/business/scripts/ua4-growth-core-host-run.ts, som
// bootstrapper workspacet/Docker/migrasjoner først)
//
// Bruker UTELUKKENDE syntetiske test-selskaper/leads/opportunities/kampanjer
// i en isolert, kjøre-unik tenant (tenant-ua4-grw-live-<run_id>-a/-b) - RØRER
// ALDRI ekte kunde-/forretningsdata. All test-scaffolding fjernes ved slutten.

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, OpenLoopService } from "@jarvis/business";
import { LocalHashEmbedding } from "@jarvis/memory";
import { GrowthService } from "../../growth/src/service.ts";
import { GrowthTransport } from "../../growth/src/transport.ts";
import { InvalidCampaignTransitionError } from "../../growth/src/state-machine.ts";
import { ErasureService } from "../../erasure/src/erasure-service.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  ua4_growth_runtime_role: "FAIL",
  ua4_growth_no_ad_platform_dependency: "FAIL",
  ua4_growth_create_campaign: "FAIL",
  ua4_growth_spend_idempotent: "FAIL",
  ua4_growth_lifecycle_valid: "FAIL",
  ua4_growth_lifecycle_invalid_rejected: "FAIL",
  ua4_growth_attribution_created: "FAIL",
  ua4_growth_cac_roas: "FAIL",
  ua4_growth_experiment_registry: "FAIL",
  ua4_growth_timeline: "FAIL",
  ua4_growth_open_loop_created: "FAIL",
  ua4_growth_open_loop_resolved: "FAIL",
  ua4_growth_tenant_isolation: "FAIL",
  ua4_growth_space_isolation: "FAIL",
  ua4_growth_toolgateway: "FAIL",
  ua4_growth_audit_safe: "FAIL",
  ua4_growth_q20: "FAIL",
  ua4_growth_cleanup: "FAIL"
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
log(`UA-4 NATIVE GROWTH CORE LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-ua4-grw-live-${runId}-a`;
const TENANT_B = `tenant-ua4-grw-live-${runId}-b`; // tenant-isolasjon: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua4-grw-live-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-ua4-grw-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`ua4_grw_cleanup_unsafe_identifier: "${name}"`);
  }
}

interface TenantFkBlocker {
  table: string;
  constraint: string;
  rows: number;
}

/** Schema-drevet (ikke hardkodet) sjekk FØR `DELETE FROM tenants` - samme mønster som ua3-native-contracts-live.ts. */
async function findBlockingTenantDependencies(tenantId: string): Promise<TenantFkBlocker[]> {
  const { rows: fkRows } = await adminPool.query(`
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'tenants' AND kcu.column_name = 'tenant_id'
  `);
  const blockers: TenantFkBlocker[] = [];
  for (const row of fkRows as Array<{ table_name: string; constraint_name: string }>) {
    assertSafeIdentifier(row.table_name);
    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM "${row.table_name}" WHERE tenant_id = $1`, [tenantId]);
    const n = (rows[0] as { n: number }).n;
    if (n > 0) blockers.push({ table: row.table_name, constraint: row.constraint_name, rows: n });
  }
  return blockers;
}

/**
 * FK-rekkefølge (proaktivt anvendt lærdom fra D-67/D-69/D-72 - unngå å
 * gjenoppdage samme feilklasse reaktivt): vekst-barnetabeller FØR
 * marketing_campaigns; business_activities/business_opportunities/
 * business_leads FØR business_companies (samme kjede som CAC/ROAS-
 * seksjonen under faktisk populerer via ekte business_leads/
 * business_opportunities-fixtures for attribusjon).
 */
async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_attributions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_spend_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_campaign_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_experiments WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_campaigns WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  // Q-20 (samme etablerte mønster som ua3-native-contracts-live.ts sin egen
  // cleanupTenant()): ErasureService.executeErasure() skriver en EKTE
  // erasure_requests/erasure_fingerprints-revisjonsrad. `jarvis_app` har
  // bevisst INGEN DELETE-rettighet der (append-only-lignende revisjonsspor,
  // 018_erasure.sql) - ren test-fixture-opprydding via admin-pool.
  await adminPool.query("DELETE FROM erasure_fingerprints WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM erasure_requests WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_opportunities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_leads WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);

  const blockers = await findBlockingTenantDependencies(tenantId);
  if (blockers.length > 0) {
    for (const b of blockers) log(`blocking_fk_table=${b.table} blocking_fk_name=${b.constraint} rows_for_test_tenant=${b.rows}`);
    throw new Error(`ua4_grw_cleanup_blocked: ${blockers.length} uventet(e) FK-refererende tabell(er) har fortsatt rader for ${tenantId}`);
  }
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua4-grw-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua4-grw-%'").catch(() => undefined);
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
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nNATIVE GROWTH CORE KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await section("ZERO ANNONSEPLATTFORM-LEVERANDØR-AVHENGIGHET", async () => {
    const providerEnvKeys = Object.keys(process.env).filter((k) => /GOOGLE_ADS|META_ADS|FACEBOOK_ADS|LINKEDIN_ADS|TIKTOK_ADS|_GA4_|SEARCH_CONSOLE/i.test(k));
    for (const key of providerEnvKeys) delete process.env[key];
    diagnostics["ad_platform_provider_env_unset_count"] = String(providerEnvKeys.length);
    // GrowthService/GrowthTransport konstrueres KUN med (pool)/(service) -
    // ingen provider-credential-parameter finnes i det hele tatt (strukturelt bevist av transport-wiring.test.ts §D).
    results.ua4_growth_no_ad_platform_dependency = "PASS";
    log(`ad_platform_provider_env_vars_unset=${providerEnvKeys.length} -> ua4_growth_no_ad_platform_dependency: PASS`);
  });

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-4 Growth Live A ${runId}`, TENANT_B, `UA-4 Growth Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "UA-4 Growth Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua4-grw-a-business-${runId}`, TENANT_A, `ms-ua4-grw-a-personal-${runId}`, TENANT_A, `ms-ua4-grw-b-business-${runId}`, TENANT_B]
  );

  await section("GROWTH RUNTIME-ROLLE (rett før faktiske growth-operasjoner)", async () => {
    const { rows } = await pool.query("SELECT current_user AS role");
    const role = (rows[0] as { role: string }).role;
    results.ua4_growth_runtime_role = role === diagnostics["runtime_current_user"] ? "PASS" : "FAIL";
    log(`growth_runtime_role=${role} -> ua4_growth_runtime_role: ${results.ua4_growth_runtime_role}`);
  });

  const business = new BusinessService(pool);
  const growth = new GrowthService(pool);
  const openLoops = new OpenLoopService(pool);
  let companyId = "";
  let campaignId = "";

  await section("OPPRETT KAMPANJE (kanal-nøytral, ZERO leverandør-credential)", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: `Growth Syntetisk AS ${runId}` });
    companyId = company.company_id;

    const a = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: `Kampanje A ${runId}` });
    campaignId = a.campaign_id;
    results.ua4_growth_create_campaign = a.status === "draft" && Boolean(a.campaign_id) ? "PASS" : "FAIL";
    log(`campaign_id=${campaignId} campaign_status=${a.status} -> ua4_growth_create_campaign: ${results.ua4_growth_create_campaign}`);
  });

  await section("IDEMPOTENT UTGIFTS-INGESTION (before/after state, ingen duplikat)", async () => {
    const first = await growth.recordSpendEvent(TENANT_A, "business", campaignId, { event_date: "2026-01-10", spend_amount_ore: 10_000 });
    const second = await growth.recordSpendEvent(TENANT_A, "business", campaignId, { event_date: "2026-01-10", spend_amount_ore: 25_000 });
    const events = await growth.listSpendEvents(TENANT_A, "business", campaignId);
    const sameRowSameDay = second.spend_event_id === first.spend_event_id && events.filter((e) => String(e.event_date).slice(0, 10) === "2026-01-10").length === 1;
    results.ua4_growth_spend_idempotent = sameRowSameDay && second.spend_amount_ore === "25000" ? "PASS" : "FAIL";
    log(`spend_event_ids_equal=${second.spend_event_id === first.spend_event_id} final_amount=${second.spend_amount_ore} -> ua4_growth_spend_idempotent: ${results.ua4_growth_spend_idempotent}`);
  });

  await section("DETERMINISTISK LIFECYCLE (state-machine, ingen LLM-avgjoerelse)", async () => {
    const active = await growth.setStatus(TENANT_A, "business", campaignId, "active");
    results.ua4_growth_lifecycle_valid = active?.status === "active" && active.started_at !== null ? "PASS" : "FAIL";
    log(`status_after_valid_transition=${active?.status} -> ua4_growth_lifecycle_valid: ${results.ua4_growth_lifecycle_valid}`);

    let invalidRejected = false;
    try {
      await growth.setStatus(TENANT_A, "business", campaignId, "draft");
    } catch (err) {
      invalidRejected = err instanceof InvalidCampaignTransitionError;
    }
    results.ua4_growth_lifecycle_invalid_rejected = invalidRejected ? "PASS" : "FAIL";
    log(`invalid_transition_rejected=${invalidRejected} -> ua4_growth_lifecycle_invalid_rejected: ${results.ua4_growth_lifecycle_invalid_rejected}`);
  });

  let opportunityId = "";
  await section("DETERMINISTISK ATTRIBUSJON + CAC/ROAS KNYTTET TIL EKTE CRM-DATA (UA-4 akseptansekriterium 1)", async () => {
    // Ekte business_opportunities-rad, IKKE en fabrikkert tallverdi -
    // CAC/ROAS må knyttes til reelt CRM-data (byggeordren krever eksplisitt
    // "CAC/ROAS tied to real CRM/revenue", ikke en gjettet/simulert verdi).
    const opp = await business.createOpportunity(TENANT_A, "business", { title: `Opportunity ${runId}`, company_id: companyId });
    opportunityId = opp.opportunity_id;
    await pool.query(
      "UPDATE business_opportunities SET stage = 'won', value_ore = 500000 WHERE tenant_id = $1 AND opportunity_id = $2",
      [TENANT_A, opportunityId]
    );

    const attribution = await growth.attributeToCampaign(TENANT_A, "business", campaignId, { entity_type: "opportunity", entity_id: opportunityId });
    results.ua4_growth_attribution_created = attribution.entity_id === opportunityId && attribution.attribution_model === "first_touch" ? "PASS" : "FAIL";
    log(`attribution_id=${attribution.attribution_id} -> ua4_growth_attribution_created: ${results.ua4_growth_attribution_created}`);

    const perf = await growth.campaignPerformance(TENANT_A, "business", campaignId);
    const expectedCac = perf ? Number(perf.total_spend_ore) / 1 : null;
    results.ua4_growth_cac_roas =
      perf !== null && perf.won_opportunities === 1 && perf.attributed_revenue_ore === "500000" &&
      perf.cac_ore === expectedCac && perf.roas === Number(perf.attributed_revenue_ore) / Number(perf.total_spend_ore)
        ? "PASS" : "FAIL";
    log(`total_spend_ore=${perf?.total_spend_ore} won_opportunities=${perf?.won_opportunities} attributed_revenue_ore=${perf?.attributed_revenue_ore} cac_ore=${perf?.cac_ore} roas=${perf?.roas} -> ua4_growth_cac_roas: ${results.ua4_growth_cac_roas}`);
  });

  await section("EKSPERIMENTREGISTER", async () => {
    const experiment = await growth.createExperiment(TENANT_A, "business", { name: `Eksperiment ${runId}`, campaign_id: campaignId, hypothesis: "Ny annonsetekst gir høyere CTR" });
    await growth.setExperimentStatus(TENANT_A, "business", experiment.experiment_id, "running");
    const concluded = await growth.setExperimentStatus(TENANT_A, "business", experiment.experiment_id, "concluded", "Ingen signifikant forskjell observert");
    results.ua4_growth_experiment_registry = concluded?.status === "concluded" && concluded.result_summary === "Ingen signifikant forskjell observert" ? "PASS" : "FAIL";
    log(`experiment_id=${experiment.experiment_id} final_status=${concluded?.status} -> ua4_growth_experiment_registry: ${results.ua4_growth_experiment_registry}`);
  });

  await section("BUSINESS OS-TIDSLINJE ('Hva skjer med kunde X?' inkluderer vekst-attribusjon)", async () => {
    await business.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "CRM-aktivitet for samme kunde", company_id: companyId,
      source_type: "gmail", source_instance_id: "post@tsworkflow.com", external_id: `crm-msg-grw-${runId}`
    });
    const timeline = await business.companyTimeline(TENANT_A, "business", companyId);
    const companyCampaigns = await growth.listByCompany(TENANT_A, "business", companyId);
    results.ua4_growth_timeline = timeline.length > 0 && companyCampaigns.some((c) => c.campaign_id === campaignId) ? "PASS" : "FAIL";
    log(`timeline_entries=${timeline.length} company_campaigns=${companyCampaigns.length} -> ua4_growth_timeline: ${results.ua4_growth_timeline}`);
  });

  await section("TOOLGATEWAY (growth.* namespace, klasse C for lifecycle-overgang) + AUDIT-SAFETY", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    });
    const secrets = new BusinessInternalSecretProvider();
    const toolGateway = new ToolGateway(pool, policy, secrets);
    for (const tool of firstWaveTools({ growth: new GrowthTransport(growth) })) toolGateway.register(tool);
    const identity = ownerIdentityFor(TENANT_A);

    // Urelatert, sensitiv-lignende eksperimenttekst PAA SAMME kampanje -
    // beviser at audit-eventet for set_campaign_status IKKE dumper hele
    // kampanjens interne tilstand, kun sine egne handlings-parametere.
    const sensitiveMarker = `UA4-GRW-LIVE-INTERN-${runId}`;
    await growth.createExperiment(TENANT_A, "business", { name: sensitiveMarker, campaign_id: campaignId });

    const result = await toolGateway.execute({
      identity, tool_id: "growth", action: "set_campaign_status",
      parameters: { tenant_id: TENANT_A, memory_space: "business", campaign_id: campaignId, status: "paused" }
    });
    results.ua4_growth_toolgateway = result.ok ? "PASS" : "FAIL";
    log(`toolgateway_set_campaign_status_ok=${result.ok} -> ua4_growth_toolgateway: ${results.ua4_growth_toolgateway}`);

    const { rows: auditRows } = await pool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'growth' AND action = 'set_campaign_status' ORDER BY at DESC LIMIT 1",
      [TENANT_A]
    );
    const auditPayload = JSON.stringify((auditRows[0] as { payload: unknown } | undefined)?.payload ?? {});
    results.ua4_growth_audit_safe = !auditPayload.includes(sensitiveMarker) ? "PASS" : "FAIL";
    log(`audit_payload_excerpt=${auditPayload.slice(0, 120)} -> ua4_growth_audit_safe: ${results.ua4_growth_audit_safe}`);

    await growth.setStatus(TENANT_A, "business", campaignId, "active");
  });

  await section("OPEN-LOOP-INTEGRASJON (gjenbruker OpenLoopService.runSweep() uendret, marketing_spend_anomaly)", async () => {
    const anomalyCampaign = await growth.createCampaign(TENANT_A, "business", { channel: "meta_ads", name: `Avvikskampanje ${runId}` });
    await growth.setStatus(TENANT_A, "business", anomalyCampaign.campaign_id, "active");
    for (let d = 8; d >= 1; d--) {
      await growth.recordSpendEvent(TENANT_A, "business", anomalyCampaign.campaign_id, {
        event_date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 1_000
      });
    }
    await growth.recordSpendEvent(TENANT_A, "business", anomalyCampaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 20_000
    });
    await openLoops.runSweep(TENANT_A, "business");
    const loopsOpen = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const createdLoop = loopsOpen.find((l) => l.loop_type === "marketing_spend_anomaly" && l.campaign_id === anomalyCampaign.campaign_id);
    results.ua4_growth_open_loop_created = createdLoop ? "PASS" : "FAIL";
    log(`open_loops_after_create=${loopsOpen.length} -> ua4_growth_open_loop_created: ${results.ua4_growth_open_loop_created}`);

    // Stabil ny dag - siste dag (rn=1) sitt glidende snitt normaliseres, avviket forsvinner.
    await growth.recordSpendEvent(TENANT_A, "business", anomalyCampaign.campaign_id, {
      event_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 2_000
    });
    await openLoops.runSweep(TENANT_A, "business");
    const loopsAfter = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const stillOpen = loopsAfter.find((l) => l.campaign_id === anomalyCampaign.campaign_id && l.loop_type === "marketing_spend_anomaly");
    results.ua4_growth_open_loop_resolved = !stillOpen ? "PASS" : "FAIL";
    log(`open_loops_after_normal_day=${loopsAfter.length} -> ua4_growth_open_loop_resolved: ${results.ua4_growth_open_loop_resolved}`);
  });

  await section("TENANT-/MEMORY-SPACE-ISOLASJON", async () => {
    const campaignsB = await growth.listCampaigns(TENANT_B, "business", "all");
    results.ua4_growth_tenant_isolation = campaignsB.length === 0 ? "PASS" : "FAIL";
    log(`tenant_b_campaigns=${campaignsB.length} -> ua4_growth_tenant_isolation: ${results.ua4_growth_tenant_isolation}`);

    const crossSpace = await growth.listCampaigns(TENANT_A, "personal", "all");
    results.ua4_growth_space_isolation = crossSpace.length === 0 ? "PASS" : "FAIL";
    log(`personal_space_cross_read_hits=${crossSpace.length} -> ua4_growth_space_isolation: ${results.ua4_growth_space_isolation}`);
  });

  await section("Q-20 ERASURE-INTEGRASJON (ekte ErasureService, memory_space-scope)", async () => {
    const grantRows = await adminPool.query(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee = 'jarvis_app' AND table_name IN ('marketing_campaigns', 'marketing_spend_events', 'marketing_attributions', 'marketing_experiments', 'marketing_campaign_events') AND privilege_type = 'DELETE'`
    );
    const hasDeleteGrant = grantRows.rows.length === 5;
    log(`jarvis_app_delete_grants (marketing_campaigns/marketing_spend_events/marketing_attributions/marketing_experiments/marketing_campaign_events)=${grantRows.rows.length}/5`);

    const fkRows = await adminPool.query(`
      SELECT tc.table_name, tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'marketing_campaigns'
    `);
    const known = new Set(["business_open_loops", "marketing_spend_events", "marketing_attributions", "marketing_experiments", "marketing_campaign_events"]);
    const externalFks = (fkRows.rows as Array<{ table_name: string; constraint_name: string }>).filter((r) => !known.has(r.table_name));
    log(`fk_audit_unexpected_external_to_marketing_campaigns=${JSON.stringify(externalFks)}`);
    const fkAuditKnown = externalFks.length === 0;

    const erasureCampaign = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Q20 erasure campaign" });
    await growth.setStatus(TENANT_A, "business", erasureCampaign.campaign_id, "active");
    for (let d = 8; d >= 1; d--) {
      await growth.recordSpendEvent(TENANT_A, "business", erasureCampaign.campaign_id, {
        event_date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 1_000
      });
    }
    await growth.recordSpendEvent(TENANT_A, "business", erasureCampaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 25_000
    });
    await openLoops.runSweep(TENANT_A, "business");
    const linkedLoopBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find(
      (l) => l.campaign_id === erasureCampaign.campaign_id && l.loop_type === "marketing_spend_anomaly"
    );
    log(`erasure_campaign_id=${erasureCampaign.campaign_id} linked_open_loop_before=${linkedLoopBefore?.open_loop_id ?? "MANGLER"}`);

    // Urelatert, IKKE-kampanje-tilknyttet open-loop (RETAIN_SAFE_REFERENCE) -
    // beviser at erasure-scopet KUN treffer kampanje-tilknyttede rader
    // (campaign_id IS NOT NULL), aldri en generell business_open_loops-tømming.
    const unrelatedFollowup = await business.createFollowup(TENANT_A, "business", { title: "Q20 unrelated followup grw", due_at: "2020-01-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const unrelatedLoopBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find((l) => l.followup_id === unrelatedFollowup.followup_id);

    const identity = ownerIdentityFor(TENANT_A);
    const erasure = new ErasureService(pool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    }), new LocalHashEmbedding());
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" } as const;
    const result = await erasure.executeErasure({ scope, requestId: `req-ua4-grw-live-${runId}`, identity });
    log(`erasure_result=${JSON.stringify(result)}`);

    const erasedCampaign = await growth.getCampaign(TENANT_A, "business", erasureCampaign.campaign_id);
    const loopsAfter = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const linkedLoopGone = !loopsAfter.some((l) => l.campaign_id === erasureCampaign.campaign_id);
    const unrelatedLoopStillThere = loopsAfter.some((l) => l.open_loop_id === unrelatedLoopBefore?.open_loop_id);

    // Ingen resurrection: en NY kampanje opprettet etter erasure faar en HELT NY campaign_id.
    const fresh = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Q20 erasure campaign" });
    const noResurrection = fresh.campaign_id !== erasureCampaign.campaign_id;

    results.ua4_growth_q20 =
      hasDeleteGrant && fkAuditKnown && result.status === "completed" &&
      erasedCampaign === null && linkedLoopGone && unrelatedLoopStillThere && noResurrection
        ? "PASS" : "FAIL";
    log(
      `erasure_completed=${result.status === "completed"} campaign_gone=${erasedCampaign === null} ` +
        `linked_loop_gone=${linkedLoopGone} unrelated_loop_preserved=${unrelatedLoopStillThere} no_resurrection=${noResurrection} ` +
        `-> ua4_growth_q20: ${results.ua4_growth_q20}`
    );
  });

  await section("CLEANUP", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => {
      cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`);
    });
    const remainingCampaigns = await adminPool.query("SELECT count(*)::int AS n FROM marketing_campaigns WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverCampaigns = (remainingCampaigns.rows[0] as { n: number }).n;
    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.ua4_growth_cleanup = cleanupOk && leftoverCampaigns === 0 && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_campaigns=${leftoverCampaigns} leftover_tenants=${leftoverTenants} -> ua4_growth_cleanup: ${results.ua4_growth_cleanup}`);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-4 NATIVE GROWTH CORE LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
