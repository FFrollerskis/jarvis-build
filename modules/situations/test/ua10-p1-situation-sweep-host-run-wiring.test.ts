import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BusinessInternalSecretProvider } from "@jarvis/business";
import { EnvSecretProvider, FallbackSecretProvider } from "@jarvis/tool-gateway";
import { SituationsTransport, situationsToolDefinitions } from "../src/transport.ts";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import type { SituationEngine } from "../src/service.ts";

/**
 * UA-10 P1 (D-160) host-akseptanse:
 * `modules/situations/scripts/ua10-p1-situation-sweep-host-run.ts` er den ENE
 * host-kommandoen Tobias trenger for aa bevise `situation-sweep` LIVE mot en
 * ekte Docker-Postgres. Speiler NØYAKTIG samme struktur som
 * `ua4-growth-domain-coverage-host-run.ts` - denne suiten beviser den
 * strukturelt, uten aa faktisk kjøre Docker/pnpm (det er selve host-akseptansens jobb).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua10-p1-situation-sweep-host-run.ts");
const liveScriptSource = readSource("../scripts/ua10-p1-situation-sweep-live.ts");

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

describe("migrate/api/worker bygges ferske FØR migrate kjøres (057 er en NY migrasjon), deretter kjøres migrate FØR selve akseptansen", () => {
  it("bygger migrate/api/worker FØR migrate faktisk kjøres", () => {
    const buildIdx = hostRunSource.indexOf('"build", "migrate", "api", "worker"');
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(migrateRunIdx);
  });
  it("kjører migrate FØR ua10-p1-situation-sweep-live.ts, og restarter api/worker på det ferske imaget", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const restartIdx = hostRunSource.indexOf('"up", "-d", "--force-recreate", "api", "worker"');
    const liveCallIdx = hostRunSource.indexOf('"modules/situations/scripts/ua10-p1-situation-sweep-live.ts"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(migrateRunIdx);
    expect(liveCallIdx).toBeGreaterThan(restartIdx);
  });
});

describe("live-scriptet beviser Q-21 FØR noen skriving, og har eksplisitt BLOCKED_BY_RUNTIME_ROLE-fallback", () => {
  it("kaller assertRuntimeRoleSafe() FØR noen tenant/loop opprettes", () => {
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

describe("live-scriptet bruker PRODUKSJONENS komposisjon - ikke en test-provider som skjuler credential-hull", () => {
  it("ToolGateway bygges med FallbackSecretProvider(EnvSecretProvider, BusinessInternalSecretProvider) - samme kjede som main.ts", () => {
    expect(liveScriptSource).toContain("new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider())");
  });
  it("`telegram.notify` hentes fra den KANONISKE firstWaveTools-definisjonen, aldri en parallell kopi", () => {
    expect(liveScriptSource).toMatch(/firstWaveTools\(\{\s*telegram\s*\}\)\.filter\(/);
  });
  it("Telegram uten credential rapporteres BLOCKED_EXTERNAL - aldri en fake PASS", () => {
    expect(liveScriptSource).toContain('"BLOCKED_EXTERNAL"');
    expect(liveScriptSource).toMatch(/telegramConfigured\s*\?[\s\S]*:\s*"BLOCKED_EXTERNAL"/);
  });
  it("scheduler-beviset bruker KJØRE-UNIKE jobbnavn - produksjonens `situation-sweep`-rad røres aldri", () => {
    expect(liveScriptSource).toContain("situation-sweep-acceptance-${runId}");
    expect(liveScriptSource).not.toMatch(/new DailyScheduler\(pool, "situation-sweep"/);
  });
});

describe("live-scriptet rydder opp etter seg selv (samme run-unik tenant-suffiks-mønster)", () => {
  it("kaller selfHeal() FØR main() sin scaffolding", () => {
    const selfHealCallIdx = liveScriptSource.lastIndexOf("await selfHeal();");
    const tenantInsertIdx = liveScriptSource.indexOf("INSERT INTO tenants");
    expect(selfHealCallIdx).toBeGreaterThan(-1);
    expect(selfHealCallIdx).toBeLessThan(tenantInsertIdx);
  });
  it("cleanupTenant() sletter situations FØR situation_autonomy_policies FØR business_open_loops FØR business_followups (FK-rekkefølge), og rydder eier-policyene som Q-20 bevisst utelater", () => {
    const situationsIdx = liveScriptSource.indexOf("DELETE FROM situations WHERE");
    const policiesIdx = liveScriptSource.indexOf("DELETE FROM situation_autonomy_policies WHERE");
    const loopsIdx = liveScriptSource.indexOf("DELETE FROM business_open_loops WHERE");
    const followupsIdx = liveScriptSource.indexOf("DELETE FROM business_followups WHERE");
    expect(situationsIdx).toBeGreaterThan(-1);
    expect(policiesIdx).toBeGreaterThan(situationsIdx);
    expect(loopsIdx).toBeGreaterThan(policiesIdx);
    expect(followupsIdx).toBeGreaterThan(loopsIdx);
  });
  it("sletter de kjøre-unike scheduler_state-radene, aldri hele tabellen", () => {
    expect(liveScriptSource).toContain("DELETE FROM scheduler_state WHERE job_name LIKE $1");
    expect(liveScriptSource).not.toMatch(/DELETE FROM scheduler_state\s*"/);
    expect(liveScriptSource).not.toMatch(/DELETE FROM situation_domain_pauses/);
  });
});

describe("REGRESJONSVAKT (host-funn): kontrollflatens credential_ref løses av PRODUKSJONENS secret-kjede", () => {
  it("hver `situations.*`-definisjon får en credential fra FallbackSecretProvider(Env, BusinessInternal) uten noen env-variabel satt", async () => {
    // Den opprinnelige P1-definisjonen brukte en oppfunnet `JARVIS_SITUATIONS_INTERNAL_TOKEN`
    // som INGEN provider i main.ts/worker-main.ts leverer - hele eier-kontrollflaten var
    // `credential_unavailable` i drift, usynlig for activation.test.ts sin test-provider
    // (som returnerte en verdi for ENHVER ref). Bevises nå mot den ekte kjeden.
    const chain = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
    const tools = situationsToolDefinitions(new SituationsTransport({} as SituationEngine, new DomainPauseRegistry()));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(process.env[tool.credential_ref]).toBeUndefined();
      expect(await chain.get(tool.credential_ref), `${tool.tool_id}.${tool.action} credential_ref=${tool.credential_ref}`).not.toBeNull();
    }
  });
});
