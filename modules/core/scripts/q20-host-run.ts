// Q-20 HOST RECOVERY #1+#2+#3 (2026-08-16): ÉN host-kommando som bootstrapper
// workspacet (denne branchen la til en NY pnpm-workspace-pakke,
// `modules/erasure` - en host som installerte avhengigheter FØR den pakken
// eksisterte har aldri fått `node_modules`/symlinks for den, og
// `q20-erasure-live.ts` feiler da med `ERR_MODULE_NOT_FOUND` FØR noe
// Q-20-innhold i det hele tatt er testet), sikrer et FERSKT migrate-image
// (samme "always rebuild"-leksjon som Q-21 host-runde 3), kjører migrasjonene
// (inkl. `018_erasure.sql`) via admin-rollen, og kjører til slutt selve
// Q-20-akseptansen (`modules/erasure/scripts/q20-erasure-live.ts`).
//
// HOST RECOVERY #2: `spawnSync("pnpm", ...)` UTEN shell-involvering feiler med
// `ENOENT` på Windows sjøl om `pnpm` fungerer fint fra Tobias sin egen
// PowerShell - Node gjør IKKE Windows sin PATHEXT-baserte utvidelsesoppløsning
// (`.CMD`/`.EXE`/`.BAT`) uten en shell. Løst med en eksplisitt, testbar
// oppløsningsrekkefølge (`lib/package-manager-resolve.ts`): finn
// `pnpm`/`pnpm.cmd` på PATH → ellers `corepack`/`corepack.cmd` på PATH (påkalt
// med EKSPLISITT pinnet versjon, ALDRI `corepack enable`) → ellers fail-closed.
//
// HOST RECOVERY #3: den første fiksen (runde #2) brukte `shell: true` for å
// kjøre `.cmd`-shims, som utløste Node sin `DEP0190`-advarsel (kombinasjonen
// `shell: true` + et args-array er en kjent injeksjonsrisiko - Node må da selv
// gjette hvordan argumentene skal escapes). Løst PERMANENT: `shell` er nå
// IKKE et alternativ noe sted i denne fila. Et `.cmd`-shim MÅ tolkes av
// cmd.exe for å kjøres i det hele tatt (Windows CreateProcess kan ikke starte
// batch-filer direkte) - løsningen er å kalle cmd.exe SELV som en helt
// vanlig, ikke-shell barneprosess med et eksplisitt argv (`/d /s /c <sti>
// <args>`, se `buildSpawnInvocation()`), ALDRI via `shell: true`. `command`/
// `args` stammer utelukkende fra filsystem-oppløsning + statiske, repo-egne
// argumenter - aldri fra ubetrodd input.
//
// BEVISST kun Node-innebygde moduler på TOPPNIVÅ (`node:child_process`,
// `node:fs`, `node:path`, `node:process`) + rene, avhengighetsfrie lokale
// relative imports (`./lib/*.ts` - ALDRI `@jarvis/*`/npm-pakke-import).
// Dette scriptet MÅ kunne kjøre FØR `pnpm install` har bootstrappet
// workspacet (det er selve poenget - det er `pnpm install` som mangler).
// Alt som trenger workspace-avhengigheter (pg, @jarvis/core osv.) kjøres som
// EGNE subprosesser ETTER at install er bekreftet fullført.
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten:
//
//   node --experimental-transform-types modules/core/scripts/q20-host-run.ts
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations` (kjører
// aldri om igjen), Docker-images bygges alltid ferske, `q20-erasure-live.ts`
// er selv idempotent (egen SENTINEL + selvopprydding per kjøring). Sletter
// ALDRI Docker-volumes, databasedata, `.env`, eller `.env.bak.*`.
//
// Forutsetter (uendret fra Q-21): `.env` allerede korrekt konfigurert med
// JARVIS_DB_ADMIN_USER/PASSWORD (migrate) og JARVIS_DB_USER/PASSWORD
// (jarvis_runtime - api/worker/runtime) - Q-21 er VERIFIED/CLOSED og krever
// ingen ny credential-gjenoppretting her. Dette scriptet endrer ALDRI `.env`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "./lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[q20-host-run] ${msg}`);
}

// DEP0190 (Q-20 HOST RECOVERY #3): `shell` er BEVISST IKKE et alternativ her -
// `execFileSync` kjøres ALLTID med et rent argv-array, ALDRI `shell: true`.
// Windows `.cmd`-shims håndteres av `buildSpawnInvocation()` (en eksplisitt
// cmd.exe-child-prosess med sitt eget kontrollerte argv), ikke av denne
// generiske hjelperen - se `lib/package-manager-resolve.ts`.
function run(command: string, args: string[], cwd: string = repoRoot): void {
  log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd });
}

function assertRepoRoot(): void {
  // §1: verifiser repo-rot FØR noe annet forsøkes - en tydelig feilmelding her
  // er bedre enn en kryptisk ENOENT lenger nede.
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

function nodeVersionInfo(): void {
  // §6: Node 24 er IKKE root cause (engines-feltet i package.json krever kun
  // >=22, og --experimental-transform-types finnes fortsatt på Node 24) -
  // dokumenteres eksplisitt slik at feilmeldingen aldri blir mistolket som et
  // Node-versjonsproblem igjen. Docker-imagene bruker fortsatt Node 22 internt
  // (uendret, uavhengig av host-Noden som kjører DETTE scriptet).
  log(`host_node_version=${process.version} (engines krever >=22 - kompatibelt, ikke root cause for denne feilen)`);
}

function ensureWorkspaceInstalled(): void {
  // §2 i BO-en: bruk det REPO-PINNEDE pnpm-verktøyet (package.json sitt
  // `packageManager`-felt) - aldri en annen/nyere versjon.
  const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
  const pinned = readPinnedPackageManager(packageJson);
  if (!pinned || pinned.name !== "pnpm") {
    throw new Error(`package.json sitt "packageManager"-felt mangler eller er ikke pnpm-basert: ${JSON.stringify(pinned)}`);
  }

  // §3 i BO-en: Windows-bevisst oppløsning - IKKE anta at "pnpm" er direkte
  // spawnbart uten shell (se HOST RECOVERY #2-kommentaren øverst i fila).
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

  // §5: ETT sted avhengigheter installeres - frozen lockfile (ALDRI oppdater
  // pnpm-versjon eller lockfile her), trygt å re-kjøre uansett tilstand
  // (no-op hvis alt allerede er installert - §8 idempotens).
  const invocation = buildSpawnInvocation(resolved, ["install", "--frozen-lockfile"]);
  run(invocation.command, invocation.args);
  log("install_frozen_lockfile=PASS workspace_install=PASS");
}

function verifyErasureWorkspaceResolution(): void {
  // §3/§7.H: tydelig, isolert diagnostikk FØR selve akseptansen startes -
  // feiler denne fortsatt etter install, er det IKKE et Q-20-funn.
  run("node", ["--experimental-transform-types", "modules/erasure/scripts/verify-workspace.ts"]);
}

function ensurePostgresAndFreshImages(envPath: string, composeArgs: string[]): void {
  // §4: Postgres oppe (rører ALDRI volumes/data).
  run("docker", [...composeArgs, "up", "-d", "postgres"]);
  // §5: ALLTID bygg migrate/api/worker fra AKTUELL checkout - samme "always
  // rebuild"-leksjon fra Q-21 host-runde 3 (Compose bygger aldri om automatisk
  // bare fordi kildekoden har endret seg).
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. Q-20-kode)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
  void envPath;
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // §6: kjører migrasjonene (inkl. 018_erasure.sql) via ADMIN-rollen -
  // `migrate-main.ts` bruker `adminConfigFromEnv()` uendret fra Q-21, og
  // `runMigrations()` sporer allerede anvendte filer i `schema_migrations` -
  // idempotent, ingen DB-reset.
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  // §7: restart api/worker fra de FERSKT bygde imagene - de plukker opp
  // EKSISTERENDE `.env` uendret (JARVIS_DB_USER=jarvis_runtime osv., Q-21
  // rørt IKKE her) og fail-closed-vaktene (`assertRuntimeRoleSafe`) kjører
  // automatisk ved oppstart, akkurat som før.
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

function runQ20Acceptance(): void {
  // §8: selve Q-20-akseptansen - egen subprosess, egen (allerede
  // installerte) avhengigheter. Denne verifiserer SELV Q-21-rollen på nytt
  // (§1 i q20-erasure-live.ts, `assertRuntimeRoleSafe`) FØR noe destruktivt
  // forsøkes - ingen duplisert logikk her.
  run("node", ["--env-file=.env", "--experimental-transform-types", "modules/erasure/scripts/q20-erasure-live.ts"]);
}

function main(): void {
  assertRepoRoot();
  nodeVersionInfo();
  ensureWorkspaceInstalled();
  verifyErasureWorkspaceResolution();

  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - Q-21 er allerede løst på denne hosten; kopier .env.example til .env hvis den mangler helt.`);
  }
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

  ensurePostgresAndFreshImages(envPath, composeArgs);
  applyMigrationsAndRestart(composeArgs);

  log("bootstrap fullført - kjører Q-20-akseptanse (q20-erasure-live.ts)...");
  runQ20Acceptance();
}

try {
  main();
} catch (err) {
  console.error(`[q20-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
