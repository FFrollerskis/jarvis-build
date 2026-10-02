// UA-4 GROWTH -> BUSINESS DOMAIN COVERAGE INTEGRATION (D-78) - HOST RUN
//
// STATUS (D-78, oppdatert "CI-AKSEPTANSE ERSTATTER MANUELL HOST-KJØRING",
// se docs/DECISIONS_AND_ASSUMPTIONS.md): dette scriptet er IKKE lenger en
// release-gate for D-78/UA4_SLICE_2. D-78 endrer ingen DB-migrasjon, ingen
// persistert domenetilstand, ingen credential, ingen ekstern leverandør,
// ingen ToolGateway-handling, ingen OS-/Docker-spesifikk produksjonsatferd -
// den er en ren rapporterings-/kartleggingsendring i `business-brief.ts`
// (BUSINESS_DOMAIN_COVERAGE), og den samme reelle kjøretidsstien
// (`generateWeeklyBrief()`, `renderDomainCoverage()`, ekte Postgres via
// embedded-postgres, ekte `companyTimeline()`-sameksistens med en ekte
// `marketing_campaigns`-rad) kjøres nå DETERMINISTISK i
// `modules/business/test/business-brief.test.ts` (describe-blokk "E") som
// en del av `pnpm test` i CI (`.github/workflows/ci.yml` build-test-jobben)
// - INGEN Docker, INGEN Windows-host, INGEN manuell kommando kreves for
// denne sliceen. D-78 er derfor `CI_VERIFIED / COMPLETE`, ALDRI
// `HOST_VERIFIED` (se D-78-oppdateringen for den fulle begrunnelsen og
// hvorfor dette IKKE er en generell fritakelse fra host-verifisering for
// fremtidig UA-4-arbeid). Scriptet beholdes KUN for manuell
// feilsøking/referanse (f.eks. hvis Tobias ønsker å se den fulle
// Docker/migrate-pipelinen kjøre ende-til-ende) - IKKE som en
// merge-forutsetning.
//
// ÉN host-kommando som bootstrapper workspacet, sikrer et FERSKT
// migrate/api/worker-image, kjører migrasjonene via admin-rollen (ingen NY
// migrasjon i denne sliceen - kun kode-/dokumentendring), og kjører til
// slutt selve akseptansen (`ua4-growth-domain-coverage-live.ts`). Speiler
// NØYAKTIG samme struktur som `ua4-growth-core-host-run.ts` og alle øvrige
// UA-3/UA-4-host-run-scriptene - ingen ny mekanisme.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale relative imports (SAMME delte lib som de øvrige host-run-scriptene -
// ALDRI en duplisert kopi). Dette scriptet MÅ kunne kjøre FØR `pnpm install`
// har bootstrappet workspacet.
//
// Valgfri, ikke-påkrevd referansekommando (fra repo-roten), INGEN Google
// Ads/Meta Ads/GA4/annen annonseplattform-oppsett, INGEN
// annonseplattform-credential, INGEN manuell SQL kreves:
//
//   node --env-file=.env --experimental-transform-types modules/business/scripts/ua4-growth-domain-coverage-host-run.ts
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations` (kjører
// aldri om igjen), Docker-images bygges alltid ferske, selve akseptansen er
// selv idempotent (egen kjøre-unik tenant-suffiks + selvopprydding per
// kjøring). Sletter ALDRI Docker-volumer, databasedata, `.env`, eller ekte
// business-/kundedata.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";
import { requireProductionMutationConsent } from "../../core/scripts/lib/production-mutation-guard.ts";

// Remediering del 1 (JARVIS-086): mutates the live stack - refuses without explicit consent.
requireProductionMutationConsent("ua4-growth-domain-coverage-host-run.ts");

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[ua4-growth-domain-coverage-host-run] ${msg}`);
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. oppdatert BUSINESS_DOMAIN_COVERAGE)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // Ingen NY migrasjon i denne sliceen - kjøres likevel via ADMIN-rollen for
  // konsistens med alle øvrige host-run-scriptene (idempotent, ingen DB-reset).
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runDomainCoverageAcceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/business/scripts/ua4-growth-domain-coverage-live.ts"]);
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

  log("bootstrap fullført - kjører Growth->Business Domain Coverage-akseptanse (ua4-growth-domain-coverage-live.ts)...");
  runDomainCoverageAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[ua4-growth-domain-coverage-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
