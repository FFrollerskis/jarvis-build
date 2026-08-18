// Q-27 (2026-08-18, D-65) - RLS-BLIND BUSINESS TENANT ENUMERATION FIX
// HOST LIVE ACCEPTANCE - kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose).
// Gjenbruker KUN eksisterende arkitektur (@jarvis/business, @jarvis/core) -
// ingen alternativ testimplementasjon. Speiler NØYAKTIG samme
// admin-runtime-pool-separasjon/selvdiagnostisk-FK-sperre-mønster som
// `ua3-open-loops-live.ts` og alle øvrige UA-3-host-live-scriptene.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/q27-tenant-enumeration-live.ts
// (normalt via modules/business/scripts/q27-tenant-enumeration-host-run.ts,
// som bootstrapper workspacet/Docker/migrasjoner først)
//
// Beviser BÅDE den opprinnelige bugen OG fiksen: (1) en rå spørring mot
// `tenants` under den ekte `jarvis_runtime`-rollen er FORTSATT strukturelt
// RLS-blind (viser at RLS faktisk håndheves, ikke svekket); (2) den nye
// `jarvis_list_business_tenant_ids()`-katalogfunksjonen finner de RIKTIGE
// bedrifts-tenantene under SAMME rolle; (3) alle tre produksjons-schedulere
// (`runOpenLoopSweepForAllTenants`/`runBusinessEventSyncForAllTenants`/
// `runScoringSweepForAllTenants`) faktisk oppdager syntetiske bedrifts-
// tenants via denne veien. Bruker UTELUKKENDE syntetiske,
// kjøre-unike tenants (tenant-q27-live-<run_id>-a/-b/-p) - RØRER ALDRI ekte
// kunde-/forretningsdata. All test-scaffolding fjernes ved slutten
// (§CLEANUP).

import { randomUUID } from "node:crypto";
import {
  adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool,
  listBusinessTenantIds
} from "@jarvis/core";
import {
  BusinessService, OpenLoopService, ScoringService,
  runBusinessEventSyncForAllTenants, runOpenLoopSweepForAllTenants, runScoringSweepForAllTenants
} from "@jarvis/business";
import type { BusinessEventSyncResult, BusinessEventSyncService } from "@jarvis/business";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  q27_direct_runtime_global_query_restricted: "FAIL",
  q27_catalog_business_tenants: "FAIL",
  q27_catalog_excludes_nonbusiness: "FAIL",
  q27_catalog_minimal_surface: "FAIL",
  q27_catalog_public_execute_denied: "FAIL",
  q27_catalog_runtime_execute_allowed: "FAIL",
  q27_open_loop_scheduler: "FAIL",
  q27_business_event_scheduler: "FAIL",
  q27_scoring_scheduler: "FAIL",
  q27_multiple_business_tenants: "FAIL",
  q27_tenant_isolation: "FAIL",
  q27_runtime_no_superuser: "FAIL",
  q27_runtime_no_bypassrls: "FAIL",
  q27_cleanup: "FAIL"
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
log(`Q-27 TENANT ENUMERATION LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
// SAMME mønster som ALLE tidligere UA-3-live-scripts: `pool` (RUNTIME -
// `jarvis_runtime`) er den ENESTE tilkoblingen som utfører operasjoner
// under test - EKSAKT samme pool en ekte api-prosess ville brukt.
// `adminPool` provisjonerer/rydder UTELUKKENDE midlertidig scaffold.
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-q27-live-${runId}-a`;
const TENANT_B = `tenant-q27-live-${runId}-b`;
const TENANT_PERSON = `tenant-q27-live-${runId}-p`;
const OUTSIDER_ROLE = `jarvis_q27_outsider_${runId.replace(/-/g, "")}`;

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`q27_cleanup_unsafe_identifier: "${name}"`);
  }
}

interface TenantFkBlocker {
  table: string;
  constraint: string;
  rows: number;
}

/** Selvdiagnostisk, SKJEMA-DREVET (ikke hardkodet) sjekk FØR `DELETE FROM
 * tenants` forsøkes - samme mønster som ALLE tidligere UA-3-live-scripts. */
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

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_scores WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_opportunities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_leads WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);

  const blockers = await findBlockingTenantDependencies(tenantId);
  if (blockers.length > 0) {
    for (const b of blockers) {
      log(`blocking_fk_table=${b.table} blocking_fk_name=${b.constraint} rows_for_test_tenant=${b.rows}`);
    }
    throw new Error(`q27_cleanup_blocked: ${blockers.length} uventet(e) FK-refererende tabell(er) har fortsatt rader for ${tenantId} - se blocking_fk_table-diagnostikk over`);
  }

  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-q27-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await cleanupTenant(row.tenant_id).catch(() => undefined);
    }
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-q27-live-%'").catch(() => undefined);
    await adminPool.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'jarvis_q27_outsider_%'").then(async (r) => {
      for (const row of r.rows as Array<{ rolname: string }>) {
        await adminPool.query(`DROP ROLE IF EXISTS ${row.rolname}`).catch(() => undefined);
      }
    }).catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  // ===== §Q-21 RUNTIME ROLE (Q-27 er bygget PÅ Q-21, ikke i stedet for) =====
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    results.q21_runtime_role_safe = "PASS";
    results.q27_runtime_no_superuser = status.superuser ? "FAIL" : "PASS";
    results.q27_runtime_no_bypassrls = status.bypassrls ? "FAIL" : "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nQ-27 KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business'), ($5,$6,'person')", [
    TENANT_A, `Q27 Live A ${runId}`, TENANT_B, `Q27 Live B ${runId}`, TENANT_PERSON, `Q27 Live Person ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [`person-q27-live-${runId}`, "Q27 Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3), ($1,$4)", [
    `person-q27-live-${runId}`, TENANT_A, TENANT_B, TENANT_PERSON
  ]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-q27-a-business-${runId}`, TENANT_A, `ms-q27-b-business-${runId}`, TENANT_B]
  );

  await section("BUG-REPRODUKSJON: rå spørring mot tenants forblir RLS-blind under runtime-rollen", async () => {
    const viaAdmin = await adminPool.query("SELECT tenant_id FROM tenants WHERE kind = 'business' AND tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const viaRuntime = await pool.query("SELECT tenant_id FROM tenants WHERE kind = 'business' AND tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    // Beviser at RLS FORTSATT håndheves (ikke svekket for å "fikse" dette) -
    // adminPool ser radene, en rå spørring under runtime-rollen ser 0.
    results.q27_direct_runtime_global_query_restricted =
      viaAdmin.rows.length === 2 && viaRuntime.rows.length === 0 ? "PASS" : "FAIL";
    log(`admin_sees=${viaAdmin.rows.length} raw_runtime_sees=${viaRuntime.rows.length} -> q27_direct_runtime_global_query_restricted: ${results.q27_direct_runtime_global_query_restricted}`);
  });

  await section("KATALOGFUNKSJON: finner de RIKTIGE bedrifts-tenantene under SAMME runtime-rolle", async () => {
    const tenantIds = await listBusinessTenantIds(pool, 200);
    const foundA = tenantIds.includes(TENANT_A);
    const foundB = tenantIds.includes(TENANT_B);
    results.q27_catalog_business_tenants = foundA && foundB ? "PASS" : "FAIL";
    results.q27_multiple_business_tenants = tenantIds.filter((t) => t === TENANT_A || t === TENANT_B).length === 2 ? "PASS" : "FAIL";
    results.q27_catalog_excludes_nonbusiness = !tenantIds.includes(TENANT_PERSON) ? "PASS" : "FAIL";
    results.q27_catalog_runtime_execute_allowed = foundA && foundB ? "PASS" : "FAIL";
    log(`found_a=${foundA} found_b=${foundB} excludes_person=${!tenantIds.includes(TENANT_PERSON)} -> q27_catalog_business_tenants/q27_multiple_business_tenants/q27_catalog_excludes_nonbusiness/q27_catalog_runtime_execute_allowed`);
  });

  await section("MINIMAL OVERFLATE: katalogfunksjonen eksponerer KUN tenant_id", async () => {
    const { rows } = await pool.query("SELECT * FROM jarvis_list_business_tenant_ids($1)", [200]);
    const onlyTenantId = rows.every((row) => Object.keys(row as object).length === 1 && Object.prototype.hasOwnProperty.call(row, "tenant_id"));
    results.q27_catalog_minimal_surface = rows.length > 0 && onlyTenantId ? "PASS" : "FAIL";
    log(`columns_ok=${onlyTenantId} row_count=${rows.length} -> q27_catalog_minimal_surface: ${results.q27_catalog_minimal_surface}`);
  });

  await section("PUBLIC/UTENFORSTAAENDE ROLLE NEKTES EXECUTE", async () => {
    await adminPool.query(`CREATE ROLE ${OUTSIDER_ROLE} LOGIN PASSWORD 'q27-outsider-pw' NOSUPERUSER NOBYPASSRLS`);
    const outsiderPool = createPool({ ...configFromEnv(), user: OUTSIDER_ROLE, password: "q27-outsider-pw" });
    try {
      let denied = false;
      try {
        await outsiderPool.query("SELECT tenant_id FROM jarvis_list_business_tenant_ids($1)", [200]);
      } catch (err) {
        denied = /permission denied/i.test((err as Error).message);
      }
      results.q27_catalog_public_execute_denied = denied ? "PASS" : "FAIL";
      log(`outsider_denied=${denied} -> q27_catalog_public_execute_denied: ${results.q27_catalog_public_execute_denied}`);
    } finally {
      await outsiderPool.end();
      await adminPool.query(`DROP ROLE IF EXISTS ${OUTSIDER_ROLE}`);
    }
  });

  await section("TENANT-ISOLASJON: bedrifts-tenants forblir gjensidig isolert (RLS uendret av Q-27)", async () => {
    const service = new BusinessService(pool);
    await service.createLead(TENANT_A, "business", { title: `Q27 Syntetisk Lead ${runId}`, source: "manual" });
    const metricsB = await service.metrics(TENANT_B, "business");
    results.q27_tenant_isolation = metricsB.open_leads === 0 ? "PASS" : "FAIL";
    log(`tenant_b_open_leads=${metricsB.open_leads} -> q27_tenant_isolation: ${results.q27_tenant_isolation}`);
  });

  await section("OPEN-LOOP-SVEIP: oppdager BEGGE syntetiske bedrifts-tenants via runtime-pool", async () => {
    const openLoops = new OpenLoopService(pool);
    const before = await runOpenLoopSweepForAllTenants(pool, openLoops);
    const visited = Object.keys(before).filter((t) => t === TENANT_A || t === TENANT_B);
    results.q27_open_loop_scheduler = visited.length === 2 ? "PASS" : "FAIL";
    log(`open_loop_visited=${JSON.stringify(visited)} -> q27_open_loop_scheduler: ${results.q27_open_loop_scheduler}`);
  });

  await section("BUSINESS-EVENT-SVEIP: oppdager BEGGE syntetiske bedrifts-tenants via runtime-pool (deterministisk fake sync - Gmail/Calendar-korrekthet er allerede D-60-host-bevist separat)", async () => {
    const visited: string[] = [];
    const zeroResult: BusinessEventSyncResult = {
      gmail: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
      calendar: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
      open_loops_reevaluated: false
    };
    const fakeSyncService = {
      syncTenant: async (tenantId: string) => {
        visited.push(tenantId);
        return zeroResult;
      }
    } as unknown as BusinessEventSyncService;
    await runBusinessEventSyncForAllTenants(pool, fakeSyncService);
    const found = visited.filter((t) => t === TENANT_A || t === TENANT_B);
    results.q27_business_event_scheduler = found.length === 2 ? "PASS" : "FAIL";
    log(`business_event_visited=${JSON.stringify(found)} -> q27_business_event_scheduler: ${results.q27_business_event_scheduler}`);
  });

  await section("SCORING-SVEIP: oppdager BEGGE syntetiske bedrifts-tenants via runtime-pool", async () => {
    const scoring = new ScoringService(pool);
    const before = await runScoringSweepForAllTenants(pool, scoring);
    const visited = Object.keys(before).filter((t) => t === TENANT_A || t === TENANT_B);
    results.q27_scoring_scheduler = visited.length === 2 ? "PASS" : "FAIL";
    log(`scoring_visited=${JSON.stringify(visited)} -> q27_scoring_scheduler: ${results.q27_scoring_scheduler}`);
  });

  await section("CLEANUP", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_PERSON).catch((err: unknown) => { cleanupOk = false; log(`cleanup person-tenant feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [`person-q27-live-${runId}`]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });
    await adminPool.query(`DROP ROLE IF EXISTS ${OUTSIDER_ROLE}`).catch(() => undefined);

    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B, TENANT_PERSON]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.q27_cleanup = cleanupOk && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftoverTenants} -> q27_cleanup: ${results.q27_cleanup}`);
  });

  return finish();
}

function finish(): void {
  log("\n== Q-27 TENANT ENUMERATION LIVE ACCEPTANCE SUMMARY ==");
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
