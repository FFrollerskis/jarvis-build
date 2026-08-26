// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - FJERDE SLICE (D-110) - VIPPS
// MOBILEPAY GUARDED HOST RUN. ÉN host-kommando som bootstrapper workspacet,
// sikrer et FERSKT migrate/api/worker-image, kjører migrasjonene via
// admin-rollen, og kjører til slutt selve den guardede Vipps-akseptansen
// (`modules/finance/scripts/vipps-live.ts`). Speiler NØYAKTIG samme
// struktur som `stripe-live-host-run.ts` (D-109) - ingen ny mekanisme.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale relative imports - MÅ kunne kjøre FØR `pnpm install` har
// bootstrappet workspacet.
//
// ZERO Vipps-credential nødvendig (D-108/D-110) - HELE denne akseptansen
// beviser produkt-WIRING mot en fake ved Vipps-transportens nettverksgrense,
// ALDRI ekte Vipps-reachability. Guard: eksakt PR-HEAD (verifiseres av det
// PowerShell-vedlagte guard-scriptet FØR denne kommandoen), rent arbeidstre,
// migrasjoner anvendt, runtime-rolle Q-21-verifisert, fail-closed.
//
//   node --env-file=.env --experimental-transform-types modules/finance/scripts/vipps-live-host-run.ts
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations`
// (kjører aldri om igjen), Docker-images bygges alltid ferske, selve
// akseptansen er selv idempotent (egen kjøre-unik tenant-suffiks +
// selvopprydding per kjøring). Sletter ALDRI Docker-volumer, databasedata,
// `.env`, eller noe ekte business-/kundedata.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[vipps-live-host-run] ${msg}`);
}

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

/** Guard (byggeordrens §20): rent arbeidstre - ingen ubestemt/blandet tilstand skal bevises. */
function assertCleanWorktree(): void {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString("utf8").trim();
  if (status.length > 0) {
    throw new Error(`Arbeidstreet er IKKE rent (git status --porcelain viste endringer) - commit/stash FØR host-akseptanse:\n${status}`);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString("utf8").trim();
  log(`clean_worktree=PASS head=${head}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. Slice 4 sitt Vipps-domene)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runVippsLiveAcceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/finance/scripts/vipps-live.ts"]);
}

function main(): void {
  assertRepoRoot();
  assertCleanWorktree();
  ensureWorkspaceInstalled();

  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kopier .env.example til .env hvis den mangler helt.`);
  }
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

  ensurePostgresAndFreshImages(composeArgs);
  applyMigrationsAndRestart(composeArgs);

  log("bootstrap fullført - kjører Vipps guarded live-akseptanse (vipps-live.ts)...");
  runVippsLiveAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[vipps-live-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
