// Q-21 FIX (2026-08-15): ÉN host-kommando som automatiserer HELE split mellom
// DB-admin-rolle og en ekte non-bypass runtime-LOGIN-rolle (`jarvis_runtime`),
// verifiserer den faktisk er trygg, og kjører UA-2 P0-akseptansen til slutt.
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten, IKKE inni en container - trenger
// `docker`/`docker compose` og Node tilgjengelig på PATH:
//
//   node --experimental-transform-types modules/core/scripts/fix-q21-runtime-role.ts
//
// Trygt å kjøre flere ganger (idempotent). Sikkerhetskopierer .env FØR endring.
// Skriver ALDRI passord til stdout/stderr. Sletter/tilbakestiller ALDRI Docker
// volumes eller eksisterende databasedata - kun ruller DB-rollen og .env.

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env");
const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
const composeArgs = ["compose", "-f", composeFile];

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

interface EnvFile {
  lines: string[];
  values: Map<string, string>;
}

function readEnvFile(path: string): EnvFile {
  if (!existsSync(path)) {
    throw new Error(`.env ikke funnet: ${path} - kjør fra repo-roten, kopier .env.example til .env først`);
  }
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const values = new Map<string, string>();
  for (const line of lines) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) values.set(m[1]!, m[2]!);
  }
  return { lines, values };
}

function setEnvValue(lines: string[], key: string, value: string): string[] {
  let found = false;
  const next = lines.map((line) => {
    if (new RegExp(`^${key}=`).test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  return next;
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
  const { lines, values } = readEnvFile(envPath);

  const adminUser = values.get("JARVIS_DB_ADMIN_USER") || "postgres";
  const adminPassword = values.get("JARVIS_DB_ADMIN_PASSWORD") || "";
  if (!adminPassword) {
    throw new Error(
      "JARVIS_DB_ADMIN_PASSWORD mangler i .env - sett den (samme verdi docker-compose sin Postgres-container allerede bootstrapper med) før dette scriptet kjøres"
    );
  }

  // 1. Behold eksisterende admin-credentials UENDRET. Avgjør runtime-credentials:
  //    gjenbruk hvis allerede distinkt og trygt navngitt, ellers generer nye.
  const currentRuntimeUser = values.get("JARVIS_DB_USER") || "";
  const currentRuntimePassword = values.get("JARVIS_DB_PASSWORD") || "";
  const runtimeUserNeedsFix = !currentRuntimeUser || currentRuntimeUser === adminUser || currentRuntimeUser === "jarvis_app";
  const runtimeUser = runtimeUserNeedsFix ? "jarvis_runtime" : currentRuntimeUser;
  const runtimePassword = runtimeUserNeedsFix || !currentRuntimePassword ? randomPassword() : currentRuntimePassword;

  log(`admin-rolle (uendret): ${adminUser}`);
  log(`runtime-rolle: ${runtimeUser} (${runtimeUserNeedsFix ? "ny/fikset" : "gjenbrukt fra .env"})`);

  // 2. Sikkerhetskopi FØR noen endring.
  const backupPath = `${envPath}.bak.${Date.now()}`;
  copyFileSync(envPath, backupPath);
  log(`sikkerhetskopi skrevet: ${backupPath}`);

  // 3. Skriv oppdatert .env (aldri logg selve passordverdien).
  let nextLines = lines;
  nextLines = setEnvValue(nextLines, "JARVIS_DB_USER", runtimeUser);
  nextLines = setEnvValue(nextLines, "JARVIS_DB_PASSWORD", runtimePassword);
  writeFileSync(envPath, nextLines.join("\n"));
  log(".env oppdatert (JARVIS_DB_USER/JARVIS_DB_PASSWORD)");

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
  const dbHost = values.get("JARVIS_DB_HOST") || "127.0.0.1";
  const dbPort = Number(values.get("JARVIS_DB_PORT") || 5432);
  const dbName = values.get("JARVIS_DB_NAME") || "jarvis";
  await waitFor(
    async () => {
      const verifyPool = new pg.Pool({
        host: dbHost,
        port: dbPort,
        database: dbName,
        user: runtimeUser,
        password: runtimePassword,
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
