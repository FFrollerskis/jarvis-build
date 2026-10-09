import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { runBackup } from "../../../ops/backup/lib/backup.mjs";
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
