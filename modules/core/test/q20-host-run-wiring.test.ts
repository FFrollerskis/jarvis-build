import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Q-20 HOST RECOVERY #1 (2026-08-16): Tobias kjørte den instruerte
 * kommandoen (`node --env-file=.env --experimental-transform-types
 * modules/erasure/scripts/q20-erasure-live.ts`) og fikk
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@jarvis/core'` FØR noe
 * Q-20-innhold ble testet. Root cause: denne branchen la til en NY
 * pnpm-workspace-pakke (`modules/erasure`) - hosten sin `node_modules` var
 * aldri bootstrappet for den (siste `pnpm install` skjedde FØR pakken
 * eksisterte). Dette er en HOST-bootstrap-feil, ikke et Q-20-funn - fikset
 * med `modules/core/scripts/q20-host-run.ts`, en ny "ett-kommando"-
 * orkestrator som (1) bootstrapper workspacet, (2) verifiserer resolvering,
 * (3) sikrer et FERSKT migrate-image + kjører migrasjonene (inkl.
 * `018_erasure.sql`) via ADMIN-rollen, (4) restarter api/worker, (5) kjører
 * selve `q20-erasure-live.ts`. Denne suiten beviser §7.A-I i BO-en.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/q20-host-run.ts");
const verifyWorkspaceSource = readSource("../../erasure/scripts/verify-workspace.ts");

describe("§7.A/§7.B: workspace bootstrap - ny pakke uten lokal node_modules repareres", () => {
  it("kjører `install --frozen-lockfile` (via den resolvede package manager-en) FØR noe som avhenger av modules/erasure sine workspace-deps", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const verifyIdx = hostRunSource.indexOf("verifyErasureWorkspaceResolution()");
    expect(installIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(verifyIdx);
  });

  it("bruker --frozen-lockfile (aldri --no-frozen-lockfile, aldri en variant som skriver om lockfilen)", () => {
    expect(hostRunSource).toMatch(/--frozen-lockfile/);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
    expect(hostRunSource).not.toMatch(/pnpm.*update/);
  });

  it("verify-workspace.ts importerer faktisk de workspace-pakkene q20-erasure-live.ts trenger", () => {
    for (const pkg of ["@jarvis/core", "@jarvis/knowledge", "@jarvis/memory", "@jarvis/policy", "@jarvis/contracts"]) {
      expect(verifyWorkspaceSource).toContain(`await import("${pkg}")`);
    }
    expect(verifyWorkspaceSource).toMatch(/erasure_workspace_dependencies=PASS/);
    expect(verifyWorkspaceSource).toMatch(/erasure_workspace_dependencies=FAIL/);
  });
});

describe("§7.C/§7.D: migrasjon 018 anvendes med et ferskt image, FØR akseptansen starter", () => {
  it("bygger migrate/api/worker FØR migrate faktisk kjøres (aldri et stale image - Q-21 host-runde 3-leksjonen)", () => {
    const buildIdx = hostRunSource.indexOf('"build", "migrate", "api", "worker"');
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(migrateRunIdx);
  });

  it("kjører migrate FØR q20-erasure-live.ts (018_erasure.sql må være anvendt før erasure_requests/erasure_fingerprints leses)", () => {
    // Merk: "q20-erasure-live.ts" nevnes FØRST i toppkommentaren (dokumentasjon) -
    // søket må derfor treffe den FAKTISKE kode-linjen, ikke doc-omtalen.
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const q20CallIdx = hostRunSource.indexOf('run("node", ["--env-file=.env"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(q20CallIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeLessThan(q20CallIdx);
  });

  it("018_erasure.sql finnes og følger migrasjonsfil-konvensjonen (nummerert, plukkes opp av migrator.ts sin glob)", () => {
    const migrationPath = fileURLToPath(new URL("../src/db/migrations/018_erasure.sql", import.meta.url));
    expect(existsSync(migrationPath)).toBe(true);
    expect(/^\d{3}_.*\.sql$/.test("018_erasure.sql")).toBe(true);
  });
});

describe("§7.E: Q-21 admin/runtime-splitt regresserer ikke", () => {
  it("q20-host-run.ts skriver/endrer ALDRI .env - gjenbruker Q-21 sin eksisterende, allerede korrekte konfigurasjon", () => {
    expect(hostRunSource).not.toMatch(/writeFileSync/);
    expect(hostRunSource).not.toMatch(/renameSync/);
    expect(hostRunSource).not.toMatch(/copyFileSync/);
  });

  it("kjører q20-erasure-live.ts med samme --env-file=.env-kontrakt som Tobias sin opprinnelige kommando", () => {
    expect(hostRunSource).toMatch(/--env-file=\.env/);
  });

  it("q20-erasure-live.ts verifiserer selv Q-21-rollen (assertRuntimeRoleSafe) FØR noe destruktivt - ingen duplisert logikk i host-runneren", () => {
    const liveScript = readSource("../../erasure/scripts/q20-erasure-live.ts");
    expect(liveScript).toContain("assertRuntimeRoleSafe");
    const assertIdx = liveScript.indexOf("assertRuntimeRoleSafe(pool)");
    const executeIdx = liveScript.indexOf("erasure.executeErasure");
    expect(assertIdx).toBeGreaterThan(-1);
    expect(executeIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeLessThan(executeIdx);
  });
});

describe("§7.F: idempotent ved gjentatt kjøring", () => {
  it("ingen destruktive docker/SQL-argumenter (kun faktiske CLI-argument-literaler sjekket, ikke forklarende kommentarer)", () => {
    expect(hostRunSource).not.toMatch(/"down"/);
    expect(hostRunSource).not.toMatch(/"-v"/);
    expect(hostRunSource).not.toMatch(/DROP (DATABASE|TABLE)/i);
  });

  it("--force-recreate er skopet til KUN api/worker (aldri postgres)", () => {
    const match = hostRunSource.match(/"up", "-d", "--force-recreate", "([^"]+)", "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("api");
    expect(match?.[2]).toBe("worker");
  });
});

describe("§7.G: ingen secrets logges", () => {
  it("q20-host-run.ts leser KUN ufarlige PATH/PATHEXT-miljøvariabler direkte - aldri noe som kan inneholde et passord/token/secret", () => {
    const envReads = [...hostRunSource.matchAll(/process\.env\["([^"]+)"\]/g)].map((m) => m[1]);
    expect(envReads.length).toBeGreaterThan(0); // PATH/PATHEXT-oppløsningen (Host Recovery #2) leser faktisk noe
    for (const name of envReads) {
      expect(name).toMatch(/^Path(ext)?$|^PATH(EXT)?$/i);
      expect(name).not.toMatch(/PASSWORD|TOKEN|SECRET|KEY/i);
    }
  });

  it("ingen kode-token (kun forklarende prosa-kommentarer nevner variabelnavn) leser eller logger en faktisk passordverdi", () => {
    const codeOnlyLines = hostRunSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnlyLines).not.toMatch(/PASSWORD/);
  });
});

describe("§7.H: tydelig diagnostikk FØR bootstrap forsøkes", () => {
  it("assertRepoRoot() kalles FØRST i main() - før pnpm install/docker/noe annet", () => {
    const mainBody = hostRunSource.slice(hostRunSource.indexOf("function main(): void {"));
    const repoRootIdx = mainBody.indexOf("assertRepoRoot();");
    const installIdx = mainBody.indexOf("ensureWorkspaceInstalled();");
    expect(repoRootIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(repoRootIdx).toBeLessThan(installIdx);
  });

  it("assertRepoRoot() kaster en beskrivende feil (ikke en kryptisk ENOENT) hvis kjørt fra feil mappe", () => {
    expect(hostRunSource).toMatch(/Ikke kjørt fra repo-roten/);
  });

  it("dokumenterer eksplisitt at Node 24 er kompatibelt (root cause var IKKE Node-versjon)", () => {
    expect(hostRunSource).toMatch(/host_node_version/);
    expect(hostRunSource).toMatch(/ikke root cause/);
  });
});

describe("§7.I: ett-kommando-runneren når faktisk frem til Q-20-akseptansen", () => {
  it("siste steg i main() er runQ20Acceptance(), som kjører modules/erasure/scripts/q20-erasure-live.ts", () => {
    const mainBody = hostRunSource.slice(hostRunSource.indexOf("function main(): void {"), hostRunSource.indexOf("try {\n  main();"));
    expect(mainBody).toContain("runQ20Acceptance();");
    const runQ20Body = hostRunSource.slice(hostRunSource.indexOf("function runQ20Acceptance"));
    expect(runQ20Body).toContain("modules/erasure/scripts/q20-erasure-live.ts");
  });

  it("q20-host-run.ts importerer KUN Node-innebygde moduler eller rene relative lib-filer på toppnivå (må kunne kjøre FØR pnpm install - aldri @jarvis/*/npm-pakker)", () => {
    const importLines = hostRunSource.split("\n").filter((l) => l.trim().startsWith("import "));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).toMatch(/from "(node:|\.\/lib\/)/);
      expect(line).not.toMatch(/from "@jarvis\//);
    }
  });
});
