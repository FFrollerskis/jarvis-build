import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import { describeDatabaseUrl, readMigrationFiles, startLeasedEmbeddedPostgres, withReadOnlyCatalogSession, type ReadOnlyPool } from "@jarvis/core/testing";
import { DATABASE_URL_ENV, parseCliArgs, runCli, type CliIo } from "../src/testing/schema-classes/cli.ts";

/**
 * WP-MC8a fiks-runde 1 (HIGH-1): CLI-ens exit-kode i FULL modus (katalogsjekk mot en migrert embedded Postgres) overlever `async-exit-hook`.
 *
 * Feilen (funnet av reviewer): `process.exitCode = code` ble overstyrt av `embedded-postgres` sin `async-exit-hook`, som kaller `process.exit(0)` ved
 * `beforeExit` - full modus ga ALLTID exit 0, også ved brudd og feil. `--static` startet aldri Postgres og var dermed upåvirket, så de gamle CLI-testene
 * (kun `--static`) så aldri feilen. Eneste ekte bevis er derfor en ekte barneprosess: disse testene starter CLI-en som en egen Node-prosess.
 *
 * Disse testene starter embedded Postgres og MÅ derfor kjøres som en vanlig bruker (ikke root), som alle andre DB-tester i pakken.
 */
const SCRIPT = fileURLToPath(new URL("../scripts/check-schema-classes.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const REAL = readMigrationFiles(MIGRATIONS_DIR);

const TENANT = "tenant_id = current_setting('jarvis.tenant_id', true)";
const GOOD_TABLE = `-- jarvis-class: cli_ok ORG_OWNED
CREATE TABLE cli_ok (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants (tenant_id), payload text NOT NULL DEFAULT '');
CREATE INDEX cli_ok_tenant_idx ON cli_ok (tenant_id);
ALTER TABLE cli_ok ENABLE ROW LEVEL SECURITY;
ALTER TABLE cli_ok FORCE ROW LEVEL SECURITY;
CREATE POLICY cli_ok_tenant ON cli_ok USING (${TENANT}) WITH CHECK (${TENANT});
GRANT SELECT, INSERT, UPDATE, DELETE ON cli_ok TO jarvis_app;
`;
const LEAKY_TABLE = GOOD_TABLE.replace(`USING (${TENANT}) WITH CHECK (${TENANT})`, "USING (true) WITH CHECK (true)");

async function migrationsDirWith(extra: ReadonlyArray<{ name: string; sql: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-mc8a-cli-full-"));
  for (const f of REAL) await writeFile(join(dir, f.name), f.sql);
  for (const f of extra) await writeFile(join(dir, f.name), f.sql);
  return dir;
}

const run = (...args: string[]): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });

describe("HIGH-1: full modus (embedded Postgres) gir riktig exit-kode som en ekte prosess", () => {
  it("exit 0 + «schemaklassifisering OK» for de ekte migrasjonene og for en korrekt ny tabell", async () => {
    const real = run();
    expect(real.status, `${real.stdout}\n${real.stderr}`).toBe(0);
    expect(real.stdout).toContain("modus: static+catalog");
    expect(real.stdout).toContain("schemaklassifisering OK");
    const ok = run("--migrations-dir", await migrationsDirWith([{ name: "149_cli_ok.sql", sql: GOOD_TABLE }]));
    expect(ok.status, `${ok.stdout}\n${ok.stderr}`).toBe(0);
    expect(ok.stdout).toContain("brudd (feiler): 0");
  }, 300_000);

  it("exit 1 (ikke 0) når en ny migrasjon lager en lekk policy (USING true), med regel-ID i stderr", async () => {
    const r = run("--migrations-dir", await migrationsDirWith([{ name: "149_cli_leaky.sql", sql: LEAKY_TABLE }]));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("schemaklassifisering BRUTT");
    expect(r.stderr).toContain("[policy_true] cli_ok");
    expect(r.stderr).toContain("[policy_scope] cli_ok");
  }, 300_000);

  it("exit 2 (ikke 0) når en migrasjon ikke lar seg anvende (syntaksfeil): «kunne ikke kjøre»", async () => {
    const r = run("--migrations-dir", await migrationsDirWith([{ name: "149_cli_broken.sql", sql: "CREATE TABLE oops (;\n" }]));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("check-schema-classes feilet");
    expect(r.stderr).toContain("149_cli_broken.sql");
  }, 300_000);
});

/** Kjører `runCli` i prosessen med innsamlet stdout/stderr (kun for modi som ikke avslutter prosessen). */
async function inProcess(argv: string[], options: { uid?: number; env?: Record<string, string | undefined> } = {}): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (t) => void out.push(t), err: (t) => void err.push(t), uid: options.uid ?? 1000, env: options.env ?? {} };
  const code = await runCli(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("L1: CLI-polering (argumenter, meldinger, ren JSON, ødelagt manifest)", () => {
  it("--manifest / --migrations-dir / --database-url uten verdi FEILER (exit 2) i stedet for å bruke en stille standard; en verdi som ser ut som et flagg avvises", async () => {
    for (const argv of [["--static", "--manifest"], ["--manifest", "--static"], ["--static", "--migrations-dir"], ["--migrations-dir", "--json"], ["--database-url"], ["--database-url", "--json"]]) {
      const r = await inProcess(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toMatch(/krever en verdi/);
    }
    expect(() => parseCliArgs(["--bogus"])).toThrow(/ukjent argument: --bogus/);
    expect(parseCliArgs(["--static"]).manifestPath).toBeUndefined();
  });

  it("--static sier tydelig at katalogreglene IKKE er kjørt (tekst og --json)", async () => {
    const text = await inProcess(["--static"]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain("Katalogreglene");
    expect(text.out).toContain("IKKE kjørt");
    expect(text.out).toContain("schemaklassifisering OK (kun statisk: katalogreglene er IKKE kjørt)");
    const json = JSON.parse((await inProcess(["--static", "--json"])).out) as { mode: string; catalogRulesRun: boolean };
    expect(json).toMatchObject({ mode: "static", catalogRulesRun: false });
  });

  it("strukturelt ugyldig manifest gir en KLAR feilmelding (exit 2), aldri «Cannot convert undefined or null to object»", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-mc8a-cli-manifest-"));
    const real = JSON.parse((await import("node:fs")).readFileSync(fileURLToPath(new URL("../src/db/schema-classes.baseline.json", import.meta.url)), "utf8")) as Record<string, unknown>;
    const without = async (key: string): Promise<string> => {
      const copy = { ...real };
      delete copy[key];
      const file = join(dir, `no-${key}.json`);
      await writeFile(file, JSON.stringify(copy));
      return file;
    };
    for (const key of ["exceptions", "exception_ceiling", "classes", "frozen_migrations", "definer_allowlist", "bootstrap_tables", "class_notes"]) {
      const r = await inProcess(["--static", "--manifest", await without(key)]);
      expect(r.code, key).toBe(2);
      expect(r.err, key).toContain(`manifest_shape:${key}`);
      expect(r.err, key).not.toContain("Cannot convert");
    }
    const notJson = join(dir, "not-json.json");
    await writeFile(notJson, "{ dette er ikke json");
    const a = await inProcess(["--static", "--manifest", notJson]);
    expect(a.code).toBe(2);
    expect(a.err).toContain("manifest_not_json");
    const missing = await inProcess(["--static", "--manifest", join(dir, "finnes-ikke.json")]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("manifest_unreadable");
    const wrongType = join(dir, "wrong-type.json");
    await writeFile(wrongType, JSON.stringify({ ...real, exceptions: "ingen" }));
    expect((await inProcess(["--static", "--manifest", wrongType])).err).toContain("manifest_shape:exceptions");
  });

  it("duplisert migrasjonsprefiks flagges også av --static (exit 1), og full modus rapporterer det UTEN å starte Postgres (exit 1)", async () => {
    const dir = await migrationsDirWith([{ name: "149_dup_a.sql", sql: "SELECT 1;\n" }, { name: "149_dup_b.sql", sql: "SELECT 2;\n" }]);
    const stat = await inProcess(["--static", "--migrations-dir", dir]);
    expect(stat.code, stat.out).toBe(1);
    expect(stat.err).toContain("[migration_prefix_duplicate]");
    expect(stat.err).toContain("149_dup_a.sql");
    const full = await inProcess(["--migrations-dir", dir]);
    expect(full.code, `${full.out}\n${full.err}`).toBe(1);
    expect(full.err).toContain("[migration_prefix_duplicate]");
    expect(full.out).toContain("IKKE kjørt");
  });

  it("full modus som root: exit 2 med en melding som nevner både --static og --database-url (Postgres startes aldri)", async () => {
    const r = await inProcess([], { uid: 0 });
    expect(r.code).toBe(2);
    expect(r.err).toContain("nekter å kjøre som root");
    expect(r.err).toContain("--static");
    expect(r.err).toContain("--database-url");
    expect(r.out).toBe("");
  });

  it("--static kan ikke kombineres med --database-url (flagg eller miljøvariabel)", async () => {
    expect((await inProcess(["--static", "--database-url", "postgres://x/y"])).err).toContain("bruk ett av dem");
    const viaEnv = await inProcess(["--static"], { env: { [DATABASE_URL_ENV]: "postgres://x/y" } });
    expect(viaEnv.code).toBe(2);
    expect(viaEnv.err).toContain(DATABASE_URL_ENV);
  });

  it("--json i FULL modus: stdout er KUN JSON (ingen Postgres-logg foran), exit 0", async () => {
    const r = run("--json");
    expect(r.status, `${r.stdout.slice(0, 300)}\n${r.stderr.slice(0, 300)}`).toBe(0);
    expect(r.stdout.trimStart().startsWith("{")).toBe(true);
    const parsed = JSON.parse(r.stdout) as { mode: string; catalogRulesRun: boolean; failures: unknown[]; known: unknown[] };
    expect(parsed).toMatchObject({ mode: "static+catalog", catalogRulesRun: true, failures: [] });
    expect(parsed.known).toHaveLength(29);
  }, 300_000);

  it("--static gir riktige exit-koder som prosess: 0 ren, 1 brudd, 2 ukjent argument", async () => {
    expect(run("--static").status).toBe(0);
    const dirty = run("--static", "--migrations-dir", await migrationsDirWith([{ name: "149_cli_unclassified.sql", sql: "CREATE TABLE cli_unclassified (id text PRIMARY KEY);\n" }]));
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("[unclassified_table] cli_unclassified");
    expect(run("--no-such-flag").status).toBe(2);
  });
});

describe("L8: --database-url - katalogsjekken mot en EKSISTERENDE database (eierens NAS-trinn), KUN LESING", () => {
  const PASSWORD = "live-pw-Zq7";
  const LIVE_USER = "live_owner";
  let stop: (() => Promise<void>) | undefined;
  let port = 0;
  let admin: pg.Pool;
  const url = (db: string): string => `postgres://${LIVE_USER}:${PASSWORD}@127.0.0.1:${port}/${db}`;
  const open = (database: string): pg.Pool => {
    const pool = new pg.Pool({ host: "127.0.0.1", port, database, user: LIVE_USER, password: PASSWORD });
    pool.on("error", () => undefined);
    return pool;
  };

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-mc8a-live-"));
    const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
    stop = leased.stop;
    port = leased.port;
    // Innlogging med et eget, gjenkjennelig passord (så testen kan bevise at det aldri havner i utskriften); superbruker som en restore-eier.
    const root = new pg.Pool({ host: "127.0.0.1", port, database: "postgres", user: "postgres", password: "pw" });
    root.on("error", () => undefined);
    await root.query(`CREATE ROLE ${LIVE_USER} LOGIN SUPERUSER PASSWORD '${PASSWORD}'`);
    await root.end();
    await leased.postgres.createDatabase("live_base");
    const base = open("live_base");
    await runMigrations(base);
    await base.end();
    admin = open("postgres");
    await admin.query("CREATE DATABASE live_clean TEMPLATE live_base");
    await admin.query("CREATE DATABASE live_dirty TEMPLATE live_base");
    const dirty = open("live_dirty");
    await dirty.query("ALTER POLICY sites_tenant_isolation ON sites USING (true) WITH CHECK (true)");
    await dirty.end();
  }, 300_000);

  afterAll(async () => {
    await admin?.end();
    await stop?.();
  }, 120_000);

  const fingerprint = async (db: string): Promise<string> => {
    const pool = open(db);
    try {
      const r = await pool.query("SELECT (SELECT count(*) FROM pg_class)::text || '/' || (SELECT count(*) FROM pg_policy)::text || '/' || (SELECT count(*) FROM schema_migrations)::text || '/' || (SELECT count(*) FROM pg_roles)::text AS f");
      return String((r.rows[0] as { f: string }).f);
    } finally {
      await pool.end();
    }
  };

  it("ren database: exit 0, tydelig merket EKSISTERENDE/KUN LESING, uten passord i utskriften; databasen er uendret", async () => {
    const before = await fingerprint("live_clean");
    const r = run("--database-url", url("live_clean"));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("EKSISTERENDE database");
    expect(r.stdout).toContain(`127.0.0.1:${port}/live_clean`);
    expect(r.stdout).toContain("KUN LESING");
    expect(r.stdout).toContain("schemaklassifisering OK");
    expect(`${r.stdout}${r.stderr}`).not.toContain(PASSWORD);
    expect(await fingerprint("live_clean")).toBe(before);
  }, 300_000);

  it("database med en lekk policy: exit 1 med regel-ID; URL kan også gis i miljøvariabelen (ingen passord i argumentlisten)", () => {
    const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 240_000,
      env: { ...process.env, [DATABASE_URL_ENV]: url("live_dirty") }
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("[policy_true] sites");
    expect(r.stderr).toContain("[policy_scope] sites");
    expect(`${r.stdout}${r.stderr}`).not.toContain(PASSWORD);
  }, 300_000);

  it("--json mot en live database er ren JSON og merker kilden", () => {
    const r = run("--json", "--database-url", url("live_clean"));
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ mode: "static+catalog", catalogRulesRun: true, readOnly: true, database: `127.0.0.1:${port}/live_clean`, failures: [] });
  }, 300_000);

  it("utilgjengelig database: exit 2 (kunne ikke kjøre), ingen passord i meldingen", () => {
    const r = run("--database-url", `postgres://postgres:hemmelig-pw-Q1@127.0.0.1:1/ingen`);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("check-schema-classes feilet");
    expect(`${r.stdout}${r.stderr}`).not.toContain("hemmelig-pw-Q1");
  }, 120_000);

  it("biblioteket: økten er READ ONLY - både DDL og DML avvises av Postgres, og ingenting overlever (ROLLBACK)", async () => {
    const pool = open("live_clean");
    try {
      const readOnlyPool = pool as unknown as ReadOnlyPool;
      await withReadOnlyCatalogSession(readOnlyPool, async (db) => {
        expect((await db.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0]).toEqual({ ro: "on" });
        await expect(db.query("CREATE TABLE should_not_exist (id int)")).rejects.toThrow(/read-only transaction/);
      });
      // Én setning per økt: etter første avviste setning er transaksjonen avbrutt.
      await withReadOnlyCatalogSession(readOnlyPool, async (db) => {
        await expect(db.query("INSERT INTO schema_migrations (name) VALUES ('x')")).rejects.toThrow(/read-only transaction/);
      });
      await withReadOnlyCatalogSession(readOnlyPool, async (db) => {
        await expect(db.query("ALTER TABLE sites DISABLE ROW LEVEL SECURITY")).rejects.toThrow(/read-only transaction/);
      });
      await withReadOnlyCatalogSession(readOnlyPool, async (db) => {
        await expect(db.query("GRANT ALL ON sites TO PUBLIC")).rejects.toThrow(/read-only transaction/);
      });
      expect((await pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name = 'x'")).rows[0]).toEqual({ n: 0 });
      expect((await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'sites'")).rows[0]).toEqual({ relrowsecurity: true });
      expect((await pool.query("SELECT to_regclass('should_not_exist') AS t")).rows[0]).toEqual({ t: null });
    } finally {
      await pool.end();
    }
  });

  it("describeDatabaseUrl skjuler brukernavn/passord og gjengir aldri en ugyldig URL", () => {
    expect(describeDatabaseUrl("postgres://bruker:passord@db.example.test:6543/jarvis")).toBe("db.example.test:6543/jarvis");
    expect(describeDatabaseUrl("postgresql://u:p@host/db")).toBe("host:5432/db");
    expect(describeDatabaseUrl("ikke en url med passord=hemmelig")).toBe("(ugyldig database-URL)");
  });
});
