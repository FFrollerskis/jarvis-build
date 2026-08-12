import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/**
 * Minimal, gjennomsiktig migrasjonskjører: nummererte .sql-filer kjøres i
 * rekkefølge, én transaksjon per fil, registrert i schema_migrations.
 * Bevisst ingen ekstern migrasjonsrammeverk i fase 2 (regel: ingen nye
 * rammeverk uten begrunnet behov); byttes hvis behovet vokser.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

export async function runMigrations(adminPool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await adminPool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await adminPool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (done.rowCount) {
      continue;
    }
    const sql = await readFile(join(dir, file), "utf8");
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migrasjon ${file} feilet: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
