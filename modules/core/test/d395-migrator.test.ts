import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listMigrationFiles,
  MigrationChecksumMismatchError,
  migrationChecksum,
  planMigrations,
  runMigrations,
  runMigrationsAsAdmin
} from "../src/db/migrator.ts";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * D-395 (JARVIS-075) - migratorens sikkerhetsnett, bevist mot EKTE Postgres:
 *  A. rene hjelpere (sjekksum, filnavn, dupliserte prefikser),
 *  B. advisory lock (to samtidige migratorer anvender hver fil NØYAKTIG én gang),
 *  C. sjekksum (endret anvendt fil feiler høyt; eldre rader fylles inn; mislykket fil låser ikke),
 *  D. skrivebeskyttet plan,
 *  E. `JARVIS_DB_RUN_MIGRATIONS` bruker ADMIN-konfig (aldri runtime-rollen) og feiler lukket uten admin-passord.
 */
const REAL_MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
let port = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let dbCounter = 0;
const pools: pg.Pool[] = [];
const dirs: string[] = [];

async function freshDb(): Promise<{ pool: pg.Pool; name: string }> {
  const name = `d395_${(dbCounter += 1)}`;
  await epg.createDatabase(name);
  const pool = new pg.Pool({ host: "127.0.0.1", port, database: name, user: "postgres", password: "pw", max: 6 });
  pool.on("error", () => undefined);
  pools.push(pool);
  return { pool, name };
}

async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-d395-migr-"));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql, "utf8");
  return dir;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d395-"));
  dirs.push(dir);
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  epg = leased.postgres;
  port = leased.port;
  stopEmbeddedPostgres = leased.stop;
}, 240_000);

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  await stopEmbeddedPostgres?.();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
}, 120_000);

describe("A: rene hjelpere", () => {
  it("sjekksummen er uavhengig av linjeskift (Windows CRLF = Linux LF) men følger innholdet", () => {
    expect(migrationChecksum("SELECT 1;\r\nSELECT 2;\r\n")).toBe(migrationChecksum("SELECT 1;\nSELECT 2;\n"));
    expect(migrationChecksum("SELECT 1;")).not.toBe(migrationChecksum("SELECT 2;"));
    expect(migrationChecksum("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sorterer, ignorerer ikke-.sql-filer og nekter ugyldige navn (en fil som ikke matcher ble tidligere aldri anvendt - i det stille)", () => {
    expect(listMigrationFiles(["002_b.sql", "README.md", "001_a.sql"])).toEqual(["001_a.sql", "002_b.sql"]);
    expect(() => listMigrationFiles(["001_a.sql", "1_forkortet.sql"])).toThrow(/migration_file_name_invalid:1_forkortet\.sql/);
    expect(() => listMigrationFiles(["fix.sql"])).toThrow(/migration_file_name_invalid/);
    expect(() => listMigrationFiles(["0010_for_langt.sql"])).toThrow(/migration_file_name_invalid/);
  });

  it("nekter to filer med samme 3-sifrede prefiks (tvetydig rekkefølge)", () => {
    expect(() => listMigrationFiles(["073_a.sql", "073_b.sql"])).toThrow(/migration_prefix_duplicate:073/);
  });

  it("den faktiske migrasjonskatalogen er gyldig (unike prefikser, riktige navn)", async () => {
    const files = listMigrationFiles(await readdir(REAL_MIGRATIONS_DIR));
    expect(files.length).toBeGreaterThan(60);
    expect(files[0]).toMatch(/^001_/);
  });
});

describe("B: advisory lock", () => {
  it("to samtidige migratorer anvender hver fil NØYAKTIG én gang (uten lås feiler den andre med «finnes allerede»)", async () => {
    const { pool, name } = await freshDb();
    const dir = await migrationDir({ "001_conc.sql": "CREATE TABLE conc_probe (id int);\nSELECT pg_sleep(0.8);" });
    const second = new pg.Pool({ host: "127.0.0.1", port, database: name, user: "postgres", password: "pw", max: 2 });
    second.on("error", () => undefined);
    pools.push(second);
    const results = await Promise.all([runMigrations(pool, dir), runMigrations(second, dir)]);
    expect(results.flat()).toEqual(["001_conc.sql"]);
    const count = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect((count.rows[0] as { n: number }).n).toBe(1);
  }, 60_000);

  it("låsen slippes etter en mislykket migrasjon (ingen låst migrator), og den mislykkede filen rulles tilbake og registreres ikke", async () => {
    const { pool, name } = await freshDb();
    const dir = await migrationDir({
      "001_ok.sql": "CREATE TABLE ok_t (id int);",
      "002_bad.sql": "CREATE TABLE bad_t (id int);\nSELECT 1/0;"
    });
    await expect(runMigrations(pool, dir)).rejects.toThrow(/Migrasjon 002_bad\.sql feilet/);
    const bad = await pool.query("SELECT to_regclass('bad_t') AS t");
    expect((bad.rows[0] as { t: string | null }).t).toBeNull();
    const recorded = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
    expect((recorded.rows as { name: string }[]).map((r) => r.name)).toEqual(["001_ok.sql"]);
    // Låsen er fri: en ANNEN forbindelse får den umiddelbart.
    const other = new pg.Pool({ host: "127.0.0.1", port, database: name, user: "postgres", password: "pw", max: 1 });
    other.on("error", () => undefined);
    pools.push(other);
    const lock = await other.query("SELECT pg_try_advisory_lock(7340001075::bigint) AS got");
    expect((lock.rows[0] as { got: boolean }).got).toBe(true);
    await other.query("SELECT pg_advisory_unlock(7340001075::bigint)");
    // Rettet fil (aldri registrert) kan anvendes uten sjekksum-feil.
    await writeFile(join(dir, "002_bad.sql"), "CREATE TABLE bad_t (id int);", "utf8");
    await expect(runMigrations(pool, dir)).resolves.toEqual(["002_bad.sql"]);
  }, 60_000);
});

describe("C: sjekksum", () => {
  it("lagrer SHA-256 per anvendt fil og re-kjøring er en no-op", async () => {
    const { pool } = await freshDb();
    const sql = "CREATE TABLE chk_t (id int);\n";
    const dir = await migrationDir({ "001_chk.sql": sql });
    await expect(runMigrations(pool, dir)).resolves.toEqual(["001_chk.sql"]);
    const row = await pool.query("SELECT checksum FROM schema_migrations WHERE name = '001_chk.sql'");
    expect((row.rows[0] as { checksum: string }).checksum).toBe(migrationChecksum(sql));
    await expect(runMigrations(pool, dir)).resolves.toEqual([]);
  }, 60_000);

  it("en ALLEREDE anvendt fil som endres feiler høyt med filnavn - og endrer ingenting", async () => {
    const { pool } = await freshDb();
    const dir = await migrationDir({ "001_chk.sql": "CREATE TABLE chk_a (id int);", "002_next.sql": "CREATE TABLE chk_b (id int);" });
    await runMigrations(pool, dir);
    await writeFile(join(dir, "001_chk.sql"), "CREATE TABLE chk_a (id int, extra text);", "utf8");
    await writeFile(join(dir, "003_new.sql"), "CREATE TABLE chk_c (id int);", "utf8");
    const err = await runMigrations(pool, dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationChecksumMismatchError);
    expect((err as Error).message).toMatch(/migration_checksum_mismatch:001_chk\.sql/);
    // Feiler FØR noe nytt anvendes: 003 er ikke kjørt.
    const c = await pool.query("SELECT to_regclass('chk_c') AS t");
    expect((c.rows[0] as { t: string | null }).t).toBeNull();
  }, 60_000);

  it("CRLF-konvertering av en anvendt fil (Windows-checkout) er IKKE en endring", async () => {
    const { pool } = await freshDb();
    const dir = await migrationDir({ "001_crlf.sql": "CREATE TABLE crlf_t (id int);\nSELECT 1;\n" });
    await runMigrations(pool, dir);
    await writeFile(join(dir, "001_crlf.sql"), "CREATE TABLE crlf_t (id int);\r\nSELECT 1;\r\n", "utf8");
    await expect(runMigrations(pool, dir)).resolves.toEqual([]);
  }, 60_000);

  it("eldre rader uten sjekksum (før D-395) fylles inn med dagens filinnhold og kjøres ikke på nytt", async () => {
    const { pool } = await freshDb();
    await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await pool.query("INSERT INTO schema_migrations (name) VALUES ('001_legacy.sql')");
    const sql = "CREATE TABLE legacy_t (id int);";
    const dir = await migrationDir({ "001_legacy.sql": sql, "002_new.sql": "CREATE TABLE new_t (id int);" });
    const before = await planMigrations(pool, dir);
    expect(before).toMatchObject({ pending: ["002_new.sql"], applied: 1, missing_checksum: ["001_legacy.sql"] });
    await expect(runMigrations(pool, dir)).resolves.toEqual(["002_new.sql"]);
    const legacy = await pool.query("SELECT to_regclass('legacy_t') AS t");
    expect((legacy.rows[0] as { t: string | null }).t).toBeNull(); // 001 ble aldri kjørt på nytt
    const row = await pool.query("SELECT checksum FROM schema_migrations WHERE name = '001_legacy.sql'");
    expect((row.rows[0] as { checksum: string }).checksum).toBe(migrationChecksum(sql));
  }, 60_000);
});

describe("D: skrivebeskyttet plan", () => {
  it("på en fersk database: alt er pending og INGEN tabell opprettes", async () => {
    const { pool } = await freshDb();
    const dir = await migrationDir({ "001_a.sql": "CREATE TABLE plan_a (id int);", "002_b.sql": "CREATE TABLE plan_b (id int);" });
    const plan = await planMigrations(pool, dir);
    expect(plan).toEqual({ pending: ["001_a.sql", "002_b.sql"], applied: 0, checksum_mismatches: [], missing_checksum: [], unknown_applied: [] });
    const t = await pool.query("SELECT to_regclass('schema_migrations') AS t, to_regclass('plan_a') AS a");
    expect(t.rows[0]).toEqual({ t: null, a: null });
  }, 60_000);

  it("rapporterer endrede anvendte filer og databaserader koden ikke kjenner (eldre kode mot nyere skjema)", async () => {
    const { pool } = await freshDb();
    const dir = await migrationDir({ "001_a.sql": "CREATE TABLE p2_a (id int);", "002_b.sql": "CREATE TABLE p2_b (id int);" });
    await runMigrations(pool, dir);
    const older = await migrationDir({ "001_a.sql": "CREATE TABLE p2_a (id int, endret text);" });
    const plan = await planMigrations(pool, older);
    expect(plan.checksum_mismatches).toEqual(["001_a.sql"]);
    expect(plan.unknown_applied).toEqual(["002_b.sql"]);
    expect(plan.pending).toEqual([]);
  }, 60_000);
});

describe("E: JARVIS_DB_RUN_MIGRATIONS bruker ADMIN-konfig (aldri runtime-rollen)", () => {
  it("feiler lukket uten JARVIS_DB_ADMIN_PASSWORD - ingen stille fallback til runtime-tilkoblingen", async () => {
    await expect(runMigrationsAsAdmin({ JARVIS_DB_HOST: "127.0.0.1", JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "x" } as NodeJS.ProcessEnv)).rejects.toThrow(
      /migration_admin_credentials_missing/
    );
    await expect(runMigrationsAsAdmin({ JARVIS_DB_ADMIN_PASSWORD: "" } as NodeJS.ProcessEnv)).rejects.toThrow(/migration_admin_credentials_missing/);
  });

  it("kobler til med JARVIS_DB_ADMIN_USER/PASSWORD og lukker sin egen pool", async () => {
    const { name } = await freshDb();
    const dir = await migrationDir({ "001_admin.sql": "CREATE TABLE admin_t (id int);" });
    const env = {
      JARVIS_DB_HOST: "127.0.0.1",
      JARVIS_DB_PORT: String(port),
      JARVIS_DB_NAME: name,
      JARVIS_DB_ADMIN_USER: "postgres",
      JARVIS_DB_ADMIN_PASSWORD: "pw",
      // Runtime-credentials finnes og SKAL ignoreres:
      JARVIS_DB_USER: "jarvis_runtime",
      JARVIS_DB_PASSWORD: "ikke-brukt"
    } as NodeJS.ProcessEnv;
    await expect(runMigrationsAsAdmin(env, dir)).resolves.toEqual(["001_admin.sql"]);
  }, 60_000);

  it("api/main.ts kjører flagget via runMigrationsAsAdmin - aldri runMigrations(pool) med runtime-poolen", () => {
    const main = readFileSync(fileURLToPath(new URL("../../../apps/api/src/main.ts", import.meta.url)), "utf8");
    expect(main).toContain("await runMigrationsAsAdmin();");
    expect(main).not.toMatch(/runMigrations\(pool\)/);
  });
});
