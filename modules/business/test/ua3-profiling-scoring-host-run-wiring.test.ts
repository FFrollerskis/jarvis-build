import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-3 profiling/scoring-slice (D-61): `modules/business/scripts/ua3-profiling-scoring-host-run.ts`
 * er den ENE host-kommandoen Tobias trenger for aa verifisere transparent
 * business-operasjonell scoring mot en ekte Docker-Postgres. Speiler
 * NØYAKTIG mønsteret i `ua3-business-events-host-run-wiring.test.ts`/
 * `ua3-open-loops-host-run-wiring.test.ts` - denne suiten beviser det
 * strukturelt, uten aa faktisk kjøre Docker/pnpm.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua3-profiling-scoring-host-run.ts");
const liveScriptSource = readSource("../scripts/ua3-profiling-scoring-live.ts");

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
    const codeOnly = hostRunSource.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
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
  it("kjører migrate FØR ua3-profiling-scoring-live.ts (022_business_scoring.sql maa vaere anvendt før scoring-akseptansen kjører)", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveCallIdx = hostRunSource.indexOf('"modules/business/scripts/ua3-profiling-scoring-live.ts"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(liveCallIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeLessThan(liveCallIdx);
  });
});

describe("host-run.ts endrer aldri .env, sletter aldri Docker-volumer/databasedata", () => {
  it("inneholder ingen writeFile/rm/DROP/TRUNCATE-mønstre mot .env eller databasen", () => {
    expect(hostRunSource).not.toMatch(/writeFileSync|rmSync|DROP\s+(TABLE|DATABASE)|TRUNCATE/i);
    expect(hostRunSource).not.toMatch(/docker.*volume.*rm|down\s+-v/);
  });
});

describe("live-scriptet bruker EKTE @jarvis/business/@jarvis/core/@jarvis/policy/@jarvis/tool-gateway-arkitektur, ingen alternativ implementasjon", () => {
  it("importerer ScoringService/BusinessTransport/BusinessService/OpenLoopService fra @jarvis/business, ikke en lokal kopi", () => {
    expect(liveScriptSource).toMatch(/import\s*\{[^}]*ScoringService[^}]*\}\s*from\s*"@jarvis\/business"/s);
    expect(liveScriptSource).toMatch(/BusinessTransport/);
    expect(liveScriptSource).toMatch(/BusinessService/);
    expect(liveScriptSource).toMatch(/OpenLoopService/);
  });
  it("importerer ALLOWED_LEAD_FACTOR_CODES/ALLOWED_OPPORTUNITY_FACTOR_CODES/assertNoProhibitedFactorCodes fra @jarvis/business - gjenbruker SAMME whitelist som enhetstestene, definerer aldri en egen kopi", () => {
    expect(liveScriptSource).toMatch(/ALLOWED_LEAD_FACTOR_CODES/);
    expect(liveScriptSource).toMatch(/ALLOWED_OPPORTUNITY_FACTOR_CODES/);
    expect(liveScriptSource).toMatch(/assertNoProhibitedFactorCodes/);
  });
  it("bruker ToolGateway.execute() for ALLE score-handlinger - aldri et direkte ScoringService-snarvei-kall utenom scaffold-oppsettet", () => {
    const gatewayExecuteCalls = (liveScriptSource.match(/gateway\.execute\(/g) ?? []).length;
    expect(gatewayExecuteCalls).toBeGreaterThanOrEqual(8);
  });
  it("bruker BusinessInternalSecretProvider (INGEN Gmail/Calendar-credential kreves - business-scoring har ingen ekstern leverandør)", () => {
    expect(liveScriptSource).toMatch(/new BusinessInternalSecretProvider\(\)/);
    expect(liveScriptSource).not.toMatch(/GmailTransport|GoogleCalendarTransport|EnvSecretProvider/);
  });
});

describe("Q-21/RLS - live-scriptet bruker withTenantTransaction, aldri en RLS-blind raw pool.query() mot audit_events (samme lærdom som D-54/D-59)", () => {
  it("importerer withTenantTransaction fra @jarvis/core", () => {
    expect(liveScriptSource).toMatch(/import\s*\{[^}]*withTenantTransaction[^}]*\}\s*from\s*"@jarvis\/core"/s);
  });
  it("audit-verifikasjonsspørringene mot audit_events er wrappet i withTenantTransaction, ikke pool.query direkte", () => {
    const auditQueryPattern = /SELECT payload FROM audit_events/g;
    const matches = [...liveScriptSource.matchAll(auditQueryPattern)];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    for (const match of matches) {
      const before = liveScriptSource.slice(Math.max(0, match.index! - 200), match.index);
      expect(before).toMatch(/withTenantTransaction\(pool, TENANT_A/);
    }
  });
  it("sjekker q21_runtime_role_safe FØR noen skriving forsøkes (fail-closed, samme mønster som alle tidligere UA-3-live-script)", () => {
    const q21Idx = liveScriptSource.indexOf("Q-21 RUNTIME ROLE");
    const scaffoldIdx = liveScriptSource.indexOf("SCAFFOLD");
    expect(q21Idx).toBeGreaterThan(-1);
    expect(scaffoldIdx).toBeGreaterThan(-1);
    expect(q21Idx).toBeLessThan(scaffoldIdx);
  });
});

describe("høy-konsekvens-forbud (§10) og beskyttet-trekk-forbud (§4) verifiseres LIVE, ikke bare i enhetstester", () => {
  it("sjekker at faktor-kodene er en delmengde av whitelisten OG kaller assertNoProhibitedFactorCodes eksplisitt", () => {
    expect(liveScriptSource).toMatch(/ALLOWED_LEAD_FACTOR_CODES as readonly string\[\]\)\.includes/);
    expect(liveScriptSource).toMatch(/assertNoProhibitedFactorCodes\(codes\)/);
  });
  it("sjekker eksplisitt at en score-rad ikke inneholder forbudte hoy-konsekvens-felt (rejected/denied/terminated/credit_decision/employment_decision)", () => {
    expect(liveScriptSource).toMatch(/forbiddenFields/);
    expect(liveScriptSource).toMatch(/"rejected"/);
    expect(liveScriptSource).toMatch(/"credit_decision"/);
  });
});

describe("cleanup - synlig FK-selvdiagnostikk, samme gjenbrukte mønster som D-55", () => {
  it("definerer findBlockingTenantDependencies() og kaller den inni cleanupTenant() FØR selve tenant-slettingen", () => {
    expect(liveScriptSource).toMatch(/async function findBlockingTenantDependencies/);
    const cleanupIdx = liveScriptSource.indexOf("async function cleanupTenant");
    const findBlockingCallIdx = liveScriptSource.indexOf("await findBlockingTenantDependencies(tenantId)");
    const deleteTenantIdx = liveScriptSource.indexOf('DELETE FROM tenants WHERE tenant_id = $1"');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(findBlockingCallIdx).toBeGreaterThan(cleanupIdx);
    expect(deleteTenantIdx).toBeGreaterThan(findBlockingCallIdx);
  });
  it("rydder business_scores eksplisitt (nytt i denne sliceen)", () => {
    expect(liveScriptSource).toMatch(/DELETE FROM business_scores WHERE tenant_id = \$1/);
  });
  it("bruker aldri en bred DELETE/TRUNCATE uten en tenant_id-WHERE-klausul", () => {
    const deleteLines = liveScriptSource.split("\n").filter((l) => l.includes("DELETE FROM"));
    for (const line of deleteLines) {
      expect(line).toMatch(/WHERE (tenant_id|person_id)\s*(=|LIKE)\s*/);
    }
  });
});

describe("alle 17 forventede markører er definert i results-objektet (matcher byggeordrens §28 eksakt)", () => {
  it("inneholder samtlige forventede markørnøkler", () => {
    const expectedKeys = [
      "q21_runtime_role_safe", "ua3_scoring_runtime_role", "ua3_scoring_lead", "ua3_scoring_opportunity",
      "ua3_scoring_explainable", "ua3_scoring_source_backed", "ua3_scoring_versioned", "ua3_scoring_idempotent",
      "ua3_scoring_protected_traits_blocked", "ua3_scoring_high_impact_blocked", "ua3_scoring_manual_override",
      "ua3_scoring_override_audit", "ua3_scoring_tenant_isolation", "ua3_scoring_space_isolation",
      "ua3_scoring_toolgateway", "ua3_scoring_audit_safe", "ua3_scoring_cleanup"
    ];
    for (const key of expectedKeys) {
      expect(liveScriptSource).toContain(`${key}:`);
    }
  });
  it("hard_fail-logikken flagger BÅDE FAIL og BLOCKED_BY_RUNTIME_ROLE, samme mønster som de andre UA-3-live-scriptene", () => {
    expect(liveScriptSource).toMatch(/v === "FAIL" \|\| v === "BLOCKED_BY_RUNTIME_ROLE"/);
  });
});

describe("ingen credential/token-verdi logges noe sted (samme sanering som resten av UA-3)", () => {
  it("logger aldri et rått access_token/refresh_token/client_secret-felt", () => {
    expect(liveScriptSource).not.toMatch(/log\(`[^`]*\$\{[^}]*(authorization|access_token|refresh_token|client_secret)[^}]*\}[^`]*`\)/i);
  });
  it("bruker utelukkende syntetiske test-selskaper/kontakter (aldri en ekte mailboks-kontakt eller ekte person profileres/scores)", () => {
    expect(liveScriptSource).toMatch(/Scoring Syntetisk AS/);
    expect(liveScriptSource).not.toMatch(/JARVIS_GOOGLE_ACCOUNT|JARVIS_EMAIL_TOKEN|JARVIS_GOOGLE_TOKEN/);
  });
});
