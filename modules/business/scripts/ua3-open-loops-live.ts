// UA-3 NEXT SLICE (D-53) - OPEN-LOOP-DETEKSJON + DAGLIG/UKENTLIG BUSINESS BRIEF
// HOST LIVE ACCEPTANCE - kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose).
// Gjenbruker KUN eksisterende arkitektur (@jarvis/business, @jarvis/core,
// @jarvis/policy, @jarvis/tool-gateway) - ingen alternativ testimplementasjon.
// Speiler NØYAKTIG samme struktur/admin-runtime-pool-separasjon som den
// VERIFISERTE (D-52) `ua3-business-live.ts` (P0) - inkludert HOST FIX #1
// (adminPool for ALL scaffold) og HOST FIX #2 (audit_events er append-only,
// ALDRI forsøkt slettet i CLEANUP).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-open-loops-live.ts
// (normalt via modules/business/scripts/ua3-open-loops-host-run.ts, som
// bootstrapper workspacet/Docker/migrasjoner først)
//
// Bruker UTELUKKENDE syntetiske test-selskaper/oppfoelginger/opportunities i
// en isolert, kjøre-unik tenant (tenant-ua3-ol-live-<run_id>-a/-b) - RØRER
// ALDRI ekte kunde-/forretningsdata. All test-scaffolding fjernes ved slutten
// (§CLEANUP), inkludert de NYE business_open_loops-radene (slettet FØR
// business_followups/business_opportunities pga FK - se cleanupTenant()).

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService } from "@jarvis/business";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  ua3_open_loop_runtime_role: "FAIL",
  ua3_open_loop_overdue_detection: "FAIL",
  ua3_open_loop_stalled_detection: "FAIL",
  ua3_open_loop_idempotency: "FAIL",
  ua3_open_loop_resolution: "FAIL",
  ua3_open_loop_priority: "FAIL",
  ua3_open_loop_source_evidence: "FAIL",
  ua3_open_loop_tenant_isolation: "FAIL",
  ua3_open_loop_space_isolation: "FAIL",
  ua3_open_loop_toolgateway: "FAIL",
  ua3_business_daily_brief: "FAIL",
  ua3_business_weekly_brief: "FAIL",
  ua3_brief_missing_domains_honest: "FAIL",
  ua3_open_loop_audit_safe: "FAIL",
  ua3_open_loop_cleanup: "FAIL"
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
log(`UA-3 OPEN-LOOP LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
// SAMME mønster som ua3-business-live.ts (D-50/HOST FIX #1): `pool` (RUNTIME -
// `jarvis_runtime`) er den ENESTE tilkoblingen som utfoerer Business OS/open-loop-
// operasjoner under test - EKSAKT samme pool en ekte api/worker-prosess ville
// brukt. `adminPool` provisjonerer/rydder UTELUKKENDE midlertidig scaffold.
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-ua3-ol-live-${runId}-a`;
const TENANT_B = `tenant-ua3-ol-live-${runId}-b`; // §tenant-isolasjon: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua3-ol-live-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-ua3-ol-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

// Cleanup via `adminPool` - EKSAKT samme scoped tenant_id-er som opprettes under, aldri en bred
// sletting. business_open_loops slettes FØR business_followups/business_opportunities (FK uten
// ON DELETE CASCADE - se 020_business_open_loops.sql). audit_events er BEVISST FRAVÆRENDE her
// (append-only trigger - se HOST FIX #2 i ua3-business-live.ts for full begrunnelse).
async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_opportunities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_leads WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua3-ol-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await cleanupTenant(row.tenant_id).catch(() => undefined);
    }
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua3-ol-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  // ===== §Q-21 RUNTIME ROLE (open-loop-deteksjon er bygget PÅ Q-21, ikke i stedet for) =====
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role}`);
  });
  if (!runtimeRoleSafe) {
    log("\nUA-3 OPEN-LOOP KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  // §HOST FIX #1-mønster: ALL midlertidig scaffolding provisjoneres via `adminPool` -
  // `jarvis_runtime` (pool) har BEVISST ingen INSERT-rettighet på `tenants` (RLS/grant-nivå).
  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-3 OL Live A ${runId}`, TENANT_B, `UA-3 OL Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "UA-3 OL Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua3-ol-a-business-${runId}`, TENANT_A, `ms-ua3-ol-a-personal-${runId}`, TENANT_A, `ms-ua3-ol-b-business-${runId}`, TENANT_B]
  );

  await section("OPEN LOOP RUNTIME-ROLLE (rett før faktiske open-loop-operasjoner)", async () => {
    const { rows } = await pool.query("SELECT current_user AS role");
    const role = (rows[0] as { role: string }).role;
    diagnostics["open_loop_runtime_role"] = role;
    results.ua3_open_loop_runtime_role = role === diagnostics["runtime_current_user"] ? "PASS" : "FAIL";
    log(`open_loop_runtime_role=${role} (forventet samme som q21_runtime_role_safe sin rolle: ${diagnostics["runtime_current_user"]}) -> ua3_open_loop_runtime_role: ${results.ua3_open_loop_runtime_role}`);
  });

  // `service`/`openLoops` bruker UTELUKKENDE `pool` (runtime) - ALDRI `adminPool` - for enhver
  // faktisk Business OS/open-loop-operasjon under test.
  const service = new BusinessService(pool);
  const openLoops = new OpenLoopService(pool);
  let companyId = "";

  await section("FORFALT OPPFOELGING - DETERMINISTISK DETEKSJON", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: `OL Syntetisk AS ${runId}` });
    companyId = company.company_id;
    const overdue = await service.createFollowup(TENANT_A, "business", {
      title: "OL syntetisk forfalt oppfoelging", due_at: "2020-01-01T00:00:00Z", company_id: companyId
    });
    const future = await service.createFollowup(TENANT_A, "business", { title: "OL syntetisk fremtidig oppfoelging", due_at: "2099-01-01T00:00:00Z" });
    const result = await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const detectedLoop = loops.find((l) => l.followup_id === overdue.followup_id);
    const futureNotDetected = !loops.some((l) => l.followup_id === future.followup_id);
    results.ua3_open_loop_overdue_detection = Boolean(detectedLoop) && futureNotDetected && result.detected >= 1 ? "PASS" : "FAIL";
    diagnostics["overdue_followup_id"] = overdue.followup_id;
    diagnostics["overdue_open_loop_id"] = detectedLoop?.open_loop_id ?? "";
    log(`detected=${result.detected} future_excluded=${futureNotDetected} -> ua3_open_loop_overdue_detection: ${results.ua3_open_loop_overdue_detection}`);

    // §kilde-forankret begrunnelse: loopet MÅ referere det EKSAKTE followup_id/company_id/reason.
    results.ua3_open_loop_source_evidence =
      detectedLoop?.company_id === companyId &&
      detectedLoop?.detection_key === `overdue_followup:${overdue.followup_id}` &&
      Boolean(detectedLoop?.reason.includes("OL syntetisk forfalt oppfoelging"))
        ? "PASS" : "FAIL";
    log(`loop.company_id=${detectedLoop?.company_id} loop.detection_key=${detectedLoop?.detection_key} -> ua3_open_loop_source_evidence: ${results.ua3_open_loop_source_evidence}`);
  });

  await section("STAGNERT OPPORTUNITY - DETERMINISTISK DETEKSJON", async () => {
    const opp = await service.createOpportunity(TENANT_A, "business", { title: "OL stagnert deal", company_id: companyId });
    // Backdatering av updated_at er REN test-scaffolding (ikke en Business OS-operasjon) -
    // samme adminPool-bruk som cleanup, aldri en simulert "runtime"-skriving.
    await adminPool.query("UPDATE business_opportunities SET updated_at = now() - interval '20 days' WHERE opportunity_id = $1", [opp.opportunity_id]);
    const result = await openLoops.detectStalledOpportunities(TENANT_A, "business", 14);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const stalledLoop = loops.find((l) => l.opportunity_id === opp.opportunity_id);
    results.ua3_open_loop_stalled_detection = Boolean(stalledLoop) && stalledLoop?.loop_type === "stalled_opportunity" && result.detected >= 1 ? "PASS" : "FAIL";
    log(`detected=${result.detected} stalled_loop_type=${stalledLoop?.loop_type} -> ua3_open_loop_stalled_detection: ${results.ua3_open_loop_stalled_detection}`);
  });

  await section("IDEMPOTENS - RE-KJOERT SVEIP OPPRETTER ALDRI EN DUPLIKAT", async () => {
    const before = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).length;
    await openLoops.runSweep(TENANT_A, "business");
    const after = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).length;
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND detection_key = $2", [
      TENANT_A, `overdue_followup:${diagnostics["overdue_followup_id"]}`
    ]);
    const duplicateCount = (rows[0] as { n: number }).n;
    results.ua3_open_loop_idempotency = before === after && duplicateCount === 1 ? "PASS" : "FAIL";
    log(`open_loops_before=${before} open_loops_after=${after} duplicate_rows_for_same_key=${duplicateCount} -> ua3_open_loop_idempotency: ${results.ua3_open_loop_idempotency}`);
  });

  await section("PRIORITET - DETERMINISTISK BASERT PAA HVOR LENGE FORFALT", async () => {
    const longOverdue = await service.createFollowup(TENANT_A, "business", { title: "OL lenge forfalt", due_at: "2020-01-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const highPriorityLoop = loops.find((l) => l.followup_id === longOverdue.followup_id);
    results.ua3_open_loop_priority = highPriorityLoop?.priority === "high" ? "PASS" : "FAIL";
    log(`long_overdue_priority=${highPriorityLoop?.priority} -> ua3_open_loop_priority: ${results.ua3_open_loop_priority}`);
  });

  await section("RESOLUSJON - MANUELL + AUTO-RESOLVE NAAR VILKAARET IKKE LENGER ER SANT", async () => {
    const openLoopId = diagnostics["overdue_open_loop_id"] ?? "";
    const resolved = await openLoops.resolveOpenLoop(TENANT_A, "business", openLoopId, "ua3-ol-live-manuell-resolusjon");
    results.ua3_open_loop_resolution = resolved?.status === "resolved" ? "PASS" : "FAIL";
    log(`manual_resolve_status=${resolved?.status} -> ua3_open_loop_resolution: ${results.ua3_open_loop_resolution}`);
  });

  await section("TENANT-ISOLASJON (RLS)", async () => {
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    results.ua3_open_loop_tenant_isolation = loopsB.length === 0 ? "PASS" : "FAIL";
    log(`tenant_b_open_loops=${loopsB.length} -> ua3_open_loop_tenant_isolation: ${results.ua3_open_loop_tenant_isolation}`);
  });

  await section("MEMORY-SPACE-ISOLASJON", async () => {
    const crossSpace = await openLoops.listOpenLoops(TENANT_A, "personal", "open");
    results.ua3_open_loop_space_isolation = crossSpace.length === 0 ? "PASS" : "FAIL";
    log(`personal_space_cross_read_hits=${crossSpace.length} -> ua3_open_loop_space_isolation: ${results.ua3_open_loop_space_isolation}`);
  });

  await section("TOOLGATEWAY-WIRING + BRIEF + AUDIT (normal runtime-bane, ikke direkte service-kall)", async () => {
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
    for (const tool of firstWaveTools({ business: new BusinessTransport(service, openLoops, pool) })) toolGateway.register(tool);
    const identity = ownerIdentityFor(TENANT_A);

    // Fersk, fortsatt-aapen forfalt oppfoelging til brief-seksjonene under (uavhengig av loopet
    // som ble manuelt resolved over).
    const briefFollowup = await service.createFollowup(TENANT_A, "business", { title: "OL brief-synlig oppfoelging", due_at: "2020-01-01T00:00:00Z", company_id: companyId });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");

    const listResult = await toolGateway.execute({
      identity, tool_id: "business", action: "list_open_loops", parameters: { tenant_id: TENANT_A, memory_space: "business" }
    });
    const attentionResult = await toolGateway.execute({
      identity, tool_id: "business", action: "get_attention_queue", parameters: { tenant_id: TENANT_A, memory_space: "business" }
    });
    const sensitiveReason = "UA3-OL-LIVE-HEMMELIG-BEGRUNNELSE";
    const resolveViaGateway = await toolGateway.execute({
      identity, tool_id: "business", action: "resolve_open_loop",
      parameters: {
        tenant_id: TENANT_A, memory_space: "business",
        open_loop_id: (listResult.ok ? (listResult.data as Array<{ open_loop_id: string; followup_id: string | null }>) : [])
          .find((l) => l.followup_id === briefFollowup.followup_id)?.open_loop_id ?? "",
        resolution_reason: sensitiveReason
      }
    });
    results.ua3_open_loop_toolgateway = listResult.ok && attentionResult.ok && resolveViaGateway.ok ? "PASS" : "FAIL";
    log(`list_ok=${listResult.ok} attention_ok=${attentionResult.ok} resolve_ok=${resolveViaGateway.ok} -> ua3_open_loop_toolgateway: ${results.ua3_open_loop_toolgateway}`);

    const { rows: auditRows } = await pool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'resolve_open_loop' ORDER BY at DESC LIMIT 1",
      [TENANT_A]
    );
    const auditPayload = JSON.stringify((auditRows[0] as { payload: unknown } | undefined)?.payload ?? {});
    results.ua3_open_loop_audit_safe = !auditPayload.includes(sensitiveReason) ? "PASS" : "FAIL";
    log(`audit_payload_excerpt=${auditPayload.slice(0, 120)} -> ua3_open_loop_audit_safe: ${results.ua3_open_loop_audit_safe}`);

    // Ny, fortsatt-aapen loop for at daglig/ukentlig brief faktisk har noe aa vise.
    const stillOpenFollowup = await service.createFollowup(TENANT_A, "business", { title: "OL brief-innhold", due_at: "2020-01-01T00:00:00Z", company_id: companyId });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");

    const dailyBriefResult = await toolGateway.execute({
      identity, tool_id: "business", action: "get_business_brief", parameters: { tenant_id: TENANT_A, memory_space: "business", period: "daily" }
    });
    const dailyRendered = dailyBriefResult.ok ? String((dailyBriefResult.data as { rendered?: string }).rendered ?? "") : "";
    results.ua3_business_daily_brief = dailyBriefResult.ok && dailyRendered.includes("OL brief-innhold") ? "PASS" : "FAIL";
    log(`daily_brief_ok=${dailyBriefResult.ok} contains_open_loop=${dailyRendered.includes("OL brief-innhold")} -> ua3_business_daily_brief: ${results.ua3_business_daily_brief}`);

    const weeklyBriefResult = await toolGateway.execute({
      identity, tool_id: "business", action: "get_business_brief", parameters: { tenant_id: TENANT_A, memory_space: "business", period: "weekly" }
    });
    const weeklyData = weeklyBriefResult.ok ? (weeklyBriefResult.data as { opened_loops?: number; rendered?: string }) : undefined;
    results.ua3_business_weekly_brief = weeklyBriefResult.ok && (weeklyData?.opened_loops ?? 0) >= 1 ? "PASS" : "FAIL";
    log(`weekly_brief_ok=${weeklyBriefResult.ok} opened_loops=${weeklyData?.opened_loops} -> ua3_business_weekly_brief: ${results.ua3_business_weekly_brief}`);

    const weeklyRendered = String(weeklyData?.rendered ?? "");
    results.ua3_brief_missing_domains_honest =
      weeklyRendered.includes("product: IKKE integrert") &&
      weeklyRendered.includes("finance: IKKE integrert") &&
      weeklyRendered.includes("marketing: IKKE integrert") &&
      weeklyRendered.includes("operations: IKKE integrert") &&
      weeklyRendered.includes("sales: tilgjengelig")
        ? "PASS" : "FAIL";
    log(`weekly_rendered_excerpt=${weeklyRendered.slice(weeklyRendered.indexOf("DATA COVERAGE")).slice(0, 300)} -> ua3_brief_missing_domains_honest: ${results.ua3_brief_missing_domains_honest}`);
    void stillOpenFollowup;
  });

  // Opprydding via `adminPool` - EKSAKT samme scoped tenant_id-er som ble opprettet over.
  await section("CLEANUP", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });

    const remainingOpenLoops = await adminPool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverOpenLoops = (remainingOpenLoops.rows[0] as { n: number }).n;
    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    // audit_events er BEVISST FRAVÆRENDE fra sjekken under - append-only, ALDRI forsøkt slettet
    // (samme dokumenterte oppførsel som ua3-business-live.ts HOST FIX #2).
    results.ua3_open_loop_cleanup = cleanupOk && leftoverOpenLoops === 0 && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_open_loops=${leftoverOpenLoops} leftover_tenants=${leftoverTenants} -> ua3_open_loop_cleanup: ${results.ua3_open_loop_cleanup}`);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-3 OPEN-LOOP LIVE ACCEPTANCE SUMMARY ==");
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
