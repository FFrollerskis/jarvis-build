import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-4 Growth -> Business Domain Coverage integration (D-78):
 * `modules/business/scripts/ua4-growth-domain-coverage-host-run.ts` er den
 * ENE host-kommandoen Tobias trenger for aa verifisere at
 * `BUSINESS_DOMAIN_COVERAGE` faktisk rapporterer marketing som tilgjengelig
 * mot en ekte Docker-Postgres. Speiler NØYAKTIG samme struktur som
 * `ua4-growth-core-host-run.ts` - denne suiten beviser den strukturelt,
 * uten aa faktisk kjøre Docker/pnpm (det er selve host-akseptansens jobb).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua4-growth-domain-coverage-host-run.ts");
const liveScriptSource = readSource("../scripts/ua4-growth-domain-coverage-live.ts");

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
  it("kjører migrate FØR ua4-growth-domain-coverage-live.ts", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveCallIdx = hostRunSource.indexOf('"modules/business/scripts/ua4-growth-domain-coverage-live.ts"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(liveCallIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeLessThan(liveCallIdx);
  });
});

describe("live-scriptet beviser Q-21 FØR noen skriving, og har eksplisitt BLOCKED_BY_RUNTIME_ROLE-fallback", () => {
  it("kaller assertRuntimeRoleSafe() FØR noen tenant/kampanje opprettes", () => {
    const roleCheckIdx = liveScriptSource.indexOf("assertRuntimeRoleSafe(pool)");
    const tenantInsertIdx = liveScriptSource.indexOf("INSERT INTO tenants");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(tenantInsertIdx).toBeGreaterThan(-1);
    expect(roleCheckIdx).toBeLessThan(tenantInsertIdx);
  });
  it("setter ALLE markører til BLOCKED_BY_RUNTIME_ROLE hvis Q-21-sjekken feiler, aldri en fake PASS", () => {
    expect(liveScriptSource).toContain('results[key] = "BLOCKED_BY_RUNTIME_ROLE"');
  });
});

describe("live-scriptet krever INGEN annonseplattform-credential (domenekapabilitet != leverandør-tilkobling)", () => {
  it("den ENESTE reelle referansen til en annonseplattform er den kanal-nøytrale streng-enumen `channel: \"google_ads\"` (samme mønster som ua4-growth-core-live.ts) - INGEN credential/API-nøkkel-referanse noe sted", () => {
    expect(liveScriptSource).not.toMatch(/GOOGLE_ADS_API_KEY|META_ADS_API_KEY|GOOGLE_ADS_TOKEN|META_ADS_TOKEN|GA4_API_KEY|SEARCH_CONSOLE_API_KEY/i);
    // Regexen som SLETTER eventuelle provider-env-nøkler (7 alternativer) + den kanal-nøytrale
    // `channel: "google_ads"`-strengen er de ENESTE forventede forekomstene - alt utover det
    // ville vaert en ny, uventet leverandør-kobling.
    const matches = liveScriptSource.match(/GOOGLE_ADS|META_ADS|FACEBOOK_ADS|LINKEDIN_ADS|TIKTOK_ADS|_GA4_|SEARCH_CONSOLE/gi) ?? [];
    expect(matches.length).toBeLessThanOrEqual(8); // 7 i selve regex-uttrykket + 1 i "google_ads"-kanal-enumen
  });
  it("sletter eventuelle provider-env-variabler FØR sjekken, i stedet for aa anta de ikke finnes", () => {
    expect(liveScriptSource).toContain("delete process.env[key]");
  });
});

describe("live-scriptet rydder opp etter seg selv (samme run-unik tenant-suffiks-mønster)", () => {
  it("kaller selfHeal() FØR main() for aa rydde opp stale kjøringer", () => {
    const selfHealCallIdx = liveScriptSource.lastIndexOf("await selfHeal();");
    const mainCallIdx = liveScriptSource.lastIndexOf("await main();");
    expect(selfHealCallIdx).toBeGreaterThan(-1);
    expect(mainCallIdx).toBeGreaterThan(-1);
    expect(selfHealCallIdx).toBeLessThan(mainCallIdx);
  });
  it("cleanupTenant() sletter marketing_campaign_events FØR marketing_campaigns FØR business_companies (FK-rekkefølge)", () => {
    // `growth.createCampaign()` logger automatisk et `campaign_created`-event - fanget av et
    // ekte smoke-test-kjør (embedded Postgres) FØR denne testen ble skrevet, ikke antatt.
    const eventsDeleteIdx = liveScriptSource.indexOf("DELETE FROM marketing_campaign_events");
    const campaignDeleteIdx = liveScriptSource.indexOf("DELETE FROM marketing_campaigns");
    const companyDeleteIdx = liveScriptSource.indexOf("DELETE FROM business_companies");
    expect(eventsDeleteIdx).toBeGreaterThan(-1);
    expect(campaignDeleteIdx).toBeGreaterThan(-1);
    expect(companyDeleteIdx).toBeGreaterThan(-1);
    expect(eventsDeleteIdx).toBeLessThan(campaignDeleteIdx);
    expect(campaignDeleteIdx).toBeLessThan(companyDeleteIdx);
  });
});
