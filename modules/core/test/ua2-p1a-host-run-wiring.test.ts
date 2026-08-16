import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-2 P1A §30: `modules/core/scripts/ua2-p1a-host-run.ts` er den ENE
 * host-kommandoen Tobias trenger for å verifisere Drive/Obsidian-kildene mot
 * en ekte Docker-Postgres. Speiler mønsteret i `q20-host-run.ts`
 * (samme pnpm-resolusjon, samme "always rebuild"-leksjon, samme
 * idempotens-/sikkerhetsgarantier) - denne suiten beviser den strukturelt,
 * på nøyaktig samme måte som q20-host-run-wiring.test.ts, uten å faktisk
 * kjøre Docker/pnpm (det er selve host-akseptansens jobb).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua2-p1a-host-run.ts");
const liveScriptSource = readSource("../../knowledge/scripts/ua2-p1a-live.ts");

describe("workspace bootstrap - ingen ny pnpm-pakke i P1A, kun standard install", () => {
  it("kjører `install --frozen-lockfile` (via den resolvede package manager-en) FØR docker/migrasjoner", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(dockerIdx);
  });

  it("bruker --frozen-lockfile (aldri --no-frozen-lockfile, aldri en variant som skriver om lockfilen)", () => {
    expect(hostRunSource).toMatch(/--frozen-lockfile/);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
    expect(hostRunSource).not.toMatch(/pnpm.*update/);
  });

  it("bruker samme Windows-sikre package-manager-resolusjon som Q-20 (buildSpawnInvocation, aldri shell:true)", () => {
    expect(hostRunSource).toContain("buildSpawnInvocation");
    expect(hostRunSource).toContain("readPinnedPackageManager");
    expect(hostRunSource).toContain("resolvePackageManager");
    // Kun kode-linjer sjekkes - forklarende kommentarer om HVORFOR shell:true
    // unngås (som den rett over denne testen) skal ikke telle som et treff.
    const codeOnlyLines = hostRunSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnlyLines).not.toMatch(/shell:\s*true/);
  });
});

describe("migrate/api/worker bygges ferske FØR migrate kjøres (Q-21 host-runde 3-leksjonen)", () => {
  it("bygger migrate/api/worker FØR migrate faktisk kjøres", () => {
    const buildIdx = hostRunSource.indexOf('"build", "migrate", "api", "worker"');
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(migrateRunIdx);
  });

  it("kjører migrate FØR ua2-p1a-live.ts", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveCallIdx = hostRunSource.indexOf('run("node", ["--env-file=.env"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(liveCallIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeLessThan(liveCallIdx);
  });

  it("P1A la IKKE til noen ny migrasjonsfil (Drive/Obsidian gjenbruker knowledge_documents/knowledge_embeddings uendret)", () => {
    const migrationsDir = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
    const migrationFiles = readdirSync(migrationsDir).filter((f) => /^\d{3}_.*\.sql$/.test(f));
    const highestNumber = Math.max(...migrationFiles.map((f) => Number(f.slice(0, 3))));
    expect(existsSync(join(migrationsDir, "018_erasure.sql"))).toBe(true);
    expect(highestNumber).toBe(18); // Q-20 (018) er fortsatt den siste - P1A la ikke til noen ny migrasjon
  });
});

describe("Q-21 admin/runtime-splitt regresserer ikke", () => {
  it("ua2-p1a-host-run.ts skriver/endrer ALDRI .env", () => {
    expect(hostRunSource).not.toMatch(/writeFileSync/);
    expect(hostRunSource).not.toMatch(/renameSync/);
    expect(hostRunSource).not.toMatch(/copyFileSync/);
  });

  it("kjører ua2-p1a-live.ts med samme --env-file=.env-kontrakt som Q-20/Q-21", () => {
    expect(hostRunSource).toMatch(/--env-file=\.env/);
  });

  it("ua2-p1a-live.ts verifiserer selv Q-21-rollen (assertRuntimeRoleSafe) FØR noe destruktivt - ingen duplisert logikk i host-runneren", () => {
    expect(liveScriptSource).toContain("assertRuntimeRoleSafe");
    const assertIdx = liveScriptSource.indexOf("assertRuntimeRoleSafe(pool)");
    const registryIdx = liveScriptSource.indexOf("§2 SOURCE REGISTRY");
    expect(assertIdx).toBeGreaterThan(-1);
    expect(registryIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeLessThan(registryIdx);
  });
});

describe("idempotent ved gjentatt kjøring, ingen destruktive argumenter", () => {
  it("ingen destruktive docker/SQL-argumenter", () => {
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

describe("Google Drive LIVE er BETINGET - aldri en fake PASS uten trygt test-scope", () => {
  it("ua2-p1a-live.ts krever client_id/client_secret/token/test_folder_id ALLE fire, ellers BLOCKED_NO_SAFE_TEST_SCOPE (alle google_drive_*-felt default dit, guarden returnerer FØR noe overskrives)", () => {
    expect(liveScriptSource).toContain("JARVIS_GOOGLE_CLIENT_ID");
    expect(liveScriptSource).toContain("JARVIS_GOOGLE_CLIENT_SECRET");
    expect(liveScriptSource).toContain("JARVIS_GOOGLE_TOKEN");
    expect(liveScriptSource).toContain("JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID");
    // Alle google_drive_*-felt i `results` defaulter til BLOCKED_NO_SAFE_TEST_SCOPE:
    const defaultsBlock = liveScriptSource.slice(liveScriptSource.indexOf("const results: Record"), liveScriptSource.indexOf("};", liveScriptSource.indexOf("const results: Record")));
    const driveFieldLines = defaultsBlock.split("\n").filter((l) => l.includes("google_drive_"));
    expect(driveFieldLines.length).toBeGreaterThan(5);
    for (const line of driveFieldLines) {
      expect(line).toContain("BLOCKED_NO_SAFE_TEST_SCOPE");
    }
    // Guarden returnerer (ingen overskriving) FØR noe live-kall forsøkes:
    const guardIdx = liveScriptSource.indexOf("!clientId || !clientSecret || !refreshToken || !testFolderId");
    const listCallIdx = liveScriptSource.indexOf('drive("list_files"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(listCallIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(listCallIdx);
  });

  it("Drive-akseptansen rapporterer BLOCKED_REAUTH_REQUIRED - ikke en fake PASS - når lesing fungerer men skriving feiler på auth (utilstrekkelig scope)", () => {
    expect(liveScriptSource).toContain("BLOCKED_REAUTH_REQUIRED");
    expect(liveScriptSource).toContain("isReauthSignal");
    expect(liveScriptSource).toMatch(/auth_error_401\|auth_error_403/);
  });

  it("Drive-akseptansen sletter PERMANENT kun artefakter DEN SELV opprettet (createdFileIds), aldri noe annet i test-mappen", () => {
    expect(liveScriptSource).toContain("createdFileIds");
    const cleanupIdx = liveScriptSource.indexOf("§cleanup");
    const deleteLoopIdx = liveScriptSource.indexOf("for (const fileId of createdFileIds)");
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(deleteLoopIdx).toBeGreaterThan(cleanupIdx);
  });

  it("permission-mutasjon er BEVISST IKKE live-testet (kan ikke gjøres trygt uten å involvere ekte personer/eksponering)", () => {
    expect(liveScriptSource).toMatch(/Permission-mutasjon.*BEVISST IKKE/s);
  });

  it("Drive-akseptansen bruker en 'folder'-scope (aldri whole_drive) mot en dedikert test-mappe", () => {
    expect(liveScriptSource).toMatch(/\{ kind: "folder", folder_id: testFolderId \}/);
  });

  it("scanner OAuth-tokenet mot audit_events OG knowledge_documents.metadata etter Drive-sync - beviser at det aldri lekker", () => {
    expect(liveScriptSource).toContain("tokenLeak");
    expect(liveScriptSource).toContain("docLeak");
    expect(liveScriptSource).toMatch(/audit_events WHERE tenant_id=\$1 AND tool_id='drive'/);
  });
});

describe("Obsidian bruker KUN en isolert midlertidig vault - aldri Tobias sin ekte vault", () => {
  it("vault-roten opprettes via mkdtemp under systemets tmpdir, aldri en fast/konfigurert sti", () => {
    expect(liveScriptSource).toContain('mkdtemp(join(tmpdir(), "jarvis-p1a-live-vault-"))');
    expect(liveScriptSource).not.toMatch(/vault_root\s*=\s*process\.env/);
  });

  it("den midlertidige vaulten ryddes opp ved slutten (§8 CLEANUP)", () => {
    const cleanupIdx = liveScriptSource.indexOf("§8 CLEANUP");
    const rmIdx = liveScriptSource.indexOf("if (vaultRoot) await rm(vaultRoot");
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(cleanupIdx);
  });
});

describe("ingen secrets logges", () => {
  it("ua2-p1a-host-run.ts leser KUN ufarlige PATH/PATHEXT-miljøvariabler direkte", () => {
    const envReads = [...hostRunSource.matchAll(/process\.env\["([^"]+)"\]/g)].map((m) => m[1]);
    expect(envReads.length).toBeGreaterThan(0);
    for (const name of envReads) {
      expect(name).toMatch(/^Path(ext)?$|^PATH(EXT)?$/i);
      expect(name).not.toMatch(/PASSWORD|TOKEN|SECRET|KEY/i);
    }
  });

  it("ua2-p1a-live.ts leser Google-credential-verdier KUN for å sende dem videre til SecretProvider/OAuth - aldri til log()", () => {
    const codeOnlyLines = liveScriptSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // De ENESTE stedene disse variabelnavnene skal opptre i kode er selve
    // process.env-oppslaget og boolean-tilstedeværelse-loggingen (Boolean(...)),
    // ALDRI en log() med selve verdien.
    expect(codeOnlyLines).not.toMatch(/log\(`[^`]*\$\{refreshToken\}/);
    expect(codeOnlyLines).not.toMatch(/log\(`[^`]*\$\{clientSecret\}/);
  });
});

describe("ett-kommando-runneren når faktisk frem til P1A-akseptansen", () => {
  it("siste steg i main() er runP1aAcceptance(), som kjører modules/knowledge/scripts/ua2-p1a-live.ts", () => {
    const mainBody = hostRunSource.slice(hostRunSource.indexOf("function main(): void {"), hostRunSource.indexOf("try {\n  main();"));
    expect(mainBody).toContain("runP1aAcceptance();");
    const runBody = hostRunSource.slice(hostRunSource.indexOf("function runP1aAcceptance"));
    expect(runBody).toContain("modules/knowledge/scripts/ua2-p1a-live.ts");
  });

  it("ua2-p1a-host-run.ts importerer KUN Node-innebygde moduler eller rene relative lib-filer på toppnivå", () => {
    const importLines = hostRunSource.split("\n").filter((l) => l.trim().startsWith("import "));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).toMatch(/from "(node:|\.\/lib\/)/);
      expect(line).not.toMatch(/from "@jarvis\//);
    }
  });

  it("ua2-p1a-live.ts eksisterer og er referert med korrekt relativ sti fra repo-roten", () => {
    const liveScriptPath = fileURLToPath(new URL("../../knowledge/scripts/ua2-p1a-live.ts", import.meta.url));
    expect(existsSync(liveScriptPath)).toBe(true);
  });
});
