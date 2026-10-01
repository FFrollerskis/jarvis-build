// D-180 (W1) WATCHDOG PRODUCTION WIRING + DURABLE EMERGENCY SHUTDOWN - HOST RUN
//
// ÉN host-kommando som bootstrapper workspacet, sikrer et FERSKT
// migrate/api/worker-image fra gjeldende kildekode, kjører migrasjonene via
// admin-rollen, restarter api/worker på det ferske imaget, og kjører til
// slutt selve akseptansen (`w1-watchdog-durability-live.ts`). Speiler
// NØYAKTIG samme struktur som `d174-executive-control-surface-host-run.ts`/
// `k1-owner-control-authority-host-run.ts` - ingen ny mekanisme.
//
// Kjøres PÅ HOSTEN (Windows + Docker Desktop), fra repo-roten:
//
//   node --env-file=.env --experimental-transform-types modules/watchdog/scripts/w1-watchdog-durability-host-run.ts
//
// VIKTIG: denne akseptansen aktiverer KORTVARIG (noen få sekunder, flere
// ganger) den EKTE, GLOBALE kill switchen midt i kjøringen. Kjør derfor
// IKKE dette samtidig med annen aktiv bruk av Jarvis. Scriptet deaktiverer/
// gjenoppretter ALLTID i `finally` (også ved feil) og verifiserer til slutt
// at `owner_control_state` er UENDRET fra før kjøringen.
//
// INGEN ekte Telegram-API-kall (skriptbar fake ved nettverksgrensen - se
// live-scriptets filhode). INGEN ny credential kreves.
//
// Trygt å kjøre flere ganger (idempotent): samme disiplin som alle andre
// host-run-script i repoet.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";
import { requireProductionMutationConsent } from "../../core/scripts/lib/production-mutation-guard.ts";

// Remediering del 1 (JARVIS-086): mutates the live stack - refuses without explicit consent.
requireProductionMutationConsent("w1-watchdog-durability-host-run.ts");

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[w1-watchdog-durability-host-run] ${msg}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. W1-endringene)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // W1 legger IKKE til noen ny migrasjon (INGEN nytt schema - kun ny
  // watchdog-wiring/kode) - `migrate` kjøres likevel (idempotent, ufarlig)
  // for å garantere at DENNE kjøringen ser et fullt oppgradert schema,
  // SAMME disiplin som alle andre host-run-script i repoet.
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runWatchdogDurabilityAcceptance(): void {
  run("node", [
    "--env-file=.env", "--experimental-transform-types",
    "modules/watchdog/scripts/w1-watchdog-durability-live.ts"
  ]);
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

  log("bootstrap fullført - kjører W1 Watchdog Durability-akseptanse (w1-watchdog-durability-live.ts)...");
  runWatchdogDurabilityAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[w1-watchdog-durability-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
