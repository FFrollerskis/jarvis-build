// UA-2 P1A HOST RUN - ÉN host-kommando som bootstrapper workspacet (samme
// pnpm-resolusjon som q20-host-run.ts - ingen ny logikk oppfunnet her),
// sikrer et FERSKT api/worker/migrate-image (samme "always rebuild"-leksjon
// fra Q-21 host-runde 3/Q-20), kjører migrasjonene (INGEN nye migrasjoner i
// P1A - kun en sikkerhetsnett-kjøring for en host som skulle ligge etter),
// og kjører til slutt selve P1A-akseptansen
// (`modules/knowledge/scripts/ua2-p1a-live.ts`).
//
// Til forskjell fra `q20-host-run.ts`: P1A la IKKE til noen ny
// pnpm-workspace-pakke (Drive/Obsidian-kildene bor i det EKSISTERENDE
// `@jarvis/knowledge`) - derfor er det ingen egen
// "verify-workspace-resolution"-steg her, kun standard install+docker-kjeden.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale imports (samme regel som q20-host-run.ts - dette scriptet MÅ kunne
// kjøre FØR `pnpm install` har bootstrappet workspacet).
//
// Kjøres PÅ HOSTEN (Windows/Docker), fra repo-roten:
//
//   node --experimental-transform-types modules/core/scripts/ua2-p1a-host-run.ts
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations`,
// Docker-images bygges alltid ferske, `ua2-p1a-live.ts` er selv idempotent
// (egen run_id + selvopprydding per kjøring, self-heal av forrige kjørings
// rester). Sletter ALDRI Docker-volumes, databasedata, `.env`, eller
// `.env.bak.*`, og skriver/sletter ALDRI noe i en ekte Google Drive eller
// Tobias sin ekte Obsidian-vault.
//
// Forutsetter (uendret fra Q-21/Q-20): `.env` allerede korrekt konfigurert
// med JARVIS_DB_ADMIN_USER/PASSWORD (migrate) og JARVIS_DB_USER/PASSWORD
// (jarvis_runtime). Google Drive LIVE-akseptansen er BETINGET - se
// ua2-p1a-live.ts §6 - og krever i tillegg JARVIS_GOOGLE_CLIENT_ID/SECRET,
// JARVIS_GOOGLE_TOKEN og JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID (en DEDIKERT,
// trygg test-mappe - IKKE hele driven). Mangler noen av disse, rapporteres
// google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE - aldri en fake PASS.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "./lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[ua2-p1a-host-run] ${msg}`);
}

// DEP0190: samme regel som q20-host-run.ts - `execFileSync` kjøres ALLTID med
// et rent argv-array, ALDRI `shell: true`. Windows `.cmd`-shims håndteres av
// `buildSpawnInvocation()` (lib/package-manager-resolve.ts), ikke her.
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. P1A-kode)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // Ingen NY migrasjon i P1A - denne kjøringen er et sikkerhetsnett (no-op
  // hvis alt allerede er anvendt, `runMigrations()` sporer i schema_migrations).
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runP1aAcceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/knowledge/scripts/ua2-p1a-live.ts"]);
}

function main(): void {
  assertRepoRoot();
  ensureWorkspaceInstalled();

  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - Q-21/Q-20 er allerede løst på denne hosten; kopier .env.example til .env hvis den mangler helt.`);
  }
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

  ensurePostgresAndFreshImages(composeArgs);
  applyMigrationsAndRestart(composeArgs);

  log("bootstrap fullført - kjører UA-2 P1A-akseptanse (ua2-p1a-live.ts)...");
  runP1aAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[ua2-p1a-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
