import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-3 Native Jarvis Support Core (D-66) §34/§35: strukturelt bevis for
 * `ua3-native-support-host-run.ts`/`ua3-native-support-live.ts`, uten å
 * faktisk kjøre Docker/pnpm - samme mønster som
 * `ua3-open-loops-host-run-wiring.test.ts`.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua3-native-support-host-run.ts");
const liveScriptSource = readSource("../scripts/ua3-native-support-live.ts");

describe("host-run: workspace bootstrap gjenbruker eksisterende Windows-sikker pnpm-resolusjon", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });
  it("kjører install --frozen-lockfile FØR docker/migrasjoner", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(dockerIdx);
  });
  it("bruker ALDRI shell:true (DEP0190-trygt)", () => {
    expect(hostRunSource).toContain('execFileSync(command, args, { stdio: "inherit", cwd });');
    const codeOnly = hostRunSource.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(codeOnly).not.toMatch(/shell:\s*true/);
  });
  it("bygger migrate/api/worker FØR migrate faktisk kjøres, deretter kjører live-scriptet", () => {
    const buildIdx = hostRunSource.indexOf('"build", "migrate", "api", "worker"');
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveIdx = hostRunSource.lastIndexOf("ua3-native-support-live.ts");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(migrateRunIdx);
    expect(migrateRunIdx).toBeLessThan(liveIdx);
  });
});

describe("live-script: alle §35-markører er initialisert fail-closed (FAIL som default)", () => {
  const expectedMarkers = [
    "q21_runtime_role_safe", "ua3_support_runtime_role", "ua3_support_no_zendesk_dependency",
    "ua3_support_create_ticket", "ua3_support_thread_idempotency", "ua3_support_message_idempotency",
    "ua3_support_contact_match", "ua3_support_unmatched", "ua3_support_ambiguous", "ua3_support_company_link",
    "ua3_support_timeline", "ua3_support_source_pointer", "ua3_support_no_body_copied",
    "ua3_support_state_machine", "ua3_support_priority", "ua3_support_assignment", "ua3_support_internal_note",
    "ua3_support_reply_path", "ua3_support_open_loop_created", "ua3_support_open_loop_resolved",
    "ua3_support_tenant_isolation", "ua3_support_space_isolation", "ua3_support_toolgateway",
    "ua3_support_audit_safe", "ua3_support_q20", "ua3_support_cleanup"
  ];
  it("results-kartet initialiserer NØYAKTIG disse markørene, alle som 'FAIL' (fail-closed default)", () => {
    for (const marker of expectedMarkers) {
      expect(liveScriptSource).toMatch(new RegExp(`${marker}:\\s*"FAIL"`));
    }
  });
  it("bruker ALDRI ekte GmailTransport for send/list_messages i live-scriptet (kun FakeTransport)", () => {
    expect(liveScriptSource).not.toMatch(/new GmailTransport\(\)/);
    expect(liveScriptSource).toMatch(/new FakeTransport\(/);
  });
  it("selvdiagnostisk FK-blokkerings-sjekk kjøres FØR DELETE FROM tenants (gjenbrukt, ikke duplisert logikk)", () => {
    const blockerFnIdx = liveScriptSource.indexOf("async function findBlockingTenantDependencies");
    const deleteTenantsIdx = liveScriptSource.lastIndexOf('"DELETE FROM tenants WHERE tenant_id = $1"');
    expect(blockerFnIdx).toBeGreaterThan(-1);
    expect(deleteTenantsIdx).toBeGreaterThan(-1);
    const callSiteIdx = liveScriptSource.indexOf("await findBlockingTenantDependencies(tenantId)");
    expect(callSiteIdx).toBeGreaterThan(-1);
    expect(callSiteIdx).toBeLessThan(deleteTenantsIdx);
  });
  it("finish() rapporterer run_id og hard_fail, aldri stille skjuler en FAIL/BLOCKED_BY_RUNTIME_ROLE", () => {
    expect(liveScriptSource).toMatch(/hardFail = Object\.values\(results\)\.some/);
    expect(liveScriptSource).toMatch(/run_id=\$\{runId\} hard_fail=\$\{hardFail\}/);
  });
});
