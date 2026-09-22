// D-35 INFISICAL PRODUCTION PORT - LIVE HOST ACCEPTANCE HOST RUN (D-235)
//
// ÉN host-kommando som bootstrapper workspacet, sikrer postgres + infisical +
// infisical-redis kjører (bygger INGEN nye api/worker-images - dette scriptet
// tester Infisical selv, ikke api/worker), kjører migrasjonene (bootstrapper
// jarvis_runtime-rollen, Q-21 - SAMME forutsetning som alle andre host-run-
// scripts), og kjører til slutt selve akseptansen (`infisical-live.ts`).
// Speiler NØYAKTIG samme struktur som `k1-owner-control-authority-host-run.ts`
// (inkl. `--compose-args`-videreformidlingen - `infisical-live.ts` gjør EKTE
// `docker ... exec/restart/stop/start` MIDT i kjøringen, se dens eget filhode).
//
// Kjøres PÅ HOSTEN (Windows + Docker Desktop), fra repo-roten:
//
//   node --env-file=.env --experimental-transform-types modules/owner-controls/scripts/infisical-live-host-run.ts
//
// KREVER (se .env.example, D-235-seksjonen): INFISICAL_ENCRYPTION_KEY/
// INFISICAL_AUTH_SECRET (for selve `infisical`-Docker-tjenesten) OG
// INFISICAL_URL/CLIENT_ID/CLIENT_SECRET/PROJECT_ID/ENV (for InfisicalSecretProvider
// - INFISICAL_URL MÅ være det PUBLISERTE host-endepunktet, f.eks.
// http://127.0.0.1:3060, IKKE api/worker sin container-interne adresse - se
// `requireHostReachableInfisicalUrl()` i infisical-live.ts). Krever OGSÅ at et
// Infisical-prosjekt + universal-auth-maskinidentitet ALLEREDE er opprettet mot
// den kjørende containeren (docs/RUNTIME_GATES.md sin BO-07-seksjon dokumenterer
// DEN ene-gangs admin-bootstrap-prosedyren Tobias allerede har kjørt) - dette
// scriptet oppretter IKKE et Infisical-prosjekt/maskinidentitet selv.
//
// D-235: KODE LEVERT, IKKE HOST-KJØRT - se infisical-live.ts sitt eget filhode.
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile` er
// alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations` (kjører
// aldri om igjen), selve akseptansen bruker KUN kjøre-unike test-artefakter
// (egen test-secret-referanse, egen syntetisk connector-oppføring, egen scratch-
// database for backup/recovery-testen) og rydder opp i `finally`. Sletter ALDRI
// Docker-volumer, `.env`, eller noen ekte credential/connector.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[infisical-live-host-run] ${msg}`);
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

function assertInfisicalEnvPresent(): void {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kopier .env.example til .env hvis den mangler helt.`);
  }
  const envContent = readFileSync(envPath, "utf8");
  const required = ["INFISICAL_URL", "INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_PROJECT_ID"];
  const missing = required.filter((key) => !new RegExp(`^${key}=.+`, "m").test(envContent));
  if (missing.length > 0) {
    throw new Error(
      `Mangler i .env: ${missing.join(", ")}. Se .env.example (D-235-seksjonen, "Infisical (D-35)") for ` +
      "forklaring og docs/RUNTIME_GATES.md sin BO-07-seksjon for hvordan prosjekt/maskinidentitet opprettes " +
      "mot en kjørende Infisical-container FØR dette scriptet kan kjøre."
    );
  }
  log("infisical_env_present=PASS (verdier ikke lest/logget her - selve scriptet gjør sine egne fail-closed sjekker)");
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

function ensureInfraUp(composeArgs: string[]): void {
  // KUN postgres + infisical + infisical-redis - dette scriptet tester
  // Infisical selv, IKKE api/worker (ingen ny api/worker-image bygges/restartes).
  run("docker", [...composeArgs, "up", "-d", "postgres", "infisical-redis", "infisical"]);
  log("bygger migrate fra gjeldende kildekode (bootstrapper jarvis_runtime-rollen, Q-21)...");
  run("docker", [...composeArgs, "build", "migrate"]);
}

function applyMigrations(composeArgs: string[]): void {
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
}

function runInfisicalLiveAcceptance(composeArgs: string[]): void {
  // Live-scriptet trenger compose-argumentene selv (den gjør EKTE
  // docker exec/restart/stop/start mot postgres/infisical MIDT i kjøringen -
  // se infisical-live.ts sitt eget filhode).
  run("node", [
    "--env-file=.env", "--experimental-transform-types",
    "modules/owner-controls/scripts/infisical-live.ts",
    "--compose-args", JSON.stringify(composeArgs)
  ]);
}

function main(): void {
  assertRepoRoot();
  assertInfisicalEnvPresent();
  ensureWorkspaceInstalled();

  const envPath = join(repoRoot, ".env");
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

  ensureInfraUp(composeArgs);
  applyMigrations(composeArgs);

  log("bootstrap fullført - kjører D-35 Infisical live-akseptanse (infisical-live.ts)...");
  runInfisicalLiveAcceptance(composeArgs);
}

try {
  main();
} catch (err) {
  console.error(`[infisical-live-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
