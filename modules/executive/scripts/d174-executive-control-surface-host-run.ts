// D-174 (B2+B3) UNIFIED OWNER CONTROL-SURFACE MUTATION COMPLETION - HOST RUN
//
// ÉN host-kommando som bootstrapper workspacet, sikrer et FERSKT
// migrate/api/worker-image fra gjeldende kildekode, kjører migrasjonene via
// admin-rollen, restarter api/worker på det ferske imaget, og kjører til
// slutt selve akseptansen (`d174-executive-control-surface-live.ts`). Speiler
// NØYAKTIG samme struktur som `k1-owner-control-authority-host-run.ts` - ingen
// ny mekanisme. I MOTSETNING til DEN (K1) restarter DENNE akseptansen ALDRI
// containere midt i kjøringen - api-/worker-prosessparitet OG durabilitet over
// en EKTE container-restart er ALLEREDE bevist av K1/B1 (D-164/D-166); denne
// akseptansen beviser KUN det B2+B3 la til (se live-scriptets filhode).
//
// Kjøres PÅ HOSTEN (Windows + Docker Desktop), fra repo-roten:
//
//   node --env-file=.env --experimental-transform-types modules/executive/scripts/d174-executive-control-surface-host-run.ts
//
// VIKTIG: denne akseptansen aktiverer KORTVARIG (noen få sekunder, flere
// ganger) den EKTE, GLOBALE kill switchen OG den EKTE, delte finans-
// nødbryteren for JARVIS_TENANT_ID midt i kjøringen. Kjør derfor IKKE dette
// samtidig med annen aktiv bruk av Jarvis. Scriptet deaktiverer/gjenoppretter
// ALLTID begge i `finally` (også ved feil) og verifiserer til slutt at
// `owner_control_state` er UENDRET fra før kjøringen.
//
// INGEN ekte Wallester-/finans-provider-kall (fake ved nettverksgrensen - se
// live-scriptets filhode). INGEN ny credential kreves. INGEN ekte enhet
// (kjøre-unik synthetic device_id/session_id, fjernet i CLEANUP).
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations`
// (kjører aldri om igjen), Docker-images bygges alltid ferske. Sletter ALDRI
// Docker-volumer, databasedata, `.env` eller ekte business-/kundedata.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";
import { requireProductionMutationConsent } from "../../core/scripts/lib/production-mutation-guard.ts";

// Remediering del 1 (JARVIS-086): mutates the live stack - refuses without explicit consent.
requireProductionMutationConsent("d174-executive-control-surface-host-run.ts");

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[d174-executive-control-surface-host-run] ${msg}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. D-174-endringene)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // D-174 legger IKKE til noen ny migrasjon (INGEN nytt schema - kun ny
  // ToolGateway-komposisjon/kode) - `migrate` kjøres likevel (idempotent,
  // ufarlig) for å garantere at DENNE kjøringen ser et fullt oppgradert
  // schema, SAMME disiplin som alle andre host-run-script i repoet.
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runExecutiveControlSurfaceAcceptance(): void {
  run("node", [
    "--env-file=.env", "--experimental-transform-types",
    "modules/executive/scripts/d174-executive-control-surface-live.ts"
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

  log("bootstrap fullført - kjører D-174 Executive Control-Surface-akseptanse (d174-executive-control-surface-live.ts)...");
  runExecutiveControlSurfaceAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[d174-executive-control-surface-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
