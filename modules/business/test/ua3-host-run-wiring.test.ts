import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-3 P0 §31: `modules/business/scripts/ua3-host-run.ts` er den ENE
 * host-kommandoen Tobias trenger for aa verifisere Business OS mot en ekte
 * Docker-Postgres. Speiler NØYAKTIG mønsteret i
 * `modules/core/scripts/q20-host-run.ts` (samme pnpm-resolusjon, samme
 * "always rebuild"-leksjon) - denne suiten beviser den strukturelt, uten aa
 * faktisk kjøre Docker/pnpm (det er selve host-akseptansens jobb).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua3-host-run.ts");
const liveScriptSource = readSource("../scripts/ua3-business-live.ts");

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
  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt, samme presedens som q20-host-run.ts) - kommentarer som NEVNER teknikken i dokumentasjonsøyemed er greit", () => {
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
  it("kjører migrate FØR ua3-business-live.ts (019_business.sql maa vaere anvendt før business-tabellene leses)", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveCallIdx = hostRunSource.indexOf('"modules/business/scripts/ua3-business-live.ts"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(liveCallIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeLessThan(liveCallIdx);
  });
});

describe("Q-21 admin/runtime-splitt regresserer ikke", () => {
  it("ua3-host-run.ts skriver/endrer ALDRI .env", () => {
    expect(hostRunSource).not.toMatch(/writeFileSync/);
    expect(hostRunSource).not.toMatch(/renameSync/);
    expect(hostRunSource).not.toMatch(/copyFileSync/);
  });
  it("ua3-business-live.ts verifiserer selv Q-21-rollen (assertRuntimeRoleSafe) FØR noe skriving forsøkes", () => {
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
});

describe("live-scriptet bruker UTELUKKENDE syntetiske, kjøre-unike tenants - aldri ekte kundedata", () => {
  it("bruker en run_id-suffikset tenant-prefiks (tenant-ua3-live-<run_id>-a/-b), ingen hardkodet ekte tenant_id", () => {
    expect(liveScriptSource).toContain("`tenant-ua3-live-${runId}-a`");
    expect(liveScriptSource).toContain("`tenant-ua3-live-${runId}-b`");
    expect(liveScriptSource).not.toMatch(/tenant-kundeoppfolging/);
  });
  it("rydder opp egen test-tenant/person ved slutten av kjøringen (CLEANUP-seksjon)", () => {
    const cleanupIdx = liveScriptSource.indexOf('section("CLEANUP"');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(liveScriptSource.slice(cleanupIdx)).toContain("cleanupTenant(TENANT_A)");
    expect(liveScriptSource.slice(cleanupIdx)).toContain("cleanupTenant(TENANT_B)");
  });
  it("selvhelbreder (selfHeal) stale kjøringer fra tidligere avbrutte forsøk FØR ny test-data plantes", () => {
    expect(liveScriptSource).toContain("await selfHeal()");
  });
});

describe("PASS-markører og hard_fail beregnes fra faktiske resultater - aldri hardkodet false", () => {
  it("hard_fail avledes fra results-objektet (FAIL/BLOCKED_BY_RUNTIME_ROLE), ikke en konstant", () => {
    expect(liveScriptSource).toMatch(/const hardFail = Object\.values\(results\)\.some/);
    expect(liveScriptSource).not.toMatch(/hard_fail=false`\)/);
  });
  it("resultat-nøklene dekker Q-21/livssyklus/idempotens/isolasjon/audit/ToolGateway-wiring", () => {
    for (const key of [
      "ua3_company_contact", "ua3_lead_idempotent", "ua3_opportunity_pipeline",
      "ua3_activity_timeline", "ua3_activity_idempotent", "ua3_followup_lifecycle",
      "ua3_followup_overdue", "ua3_metrics", "ua3_tenant_isolation", "ua3_space_isolation",
      "ua3_toolgateway_wiring", "ua3_audit_no_sensitive_content"
    ]) {
      expect(liveScriptSource).toContain(key);
    }
  });
});
