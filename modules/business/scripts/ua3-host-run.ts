// UA-3 P0 (Business Domain Foundation) HOST RUN - ÉN host-kommando som
// bootstrapper workspacet (denne branchen la til en NY pnpm-workspace-pakke,
// `modules/business` - en host som installerte avhengigheter FØR den pakken
// eksisterte har aldri fått `node_modules`/symlinks for den), sikrer et
// FERSKT migrate/api/worker-image (samme "always rebuild"-leksjon som
// Q-21/Q-20 host-runder), kjører migrasjonene (inkl. `019_business.sql`) via
// admin-rollen, og kjører til slutt selve UA-3-akseptansen
// (`modules/business/scripts/ua3-business-live.ts`). Speiler NØYAKTIG samme
// struktur som `modules/core/scripts/q20-host-run.ts` - ingen ny mekanisme.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale relative imports (`../../core/scripts/lib/package-manager-resolve.ts`,
// SAMME delte lib som q20-host-run.ts/ua2-p1b-a-host-run.ts - ALDRI en
// duplisert kopi). Dette scriptet MÅ kunne kjøre FØR `pnpm install` har
// bootstrappet workspacet.
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten:
//
//   node --experimental-transform-types modules/business/scripts/ua3-host-run.ts
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations` (kjører
// aldri om igjen), Docker-images bygges alltid ferske, `ua3-business-live.ts`
// er selv idempotent (egen kjøre-unik tenant-suffiks + selvopprydding per
// kjøring, samme mønster som q20-erasure-live.ts). Sletter ALDRI
// Docker-volumes, databasedata, `.env`, eller ekte kunde-/forretningsdata.
//
// Forutsetter (uendret fra Q-21): `.env` allerede korrekt konfigurert.
// Dette scriptet endrer ALDRI `.env`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";
import { requireProductionMutationConsent } from "../../core/scripts/lib/production-mutation-guard.ts";

// Remediering del 1 (JARVIS-086): mutates the live stack - refuses without explicit consent.
requireProductionMutationConsent("ua3-host-run.ts");

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[ua3-host-run] ${msg}`);
}

// DEP0190-trygt: `execFileSync` kjøres ALLTID med et rent argv-array, ALDRI
// `shell: true` - Windows `.cmd`-shims håndteres av `buildSpawnInvocation()`.
function run(command: string, args: string[], cwd: string = repoRoot): void {
  log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd });
}

function assertRepoRoot(): void {
  const workspaceFile = join(repoRoot, "pnpm-workspace.yaml");
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  if (!existsSync(workspaceFile) || !existsSync(composeFile)) {
    throw new Error(
      `Ikke kjørt fra repo-roten (fant ikke ${workspaceFile} og/eller ${composeFile}). ` +
        "Kjør kommandoen fra roten av jarvisbuild-repoet."
    );
  }
  log(`repo_root=PASS (${repoRoot})`);
}

function ensureWorkspaceInstalled(): void {
  const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
  const pinned = readPinnedPackageManager(packageJson);
  if (!pinned || pinned.name !== "pnpm") {
    throw new Error(`package.json sitt "packageManager"-felt mangler eller er ikke pnpm-basert: ${JSON.stringify(pinned)}`);
  }
  const resolved = resolvePackageManager(
    {
      platform: process.platform,
      pathEnv: process.env["PATH"] ?? process.env["Path"] ?? "",
      pathExt: process.env["PATHEXT"] ?? process.env["Pathext"] ?? "",
      exists: existsSync
    },
    pinned
  );
  log(`package_manager_resolution=PASS package_manager_driver=${resolved.driver} package_manager_version=${pinned.version}`);
  const invocation = buildSpawnInvocation(resolved, ["install", "--frozen-lockfile"]);
  run(invocation.command, invocation.args);
  log("install_frozen_lockfile=PASS workspace_install=PASS");
}

function ensurePostgresAndFreshImages(composeArgs: string[]): void {
  run("docker", [...composeArgs, "up", "-d", "postgres"]);
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. UA-3-kode)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // Kjører migrasjonene (inkl. 019_business.sql) via ADMIN-rollen - runMigrations()
  // sporer allerede anvendte filer i `schema_migrations` (idempotent, ingen DB-reset).
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runUa3Acceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/business/scripts/ua3-business-live.ts"]);
}

function main(): void {
  assertRepoRoot();
  ensureWorkspaceInstalled();

  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kopier .env.example til .env hvis den mangler helt.`);
  }
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

  ensurePostgresAndFreshImages(composeArgs);
  applyMigrationsAndRestart(composeArgs);

  log("bootstrap fullført - kjører UA-3 P0-akseptanse (ua3-business-live.ts)...");
  runUa3Acceptance();
}

try {
  main();
} catch (err) {
  console.error(`[ua3-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
