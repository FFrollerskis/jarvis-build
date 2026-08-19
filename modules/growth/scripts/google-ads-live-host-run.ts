// UA-4 GOOGLE ADS ADAPTER (D-83) - HOST RUN
// ÉN host-kommando som bootstrapper workspacet, sikrer et FERSKT
// migrate/api/worker-image, kjører migrasjonene via admin-rollen, og kjører
// til slutt selve live-akseptansen (`modules/growth/scripts/google-ads-live.ts`).
// Speiler NØYAKTIG samme struktur som `ua4-growth-core-host-run.ts` og alle
// øvrige UA-3/UA-4-host-run-scriptene - ingen ny mekanisme.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale relative imports (SAMME delte lib som de øvrige host-run-scriptene -
// ALDRI en duplisert kopi). Dette scriptet MÅ kunne kjøre FØR `pnpm install`
// har bootstrappet workspacet.
//
// DETTE ER DEN ENE FORVENTEDE KOMMANDOEN (kjøres PÅ HOSTEN, fra repo-roten) -
// BÅDE FØR og ETTER Tobias har konfigurert Google Ads-credentials (se D-83 i
// DECISIONS_AND_ASSUMPTIONS.md for den eksakte oppsettsekvensen). Ingen
// manuell curl, ingen manuell SQL, ingen flere scripts:
//
//   node --env-file=.env --experimental-transform-types modules/growth/scripts/google-ads-live-host-run.ts
//
// Kjørt FØR credentials er konfigurert: gir et rent, forklarende
// BLOCKED_NO_CREDENTIALS-resultat (hard_fail=false - IKKE en runner-feil).
// Kjørt ETTER: gir et ekte LIVE_PROVIDER_VERIFIED-resultat.
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations` (kjører
// aldri om igjen), Docker-images bygges alltid ferske, selve akseptansen er
// selv idempotent (egen kjøre-unik tenant-suffiks + selvopprydding per
// kjøring). Sletter ALDRI Docker-volumer, databasedata, `.env`, ekte
// business-/kundedata, eller noe i selve Google Ads-kontoen (KUN lesing mot
// Google - se google-ads-live.ts sin egen toppkommentar for Finance
// Integrity-grensen).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[google-ads-live-host-run] ${msg}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. D-83 Google Ads-adapteren)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // Ingen NY migrasjon i D-83 (gjenbruker 027_growth.sql/028_growth_attribution_tracking.sql
  // uendret) - `migrate` kjøres likevel for konsistens med alle øvrige
  // host-run-scriptene (idempotent, sporer allerede anvendte filer i
  // `schema_migrations`, ALDRI en DB-reset).
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runGoogleAdsLiveAcceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/growth/scripts/google-ads-live.ts"]);
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

  log("bootstrap fullført - kjører Google Ads live-akseptanse (google-ads-live.ts)...");
  runGoogleAdsLiveAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[google-ads-live-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
