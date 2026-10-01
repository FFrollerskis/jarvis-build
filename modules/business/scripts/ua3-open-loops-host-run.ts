// UA-3 NEXT SLICE (D-53) - OPEN-LOOP-DETEKSJON + BUSINESS BRIEF HOST RUN -
// ÉN host-kommando som bootstrapper workspacet, sikrer et FERSKT
// migrate/api/worker-image, kjører migrasjonene (inkl. NYE
// `020_business_open_loops.sql`) via admin-rollen, og kjører til slutt selve
// akseptansen (`modules/business/scripts/ua3-open-loops-live.ts`). Speiler
// NØYAKTIG samme struktur som `modules/business/scripts/ua3-host-run.ts`
// (P0) - ingen ny mekanisme.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale relative imports (SAMME delte lib som q20-host-run.ts/
// ua3-host-run.ts - ALDRI en duplisert kopi). Dette scriptet MÅ kunne kjøre
// FØR `pnpm install` har bootstrappet workspacet.
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten:
//
//   node --experimental-transform-types modules/business/scripts/ua3-open-loops-host-run.ts
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations` (kjører
// aldri om igjen), Docker-images bygges alltid ferske,
// `ua3-open-loops-live.ts` er selv idempotent (egen kjøre-unik
// tenant-suffiks + selvopprydding per kjøring). Sletter ALDRI Docker-volumes,
// databasedata, `.env`, eller ekte kunde-/forretningsdata.
//
// Forutsetter (uendret fra Q-21/UA-3 P0): `.env` allerede korrekt
// konfigurert. Dette scriptet endrer ALDRI `.env`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";
import { requireProductionMutationConsent } from "../../core/scripts/lib/production-mutation-guard.ts";

// Remediering del 1 (JARVIS-086): mutates the live stack - refuses without explicit consent.
requireProductionMutationConsent("ua3-open-loops-host-run.ts");

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[ua3-open-loops-host-run] ${msg}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. open-loop-koden)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // Kjører migrasjonene (inkl. 020_business_open_loops.sql) via ADMIN-rollen - runMigrations()
  // sporer allerede anvendte filer i `schema_migrations` (idempotent, ingen DB-reset).
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runUa3OpenLoopAcceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/business/scripts/ua3-open-loops-live.ts"]);
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

  log("bootstrap fullført - kjører UA-3 open-loop-akseptanse (ua3-open-loops-live.ts)...");
  runUa3OpenLoopAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[ua3-open-loops-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
