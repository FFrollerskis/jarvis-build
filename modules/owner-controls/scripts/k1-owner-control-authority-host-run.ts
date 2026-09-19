// K1 (Sovereign graduation, D-164) OWNER CONTROL AUTHORITY - HOST RUN
//
// ÉN host-kommando som bootstrapper workspacet, sikrer et FERSKT
// migrate/api/worker-image fra gjeldende kildekode, kjører migrasjonene via
// admin-rollen (denne sliceen HAR en ny migrasjon: 058_owner_control_authority.sql
// - migrate-steget er lastbærende, ikke seremonielt), restarter api/worker på
// det ferske imaget, og kjører til slutt selve akseptansen
// (`k1-owner-control-authority-live.ts`). Speiler NØYAKTIG samme struktur som
// `ua10-p1-situation-sweep-host-run.ts` - ingen ny mekanisme.
//
// Kjøres PÅ HOSTEN (Windows + Docker Desktop), fra repo-roten:
//
//   node --env-file=.env --experimental-transform-types modules/owner-controls/scripts/k1-owner-control-authority-host-run.ts
//
// VIKTIG (annerledes enn de fleste andre host-run-scriptene): denne
// akseptansen aktiverer KORTVARIG den EKTE, GLOBALE kill switchen midt i
// kjøringen (det er selve poenget - K1 beviser at api OG worker ser SAMME
// stans/gjenopptak, OGSÅ over en EKTE container-restart). Så lenge scriptet
// kjører, vil ALLE andre samtidige verktøykall i systemet (klasse B/C/D)
// midlertidig nektes ("kill_switch_active") - eksakt den tiltenkte, globale
// virkningen av en kill switch. Kjør derfor IKKE dette samtidig med annen
// aktiv bruk av Jarvis. Scriptet deaktiverer ALLTID kill switchen igjen i
// `finally` (også ved feil) og verifiserer til slutt at systemets tilstand
// er UENDRET fra før kjøringen (ingen data slettet, ingen ekte frys/
// tilbakekall røres, ingen ekte domenepause).
//
// INGEN ny credential kreves.
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations`
// (kjører aldri om igjen), Docker-images bygges alltid ferske. Sletter ALDRI
// Docker-volumer, databasedata, `.env` eller ekte business-/kundedata.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[k1-owner-control-authority-host-run] ${msg}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. K1 + 058-migrasjonen)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // NY migrasjon i denne sliceen (058_owner_control_authority.sql) - kjøres
  // via ADMIN-rollen (idempotent, ingen DB-reset), deretter restart av
  // api/worker på det ferske imaget slik at durable `owner_controls.*` er
  // registrert i runtime FØR selve akseptansen (som senere OGSÅ restarter
  // dem MIDT i kjøringen - det er selve K1-beviset, se live-scriptet).
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runOwnerControlAuthorityAcceptance(composeArgs: string[]): void {
  // Live-scriptet trenger compose-argumentene selv (den utfører EN restart
  // MIDT i akseptansen, for å bevise durabilitet over en EKTE container-
  // restart - se scriptets eget filhode for hvorfor dette avviker fra de
  // øvrige host-run/-live-parene, som alltid restarter FØR akseptansen).
  run("node", [
    "--env-file=.env", "--experimental-transform-types",
    "modules/owner-controls/scripts/k1-owner-control-authority-live.ts",
    "--compose-args", JSON.stringify(composeArgs)
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

  log("bootstrap fullført - kjører K1 Owner Control Authority-akseptanse (k1-owner-control-authority-live.ts)...");
  runOwnerControlAuthorityAcceptance(composeArgs);
}

try {
  main();
} catch (err) {
  console.error(`[k1-owner-control-authority-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
