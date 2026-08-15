// Q-21 FIX (2026-08-15, host-recovery-runde samme dag): ÉN host-kommando som
// automatiserer HELE split mellom DB-admin-rolle og en ekte non-bypass
// runtime-LOGIN-rolle (`jarvis_runtime`), verifiserer den faktisk er trygg,
// og kjører UA-2 P0-akseptansen til slutt.
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten, IKKE inni en container - trenger
// `docker`/`docker compose` og Node tilgjengelig på PATH:
//
//   node --experimental-transform-types modules/core/scripts/fix-q21-runtime-role.ts
//
// Trygt å kjøre flere ganger (idempotent - se lib/q21-env-recovery.ts).
// Sikkerhetskopierer .env FØR endring, validerer FULLSTENDIG resultat FØR
// noen fil skrives, gjenoppretter admin-credentials fra siste gyldige
// `.env.bak.*` hvis de mangler i nåværende .env (host-recovery-runden).
// Skriver ALDRI passord til stdout/stderr. Sletter/tilbakestiller ALDRI
// Docker volumes, databasedata, eller eksisterende `.env.bak.*`-filer.
//
// HOST-FUNN (forrige runde): `docker compose up -d postgres` feilet med
// "required variable JARVIS_DB_ADMIN_PASSWORD is missing a value" til tross
// for at verdien FAKTISK sto riktig i .env - Compose sin egen `${VAR}`-
// interpolasjon i selve compose-filen bruker et ANNET .env-oppslag enn
// tjenestenes `env_file:`-direktiv (som alltid har pekt eksplisitt på
// `../../.env`). Fikset ved å eksplisitt gi `--env-file <repoRoot>/.env`
// til hvert `docker compose`-kall - garanterer samme fil brukes for BEGGE
// mekanismene, uansett hvilken mappe compose ellers ville sett som
// "prosjektmappe".
//
// HOST-FUNN #2 (denne runden): migrate-containeren autentiserte som
// `jarvis_runtime` mot Postgres til tross for at `.env` (bekreftet av
// scriptets egen log RETT FØR feilen) hadde `JARVIS_DB_ADMIN_USER=postgres`
// korrekt satt. Sporet gjennom hele kjeden (.env → compose-interpolasjon →
// migrate sitt env_file/environment-oppsett → migrate-main.ts sin
// adminConfigFromEnv() → pg.Pool): ingen kodefeil funnet i noen av disse
// leddene - `migrate:`-tjenesten setter aldri `JARVIS_DB_ADMIN_USER` via
// `environment:`, kun via `env_file: ["../../.env"]` (ren fil-passthrough,
// ingen `${...}`-interpolasjon involvert for akkurat de nøklene). Uten
// sikker host-tilgang kan den eksakte Compose-presedens-mekanismen for
// `docker compose run` (shell-arv vs. env_file for akkurat dette
// underkommandoen) ikke bekreftes 100% herfra. I stedet for å gjette,
// FJERNES hele tvetydighetsklassen: migrate-kallet sender nå disse to
// nøklene EKSPLISITT via `-e VARNAME` (bar form - Compose leser da fra DEN
// KALLENDE PROSESSENS eget miljø, som scriptet selv kontrollerer via
// `execFileSync` sin `env`-opsjon), pluss en admin-tilkoblings-precheck FØR
// migrate kjøres, og en ny `migrate_effective_db_user`-diagnostikk skrevet
// av migrate-main.ts SELV (grunnsannhet, ikke en antakelse fra host-scriptet).

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
  buildMigrateRunArgs,
  buildUpdatedEnvLines,
  parseEnvValues,
  resolveAdminCredentials,
  resolveRuntimeCredentials,
  sortBackupFilenamesNewestFirst,
  validateRequiredEnv,
  type EnvValues
} from "./lib/q21-env-recovery.ts";

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env");
const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
// --env-file eksplisitt satt (se HOST-FUNN over) - IKKE fjern denne, den er
// den faktiske fiksen for host-feilen som utløste forrige runde.
const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

function log(msg: string): void {
  console.log(`[q21-fix] ${msg}`);
}

/**
 * `extraEnv` injiseres KUN i barneprosessens (docker-CLI-ets) eget miljø via
 * `execFileSync` sin `env`-opsjon - ALDRI som en del av `args` (som logges
 * her, og ellers ville vært synlig via `ps`/prosesslisten på maskinen).
 */
function run(args: string[], extraEnv?: NodeJS.ProcessEnv): void {
  log(`$ docker ${args.join(" ")}`);
  execFileSync("docker", args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {})
  });
}

function randomPassword(): string {
  return randomBytes(24).toString("base64url");
}

function readEnvLines(path: string): string[] {
  if (!existsSync(path)) {
    throw new Error(`.env ikke funnet: ${path} - kjør fra repo-roten, kopier .env.example til .env først`);
  }
  return readFileSync(path, "utf8").split("\n");
}

/** Leser og parser ALLE `.env.bak.*`-snapshots i repo-roten, nyest først. Rører dem aldri. */
function readBackupSnapshotsNewestFirst(): EnvValues[] {
  const backupFilenames = readdirSync(repoRoot).filter((name) => /^\.env\.bak\.\d+$/.test(name));
  const sorted = sortBackupFilenamesNewestFirst(backupFilenames);
  return sorted.map((name) => parseEnvValues(readFileSync(join(repoRoot, name), "utf8")));
}

async function waitFor<T>(fn: () => Promise<T>, timeoutMs: number, description: string): Promise<T> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  throw new Error(`timeout venter på ${description}: ${(lastErr as Error)?.message ?? "ukjent feil"}`);
}

interface DbConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Ren, direkte pg-tilkobling FRA SCRIPTET - uavhengig av hvordan Docker Compose ellers løser miljøvariabler. */
async function connectDirectly(opts: DbConnectionOptions): Promise<{ user: string }> {
  const pool = new pg.Pool({ ...opts, max: 1 });
  try {
    const r = await pool.query("SELECT current_user AS u");
    return { user: (r.rows[0] as { u: string }).u };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const lines = readEnvLines(envPath);
  const current = parseEnvValues(lines.join("\n"));

  // 1-3. Gjenopprett/avgjør admin-credentials (nåværende .env, eller siste
  // gyldige backup - §2/§3). Kaster FØR noe skrives hvis uløselig (§4/D).
  const admin = resolveAdminCredentials(current, readBackupSnapshotsNewestFirst());
  log(`admin-rolle: ${admin.adminUser} (kilde: ${admin.source})`);

  // Avgjør runtime-credentials (gjenbruk uendret på idempotent re-kjøring - §5/I).
  const runtime = resolveRuntimeCredentials(current, admin.adminUser, randomPassword);
  log(`runtime-rolle: ${runtime.runtimeUser} (${runtime.changed ? "ny/fikset" : "gjenbrukt fra .env"})`);

  const updates: EnvValues = {
    JARVIS_DB_ADMIN_USER: admin.adminUser,
    JARVIS_DB_ADMIN_PASSWORD: admin.adminPassword,
    JARVIS_DB_USER: runtime.runtimeUser,
    JARVIS_DB_PASSWORD: runtime.runtimePassword
  };
  // §4: valider FULLSTENDIG resultat FØR noen fil røres - fail-closed, ingen
  // delvis migrert mellomtilstand skal noensinne kunne skrives til disk.
  validateRequiredEnv(updates);
  const nextLines = buildUpdatedEnvLines(lines, updates);
  const nextContent = nextLines.join("\n");

  if (nextContent === lines.join("\n")) {
    log(".env er allerede korrekt konfigurert - ingen endring nødvendig (idempotent no-op).");
  } else {
    // Sikkerhetskopi FØR endring, deretter atomisk skriv (tmp-fil + rename -
    // aldri en delvis skrevet .env synlig for noen annen prosess/kjøring).
    const backupPath = `${envPath}.bak.${Date.now()}`;
    copyFileSync(envPath, backupPath);
    log(`sikkerhetskopi skrevet: ${backupPath}`);
    const tmpPath = `${envPath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, nextContent);
    renameSync(tmpPath, envPath);
    log(".env oppdatert (JARVIS_DB_ADMIN_USER/PASSWORD + JARVIS_DB_USER/PASSWORD)");
  }

  const dbHost = current["JARVIS_DB_HOST"] || "127.0.0.1";
  const dbPort = Number(current["JARVIS_DB_PORT"] || 5432);
  const dbName = current["JARVIS_DB_NAME"] || "jarvis";

  // 4. Postgres må kjøre (rører ALDRI volumes - kun sikrer containeren er oppe).
  run([...composeArgs, "up", "-d", "postgres"]);

  // 5. §6 i BO-en: ADMIN-PRECHECK FØR migrate kjøres i det hele tatt - bevis at DE
  // BEREGNEDE admin-credentials faktisk fungerer mot den ekte Postgres-instansen,
  // uavhengig av hvordan Docker Compose ellers ville løst miljøvariabler. Fanger
  // en feilkonfigurasjon her, FØR et migrate-forsøk kastes bort på den.
  await waitFor(
    async () => {
      const { user } = await connectDirectly({ host: dbHost, port: dbPort, database: dbName, user: admin.adminUser, password: admin.adminPassword });
      log(`admin_connection=PASS admin_current_user=${user}`);
      if (user !== admin.adminUser) {
        throw new Error(`admin_current_user (${user}) samsvarer ikke med forventet admin-bruker (${admin.adminUser})`);
      }
    },
    60_000,
    "admin-tilkobling mot Postgres"
  );

  // 6. Kjør migrate på nytt - migrate-main.ts bootstrapper/reparerer jarvis_runtime
  // idempotent (ensureRuntimeRole: setter/reparerer passord, NOSUPERUSER,
  // NOBYPASSRLS, LOGIN, jarvis_app-medlemskap - i DEN rekkefølgen, atomisk i én
  // CREATE/ALTER ROLE) via ADMIN-tilkoblingen. HOST-FUNN #2-fiks: admin-credentials
  // sendes EKSPLISITT via `-e VARNAME` (bar form, verdien injiseres KUN i
  // barneprosessens miljø via `run()` sin `extraEnv` - aldri i loggede args, aldri
  // via .env/env_file-oppløsning for akkurat dette kallet).
  run(buildMigrateRunArgs(composeArgs), {
    JARVIS_DB_ADMIN_USER: admin.adminUser,
    JARVIS_DB_ADMIN_PASSWORD: admin.adminPassword
  });

  // 7. Restart api/worker med tvungen re-lesing av .env (de skal nå plukke opp de
  //    NYE runtime-credentials i stedet for en evt. tidligere cachet admin-tilkobling).
  run([...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);

  // 8. Verifiser FAKTISK - koble direkte som runtime-rollen og les dens egne
  //    pg_roles-attributter. Ingen fake PASS: kaster hvis fortsatt usikker.
  await waitFor(
    async () => {
      const verifyPool = new pg.Pool({
        host: dbHost,
        port: dbPort,
        database: dbName,
        user: runtime.runtimeUser,
        password: runtime.runtimePassword,
        max: 1
      });
      try {
        const r = await verifyPool.query(
          "SELECT current_user AS u, rolsuper AS su, rolbypassrls AS br, rolcanlogin AS cl FROM pg_roles WHERE rolname = current_user"
        );
        const row = r.rows[0] as { u: string; su: boolean; br: boolean; cl: boolean } | undefined;
        log(`runtime_connection=${row ? "PASS" : "FAIL"} runtime_current_user=${row?.u ?? "ukjent"}`);
        log(`runtime_role_exists=${!!row}`);
        log(`runtime_role_superuser=${row?.su ?? "ukjent"}`);
        log(`runtime_role_bypassrls=${row?.br ?? "ukjent"}`);
        log(`runtime_role_canlogin=${row?.cl ?? "ukjent"}`);
        if (!row || row.su || row.br || !row.cl) {
          throw new Error(`runtime-rollen er FORTSATT usikker (finnes=${!!row} superuser=${row?.su} bypassrls=${row?.br} canlogin=${row?.cl})`);
        }
        const membership = await verifyPool.query(
          `SELECT EXISTS (
             SELECT 1 FROM pg_auth_members m
             JOIN pg_roles r ON r.oid = m.roleid
             JOIN pg_roles mm ON mm.oid = m.member
             WHERE mm.rolname = current_user AND r.rolname = 'jarvis_app'
           ) AS is_member`
        );
        const isMember = (membership.rows[0] as { is_member: boolean }).is_member;
        log(`runtime_role_member_jarvis_app=${isMember}`);
        if (!isMember) {
          throw new Error("runtime-rollen er IKKE medlem av jarvis_app - grants for identity/sessions/memory/knowledge osv. mangler");
        }
      } finally {
        await verifyPool.end();
      }
    },
    60_000,
    "runtime-rolle-verifikasjon mot Postgres"
  );

  log("Q-21 FIX fullført - kjører UA-2 P0-akseptanse (ua2-p0-live.ts) til slutt...");

  // 9. Kjør UA-2 P0-akseptansen automatisk - samme kommando Tobias ellers kjører selv.
  execFileSync(
    "node",
    ["--env-file=.env", "--experimental-transform-types", "modules/knowledge/scripts/ua2-p0-live.ts"],
    { stdio: "inherit", cwd: repoRoot }
  );
}

main().catch((err: unknown) => {
  console.error(`[q21-fix] FEILET: ${(err as Error).message}`);
  process.exit(1);
});
