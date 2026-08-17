// UA-3 BUSINESS-EVENT-LINKAGE (D-57) HOST RUN - ÉN host-kommando som
// bootstrapper workspacet, sikrer et FERSKT migrate/api/worker-image, kjører
// migrasjonene (inkl. NYE `021_business_contact_email_lookup.sql`) via
// admin-rollen, og kjører til slutt selve akseptansen
// (`modules/business/scripts/ua3-business-events-live.ts`). Speiler NØYAKTIG
// samme struktur som `modules/business/scripts/ua3-open-loops-host-run.ts` -
// ingen ny mekanisme (§22 i byggeordren).
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale relative imports (SAMME delte lib som q20-host-run.ts/
// ua3-host-run.ts/ua3-open-loops-host-run.ts - ALDRI en duplisert kopi).
// Dette scriptet MÅ kunne kjøre FØR `pnpm install` har bootstrappet
// workspacet.
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten:
//
//   node --experimental-transform-types modules/business/scripts/ua3-business-events-host-run.ts
//
// Forutsetter (uendret fra UA-2 P1B-A/D-43/D-45/D-47): `.env` allerede
// konfigurert med EKTE `JARVIS_EMAIL_TOKEN`/`JARVIS_GOOGLE_TOKEN` (samme
// credentials som api/worker sin normale runtime-wiring allerede bruker for
// Gmail/Calendar) - REACHABILITY-seksjonen i selve akseptansescriptet kaller
// disse ekte API-ene. Dette scriptet endrer ALDRI `.env`.
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations`,
// Docker-images bygges alltid ferske, `ua3-business-events-live.ts` er selv
// idempotent (egen kjøre-unik tenant-suffiks + selvopprydding per kjøring).
// Sletter ALDRI Docker-volumes, databasedata, `.env`, eller ekte kunde-/
// forretningsdata.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[ua3-business-events-host-run] ${msg}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. business-event-linkage-koden)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runUa3BusinessEventsAcceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/business/scripts/ua3-business-events-live.ts"]);
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

  log("bootstrap fullført - kjører UA-3 business-event-linkage-akseptanse (ua3-business-events-live.ts)...");
  runUa3BusinessEventsAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[ua3-business-events-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
