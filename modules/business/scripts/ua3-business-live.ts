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
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport } from "@jarvis/business";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  ua3_business_runtime_role: "FAIL",
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
  ua3_audit_no_sensitive_content: "FAIL",
  ua3_cleanup_mutable_rows: "FAIL",
  ua3_cleanup_person_links: "FAIL",
  ua3_cleanup_tenants: "FAIL",
  ua3_cleanup_audit_retained: "FAIL",
  ua3_cleanup: "FAIL"
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
// `pool` (RUNTIME - `jarvis_runtime`, NOSUPERUSER/NOBYPASSRLS) er den ENESTE tilkoblingen som noensinne
// utfører Business OS-operasjoner under test (BusinessService/ToolGateway) - EKSAKT samme pool en
// ekte api/worker-prosess ville brukt. `adminPool` (samme adminConfigFromEnv() som migrate/q20-erasure-
// live.ts bruker - se HOST FIX #1) brukes UTELUKKENDE til å provisjonere/rydde midlertidig
// akseptanse-scaffolding (tenant/person/person_tenants/memory_spaces) - ALDRI til å bevise en
// Business OS-kapabilitet. Root cause for host-funnet (run_id b95dd25f, 42501 mot "tenants"): scaffold-
// opprettelsen brukte tidligere FEILAKTIG `pool` (runtime) - RLS nekter (korrekt) `jarvis_runtime`
// å INSERT INTO tenants, akkurat som Q-21 skal. Se D-49 HOST FIX #1.
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-ua3-live-${runId}-a`;
const TENANT_B = `tenant-ua3-live-${runId}-b`; // §tenant-isolation: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua3-live-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-ua3-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

// Test-scaffold-opprydding: gjennomfores UTELUKKENDE via `adminPool` (samme rolle som migrate/
// q20-erasure-live.ts sin cleanupTenant()) - ALDRI `pool` (runtime). Kun parameteriserte spørringer
// scopet til DENNE ene tenant_id-en - ingen TRUNCATE, ingen bred DELETE, aldri eier-tenanten
// (tenant_id kommer alltid fra TENANT_A/TENANT_B/selfHeal() sitt 'tenant-ua3-live-%'-prefiks-søk,
// aldri en fast/gjettet verdi). DELETE er iboende idempotent - en allerede slettet rad gir 0 rader
// truffet, ikke en feil - trygt å kjøre flere ganger.
//
// HOST FIX #2 (ekte host-funn run_id ad45603d): `audit_events` er BEVISST FRAVÆRENDE fra denne
// listen - `audit_events_append_only`-triggeren (004_audit_cost.sql) forbyr UPDATE/DELETE
// ubetinget, og et forsøk kastet en feil som stoppet RESTEN av denne funksjonen (tool_executions/
// memory_spaces/person_tenants/tenants ble ALDRI slettet - derfor `leftover_tenants=1` i host-
// funnet). `audit_events.tenant_id` har heller INGEN fremmednøkkel mot `tenants` (kun
// `cost_events.tenant_id` har det) - append-only-revisjonsrader for en slettet syntetisk
// akseptanse-tenant er derfor VERKEN et FK-problem for tenant-sletting NOCH noe denne funksjonen
// noensinne skal prøve å slette. Retained by design, ikke en cleanup-feil - se ua3_cleanup_audit_
// retained under.
async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_opportunities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_leads WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  // person_tenants MÅ slettes FØR tenants (FK) OG før people slettes lenger nede i CLEANUP-
  // seksjonen (samme FK - person_tenants_person_id_fkey - var host-funnets andre feilmelding,
  // en direkte følgevirkning av at denne funksjonen aldri kom hit i forrige runde).
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua3-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await cleanupTenant(row.tenant_id).catch(() => undefined);
    }
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua3-live-%'").catch(() => undefined);
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

  // §HOST FIX #1: ALL midlertidig akseptanse-scaffolding provisjoneres via `adminPool` - `jarvis_runtime`
  // (pool) har BEVISST ingen INSERT-rettighet på `tenants` (RLS/grant-nivå), akkurat som i produksjon.
  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-3 Live A ${runId}`, TENANT_B, `UA-3 Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "UA-3 Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua3-a-business-${runId}`, TENANT_A, `ms-ua3-a-personal-${runId}`, TENANT_A, `ms-ua3-b-business-${runId}`, TENANT_B]
  );

  // §5 i HOST FIX #1-ordren: eksplisitt bevis at Business OS-operasjonene under kjører gjennom RUNTIME-
  // rollen, ikke bare Q-21-sjekken FØR scaffold - samme `pool`, spurt RETT FØR den faktiske
  // forretnings-skrivingen starter (ikke bare én gang helt i toppen).
  await section("BUSINESS OS RUNTIME-ROLLE (rett før faktiske Business OS-operasjoner)", async () => {
    const { rows } = await pool.query("SELECT current_user AS role");
    const role = (rows[0] as { role: string }).role;
    diagnostics["business_runtime_role"] = role;
    results.ua3_business_runtime_role = role === diagnostics["runtime_current_user"] ? "PASS" : "FAIL";
    log(`business_runtime_role=${role} (forventet samme som q21_runtime_role_safe sin rolle: ${diagnostics["runtime_current_user"]}) -> ua3_business_runtime_role: ${results.ua3_business_runtime_role}`);
  });

  // BusinessService/ToolGateway bruker UTELUKKENDE `pool` (runtime) - ALDRI `adminPool` - for enhver
  // faktisk Business OS-operasjon under test. `adminPool` forblir isolert til scaffold/cleanup over.
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

  // Opprydding via `adminPool` - EKSAKT samme scoped tenant_id-er som ble opprettet over, ingen
  // TRUNCATE/bred sletting - kun de to run_id-suffiksede test-tenantsene over, aldri eier-tenanten.
  await section("CLEANUP", async () => {
    let mutableRowsOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { mutableRowsOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { mutableRowsOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    results.ua3_cleanup_mutable_rows = mutableRowsOk ? "PASS" : "FAIL";
    log(`cleanup_mutable_rows_ok=${mutableRowsOk} -> ua3_cleanup_mutable_rows: ${results.ua3_cleanup_mutable_rows}`);

    // person_tenants for BÅDE TENANT_A og TENANT_B slettes av cleanupTenant() over - denne
    // spørringen beviser at INGEN person_tenants-rad for denne kjøringens person/tenants står igjen
    // (§C/§D i ordren), FØR selve people-raden forsøkes slettet.
    const remainingLinks = await adminPool.query(
      "SELECT count(*)::int AS n FROM person_tenants WHERE tenant_id = ANY($1) OR person_id = $2",
      [[TENANT_A, TENANT_B], OWNER_PERSON]
    );
    const leftoverLinks = (remainingLinks.rows[0] as { n: number }).n;
    results.ua3_cleanup_person_links = leftoverLinks === 0 ? "PASS" : "FAIL";
    log(`leftover_person_tenants=${leftoverLinks} -> ua3_cleanup_person_links: ${results.ua3_cleanup_person_links}`);

    let personOk = true;
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { personOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });

    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.ua3_cleanup_tenants = personOk && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_person_ok=${personOk} leftover_tenants=${leftoverTenants} -> ua3_cleanup_tenants: ${results.ua3_cleanup_tenants}`);

    // §2/§5 i ordren: audit_events er BEVISST append-only - denne kjøringens revisjonsrader (bl.a.
    // fra TOOLGATEWAY-WIRING-seksjonen over) forblir INTAKT som lovlig revisjonshistorikk. PASS
    // betyr her "riktig oppførsel oppnådd" (retained, ALDRI forsøkt slettet), IKKE et krav om at
    // audit_events=0 for denne tenanten - se ua3_audit_no_sensitive_content for at INNHOLDET i de
    // beholdte radene fortsatt er trygt.
    const retainedAudit = await adminPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1", [TENANT_A]);
    const retainedCount = (retainedAudit.rows[0] as { n: number }).n;
    results.ua3_cleanup_audit_retained = retainedCount >= 1 ? "PASS" : "FAIL";
    log(`retained_audit_rows_tenant_a=${retainedCount} (append-only - ALDRI forsøkt slettet) -> ua3_cleanup_audit_retained: ${results.ua3_cleanup_audit_retained}`);

    results.ua3_cleanup =
      results.ua3_cleanup_mutable_rows === "PASS" &&
      results.ua3_cleanup_person_links === "PASS" &&
      results.ua3_cleanup_tenants === "PASS" &&
      results.ua3_cleanup_audit_retained === "PASS"
        ? "PASS" : "FAIL";
    log(`-> ua3_cleanup: ${results.ua3_cleanup}`);
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
  await adminPool.end();
}
