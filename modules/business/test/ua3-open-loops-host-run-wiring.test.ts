import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-3 next slice (D-53) §30/§31: `modules/business/scripts/ua3-open-loops-host-run.ts`
 * er den ENE host-kommandoen Tobias trenger for aa verifisere automatisk
 * open-loop-deteksjon + business-brief mot en ekte Docker-Postgres. Speiler
 * NØYAKTIG mønsteret i `ua3-host-run-wiring.test.ts` (P0) - denne suiten
 * beviser den strukturelt, uten aa faktisk kjøre Docker/pnpm.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua3-open-loops-host-run.ts");
const liveScriptSource = readSource("../scripts/ua3-open-loops-live.ts");

describe("workspace bootstrap - gjenbruker EKSISTERENDE Windows-sikker pnpm-resolusjon, ingen ny mekanisme", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en (ikke en duplisert kopi)", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });
  it("kjører install --frozen-lockfile FØR docker/migrasjoner, aldri --no-frozen-lockfile", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(dockerIdx);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
  });
  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt)", () => {
    expect(hostRunSource).toContain('execFileSync(command, args, { stdio: "inherit", cwd });');
    const codeOnly = hostRunSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/shell:\s*true/);
  });
});

describe("migrate/api/worker bygges ferske FØR migrate kjøres, deretter kjøres migrate FØR selve akseptansen", () => {
  it("bygger migrate/api/worker FØR migrate faktisk kjøres", () => {
    const buildIdx = hostRunSource.indexOf('"build", "migrate", "api", "worker"');
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(migrateRunIdx);
  });
  it("kjører migrate FØR ua3-open-loops-live.ts (020_business_open_loops.sql maa vaere anvendt før open-loop-tabellen leses)", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveCallIdx = hostRunSource.indexOf('"modules/business/scripts/ua3-open-loops-live.ts"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(liveCallIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeLessThan(liveCallIdx);
  });
});

describe("Q-21 admin/runtime-splitt regresserer ikke (samme presedens som P0 HOST FIX #1)", () => {
  it("ua3-open-loops-host-run.ts skriver/endrer ALDRI .env", () => {
    expect(hostRunSource).not.toMatch(/writeFileSync/);
    expect(hostRunSource).not.toMatch(/renameSync/);
    expect(hostRunSource).not.toMatch(/copyFileSync/);
  });
  it("ua3-open-loops-live.ts verifiserer selv Q-21-rollen (assertRuntimeRoleSafe) FØR noe skriving forsøkes", () => {
    expect(liveScriptSource).toContain("assertRuntimeRoleSafe");
    const roleCheckIdx = liveScriptSource.indexOf("assertRuntimeRoleSafe(pool)");
    const firstWriteIdx = liveScriptSource.indexOf("service.createCompany(");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(firstWriteIdx).toBeGreaterThan(-1);
    expect(roleCheckIdx).toBeLessThan(firstWriteIdx);
  });
  it("BLOCKED_BY_RUNTIME_ROLE stopper ALL videre skriving hvis rollen ikke er trygg", () => {
    expect(liveScriptSource).toContain("BLOCKED_BY_RUNTIME_ROLE");
    expect(liveScriptSource).toMatch(/if \(!runtimeRoleSafe\)/);
  });
  it("all scaffold-provisjonering (tenants/people/memory_spaces) gaar via adminPool, aldri pool (runtime) - samme HOST FIX #1-mønster", () => {
    const scaffoldSection = liveScriptSource.slice(
      liveScriptSource.indexOf("await selfHeal()"),
      liveScriptSource.indexOf('section("OPEN LOOP RUNTIME-ROLLE')
    );
    expect(scaffoldSection).toContain("adminPool.query");
    expect(scaffoldSection).not.toMatch(/(?<!admin)pool\.query\(\s*"INSERT INTO tenants/);
  });
});

describe("live-scriptet bruker UTELUKKENDE syntetiske, kjøre-unike tenants - aldri ekte kundedata", () => {
  it("bruker en run_id-suffikset tenant-prefiks (tenant-ua3-ol-live-<run_id>-a/-b), ingen hardkodet ekte tenant_id", () => {
    expect(liveScriptSource).toContain("`tenant-ua3-ol-live-${runId}-a`");
    expect(liveScriptSource).toContain("`tenant-ua3-ol-live-${runId}-b`");
    expect(liveScriptSource).not.toMatch(/tenant-kundeoppfolging/);
  });
  it("rydder opp egen test-tenant/person ved slutten av kjøringen (CLEANUP-seksjon), sletter business_open_loops FØR followups/opportunities (FK)", () => {
    const cleanupTenantFnIdx = liveScriptSource.indexOf("async function cleanupTenant");
    const cleanupFnBody = liveScriptSource.slice(cleanupTenantFnIdx, liveScriptSource.indexOf("async function selfHeal"));
    const openLoopDeleteIdx = cleanupFnBody.indexOf("DELETE FROM business_open_loops");
    const followupDeleteIdx = cleanupFnBody.indexOf("DELETE FROM business_followups");
    const opportunityDeleteIdx = cleanupFnBody.indexOf("DELETE FROM business_opportunities");
    expect(openLoopDeleteIdx).toBeGreaterThan(-1);
    expect(openLoopDeleteIdx).toBeLessThan(followupDeleteIdx);
    expect(openLoopDeleteIdx).toBeLessThan(opportunityDeleteIdx);

    const cleanupSectionIdx = liveScriptSource.indexOf('section("CLEANUP"');
    expect(cleanupSectionIdx).toBeGreaterThan(-1);
    expect(liveScriptSource.slice(cleanupSectionIdx)).toContain("cleanupTenant(TENANT_A)");
    expect(liveScriptSource.slice(cleanupSectionIdx)).toContain("cleanupTenant(TENANT_B)");
  });
  it("selvhelbreder (selfHeal) stale kjøringer fra tidligere avbrutte forsøk FØR ny test-data plantes", () => {
    expect(liveScriptSource).toContain("await selfHeal()");
  });
  it("audit_events er BEVISST FRAVÆRENDE fra cleanupTenant() - append-only trigger (samme HOST FIX #2-mønster)", () => {
    const cleanupTenantFnIdx = liveScriptSource.indexOf("async function cleanupTenant");
    const cleanupFnBody = liveScriptSource.slice(cleanupTenantFnIdx, liveScriptSource.indexOf("async function selfHeal"));
    expect(cleanupFnBody).not.toMatch(/DELETE FROM audit_events/);
  });
});

describe("PASS-markører og hard_fail beregnes fra faktiske resultater - aldri hardkodet false", () => {
  it("hard_fail avledes fra results-objektet (FAIL/BLOCKED_BY_RUNTIME_ROLE), ikke en konstant", () => {
    expect(liveScriptSource).toMatch(/const hardFail = Object\.values\(results\)\.some/);
    expect(liveScriptSource).not.toMatch(/hard_fail=false`\)/);
  });
  it("resultat-nøklene dekker EKSAKT de 16 markørene fra byggeordrens §31", () => {
    for (const key of [
      "q21_runtime_role_safe", "ua3_open_loop_runtime_role", "ua3_open_loop_overdue_detection",
      "ua3_open_loop_stalled_detection", "ua3_open_loop_idempotency", "ua3_open_loop_resolution",
      "ua3_open_loop_priority", "ua3_open_loop_source_evidence", "ua3_open_loop_tenant_isolation",
      "ua3_open_loop_space_isolation", "ua3_open_loop_toolgateway", "ua3_business_daily_brief",
      "ua3_business_weekly_brief", "ua3_brief_missing_domains_honest", "ua3_open_loop_audit_safe",
      "ua3_open_loop_cleanup"
    ]) {
      expect(liveScriptSource).toContain(key);
    }
  });
});

describe("AI Mesh-bruk (§11 i byggeordren): ua3-open-loops-live.ts kaller aldri en provider-SDK/ModelGateway direkte", () => {
  it("importerer aldri @jarvis/model-gateway eller @jarvis/provider-adapters", () => {
    expect(liveScriptSource).not.toMatch(/@jarvis\/model-gateway|@jarvis\/provider-adapters|openai|anthropic/i);
  });
});
