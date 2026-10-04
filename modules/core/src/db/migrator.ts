import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { adminConfigFromEnv, createPool } from "./pool.ts";

/**
 * Minimal, gjennomsiktig migrasjonskjører: nummererte .sql-filer kjøres i
 * rekkefølge, én transaksjon per fil, registrert i schema_migrations.
 * Bevisst ingen ekstern migrasjonsrammeverk i fase 2 (regel: ingen nye
 * rammeverk uten begrunnet behov); byttes hvis behovet vokser.
 *
 * D-395 (JARVIS-075):
 *  1. En Postgres advisory lock serialiserer samtidige migratorer (to instanser som startet samtidig kunne kjøre samme fil to ganger).
 *  2. Hver anvendt fil lagrer en SHA-256-sjekksum. En senere endring av en ALLEREDE anvendt fil feiler høyt (`migration_checksum_mismatch`)
 *     i stedet for å tolereres stille - en endret fil har aldri kjørt på databasen og ville gi et skjema som avviker fra koden. Eldre rader
 *     uten sjekksum fylles inn med dagens filinnhold første gang (tillit til nåværende tilstand), og meldes i `backfilled`.
 *  3. En `.sql`-fil som ikke følger `NNN_navn.sql` ble tidligere ignorert for alltid uten ord - nå feiler migratoren (`migration_file_name_invalid`),
 *     og to filer med samme 3-sifrede prefiks (tvetydig rekkefølge) feiler (`migration_prefix_duplicate`).
 *  4. `planMigrations()` er skrivebeskyttet: hva som VILLE blitt anvendt, hvilke anvendte filer som er endret, og hvilke databaserader koden ikke
 *     kjenner (en eldre kodeversjon mot nyere skjema). Brukes FØR backup/anvendelse i deploy-rutinen.
 *  Ned-migrasjoner finnes bevisst ikke (forover-only; «expand/contract» + gjenoppretting fra backup, se docs/remediation/BACKUP_RESTORE_RUNBOOK.md).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));
/** Fast, applikasjonsspesifikk lås-nøkkel (bigint) for migratoren. */
const MIGRATION_LOCK_KEY = "7340001075";
const MIGRATION_FILE = /^(\d{3})_.*\.sql$/;

export class MigrationChecksumMismatchError extends Error {
  constructor(readonly file: string, readonly expected: string, readonly actual: string) {
    super(
      `migration_checksum_mismatch:${file} (anvendt ${expected.slice(0, 12)}, nå ${actual.slice(0, 12)}) - en allerede anvendt migrasjon er endret; lag en NY migrasjon i stedet`
    );
    this.name = "MigrationChecksumMismatchError";
  }
}

/** Linjeskift normaliseres (CRLF → LF) slik at samme innhold gir samme sjekksum på Windows og Linux. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** Gyldige migrasjonsfiler i rekkefølge. Kaster ved ugyldig navn eller dupliserte prefikser (se punkt 3 over). */
export function listMigrationFiles(entries: readonly string[]): string[] {
  const sqlFiles = entries.filter((f) => f.toLowerCase().endsWith(".sql"));
  const invalid = sqlFiles.filter((f) => !MIGRATION_FILE.test(f));
  if (invalid.length > 0) {
    throw new Error(`migration_file_name_invalid:${invalid.sort().join(",")} - forventet NNN_navn.sql (ellers blir filen aldri anvendt)`);
  }
  const files = [...sqlFiles].sort();
  const seen = new Map<string, string>();
  for (const f of files) {
    const prefix = (MIGRATION_FILE.exec(f) as RegExpExecArray)[1] as string;
    const other = seen.get(prefix);
    if (other !== undefined) {
      throw new Error(`migration_prefix_duplicate:${prefix} (${other}, ${f}) - tvetydig rekkefølge; gi den ene et nytt, unikt nummer`);
    }
    seen.set(prefix, f);
  }
  return files;
}

export interface MigrationPlan {
  /** Filer som ikke er anvendt ennå (i rekkefølge). */
  pending: string[];
  /** Antall allerede anvendte filer som finnes i katalogen. */
  applied: number;
  /** Anvendte filer hvis innhold er endret siden anvendelse (migratoren ville avbrutt). */
  checksum_mismatches: string[];
  /** Anvendte filer uten lagret sjekksum (fylles inn ved første kjøring). */
  missing_checksum: string[];
  /** Rader i databasen som koden ikke har fil for - typisk en eldre kodeversjon mot et nyere skjema. */
  unknown_applied: string[];
}

/** Skrivebeskyttet plan: endrer ingenting (heller ikke `schema_migrations`). */
export async function planMigrations(adminPool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationPlan> {
  const files = listMigrationFiles(await readdir(dir));
  const exists = await adminPool.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  const rows = new Map<string, string | null>();
  if ((exists.rows[0] as { present: boolean }).present) {
    const hasChecksum = await adminPool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'schema_migrations' AND column_name = 'checksum'"
    );
    const result = hasChecksum.rowCount
      ? await adminPool.query("SELECT name, checksum FROM schema_migrations")
      : await adminPool.query("SELECT name, NULL::text AS checksum FROM schema_migrations");
    for (const r of result.rows as { name: string; checksum: string | null }[]) rows.set(r.name, r.checksum);
  }
  const plan: MigrationPlan = { pending: [], applied: 0, checksum_mismatches: [], missing_checksum: [], unknown_applied: [] };
  for (const file of files) {
    if (!rows.has(file)) {
      plan.pending.push(file);
      continue;
    }
    plan.applied += 1;
    const stored = rows.get(file) ?? null;
    if (stored === null) {
      plan.missing_checksum.push(file);
    } else if (stored !== migrationChecksum(await readFile(join(dir, file), "utf8"))) {
      plan.checksum_mismatches.push(file);
    }
  }
  const known = new Set(files);
  plan.unknown_applied = [...rows.keys()].filter((name) => !known.has(name)).sort();
  return plan;
}

export async function runMigrations(adminPool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = listMigrationFiles(await readdir(dir));
  const lockClient = await adminPool.connect();
  let lockReleased = false;
  try {
    // Sesjonsbundet lås på en dedikert forbindelse: holdes gjennom hele kjøringen, slippes eksplisitt (og automatisk om forbindelsen dør).
    await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    await lockClient.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    await lockClient.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    const applied: string[] = [];
    for (const file of files) {
      const sql = await readFile(join(dir, file), "utf8");
      const checksum = migrationChecksum(sql);
      const done = await lockClient.query("SELECT checksum FROM schema_migrations WHERE name = $1", [file]);
      if (done.rowCount) {
        const stored = (done.rows[0] as { checksum: string | null }).checksum;
        if (stored === null) {
          await lockClient.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL", [file, checksum]);
        } else if (stored !== checksum) {
          throw new MigrationChecksumMismatchError(file, stored, checksum);
        }
        continue;
      }
      try {
        await lockClient.query("BEGIN");
        await lockClient.query(sql);
        await lockClient.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await lockClient.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await lockClient.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migrasjon ${file} feilet: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
      lockReleased = true;
    } catch {
      // Forbindelsen er trolig død - serveren slipper sesjonslåsen uansett. Forbindelsen kastes i stedet for å gjenbrukes med en usikker lås-tilstand.
    }
    lockClient.release(lockReleased ? undefined : true);
  }
}

/**
 * D-395 (JARVIS-075): `JARVIS_DB_RUN_MIGRATIONS=true` kjørte tidligere migratoren med RUNTIME-poolen. Etter Q-21 er runtime-rollen aldri
 * superuser/eier (kan ikke kjøre DDL) - og skulle den kunne det, ville runtime-rollen hatt privilegier den aldri skal ha. Migrasjoner kjøres
 * derfor KUN med ADMIN-konfigurasjonen (en egen, kortlivet pool), og feiler lukket hvis admin-passordet mangler (aldri stille fallback til runtime).
 */
export async function runMigrationsAsAdmin(env: NodeJS.ProcessEnv = process.env, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const config = adminConfigFromEnv(env);
  if (config.password === undefined || config.password === "") {
    throw new Error(
      "migration_admin_credentials_missing: JARVIS_DB_RUN_MIGRATIONS=true krever JARVIS_DB_ADMIN_PASSWORD (migrasjoner kjøres aldri med runtime-rollen). I compose kjøres migrasjoner av `migrate`-tjenesten."
    );
  }
  const pool = createPool(config);
  try {
    return await runMigrations(pool, dir);
  } finally {
    await pool.end();
  }
}
