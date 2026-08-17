// UA-3 P0 (Business Domain Foundation) HOST LIVE ACCEPTANCE - kjøres AV TOBIAS
// mot ekte lokal Postgres (docker-compose). Gjenbruker KUN eksisterende
// arkitektur (@jarvis/business, @jarvis/core, @jarvis/policy, @jarvis/tool-gateway)
// - ingen alternativ testimplementasjon. Speiler strukturen i
// modules/erasure/scripts/q20-erasure-live.ts (samme log()/section()/Verdict-mønster).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-business-live.ts
// (normalt via modules/business/scripts/ua3-host-run.ts, som bootstrapper workspacet først)
//
// Bruker UTELUKKENDE syntetiske test-selskaper/kontakter/leads/opportunities
// i en isolert, kjøre-unik tenant (tenant-ua3-live-<run_id>-a/-b) - RØRER
// ALDRI ekte kunde-/forretningsdata. All test-scaffolding fjernes ved slutten (§CLEANUP).

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport } from "@jarvis/business";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  ua3_company_contact: "FAIL",
  ua3_lead_idempotent: "FAIL",
  ua3_opportunity_pipeline: "FAIL",
  ua3_activity_timeline: "FAIL",
  ua3_activity_idempotent: "FAIL",
  ua3_followup_lifecycle: "FAIL",
  ua3_followup_overdue: "FAIL",
  ua3_metrics: "FAIL",
  ua3_tenant_isolation: "FAIL",
  ua3_space_isolation: "FAIL",
  ua3_toolgateway_wiring: "FAIL",
  ua3_audit_no_sensitive_content: "FAIL"
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
log(`UA-3 P0 LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());

const TENANT_A = `tenant-ua3-live-${runId}-a`;
const TENANT_B = `tenant-ua3-live-${runId}-b`; // §tenant-isolation: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua3-live-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-ua3-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await pool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM business_opportunities WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM business_leads WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await pool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua3-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await cleanupTenant(row.tenant_id).catch(() => undefined);
    }
    await pool.query("DELETE FROM people WHERE person_id LIKE 'person-ua3-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  // ===== §Q-21 RUNTIME ROLE (Business OS er bygget PÅ Q-21, ikke i stedet for) =====
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    log(`q21_runtime_role_safe=PASS role=${status.role}`);
  });
  if (!runtimeRoleSafe) {
    log("\nUA-3 KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await selfHeal();
  await pool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-3 Live A ${runId}`, TENANT_B, `UA-3 Live B ${runId}`
  ]);
  await pool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "UA-3 Live Owner"]);
  await pool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await pool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua3-a-business-${runId}`, TENANT_A, `ms-ua3-a-personal-${runId}`, TENANT_A, `ms-ua3-b-business-${runId}`, TENANT_B]
  );

  const service = new BusinessService(pool);
  let companyId = "";
  let opportunityId = "";
  let followupId = "";

  await section("SELSKAP/KONTAKT (syntetisk)", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: `Syntetisk AS ${runId}` });
    companyId = company.company_id;
    const contact = await service.createContact(TENANT_A, "business", {
      name: "Test Testesen", email: `test-${runId}@example.invalid`, company_id: companyId
    });
    results.ua3_company_contact = contact.company_id === companyId ? "PASS" : "FAIL";
    log(`company_id=${companyId} contact.company_id=${contact.company_id} -> ua3_company_contact: ${results.ua3_company_contact}`);
  });

  await section("LEAD - IDEMPOTENT INGESTION", async () => {
    const first = await service.createLead(TENANT_A, "business", {
      title: "Syntetisk lead", company_id: companyId, source_type: "ua3-live", source_instance_id: `run-${runId}`, external_id: "lead-1"
    });
    const second = await service.createLead(TENANT_A, "business", {
      title: "Syntetisk lead (duplikat-hendelse)", company_id: companyId, source_type: "ua3-live", source_instance_id: `run-${runId}`, external_id: "lead-1"
    });
    results.ua3_lead_idempotent = first.lead_id === second.lead_id ? "PASS" : "FAIL";
    log(`lead_id_first=${first.lead_id} lead_id_second=${second.lead_id} -> ua3_lead_idempotent: ${results.ua3_lead_idempotent}`);
  });

  await section("OPPORTUNITY - PIPELINE-STADIER", async () => {
    const opp = await service.createOpportunity(TENANT_A, "business", { title: "Syntetisk deal", company_id: companyId, value_ore: 1_000_00 });
    opportunityId = opp.opportunity_id;
    const qualified = await service.updateOpportunityStage(TENANT_A, "business", opportunityId, "qualified");
    const won = await service.updateOpportunityStage(TENANT_A, "business", opportunityId, "won");
    results.ua3_opportunity_pipeline = qualified?.stage === "qualified" && won?.stage === "won" ? "PASS" : "FAIL";
    log(`stage_after_qualify=${qualified?.stage} stage_after_won=${won?.stage} -> ua3_opportunity_pipeline: ${results.ua3_opportunity_pipeline}`);
  });

  await section("AKTIVITETSTIDSLINJE + IDEMPOTENT INGESTION", async () => {
    await service.recordActivity(TENANT_A, "business", { activity_type: "note", summary: "Første kontakt", company_id: companyId });
    const first = await service.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "E-post mottatt", company_id: companyId, source_type: "ua3-live", source_instance_id: `run-${runId}`, external_id: "act-1"
    });
    const second = await service.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "E-post mottatt (re-sync)", company_id: companyId, source_type: "ua3-live", source_instance_id: `run-${runId}`, external_id: "act-1"
    });
    results.ua3_activity_idempotent = first.activity_id === second.activity_id ? "PASS" : "FAIL";
    const timeline = await service.companyTimeline(TENANT_A, "business", companyId);
    results.ua3_activity_timeline = timeline.length === 2 ? "PASS" : "FAIL";
    log(`timeline_length=${timeline.length} -> ua3_activity_timeline: ${results.ua3_activity_timeline}, ua3_activity_idempotent: ${results.ua3_activity_idempotent}`);
  });

  await section("OPPFOELGING - LIVSSYKLUS + FORFALT-SPØRRING", async () => {
    const overdueFollowup = await service.createFollowup(TENANT_A, "business", {
      title: "Syntetisk forfalt oppfoelging", due_at: "2020-01-01T00:00:00Z", company_id: companyId, opportunity_id: opportunityId
    });
    followupId = overdueFollowup.followup_id;
    const futureFollowup = await service.createFollowup(TENANT_A, "business", { title: "Syntetisk fremtidig oppfoelging", due_at: "2099-01-01T00:00:00Z" });
    const completed = await service.completeFollowup(TENANT_A, "business", followupId);
    results.ua3_followup_lifecycle = completed?.status === "completed" ? "PASS" : "FAIL";

    const secondFollowup = await service.createFollowup(TENANT_A, "business", { title: "Forfalt (aapen)", due_at: "2020-01-01T00:00:00Z" });
    const overdue = await service.overdueFollowups(TENANT_A, "business");
    const overdueIds = overdue.map((f) => f.followup_id);
    results.ua3_followup_overdue =
      overdueIds.includes(secondFollowup.followup_id) && !overdueIds.includes(followupId) && !overdueIds.includes(futureFollowup.followup_id)
        ? "PASS" : "FAIL";
    log(`completed_status=${completed?.status} overdue_count=${overdue.length} -> ua3_followup_lifecycle: ${results.ua3_followup_lifecycle}, ua3_followup_overdue: ${results.ua3_followup_overdue}`);
  });

  await section("METRIKKER", async () => {
    const metrics = await service.metrics(TENANT_A, "business");
    results.ua3_metrics = metrics.active_opportunities >= 0 && metrics.overdue_followups >= 1 ? "PASS" : "FAIL";
    log(`metrics=${JSON.stringify(metrics)} -> ua3_metrics: ${results.ua3_metrics}`);
  });

  await section("TENANT-ISOLASJON (RLS)", async () => {
    const metricsB = await service.metrics(TENANT_B, "business");
    const crossRead = await service.companyTimeline(TENANT_B, "business", companyId);
    results.ua3_tenant_isolation = metricsB.open_leads === 0 && crossRead.length === 0 ? "PASS" : "FAIL";
    log(`tenant_b_open_leads=${metricsB.open_leads} tenant_b_cross_timeline_hits=${crossRead.length} -> ua3_tenant_isolation: ${results.ua3_tenant_isolation}`);
  });

  await section("MEMORY-SPACE-ISOLASJON", async () => {
    const crossSpace = await service.companyTimeline(TENANT_A, "personal", companyId);
    results.ua3_space_isolation = crossSpace.length === 0 ? "PASS" : "FAIL";
    log(`personal_space_cross_read_hits=${crossSpace.length} -> ua3_space_isolation: ${results.ua3_space_isolation}`);
  });

  await section("TOOLGATEWAY-WIRING + AUDIT (normal runtime-bane, ikke direkte service-kall)", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(),
      nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    });
    const toolGateway = new ToolGateway(
      pool, policy,
      new FallbackSecretProvider({ name: "env-empty", get: async () => null }, new BusinessInternalSecretProvider())
    );
    for (const tool of firstWaveTools({ business: new BusinessTransport(service) })) toolGateway.register(tool);
    const identity = ownerIdentityFor(TENANT_A);
    const result = await toolGateway.execute({
      identity, tool_id: "business", action: "create_contact",
      parameters: { tenant_id: TENANT_A, memory_space: "business", name: "Live ToolGateway-kontakt", email: "live-contact@example.invalid" }
    });
    results.ua3_toolgateway_wiring = result.ok ? "PASS" : "FAIL";
    log(`toolgateway_execute_ok=${result.ok} -> ua3_toolgateway_wiring: ${results.ua3_toolgateway_wiring}`);

    const { rows } = await pool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'create_contact' ORDER BY at DESC LIMIT 1",
      [TENANT_A]
    );
    const payload = JSON.stringify((rows[0] as { payload: unknown } | undefined)?.payload ?? {});
    results.ua3_audit_no_sensitive_content =
      !payload.includes("Live ToolGateway-kontakt") && !payload.includes("live-contact@example.invalid") ? "PASS" : "FAIL";
    log(`audit_payload_excerpt=${payload.slice(0, 120)} -> ua3_audit_no_sensitive_content: ${results.ua3_audit_no_sensitive_content}`);
  });

  await section("CLEANUP", async () => {
    await cleanupTenant(TENANT_A).catch((err: unknown) => log(`cleanup A feilet: ${(err as Error).message}`));
    await cleanupTenant(TENANT_B).catch((err: unknown) => log(`cleanup B feilet: ${(err as Error).message}`));
    await pool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch(() => undefined);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-3 P0 LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) {
    log(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(diagnostics)) {
    log(`${key}=${value}`);
  }
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
} finally {
  await pool.end();
}
