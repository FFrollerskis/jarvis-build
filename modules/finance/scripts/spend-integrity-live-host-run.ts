// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - ANDRE SLICE (Slice 2) - HOST RUN
// ÉN host-kommando som bootstrapper workspacet, sikrer et FERSKT
// migrate/api/worker-image, kjører migrasjonene via admin-rollen, og kjører
// til slutt selve live-akseptansen (`modules/finance/scripts/spend-integrity-live.ts`).
// Speiler NØYAKTIG samme struktur som `fiken-live-host-run.ts` (D-107 FØRSTE
// slice) og alle øvrige UA-3/UA-4/UA-6-host-run-scriptene - ingen ny mekanisme.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale relative imports (SAMME delte lib som de øvrige host-run-scriptene -
// ALDRI en duplisert kopi). Dette scriptet MÅ kunne kjøre FØR `pnpm install`
// har bootstrappet workspacet.
//
// ZERO ekstern leverandør-credential nødvendig (D-108) - HELE denne
// akseptansen kjører KUN mot interne kilder Jarvis allerede eier.
//
//   node --env-file=.env --experimental-transform-types modules/finance/scripts/spend-integrity-live-host-run.ts
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
import { requireProductionMutationConsent } from "../../core/scripts/lib/production-mutation-guard.ts";

// Remediering del 1 (JARVIS-086): mutates the live stack - refuses without explicit consent.
requireProductionMutationConsent("spend-integrity-live-host-run.ts");

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[spend-integrity-live-host-run] ${msg}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. Slice 2 sitt utgifts-integritetsdomene)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runSpendIntegrityLiveAcceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/finance/scripts/spend-integrity-live.ts"]);
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

  log("bootstrap fullført - kjører Spend Integrity live-akseptanse (spend-integrity-live.ts)...");
  runSpendIntegrityLiveAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[spend-integrity-live-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
