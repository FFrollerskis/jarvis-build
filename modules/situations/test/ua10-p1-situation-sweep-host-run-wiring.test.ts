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
  });
});

describe("REGRESJONSVAKT (arkitekt-review 5234145170 på PR #88): akseptansen rører ALDRI den globale pausetilstanden for et ekte domene", () => {
  const codeOnly = liveScriptSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  const realDomains = "spend|pipeline|support|deadlines|product|operations|\\*";

  it("pause_domain/unpause_domain via gateway bruker KUN det kjøre-unike akseptansedomenet - aldri et hardkodet ekte domene", () => {
    expect(liveScriptSource).toContain("const ACCEPTANCE_DOMAIN = `ua10_acceptance_${runId}`;");
    // Fanger HELE kallet fram til og med `parameters: {...}` (kan gå over linjeskift) - både
    // gateway.execute({ action: "pause_domain", ... parameters: {...} }) og direkte
    // transport.invoke("pause_domain", { domain: ... }).
    const gatewayCalls = codeOnly.match(/action:\s*"(un)?pause_domain"[\s\S]{0,200}?parameters:\s*\{[^}]*\}/g) ?? [];
    const directCalls = codeOnly.match(/invoke\(\s*"(un)?pause_domain"\s*,\s*\{[^}]*\}/g) ?? [];
    const pauseCalls = [...gatewayCalls, ...directCalls];
    expect(gatewayCalls.length).toBeGreaterThan(0);
    // Antall forekomster av action-strengen må matche antall fangede kall - ingen kan "slippe unna" vakten.
    expect((codeOnly.match(/"(un)?pause_domain"/g) ?? []).length).toBe(pauseCalls.length);
    for (const call of pauseCalls) {
      expect(call).toContain("domain: ACCEPTANCE_DOMAIN");
      expect(call).not.toMatch(new RegExp(`domain:\\s*"(${realDomains})"`));
    }
  });
  it("pauseDurable/unpauseDurable/pause_all kalles aldri for et ekte domene eller `*`", () => {
    expect(codeOnly).not.toMatch(new RegExp(`(pauseDurable|unpauseDurable)\\(\\s*"(${realDomains})"`));
    expect(codeOnly).not.toMatch(/"pause_all"|"unpause_all"|pauseAllDurable|unpauseAllDurable/);
    // Ingen hardkodet ekte domene-streng sendes til pause-primitivene overhodet.
    const durableCalls = codeOnly.match(/(pauseDurable|unpauseDurable)\([^)]*\)/g) ?? [];
    for (const call of durableCalls) expect(call).toContain("ACCEPTANCE_DOMAIN");
  });
  it("selfHeal/cleanup sletter KUN akseptansedomener i situation_domain_pauses, aldri hele tabellen eller et ekte domene", () => {
    const deletes = codeOnly.match(/DELETE FROM situation_domain_pauses[^\n]*/g) ?? [];
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) expect(d).toContain("WHERE domain LIKE 'ua10_acceptance_%'");
  });
  it("beviser eksplisitt at global pausetilstand er identisk før/etter (egen markør, snapshot FØR første skriving)", () => {
    expect(liveScriptSource).toContain("ua10_existing_global_pauses_preserved");
    const snapshotIdx = liveScriptSource.indexOf("const globalPausesBefore");
    const tenantInsertIdx = liveScriptSource.indexOf("INSERT INTO tenants");
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(snapshotIdx).toBeLessThan(tenantInsertIdx);
  });
});

describe("REGRESJONSVAKT (host-funn run_id 2105bb7d, D-160 I): transport-wrapperen videresender ALLE argumenter og teller ved INNGANG", () => {
  const wrapper = liveScriptSource.slice(liveScriptSource.indexOf("class CountingTransport"), liveScriptSource.indexOf("class ObservingGateway"));
  it("CountingTransport.invoke videresender rest-argumentene UENDRET (credential + invocation-context) - aldri kun (action, parameters)", () => {
    expect(wrapper).toContain("this.inner.invoke(...args)");
    expect(wrapper).not.toMatch(/this\.inner\.invoke\(action,\s*parameters\)/);
  });
  it("forsøk telles FØR inner-kallet (transport_attempts), suksesser etter - et kast gir attempts=1, successes=0, aldri et usynlig 0/0", () => {
    const attemptsIdx = wrapper.indexOf("this.attempts += 1;");
    const innerIdx = wrapper.indexOf("this.inner.invoke(");
    expect(attemptsIdx).toBeGreaterThan(-1);
    expect(attemptsIdx).toBeLessThan(innerIdx);
  });
  it("diagnostikk: gateway-utfall/grunn observeres (ObservingGateway), audit_events-grunner og tool_executions-status logges - uten parametre/credentials", () => {
    expect(liveScriptSource).toContain("class ObservingGateway extends ToolGateway");
    expect(liveScriptSource).toMatch(/FROM audit_events WHERE tenant_id = ANY\(\$1\) AND tool_id = 'telegram'/);
    expect(liveScriptSource).toContain("credential_resolved=");
    expect(liveScriptSource).toContain("transport_attempts=");
    // Grunn-strengen redigeres for token-verdien FØR logging - aldri en rå credential i output.
    expect(liveScriptSource).toMatch(/last_reason=\$\{redact\(/);
  });
  it("scripts/ typesjekkes nå av pakken (tsconfig include) - TS2554 hadde fanget host-feilen", () => {
    const tsconfig = JSON.parse(readSource("../tsconfig.json")) as { include: string[] };
    expect(tsconfig.include).toContain("scripts");
  });
});

describe("REGRESJONSVAKT (host-funn run_id 2105bb7d, D-160 I): migrasjonsbeviset er det UA-10 trenger - ikke 'ingen prefiks-duplikat i hele tabellen'", () => {
  it("bruker den rene, enhetstestede evaluateMigrationEvidence() og leser HELE schema_migrations + repoets mappe", () => {
    expect(liveScriptSource).toMatch(/import \{ evaluateMigrationEvidence \} from "\.\/lib\/migration-evidence\.ts"/);
    expect(liveScriptSource).toContain("SELECT name, applied_at FROM schema_migrations ORDER BY name");
    expect(liveScriptSource).toMatch(/evaluateMigrationEvidence\(rows as Array<\{ name: string; applied_at: Date \}>, repoFiles\)/);
    expect(liveScriptSource).not.toMatch(/HAVING count\(\*\) > 1/);
  });
  it("historiske duplikater og orphan-rader RAPPORTERES (observabilitet) - skjules aldri", () => {
    expect(liveScriptSource).toContain('diagnostics["migration_historical_prefix_duplicates"]');
    expect(liveScriptSource).toContain('diagnostics["migration_orphan_rows"]');
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
