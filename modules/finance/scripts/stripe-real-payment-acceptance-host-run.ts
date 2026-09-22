// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - STRIPE (D-109) - REAL, TEST-MODE
// LIVE ACCEPTANCE HOST RUN (D-225). ÉN host-kommando som bootstrapper
// workspacet, sikrer et FERSKT migrate/api/worker-image, kjører
// migrasjonene via admin-rollen, og kjører til slutt selve den EKTE
// test-modus-akseptansen (`modules/finance/scripts/stripe-real-payment-
// acceptance.ts`). Speiler NØYAKTIG samme struktur som
// `stripe-live-host-run.ts`/alle øvrige UA-3/UA-4/UA-6-host-run-scriptene
// - ingen ny mekanisme.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ + rene, avhengighetsfrie
// lokale relative imports (SAMME delte lib som de øvrige host-run-
// scriptene - ALDRI en duplisert kopi). Dette scriptet MÅ kunne kjøre FØR
// `pnpm install` har bootstrappet workspacet.
//
// KREVER (se stripe-real-payment-acceptance.ts sitt filhode for full
// forklaring):
//   - JARVIS_STRIPE_TEST_SECRET_KEY i .env - en Stripe TEST-modus-nøkkel
//     (sk_test_.../rk_test_...), ALDRI den ekte, live
//     JARVIS_STRIPE_SECRET_KEY.
//   - Stripe CLI installert og INNLOGGET (`stripe login`) - samme CLI
//     Tobias allerede installerte/logget inn med for D-224 (én global CLI-
//     innlogging dekker BÅDE test- og live-modus for samme konto).
//   - Valgfritt: JARVIS_STRIPE_CLI_BIN hvis `stripe`/`stripe.exe` ikke
//     ligger på PATH (f.eks. full sti til stripe-cli-mappen fra D-224).
//
//   node --env-file=.env --experimental-transform-types modules/finance/scripts/stripe-real-payment-acceptance-host-run.ts
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations`
// (kjører aldri om igjen), Docker-images bygges alltid ferske, selve
// akseptansen er selv idempotent (egen kjøre-unik tenant-suffiks +
// selvopprydding per kjøring). Sletter ALDRI Docker-volumer, databasedata,
// `.env`, eller noe ekte business-/kundedata. Rører ALDRI
// JARVIS_STRIPE_SECRET_KEY (den ekte, live D-224-nøkkelen).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[stripe-real-payment-acceptance-host-run] ${msg}`);
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

/** Guard (byggeordrens §21): rent arbeidstre - ingen ubestemt/blandet tilstand skal bevises. */
function assertCleanWorktree(): void {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString("utf8").trim();
  if (status.length > 0) {
    throw new Error(`Arbeidstreet er IKKE rent (git status --porcelain viste endringer) - commit/stash FØR host-akseptanse:\n${status}`);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString("utf8").trim();
  log(`clean_worktree=PASS head=${head}`);
}

function assertTestKeyPresent(): void {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kopier .env.example til .env hvis den mangler helt.`);
  }
  const envContent = readFileSync(envPath, "utf8");
  const hasKey = /^JARVIS_STRIPE_TEST_SECRET_KEY=.+/m.test(envContent);
  if (!hasKey) {
    throw new Error(
      "JARVIS_STRIPE_TEST_SECRET_KEY mangler eller er tom i .env. Hent en Stripe TEST-modus-nøkkel " +
      "(Dashboard -> slå PÅ \"Test mode\" -> Developers -> API keys -> Secret key, sk_test_.../rk_test_...) " +
      "og legg den til FØR du kjører dette scriptet. ALDRI den ekte, live JARVIS_STRIPE_SECRET_KEY."
    );
  }
  log("test_key_present=PASS (verdi ikke lest/logget her - selve scriptet gjør sin egen fail-closed prefiks-validering)");
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
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runStripeRealAcceptance(): void {
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/finance/scripts/stripe-real-payment-acceptance.ts"]);
}

function main(): void {
  assertRepoRoot();
  assertCleanWorktree();
  assertTestKeyPresent();
  ensureWorkspaceInstalled();

  const envPath = join(repoRoot, ".env");
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

  ensurePostgresAndFreshImages(composeArgs);
  applyMigrationsAndRestart(composeArgs);

  log("bootstrap fullført - kjører Stripe EKTE test-modus live-akseptanse (stripe-real-payment-acceptance.ts)...");
  runStripeRealAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[stripe-real-payment-acceptance-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
