import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { runBackup, sha256File } from "../../../ops/backup/lib/backup.mjs";
import { ROLE_SET_ALLOWLIST, sanitizeGlobals } from "../../../ops/backup/lib/globals-filter.mjs";
import { SCRATCH_DB_PREFIX, backupAgeHours, listBackupSets, pruneBackupSets, runRestoreVerify } from "../../../ops/backup/lib/restore-verify.mjs";
import { makeRunner } from "../../../ops/backup/lib/runner.mjs";
import { findBinary } from "../../../ops/backup/lib/tools.mjs";

/**
 * Remediation part 1 / JARVIS-007: real encrypted backup + real restore into a SEPARATE scratch
 * server, compared by table inventory and exact row counts. Runs against two real PostgreSQL
 * instances (source cluster + scratch cluster) with the real pg_dump / pg_restore / age binaries.
 * Test data contains marker strings that must never appear in the report or the manifest.
 */
const haveTools = ["pg_dump", "pg_restore", "pg_dumpall", "psql", "age", "age-keygen"].every((t) => findBinary(t));
const SECRET_MARKER = "TOPSECRET-ROW-VALUE-9d3f";
const DBS = ["jarvis", "infisical", "langfuse"];

let stopSource: (() => Promise<void>) | undefined;
let stopScratch: (() => Promise<void>) | undefined;
let sourcePort = 0;
let scratchPort = 0;
let work = "";
let identityFile = "";
let recipient = "";

async function startCluster() {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-backup-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  return leased;
}

async function execAs(port: number, database: string, sql: string, user: string, password: string) {
  const client = new pg.Client({ host: "127.0.0.1", port, user, password, database });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

const runnerFor = (port: number) => makeRunner({ mode: "direct", host: "127.0.0.1", port, user: "postgres", password: "pw" });

async function exec(port: number, database: string, sql: string) {
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "pw", database });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

// Falsk-grønn-vern: i CI skal verktøyene finnes (se .github/workflows/ci.yml), ikke bli en stille skip.
if (process.env["CI"]) {
  it("CI har pg_dump/pg_restore/pg_dumpall/psql/age (ellers hadde backup-testen stille blitt hoppet over)", () => {
    expect(haveTools).toBe(true);
  });
}

describe.skipIf(!haveTools)("kryptert backup + restore-verifisering (ekte Postgres, pg_dump/pg_restore/age)", () => {
  beforeAll(async () => {
    const a = await startCluster();
    const b = await startCluster();
    const source = a.postgres;
    stopSource = a.stop;
    stopScratch = b.stop;
    sourcePort = a.port;
    scratchPort = b.port;
    for (const db of DBS) await source.createDatabase(db);
    await exec(sourcePort, "jarvis", `
      CREATE TABLE tenants (tenant_id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE audit_events (id serial PRIMARY KEY, payload jsonb NOT NULL);
      CREATE TABLE "Odd Table" ("Col A" int);
      INSERT INTO tenants VALUES ('t1','${SECRET_MARKER}'),('t2','Annet');
      INSERT INTO audit_events (payload) SELECT jsonb_build_object('n', g, 'v', '${SECRET_MARKER}') FROM generate_series(1,250) g;
      INSERT INTO "Odd Table" VALUES (1),(2),(3);
      CREATE SCHEMA extra; CREATE TABLE extra.notes (id int);
      INSERT INTO extra.notes SELECT g FROM generate_series(1,40) g;
    `);
    await exec(sourcePort, "infisical", `CREATE TABLE secrets (id int, ciphertext text); INSERT INTO secrets VALUES (1,'${SECRET_MARKER}'),(2,'x');`);
    await exec(sourcePort, "langfuse", `CREATE TABLE traces (id int); INSERT INTO traces SELECT g FROM generate_series(1,17) g;`);
    work = mkdtempSync(join(tmpdir(), "jarvis-backup-work-"));
    identityFile = join(work, "identity.txt");
    execFileSync(findBinary("age-keygen")!, ["-o", identityFile], { stdio: "pipe" });
    recipient = readFileSync(identityFile, "utf8").match(/public key: (age1\S+)/)![1]!;
  }, 240_000);

  afterAll(async () => {
    await stopSource?.();
    await stopScratch?.();
    if (work) rmSync(work, { recursive: true, force: true });
  }, 120_000);

  it("backup: krypterte filer, manifest med tabellinventar + radtall, ingen klartekst, ingen radinnhold i manifestet", async () => {
    const out = join(work, "out1");
    const { setDir, manifest } = await runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient, now: new Date("2026-10-01T22:00:00Z") });
    expect(manifest.set).toBe("jarvis-backup-20261001T220000Z");
    // runde 2 (L1): kildeklyngens system_identifier følger settet (alias-sikkert «samme klynge»-bevis), og er IKKE scratch-klyngens
    const idOf = async (port: number) => (await exec(port, "postgres", "SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0]?.id as string;
    expect(manifest.source.system_identifier).toBe(await idOf(sourcePort));
    expect(manifest.source.system_identifier).not.toBe(await idOf(scratchPort));
    expect(manifest.databases.map((d) => d.database)).toEqual(DBS);
    const jarvis = manifest.databases.find((d) => d.database === "jarvis");
    expect(jarvis).toBeDefined();
    const byTable = Object.fromEntries(jarvis!.tables.map((t) => [t.table, t.rows]));
    expect(byTable).toEqual({ "public.tenants": 2, "public.audit_events": 250, 'public."Odd Table"': 3, "extra.notes": 40 });
    // krypterte filer: age-format, ikke klartekst, ingen markørstreng
    for (const file of [...readdirSync(setDir)].filter((f) => f.endsWith(".age"))) {
      const bytes = readFileSync(join(setDir, file));
      expect(bytes.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
      expect(bytes.includes(Buffer.from(SECRET_MARKER))).toBe(false);
      expect(bytes.includes(Buffer.from("PGDMP"))).toBe(false);
      expect(statSync(join(setDir, file)).mode & 0o077).toBe(0);
    }
    // ingen ukrypterte dump-filer, og manifest/SHA256SUMS inneholder ingen radinnhold
    expect(readdirSync(setDir).sort()).toEqual(["SHA256SUMS", "globals.sql.age", "infisical.dump.age", "jarvis.dump.age", "langfuse.dump.age", "manifest.json"]);
    expect(readFileSync(join(setDir, "manifest.json"), "utf8")).not.toContain(SECRET_MARKER);
    expect(readFileSync(join(setDir, "SHA256SUMS"), "utf8")).toMatch(/^[0-9a-f]{64} {2}jarvis\.dump\.age$/m);
  }, 120_000);

  it("restore-verifisering inn i en SEPARAT scratch-server: samme tabeller og eksakte radtall, ingen radinnhold i rapporten, scratch ryddet", async () => {
    const out = join(work, "out2");
    const { setDir } = await runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient, now: new Date("2026-10-01T22:05:00Z") });
    const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort), now: new Date("2026-10-01T22:06:00Z") });
    expect(report.ok).toBe(true);
    expect(report.stage).toBe("complete");
    expect(report.databases.map((d) => [d.database, d.ok, d.tables_expected, d.tables_restored])).toEqual([
      ["jarvis", true, 4, 4],
      ["infisical", true, 1, 1],
      ["langfuse", true, 1, 1]
    ]);
    expect(report.databases.find((d) => d.database === "jarvis")?.total_rows_expected).toBe(295);
    expect(JSON.stringify(report)).not.toContain(SECRET_MARKER);
    // scratch-databasene er droppet igjen, og kilden er urørt
    const left = await exec(scratchPort, "postgres", `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_DB_PREFIX}%'`);
    expect(left.rows).toEqual([]);
    const still = await exec(sourcePort, "jarvis", "SELECT count(*)::int AS n FROM audit_events");
    expect(still.rows[0]?.n).toBe(250);
  }, 240_000);

  it("radtallene i manifestet er tatt i samme snapshot som dumpen - endringer under/etter backup gir ikke falsk avvik", async () => {
    const out = join(work, "out3");
    const { setDir } = await runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient, now: new Date("2026-10-01T22:10:00Z") });
    await exec(sourcePort, "jarvis", "INSERT INTO audit_events (payload) VALUES ('{}')"); // kilden vokser etter backup
    const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort), now: new Date("2026-10-01T22:11:00Z") });
    expect(report.ok).toBe(true);
    await exec(sourcePort, "jarvis", "DELETE FROM audit_events WHERE id = (SELECT max(id) FROM audit_events)");
  }, 240_000);

  it("avvik fanges: en slettet rad i manifestet gir mismatch (verifiseringen kan feile)", async () => {
    const out = join(work, "out4");
    const { setDir } = await runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient, now: new Date("2026-10-01T22:15:00Z") });
    const manifestPath = join(setDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.databases[0].tables.find((t: { table: string }) => t.table === "public.tenants").rows = 999;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort), now: new Date("2026-10-01T22:16:00Z") });
    expect(report.ok).toBe(false);
    expect(report.databases[0]?.row_count_mismatches).toEqual([{ table: "public.tenants", expected: 999, restored: 2 }]);
  }, 240_000);

  it("korrupt/endret backup-fil avvises på integritetssjekken før dekryptering", async () => {
    const out = join(work, "out5");
    const { setDir } = await runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient, now: new Date("2026-10-01T22:20:00Z") });
    const file = join(setDir, "jarvis.dump.age");
    const bytes = readFileSync(file);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 0xff;
    writeFileSync(file, bytes);
    const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort) });
    expect(report.ok).toBe(false);
    expect(report.stage).toBe("integrity");
    expect(report.integrity.find((i) => i.file === "jarvis.dump.age")?.ok).toBe(false);
  }, 240_000);

  it("feil privatnøkkel kan ikke dekryptere - verifiseringen feiler (aldri en stille suksess)", async () => {
    const out = join(work, "out6");
    const { setDir } = await runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient, now: new Date("2026-10-01T22:25:00Z") });
    const other = join(work, "other-identity.txt");
    execFileSync(findBinary("age-keygen")!, ["-o", other], { stdio: "pipe" });
    const report = await runRestoreVerify({ setDir, identityFile: other, scratchRunner: runnerFor(scratchPort), now: new Date("2026-10-01T22:26:00Z") });
    expect(report.ok).toBe(false);
    expect(report.stage).toBe("restore");
    const left = await exec(scratchPort, "postgres", `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_DB_PREFIX}%'`);
    expect(left.rows).toEqual([]);
  }, 240_000);

  it("nekter å restore til kildeserveren (samme endepunkt) uten eksplisitt flagg", async () => {
    const out = join(work, "out7");
    const { setDir } = await runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient, now: new Date("2026-10-01T22:30:00Z") });
    await expect(runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(sourcePort) })).rejects.toThrow(/refusing to restore into the source server/);
  }, 240_000);

  it("review F1: en feilpekt scratch (samme server under et annet navn) nektes av tom-sjekken - ingenting skrives, kildens roller og passord er urørt", async () => {
    await exec(sourcePort, "postgres", "CREATE ROLE f1_probe LOGIN PASSWORD 'gammelt-passord'");
    try {
      const out = join(work, "out7b");
      const { setDir } = await runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient, now: new Date("2026-10-01T22:31:00Z") });
      await exec(sourcePort, "postgres", "ALTER ROLE f1_probe PASSWORD 'nytt-passord'"); // produksjonen har gått videre siden backupen
      const hash = async () => (await exec(sourcePort, "postgres", "SELECT rolpassword FROM pg_authid WHERE rolname = 'f1_probe'")).rows[0]?.rolpassword as string;
      const before = await hash();
      expect(before).toMatch(/^SCRAM-SHA-256\$/);
      // `localhost` ≠ `127.0.0.1` som streng, men er samme server: bare tom-sjekken kan stoppe dette
      const alias = makeRunner({ mode: "direct", host: "localhost", port: sourcePort, user: "postgres", password: "pw" });
      expect(alias.endpoint).not.toBe(runnerFor(sourcePort).endpoint);
      const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: alias, now: new Date("2026-10-01T22:32:00Z") });
      expect(report).toMatchObject({ ok: false, stage: "scratch_guard" });
      expect(report.error).toContain("ikke en tom, kastbar instans");
      expect(await hash()).toBe(before); // passordet er IKKE overskrevet til backup-tidens
      expect((await exec(sourcePort, "postgres", `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_DB_PREFIX}%'`)).rows).toEqual([]);
      expect((await exec(sourcePort, "jarvis", "SELECT count(*)::int AS n FROM tenants")).rows[0]?.n).toBe(2);
    } finally {
      await exec(sourcePort, "postgres", "DROP ROLE IF EXISTS f1_probe");
    }
  }, 240_000);

  it("review F2: en ondsinnet globals.sql (konsistent mot sitt eget manifest) kjører ALDRI psql-metakommandoer på verifisererens vert - positiv kontroll: ubeskyttet psql ville gjort det", async () => {
    const marker = join(work, "pwned-marker");
    const hostile = `\\! touch ${marker}\nCREATE ROLE f2_probe;\n`;
    // Positiv kontroll: ekte psql kjører metakommandoen når den får teksten rett inn (slik koden gjorde før F2). Uten denne kontrollen beviser testen ingenting.
    const direct = runnerFor(scratchPort).command("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=0", "-f", "-"], { database: "postgres" });
    execFileSync(direct.file, direct.args, { env: direct.env, input: hostile, stdio: ["pipe", "pipe", "pipe"] });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    await exec(scratchPort, "postgres", "DROP ROLE IF EXISTS f2_probe");

    // Samme innhold, kryptert med den offentlige nøkkelen i et sett hvis manifest stemmer med filen (age er ikke autentisert)
    const { setDir, manifest } = await runBackup({ runner: runnerFor(sourcePort), outDir: join(work, "out7c"), recipient, now: new Date("2026-10-01T22:33:00Z") });
    const file = join(setDir, "globals.sql.age");
    rmSync(file);
    execFileSync(findBinary("age")!, ["-r", recipient, "-o", file], { input: hostile });
    manifest.globals.sha256 = await sha256File(file);
    writeFileSync(join(setDir, "manifest.json"), JSON.stringify(manifest));
    const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort), now: new Date("2026-10-01T22:34:00Z") });
    expect(report).toMatchObject({ ok: false, stage: "globals" });
    expect(existsSync(marker)).toBe(false);
    expect((await exec(scratchPort, "postgres", "SELECT 1 FROM pg_roles WHERE rolname = 'f2_probe'")).rows).toEqual([]);
    expect((await exec(scratchPort, "postgres", `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_DB_PREFIX}%'`)).rows).toEqual([]);
  }, 240_000);

  it("review F2: roller restores til scratch UTEN passord-hasher (en scratch skal ikke arve produksjonens passord, og en feilpekt skal aldri få dem overskrevet)", async () => {
    await exec(sourcePort, "postgres", "CREATE ROLE f2_pw LOGIN PASSWORD 'produksjons-passord'");
    try {
      const { setDir } = await runBackup({ runner: runnerFor(sourcePort), outDir: join(work, "out7d"), recipient, now: new Date("2026-10-01T22:35:00Z") });
      const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort), now: new Date("2026-10-01T22:36:00Z") });
      expect(report.ok).toBe(true);
      expect(report.globals?.passwords_stripped).toBeGreaterThanOrEqual(2); // f2_pw og postgres-rollen
      const onScratch = await exec(scratchPort, "postgres", "SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname = 'f2_pw'");
      expect(onScratch.rows).toEqual([{ rolcanlogin: true, rolpassword: null }]);
      // verifisereren kan fortsatt logge inn etter globals-restoren (begge klyngene bruker samme passord i testen, så dette beviser ikke selve stripping - det gjør raden over)
      expect((await exec(scratchPort, "postgres", "SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await exec(sourcePort, "postgres", "DROP ROLE IF EXISTS f2_pw");
      await exec(scratchPort, "postgres", "DROP ROLE IF EXISTS f2_pw");
    }
  }, 240_000);

  /**
   * WP-C2 re-review runde 2, M1 - mot EKTE psql/Postgres. `m1_verifier` er en egen superbruker-rolle på scratch-klyngen som verifisereren logger inn som (slik `postgres` er det i produksjon):
   * å bruke den i stedet for `postgres` lar oss bevise utelåsing uten å risikere å bricke selve klyngen. Hver positiv kontroll viser at den URENSEDE setningen faktisk har effekten
   * reviewer påviste (uten dem beviser testene ingenting); deretter at den samme teksten gjennom koden ikke har det.
   */
  const verifierRunner = () => makeRunner({ mode: "direct", host: "127.0.0.1", port: scratchPort, user: "m1_verifier", password: "vpw" });
  const canLogin = async (user: string, password: string) => {
    try {
      await execAs(scratchPort, "postgres", "SELECT 1", user, password);
      return true;
    } catch {
      return false;
    }
  };
  const rawPsql = (runner: ReturnType<typeof makeRunner>, input: string) => {
    const cmd = runner.command("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=0", "-f", "-"], { database: "postgres" });
    execFileSync(cmd.file, cmd.args, { env: cmd.env, input, stdio: ["pipe", "pipe", "pipe"] });
  };
  const roleSettings = async () => (await exec(scratchPort, "postgres", "SELECT coalesce(r.rolname, '<ALL>') AS role, s.setconfig::text AS setconfig FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole ORDER BY 1, 2")).rows.map((row: { role: string; setconfig: string }) => ({ role: row.role, setconfig: row.setconfig.replace(/[\\"]/g, "") })) as Array<{ role: string; setconfig: string }>; // Postgres siterer verdier med skråstrek: normaliseres bort
  /** Et backup-sett av `langfuse` (liten) der globals.sql er byttet ut med `globalsText(original)`, kryptert og konsistent mot sitt eget manifest (age er ikke autentisert). */
  async function setWithGlobals(name: string, when: string, globalsText: (original: string) => string) {
    const { setDir, manifest } = await runBackup({ runner: runnerFor(sourcePort), databases: ["langfuse"], outDir: join(work, name), recipient, now: new Date(when) });
    const file = join(setDir, "globals.sql.age");
    const original = execFileSync(findBinary("age")!, ["-d", "-i", identityFile, file], { encoding: "utf8" });
    rmSync(file);
    execFileSync(findBinary("age")!, ["-r", recipient, "-o", file], { input: globalsText(original) });
    manifest.globals.sha256 = await sha256File(file);
    writeFileSync(join(setDir, "manifest.json"), JSON.stringify(manifest));
    return setDir;
  }

  it("review M1 (ekte psql): `ALTER ROLE <verifisereren> WITH NOLOGIN` låser den ute uten filteret - gjennom filteret rører verifisereren seg ikke, mens andre roller får attributtene sine", async () => {
    await exec(scratchPort, "postgres", "CREATE ROLE m1_verifier LOGIN SUPERUSER PASSWORD 'vpw'");
    try {
      // positiv kontroll: ubeskyttet psql (slik koden gjorde før) låser verifisereren ute - også via CURRENT_USER
      for (const hostile of ["ALTER ROLE m1_verifier WITH NOLOGIN;\n", "ALTER ROLE CURRENT_USER WITH NOSUPERUSER NOLOGIN;\n"]) {
        expect(await canLogin("m1_verifier", "vpw")).toBe(true);
        rawPsql(verifierRunner(), hostile);
        expect(await canLogin("m1_verifier", "vpw"), hostile).toBe(false);
        await exec(scratchPort, "postgres", "ALTER ROLE m1_verifier WITH LOGIN SUPERUSER");
      }
      // samme angrep gjennom koden, pakket inn i et ellers ekte uttrekk
      const setDir = await setWithGlobals("out-m1a", "2026-10-01T23:00:00Z", (original) =>
        `${original}\nALTER ROLE m1_verifier WITH NOLOGIN NOSUPERUSER;\nALTER ROLE "M1_VERIFIER" WITH NOLOGIN;\nALTER ROLE m1_verifier SET statement_timeout TO '1ms';\nCOMMENT ON ROLE m1_verifier IS 'x';\nCREATE ROLE m1_other;\nALTER ROLE m1_other WITH LOGIN CREATEDB;\nALTER ROLE m1_other SET statement_timeout TO '5s';\n`);
      const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: verifierRunner(), now: new Date("2026-10-01T23:01:00Z") });
      expect(report).toMatchObject({ ok: true, stage: "complete" });
      expect(report.globals?.login_role_statements_skipped).toBe(4); // NOLOGIN, "M1_VERIFIER" (case-over-match), SET statement_timeout og COMMENT - alle om verifisereren
      expect(await canLogin("m1_verifier", "vpw")).toBe(true);
      expect((await exec(scratchPort, "postgres", "SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'm1_verifier'")).rows).toEqual([{ rolcanlogin: true, rolsuper: true }]);
      // andre roller får det filteret slipper gjennom (attributter og allowlistede innstillinger) - det er hele poenget med å restore roller
      expect((await exec(scratchPort, "postgres", "SELECT rolcanlogin, rolcreatedb FROM pg_roles WHERE rolname = 'm1_other'")).rows).toEqual([{ rolcanlogin: true, rolcreatedb: true }]);
      expect(await roleSettings()).toEqual([{ role: "m1_other", setconfig: "{statement_timeout=5s}" }]);
    } finally {
      await exec(scratchPort, "postgres", "DROP ROLE IF EXISTS m1_other");
      await exec(scratchPort, "postgres", "DROP ROLE IF EXISTS m1_verifier");
    }
  }, 240_000);

  it("review M1 (ekte psql): `ALTER ROLE ALL SET`, `CURRENT_USER` og `SET session_preload_libraries` har klyngeglobal effekt uten filteret - med filteret stopper filen på trinn `globals`, ingenting skrives", async () => {
    await exec(scratchPort, "postgres", "CREATE ROLE m1_verifier LOGIN SUPERUSER PASSWORD 'vpw'");
    await exec(scratchPort, "postgres", "CREATE ROLE m1_other");
    try {
      // positive kontroller med harmløse verdier som likevel viser omfanget: ALL = rad uten rolle (gjelder ALLE tilkoblinger), og preload-biblioteket lagres klyngeglobalt for rollen
      rawPsql(runnerFor(scratchPort), "ALTER ROLE ALL SET application_name TO 'm1_all';\nALTER ROLE m1_other SET session_preload_libraries TO '/tmp/x.so';\n");
      expect(await roleSettings()).toEqual([
        { role: "<ALL>", setconfig: "{application_name=m1_all}" },
        { role: "m1_other", setconfig: "{session_preload_libraries=/tmp/x.so}" }
      ]);
      await exec(scratchPort, "postgres", "ALTER ROLE ALL RESET application_name");
      await exec(scratchPort, "postgres", "ALTER ROLE m1_other RESET session_preload_libraries");
      expect(await roleSettings()).toEqual([]);

      let n = 0;
      for (const hostile of [
        "ALTER ROLE ALL SET statement_timeout TO '1ms';", "ALTER ROLE ALL IN DATABASE postgres SET application_name TO 'x';", "ALTER ROLE CURRENT_USER WITH NOSUPERUSER NOLOGIN;",
        "ALTER ROLE postgres SET session_preload_libraries TO '/tmp/x.so';", "ALTER ROLE m1_other SET session_preload_libraries TO '/tmp/x.so';", "ALTER ROLE m1_other SET dynamic_library_path TO '/tmp';",
        "ALTER ROLE m1_other SET session_replication_role TO replica;", "GRANT pg_monitor TO PUBLIC;"
      ]) {
        const setDir = await setWithGlobals(`out-m1b${n}`, `2026-10-01T23:1${n}:00Z`, (original) => `${original}\n${hostile}\n`);
        const report = await runRestoreVerify({ setDir, identityFile, scratchRunner: verifierRunner(), now: new Date(`2026-10-01T23:1${n}:30Z`) });
        n += 1;
        expect(report, hostile).toMatchObject({ ok: false, stage: "globals" });
        expect(await roleSettings(), hostile).toEqual([]);
        expect((await exec(scratchPort, "postgres", `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_DB_PREFIX}%'`)).rows, hostile).toEqual([]);
        expect(await canLogin("m1_verifier", "vpw"), hostile).toBe(true);
        expect((await exec(scratchPort, "postgres", "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'm1_verifier'")).rows).toEqual([{ rolcanlogin: true }]);
      }
    } finally {
      await exec(scratchPort, "postgres", "ALTER ROLE ALL RESET ALL").catch(() => undefined);
      await exec(scratchPort, "postgres", "DROP ROLE IF EXISTS m1_other");
      await exec(scratchPort, "postgres", "DROP ROLE IF EXISTS m1_verifier");
    }
  }, 240_000);

  it("review M1, differensialtest mot ekte psql: ALLE setninger filteret godtar (roller x skjemaer x parametere) kan verken låse ute verifisereren eller endre noe annet enn attributter/allowlistede innstillinger for andre roller", async () => {
    await exec(scratchPort, "postgres", "CREATE ROLE m1_verifier LOGIN SUPERUSER PASSWORD 'vpw'");
    const roles = ["m1_verifier", "M1_VERIFIER", '"m1_verifier"', "m1_other", '"M1_Other"', "CURRENT_USER", "SESSION_USER", "CURRENT_ROLE", "ALL", "PUBLIC", "NONE", '"all"'];
    // [parameter, gyldig verdi]: de ufarlige får effekt hos andre roller; de farlige skal aldri komme gjennom (en gyldig verdi sikrer at Postgres HADDE godtatt dem)
    const gucs: Array<[string, string]> = [
      ["application_name", "'x'"], ["statement_timeout", "'5s'"], ["lock_timeout", "'5s'"], ["timezone", "'UTC'"], ["search_path", "public"], ["default_transaction_read_only", "on"],
      ["session_preload_libraries", "'/tmp/x.so'"], ["dynamic_library_path", "'/tmp'"], ["session_replication_role", "replica"], ["role", "postgres"], ["plperl.on_plperl_init", "'1'"]
    ];
    const corpus: string[] = [];
    for (const r of roles) {
      corpus.push(`CREATE ROLE ${r};`, `ALTER ROLE ${r} WITH NOLOGIN NOSUPERUSER;`, `ALTER ROLE ${r} WITH LOGIN CREATEDB PASSWORD 'p';`, `COMMENT ON ROLE ${r} IS 'x';`, `GRANT pg_monitor TO ${r};`, `GRANT m1_other TO ${r} GRANTED BY ${r};`);
      for (const [g, v] of gucs) corpus.push(`ALTER ROLE ${r} SET ${g} TO ${v};`, `ALTER ROLE ${r} IN DATABASE postgres SET ${g} = ${v};`);
    }
    const allowed = new Set(["m1_other", "M1_Other"]);
    let accepted = 0;
    let rejected = 0;
    let skipped = 0;
    try {
      for (const text of corpus) {
        let sql: string;
        try {
          const r = sanitizeGlobals(`${text}\n`, { loginRole: "m1_verifier" });
          sql = r.sql;
          if (sql === "") skipped += 1;
        } catch {
          rejected += 1;
          continue;
        }
        accepted += 1;
        await exec(scratchPort, "postgres", `CREATE ROLE m1_other LOGIN; CREATE ROLE "M1_Other" LOGIN;`);
        try {
          if (sql !== "") rawPsql(verifierRunner(), sql);
          expect(await canLogin("m1_verifier", "vpw"), text).toBe(true);
          expect((await exec(scratchPort, "postgres", "SELECT a.rolcanlogin, a.rolsuper, a.rolcreatedb, a.rolcreaterole, a.rolreplication, a.rolbypassrls, a.rolpassword IS NULL AS nopw FROM pg_authid a WHERE a.rolname = 'm1_verifier'")).rows, text)
            .toEqual([{ rolcanlogin: true, rolsuper: true, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, nopw: false }]);
          for (const row of await roleSettings()) {
            expect(allowed.has(row.role), `${text} -> ${JSON.stringify(row)}`).toBe(true); // aldri ALL, aldri verifisereren
            const key = (/^\{"?([A-Za-z_.]+)=/.exec(row.setconfig)?.[1] ?? "").toLowerCase(); // Postgres lagrer kanonisk case (TimeZone)
            expect(ROLE_SET_ALLOWLIST.has(key), `${text} -> ${row.setconfig}`).toBe(true); // aldri preload/library/replication_role/role/dotted - kontrollert mot det Postgres faktisk lagret
          }
          // ingen nye databaser/roller utenfor de forventede
          expect((await exec(scratchPort, "postgres", "SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') AND datname NOT LIKE 'restore_verify_%'")).rows, text).toEqual([]);
        } finally {
          await exec(scratchPort, "postgres", `DROP ROLE IF EXISTS m1_other, "M1_Other", "all"`);
        }
      }
    } finally {
      await exec(scratchPort, "postgres", "DROP ROLE IF EXISTS m1_verifier");
    }
    // korpuset må treffe alle tre utfall, ellers beviser det lite
    expect(corpus.length).toBeGreaterThan(300);
    expect(rejected).toBeGreaterThan(100);
    expect(skipped).toBeGreaterThan(10);
    expect(accepted - skipped).toBeGreaterThan(50);
  }, 240_000);

  it("review L1 (ekte Postgres): samme system_identifier nektes selv mot en TOM scratch - fjernes feltet (eldre sett), passerer den samme tomme scratchen (så det var kun identifikatoren som stoppet)", async () => {
    const { setDir, manifest } = await runBackup({ runner: runnerFor(sourcePort), databases: ["langfuse"], outDir: join(work, "out-l1a"), recipient, now: new Date("2026-10-02T00:00:00Z") });
    const scratchId = (await exec(scratchPort, "postgres", "SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0]?.id as string;
    manifest.source.system_identifier = scratchId; // «scratch-klyngen ER kilden, under et annet navn»
    writeFileSync(join(setDir, "manifest.json"), JSON.stringify(manifest));
    const refused = await runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort), now: new Date("2026-10-02T00:01:00Z") });
    expect(refused).toMatchObject({ ok: false, stage: "scratch_guard" });
    expect(refused.error).toContain("samme system_identifier");
    expect((await exec(scratchPort, "postgres", `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_DB_PREFIX}%'`)).rows).toEqual([]);
    delete manifest.source.system_identifier; // eldre sett: ingen identifikator, kun tom-sjekken
    writeFileSync(join(setDir, "manifest.json"), JSON.stringify(manifest));
    const logs: string[] = [];
    const ok = await runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort), now: new Date("2026-10-02T00:02:00Z"), log: (m: string) => logs.push(m) });
    expect(ok).toMatchObject({ ok: true, stage: "complete" });
    expect(logs.some((m) => m.includes("ingen system_identifier i manifestet"))).toBe(true);
  }, 240_000);

  it("review L1 (ekte Postgres): en database som heter « postgres» og views/matviews i postgres-databasen gjør scratch ikke-kastbar (tidligere passerte begge)", async () => {
    const { setDir } = await runBackup({ runner: runnerFor(sourcePort), databases: ["langfuse"], outDir: join(work, "out-l1b"), recipient, now: new Date("2026-10-02T00:10:00Z") });
    const verify = (minute: number) => runRestoreVerify({ setDir, identityFile, scratchRunner: runnerFor(scratchPort), now: new Date(`2026-10-02T00:${String(11 + minute).padStart(2, "0")}:00Z`) });
    await exec(scratchPort, "postgres", 'CREATE DATABASE " postgres"');
    try {
      const report = await verify(0);
      expect(report).toMatchObject({ ok: false, stage: "scratch_guard" });
      expect(report.error).toContain("1 database(r)");
    } finally {
      await exec(scratchPort, "postgres", 'DROP DATABASE IF EXISTS " postgres"');
    }
    let minute = 1;
    for (const [create, drop] of [
      ["CREATE VIEW public.l1_view AS SELECT 1 AS x", "DROP VIEW IF EXISTS public.l1_view"],
      ["CREATE MATERIALIZED VIEW public.l1_mv AS SELECT 1 AS x", "DROP MATERIALIZED VIEW IF EXISTS public.l1_mv"],
      ["CREATE SEQUENCE public.l1_seq", "DROP SEQUENCE IF EXISTS public.l1_seq"]
    ] as const) {
      await exec(scratchPort, "postgres", create);
      try {
        const report = await verify(minute++);
        expect(report, create).toMatchObject({ ok: false, stage: "scratch_guard" });
        expect(report.error, create).toContain("tabell(er)/visning(er)/sekvens(er)");
      } finally {
        await exec(scratchPort, "postgres", drop);
      }
    }
    expect(await verify(minute)).toMatchObject({ ok: true, stage: "complete" }); // kontroll: ryddet scratch passerer igjen
  }, 240_000);

  it("ingen ukryptert backup: manglende/ugyldig age-mottaker avvises FØR noe skrives", async () => {
    const out = join(work, "out8");
    for (const bad of [undefined, "", "hemmelig passfrase", "age-secret-key-1ABC"] as unknown[]) {
      await expect(runBackup({ runner: runnerFor(sourcePort), outDir: out, recipient: bad })).rejects.toThrow(/age public key/);
    }
    expect(() => readdirSync(out)).toThrow(); // mappen ble aldri opprettet
  });

  it("mislykket backup etterlater ingen halvferdig backup-sett", async () => {
    const out = join(work, "out9");
    await expect(
      runBackup({ runner: runnerFor(sourcePort), databases: ["jarvis", "finnes_ikke"], outDir: out, recipient, now: new Date("2026-10-01T22:35:00Z") })
    ).rejects.toThrow();
    expect(listBackupSets(out)).toEqual([]);
    expect(readdirSync(out)).toEqual([]);
  }, 120_000);

  it("status/retention: alder beregnes fra manifestet; prune fjerner kun gamle KOMPLETTE sett og beholder alltid det nyeste", async () => {
    const out = join(work, "out10");
    const t0 = new Date("2026-08-01T00:00:00Z");
    for (const iso of ["2026-08-01T00:00:00Z", "2026-09-20T00:00:00Z", "2026-10-01T00:00:00Z"]) {
      await runBackup({ runner: runnerFor(sourcePort), databases: ["langfuse"], outDir: out, recipient, now: new Date(iso) });
    }
    expect(backupAgeHours(out, new Date("2026-10-01T12:00:00Z"))).toBeCloseTo(12, 5);
    expect(backupAgeHours(join(work, "tom"), t0)).toBeUndefined();
    writeFileSync(join(out, "ikke-et-backupsett.txt"), "x");
    const removed: string[] = [];
    const pruned = pruneBackupSets(out, 30, new Date("2026-10-02T00:00:00Z"), (d) => removed.push(d));
    expect(pruned).toEqual(["jarvis-backup-20260801T000000Z"]);
    expect(removed).toHaveLength(1);
    // selv med retention 0 beholdes det nyeste settet
    const all = pruneBackupSets(out, 0, new Date("2027-01-01T00:00:00Z"), () => undefined);
    expect(all).not.toContain("jarvis-backup-20261001T000000Z");
  }, 240_000);
});

// Ikke en ekte hemmelighet: bevisst laventropi-plassholder (gitleaks generic-api-key).
const DUMMY_PASSWORD = "not-real";

describe("runner: produksjonsbanen (docker compose exec) - kommandokonstruksjon", () => {
  it("passordet sendes ved NAVN (-e PGPASSWORD) og står aldri i argv", () => {
    const runner = makeRunner({ mode: "docker", composeFile: "/srv/jarvis/infra/local/docker-compose.yml", user: "postgres", password: DUMMY_PASSWORD });
    const cmd = runner.command("pg_dump", ["-Fc", "--snapshot=00000003-1"], { database: "jarvis" });
    expect(cmd.file).toBe("docker");
    expect(cmd.args).toEqual([
      "compose", "-f", "/srv/jarvis/infra/local/docker-compose.yml", "exec", "-T", "-e", "PGPASSWORD", "postgres",
      "pg_dump", "-U", "postgres", "-d", "jarvis", "-Fc", "--snapshot=00000003-1"
    ]);
    expect(cmd.args.join(" ")).not.toContain(DUMMY_PASSWORD);
    expect(cmd.env["PGPASSWORD"]).toBe(DUMMY_PASSWORD);
    expect(runner.endpoint).toBe("docker-compose:postgres");
  });

  it("scratch-container-modus bruker `docker exec -i` mot den navngitte engangs-containeren (aldri compose, aldri kilden)", () => {
    const runner = makeRunner({ mode: "container", container: "jarvis-restore-scratch-1", password: "scratch-pw" });
    const cmd = runner.command("pg_restore", ["--exit-on-error"], { database: "restore_verify_x" });
    expect(cmd.args).toEqual(["exec", "-i", "-e", "PGPASSWORD", "jarvis-restore-scratch-1", "pg_restore", "-U", "postgres", "-d", "restore_verify_x", "--exit-on-error"]);
    expect(cmd.args.join(" ")).not.toContain("scratch-pw");
    expect(runner.endpoint).toBe("docker-container:jarvis-restore-scratch-1");
    expect(() => makeRunner({ mode: "container", password: "pw" }).command("psql", [])).toThrow(/container name/);
  });

  it("krever passord og compose-fil i docker-modus", () => {
    expect(() => makeRunner({ mode: "docker", composeFile: "/x", password: "" })).toThrow(/password/);
    expect(() => makeRunner({ mode: "docker", password: "pw" }).command("psql", [])).toThrow(/composeFile/);
  });
});
