import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * K1 (Sovereign graduation, D-164) host-akseptanse:
 * `modules/owner-controls/scripts/k1-owner-control-authority-host-run.ts` er
 * den ENE host-kommandoen Tobias trenger for å bevise API-/worker-parity for
 * den durable eier-kontroll-autoriteten LIVE, over en EKTE container-restart.
 * Speiler NØYAKTIG samme struktur som `ua10-p1-situation-sweep-host-run.ts`
 * (se dens egen `-host-run-wiring.test.ts`) - denne suiten beviser den
 * strukturelt, uten å faktisk kjøre Docker/pnpm (det er selve host-
 * akseptansens jobb, se K1-ordren sitt HOST_ACCEPTANCE_REQUIRED-krav).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/k1-owner-control-authority-host-run.ts");
const liveScriptSource = readSource("../scripts/k1-owner-control-authority-live.ts");

describe("workspace bootstrap - gjenbruker EKSISTERENDE Windows-sikker pnpm-resolusjon, ingen ny mekanisme", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en (ikke en duplisert kopi)", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });
  it("kjører install --frozen-lockfile FØR docker build, aldri --no-frozen-lockfile", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(dockerIdx);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
  });
  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt) - verken i host-run eller i live-scriptet sin egen docker-restart", () => {
    for (const source of [hostRunSource, liveScriptSource]) {
      const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
      expect(codeOnly).not.toMatch(/shell:\s*true/);
    }
    expect(hostRunSource).toContain('execFileSync(command, args, { stdio: "inherit", cwd });');
    expect(liveScriptSource).toContain('execFileSync("docker", [...composeArgs, "restart", "api", "worker"]');
  });
});

describe("migrate/api/worker bygges ferske FØR migrate kjøres (058 er en NY migrasjon), deretter kjøres migrate FØR selve akseptansen", () => {
  it("bygger migrate/api/worker FØR migrate faktisk kjøres", () => {
    const buildIdx = hostRunSource.indexOf('"build", "migrate", "api", "worker"');
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(migrateRunIdx);
  });
  it("kjører migrate FØR den initielle api/worker-restarten, og gir compose-argumentene videre til live-scriptet", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const restartIdx = hostRunSource.indexOf('"up", "-d", "--force-recreate", "api", "worker"');
    const liveCallIdx = hostRunSource.indexOf('"modules/owner-controls/scripts/k1-owner-control-authority-live.ts"');
    const composeArgsFlagIdx = hostRunSource.indexOf('"--compose-args"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(migrateRunIdx);
    expect(liveCallIdx).toBeGreaterThan(restartIdx);
    expect(composeArgsFlagIdx).toBeGreaterThan(liveCallIdx);
  });
});

describe("live-scriptet krever compose-argumenter (ikke trygt å kjøre isolert - den restarter EKTE containere midt i seg selv)", () => {
  it("kaster en tydelig feil hvis --compose-args mangler, FØR noen tilstand endres", () => {
    const errorIdx = liveScriptSource.indexOf("k1_missing_compose_args");
    const activateIdx = liveScriptSource.indexOf('action: "activate_kill_switch"');
    expect(errorIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeLessThan(activateIdx);
  });
});

describe("live-scriptet bruker den EKTE, konfigurerte eier-identiteten - ALDRI en syntetisk 'test-eier' for selve kill switch-mutasjonen", () => {
  it("OWNER_PERSON/OWNER_TENANT kommer fra JARVIS_OWNER_PERSON_ID/JARVIS_TENANT_ID (samme env-variabler som apps/api/src/main.ts), ikke en hardkodet syntetisk verdi", () => {
    expect(liveScriptSource).toContain('process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias"');
    expect(liveScriptSource).toContain('process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"');
  });
  it("KUN connector-målet (frys-beviset) er syntetisk/kjøre-unikt - aldri en ekte, i bruk værende connector_id", () => {
    expect(liveScriptSource).toContain("SYNTHETIC_CONNECTOR = `k1_acceptance_connector_${runId}`");
  });
});

describe("live-scriptet bruker PRODUKSJONENS komposisjon - samme secret-kjede og samme *Durable()-mønster som apps/api/src/main.ts/worker-main.ts", () => {
  it("secrets: FallbackSecretProvider(EnvSecretProvider, BusinessInternalSecretProvider) - samme kjede som main.ts", () => {
    expect(liveScriptSource).toContain("new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider())");
  });
  it("'api'-siden og 'worker'-siden bruker HVER SIN egen pg.Pool (createPool kalt separat for hver) - ikke samme delte pool-objekt", () => {
    const matches = liveScriptSource.match(/apiPool\s*=\s*createPool\(configFromEnv\(\)\)/g) ?? [];
    const workerMatches = liveScriptSource.match(/workerPool\s*=\s*createPool\(configFromEnv\(\)\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(workerMatches.length).toBeGreaterThanOrEqual(1);
  });
  it("ToolGateway konstrueres med `ownerControls` som 4. argument (samme frys-/tilbakekalls-håndhevelse som main.ts/worker-main.ts)", () => {
    expect(liveScriptSource).toContain("new ToolGateway(sidePool, policy, secrets, ownerControls)");
  });
});

describe("live-scriptet garanterer opprydding OGSÅ ved feil (try/finally), og verifiserer tilstanden er UENDRET fra FØR kjøringen", () => {
  it("CLEANUP-seksjonen kjøres inni en `finally`-blokk rundt HELE hovedsekvensen", () => {
    const tryIdx = liveScriptSource.indexOf("try {");
    const finallyIdx = liveScriptSource.indexOf("} finally {");
    const cleanupIdx = liveScriptSource.indexOf('section("CLEANUP');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(finallyIdx).toBeGreaterThan(tryIdx);
    expect(cleanupIdx).toBeGreaterThan(finallyIdx);
  });
  it("sammenligner owner_control_state FØR og ETTER byte-for-byte (JSON.stringify-likhet), ikke bare et delmengde-sjekk", () => {
    expect(liveScriptSource).toContain("JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore)");
  });
});

describe("live-scriptet bruker ALDRI en fake PASS for Q-21/migrasjon-sjekker (BLOCKED_BY_RUNTIME_ROLE-fallback finnes)", () => {
  it("setter ALLE markører til BLOCKED_BY_RUNTIME_ROLE hvis Q-21-sjekken feiler", () => {
    expect(liveScriptSource).toContain('results[key] = "BLOCKED_BY_RUNTIME_ROLE"');
  });
  it("stopper (return finish()) hvis migrasjon 058 ikke er anvendt korrekt - forsøker ALDRI å aktivere kill switch mot et skjema den ikke kjenner", () => {
    const migrationCheckIdx = liveScriptSource.indexOf("k1_migration_058_applied");
    const returnIdx = liveScriptSource.indexOf('if (results.k1_migration_058_applied !== "PASS") return finish();');
    expect(migrationCheckIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(migrationCheckIdx);
  });
});

describe("D-167 (host-harness-korreksjon, arkitekt-funn PR #93): audit-bevis er avgrenset til (session_id, vannmerke) - ALDRI en håndplukket 'siste N rader'-grense som B1/D-166 beviselig gjorde ikke-deterministisk", () => {
  it("importerer captureAuditWatermark/queryRunScopedOwnerControlsAudit fra DEN DELTE hjelpe-modulen (ikke en dupliserende, ad-hoc spørring per seksjon)", () => {
    expect(liveScriptSource).toMatch(
      /import\s*\{[^}]*captureAuditWatermark[^}]*queryRunScopedOwnerControlsAudit[^}]*\}\s*from\s*"\.\.\/src\/audit-evidence\.ts"/s
    );
  });
  it("tar vannmerket FØR kjøringens FØRSTE mutasjon (aktiveringen) - ikke etter, og ikke inni en seksjon som selv muterer", () => {
    const watermarkIdx = liveScriptSource.indexOf("const auditWatermark = await captureAuditWatermark(adminPool);");
    const activationSectionIdx = liveScriptSource.indexOf('section("AKTIVERING');
    expect(watermarkIdx).toBeGreaterThan(-1);
    expect(activationSectionIdx).toBeGreaterThan(-1);
    expect(watermarkIdx).toBeLessThan(activationSectionIdx);
  });
  it("INGEN av de to audit-spørringene er en bar 'ORDER BY audit_id DESC LIMIT N' UTEN en forutgående session_id/vannmerke-avgrensning - den GAMLE, fikserte mønsteret finnes IKKE lenger i kildekoden", () => {
    expect(liveScriptSource).not.toMatch(/ORDER BY audit_id DESC LIMIT \d+/);
    expect(liveScriptSource).not.toMatch(/action IN \([^)]*\)\s*\n?\s*ORDER BY audit_id DESC LIMIT/);
  });
  it("begge audit-seksjonene kaller queryRunScopedOwnerControlsAudit med BÅDE sessionId OG watermark (ikke bare én av dem)", () => {
    const calls = liveScriptSource.match(/queryRunScopedOwnerControlsAudit\(adminPool,\s*\{[^}]*\}/gs) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toContain("sessionId:");
      expect(call).toContain("watermark:");
    }
  });
});
