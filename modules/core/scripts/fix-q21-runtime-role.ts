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

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
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
// den faktiske fiksen for host-feilen som utløste denne runden.
const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

function log(msg: string): void {
  console.log(`[q21-fix] ${msg}`);
}

function run(args: string[]): void {
  log(`$ docker ${args.join(" ")}`);
  execFileSync("docker", args, { stdio: "inherit", cwd: repoRoot });
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

  // 4. Postgres må kjøre (rører ALDRI volumes - kun sikrer containeren er oppe).
  run([...composeArgs, "up", "-d", "postgres"]);

  // 5. Kjør migrate på nytt - migrate-main.ts bootstrapper jarvis_runtime idempotent
  //    (ensureRuntimeRole) via ADMIN-tilkoblingen. `run` venter selv på
  //    postgres sin depends_on/service_healthy-betingelse.
  run([...composeArgs, "run", "--rm", "migrate"]);

  // 6. Restart api/worker med tvungen re-lesing av .env (de skal nå plukke opp de
  //    NYE runtime-credentials i stedet for en evt. tidligere cachet admin-tilkobling).
  run([...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);

  // 7. Verifiser FAKTISK - koble direkte som runtime-rollen og les dens egne
  //    pg_roles-attributter. Ingen fake PASS: kaster hvis fortsatt usikker.
  const dbHost = current["JARVIS_DB_HOST"] || "127.0.0.1";
  const dbPort = Number(current["JARVIS_DB_PORT"] || 5432);
  const dbName = current["JARVIS_DB_NAME"] || "jarvis";
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
        const row = r.rows[0] as { u: string; su: boolean; br: boolean; cl: boolean };
        log(`verifisert tilkobling: current_user=${row.u} superuser=${row.su} bypassrls=${row.br} canlogin=${row.cl}`);
        if (row.su || row.br || !row.cl) {
          throw new Error(`runtime-rollen er FORTSATT usikker (superuser=${row.su} bypassrls=${row.br} canlogin=${row.cl})`);
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
        log(`medlemskap jarvis_app: ${isMember}`);
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

  // 8. Kjør UA-2 P0-akseptansen automatisk - samme kommando Tobias ellers kjører selv.
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
