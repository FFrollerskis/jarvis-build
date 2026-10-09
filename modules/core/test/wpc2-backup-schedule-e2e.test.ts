import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { loadScheduleConfig } from "../../../ops/backup/lib/config.mjs";
import { LOCAL_MARKER, MANIFEST_AGE } from "../../../ops/backup/lib/offsite.mjs";
import { EXIT, buildDefaultDeps, listCompleteSets, runTick } from "../../../ops/backup/lib/schedule.mjs";
import { readStatusFile } from "../../../ops/backup/lib/state.mjs";
import { findBinary } from "../../../ops/backup/lib/tools.mjs";

/**
 * WP-C2 (OPS-RUNTIME): hele den planlagte kjeden mot EKTE verktøy - to Postgres-klynger (kilde + scratch), ekte `pg_dump`/`pg_restore`/`age`, ekte
 * CLI-underprosesser (backup og verify), lokal off-site-adapter og en lokal heartbeat-server på 127.0.0.1. Ingen NAS, ingen Docker, ingen ekstern tjeneste:
 * `docker compose exec`-banen og rclone/rsync/ssh er IKKE dekket her (se runbook §6.9 for kommandoene som verifiserer dem på den ekte maskinen).
 */
const haveTools = ["pg_dump", "pg_restore", "pg_dumpall", "psql", "age", "age-keygen"].every((t) => findBinary(t));
const SECRET_MARKER = "TOPSECRET-ROW-VALUE-wpc2";
const DB_PASSWORD = "pw";
const DBS = ["jarvis", "infisical", "langfuse"];

let stopSource: (() => Promise<void>) | undefined;
let stopScratch: (() => Promise<void>) | undefined;
let sourcePort = 0;
let scratchPort = 0;
let work = "";
let identityFile = "";
let recipient = "";
let hbServer: Server | undefined;
let hbPort = 0;
const hbHits: Array<{ method: string | undefined; url: string | undefined; bodyLength: number }> = [];

async function startCluster() {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpc2-"));
  return startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: DB_PASSWORD, port, persistent: false }));
}

async function exec(port: number, database: string, sql: string) {
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: DB_PASSWORD, database });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

if (process.env["CI"]) {
  it("CI har pg_dump/pg_restore/pg_dumpall/psql/age (ellers hadde WP-C2-kjeden stille blitt hoppet over)", () => {
    expect(haveTools).toBe(true);
  });
}

describe.skipIf(!haveTools)("WP-C2: planlagt backup → off-site → restore-verifisering → heartbeat mot ekte verktøy", () => {
  beforeAll(async () => {
    const a = await startCluster();
    const b = await startCluster();
    stopSource = a.stop;
    stopScratch = b.stop;
    sourcePort = a.port;
    scratchPort = b.port;
    for (const db of DBS) await a.postgres.createDatabase(db);
    await exec(sourcePort, "jarvis", `
      CREATE TABLE tenants (tenant_id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE audit_events (id serial PRIMARY KEY, payload jsonb NOT NULL);
      INSERT INTO tenants VALUES ('t1','${SECRET_MARKER}'),('t2','Annet');
      INSERT INTO audit_events (payload) SELECT jsonb_build_object('n', g, 'v', '${SECRET_MARKER}') FROM generate_series(1,120) g;
    `);
    await exec(sourcePort, "infisical", `CREATE TABLE secrets (id int, ciphertext text); INSERT INTO secrets VALUES (1,'${SECRET_MARKER}'),(2,'x');`);
    await exec(sourcePort, "langfuse", `CREATE TABLE traces (id int); INSERT INTO traces SELECT g FROM generate_series(1,17) g;`);
    work = mkdtempSync(join(tmpdir(), "jarvis-wpc2-work-"));
    identityFile = join(work, "identity.txt");
    execFileSync(findBinary("age-keygen")!, ["-o", identityFile], { stdio: "pipe" });
    recipient = readFileSync(identityFile, "utf8").match(/public key: (age1\S+)/)![1]!;
    hbServer = createServer((req: IncomingMessage, res) => {
      let n = 0;
      req.on("data", (c: Buffer) => { n += c.length; });
      req.on("end", () => { hbHits.push({ method: req.method, url: req.url, bodyLength: n }); res.statusCode = 200; res.end("OK"); });
    });
    await new Promise<void>((resolve) => hbServer!.listen(0, "127.0.0.1", resolve));
    hbPort = (hbServer.address() as AddressInfo).port;
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (hbServer ? hbServer.close(() => resolve()) : resolve()));
    await stopSource?.();
    await stopScratch?.();
    if (work) rmSync(work, { recursive: true, force: true });
  }, 120_000);

  const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    JARVIS_DB_ADMIN_USER: "postgres",
    JARVIS_DB_ADMIN_PASSWORD: DB_PASSWORD,
    JARVIS_BACKUP_AGE_RECIPIENT: recipient,
    JARVIS_SCRATCH_DB_PASSWORD: DB_PASSWORD,
    ...extra
  });

  it("første tikk: backup + off-site + restore-verify + heartbeat i riktig rekkefølge; deretter er alt stille (idempotent)", async () => {
    const out = join(work, "backups");
    const usb = join(work, "usb");
    const exportDir = join(work, "status-pub");
    mkdirSync(usb);
    writeFileSync(join(usb, LOCAL_MARKER), "");
    const env = baseEnv({
      JARVIS_BACKUP_OFFSITE_LOCAL_DIR: usb,
      JARVIS_BACKUP_OFFSITE_LOCAL_ALLOW_SAME_DEVICE: "true",
      JARVIS_BACKUP_VERIFY_IDENTITY_FILE: identityFile,
      JARVIS_BACKUP_VERIFY_SCRATCH_HOST: "127.0.0.1",
      JARVIS_BACKUP_VERIFY_SCRATCH_PORT: String(scratchPort),
      JARVIS_BACKUP_HEARTBEAT_URL: `http://127.0.0.1:${hbPort}/hc-not-real-key`
    });
    const config = loadScheduleConfig({ out, mode: "direct", host: "127.0.0.1", port: String(sourcePort), "status-export-dir": exportDir }, env);
    const logs: string[] = [];
    const deps = buildDefaultDeps(config, env, { log: (level: string, event: string) => logs.push(`${level}:${event}`) });

    const first = await runTick(config, deps, env);
    expect(first, logs.join(",")).toMatchObject({ exitCode: EXIT.OK, outcome: "ok", actions: ["backup", "offsite", "verify"], failed: [] });

    // Backup: komplett, kryptert sett uten klartekst.
    const sets = listCompleteSets(out);
    expect(sets).toHaveLength(1);
    const set = sets[0]!;
    for (const f of readdirSync(set.dir).filter((n) => n.endsWith(".age"))) {
      const bytes = readFileSync(join(set.dir, f));
      expect(bytes.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
      expect(bytes.includes(Buffer.from(SECRET_MARKER))).toBe(false);
    }

    // Off-site: nøyaktig de krypterte filene (inkl. kryptert manifest), ingen klartekst-manifest eller sjekksumfil.
    const copied = readdirSync(join(usb, set.name)).sort();
    expect(copied).toEqual(["globals.sql.age", "infisical.dump.age", "jarvis.dump.age", "langfuse.dump.age", MANIFEST_AGE].sort());
    for (const f of copied) expect(readFileSync(join(usb, set.name, f)).includes(Buffer.from(SECRET_MARKER))).toBe(false);
    expect(readFileSync(join(set.dir, MANIFEST_AGE)).includes(Buffer.from("public.tenants"))).toBe(false);

    // Statusfilen (0600) og den offentlige eksporten (0644).
    const status = readStatusFile(config.statusFile).status;
    expect(statSync(config.statusFile).mode & 0o777).toBe(0o600);
    expect(status.backup).toMatchObject({ last_set: set.name, consecutive_failures: 0, last_error_code: null });
    expect(status.offsite).toMatchObject({ state: "ok", adapter: "local", last_set: set.name, verification: "sha256" });
    expect(status.restore_verify).toMatchObject({ state: "ok", last_set: set.name, source: "local", reported_by: "local", tables: 4, rows: 2 + 120 + 2 + 17 });
    expect(status.restore_verify.duration_s).toBeGreaterThanOrEqual(0);
    expect(status.heartbeat).toMatchObject({ configured: true, last_ping_kind: "success", last_ping_ok: true });
    const pub = JSON.parse(readFileSync(join(exportDir, "backup-status.json"), "utf8"));
    expect(statSync(join(exportDir, "backup-status.json")).mode & 0o777).toBe(0o644);
    expect(pub).toMatchObject({ schema: 1, backup: { state: "ok", last_set: set.name, sets_on_disk: 1 }, offsite: { state: "ok", adapter: "local" }, restore_verify: { state: "ok", tables: 4 }, heartbeat: { last_ping_ok: true } });
    expect(JSON.stringify(pub)).not.toMatch(/password|usb|volume|127\.0\.0\.1|hc-not-real-key|TOPSECRET/i);

    // Heartbeat: start → suksess, ren GET uten kropp, nøkkelen i stien aldri i noe vi lagrer.
    expect(hbHits).toEqual([
      { method: "GET", url: "/hc-not-real-key/start", bodyLength: 0 },
      { method: "GET", url: "/hc-not-real-key", bodyLength: 0 }
    ]);
    expect(readFileSync(config.statusFile, "utf8")).not.toContain("hc-not-real-key");

    // Produksjonskilden er urørt, og restore-verifiseringen har ryddet scratch-databasene.
    expect((await exec(sourcePort, "jarvis", "SELECT count(*)::int AS n FROM audit_events")).rows[0]?.n).toBe(120);
    expect((await exec(scratchPort, "postgres", "SELECT datname FROM pg_database WHERE datname LIKE 'restore_verify_%'")).rows).toEqual([]);

    // Andre tikk: ingenting forfalt - ingen ny backup, ingen ping, ingen utskrift.
    hbHits.length = 0;
    const second = await runTick(config, deps, env);
    expect(second).toMatchObject({ exitCode: EXIT.OK, outcome: "nothing_due", actions: [] });
    expect(listCompleteSets(out)).toHaveLength(1);
    expect(hbHits).toEqual([]);
    expect(existsSync(config.lockFile)).toBe(false);
  }, 300_000);

  it("feilet backup (feil DB-passord): exit 2, /fail-ping, ingen halvferdig sett, passordet står ingen steder, forrige sett er urørt", async () => {
    const out = join(work, "backups-fail");
    const env = baseEnv({ JARVIS_DB_ADMIN_PASSWORD: "feil-passord-xyz", JARVIS_BACKUP_HEARTBEAT_URL: `http://127.0.0.1:${hbPort}/hc-not-real-key` });
    const config = loadScheduleConfig({ out, mode: "direct", host: "127.0.0.1", port: String(sourcePort), "status-export-dir": join(work, "pub-fail") }, env);
    const logs: string[] = [];
    hbHits.length = 0;
    const r = await runTick(config, buildDefaultDeps(config, env, { log: (level: string, event: string, f: object) => logs.push(JSON.stringify({ level, event, ...f })) }), env);
    expect(r).toMatchObject({ exitCode: EXIT.BACKUP_FAILED, outcome: "failed", failed: ["backup"] });
    expect(listCompleteSets(out)).toEqual([]);
    expect(readdirSync(out).filter((n) => n.startsWith("jarvis-backup-"))).toEqual([]);
    expect(hbHits.map((h) => h.url)).toEqual(["/hc-not-real-key/start", "/hc-not-real-key/fail"]);
    const status = readStatusFile(config.statusFile).status;
    expect(status.backup).toMatchObject({ consecutive_failures: 1, last_error_code: "backup_failed" });
    const everything = [readFileSync(config.statusFile, "utf8"), readFileSync(join(work, "pub-fail", "backup-status.json"), "utf8"), logs.join("\n")].join("\n");
    expect(everything).not.toContain("feil-passord-xyz");
  }, 120_000);

  it("restore-drill fra off-site (PC-rollen): henter nyeste sett fra fjernmålet, dekrypterer manifestet med den PRIVATE nøkkelen, verifiserer mot scratch og rydder", async () => {
    const usb = join(work, "usb");
    const pcOut = join(work, "pc-copy");
    const env = baseEnv({
      JARVIS_BACKUP_OFFSITE_LOCAL_DIR: usb,
      JARVIS_BACKUP_OFFSITE_LOCAL_ALLOW_SAME_DEVICE: "true",
      JARVIS_BACKUP_VERIFY_IDENTITY_FILE: identityFile,
      JARVIS_BACKUP_VERIFY_SCRATCH_HOST: "127.0.0.1",
      JARVIS_BACKUP_VERIFY_SCRATCH_PORT: String(scratchPort),
      JARVIS_BACKUP_VERIFY_SOURCE: "offsite"
    });
    delete env["JARVIS_DB_ADMIN_PASSWORD"]; // verifisereren trenger verken DB-admin-passord eller backup-rollen
    const config = loadScheduleConfig({ out: pcOut, roles: "verify" }, env);
    const r = await runTick(config, buildDefaultDeps(config, env), env);
    expect(r).toMatchObject({ exitCode: EXIT.OK, actions: ["verify"] });
    const status = readStatusFile(config.statusFile).status;
    expect(status.restore_verify).toMatchObject({ state: "ok", source: "offsite", tables: 4, rows: 141 });
    expect(status.restore_verify.fetch_duration_s).not.toBeNull();
    expect(readdirSync(pcOut).filter((n) => n.startsWith(".verify-tmp-"))).toEqual([]); // den hentede kopien er slettet
    const report = JSON.parse(readFileSync(join(pcOut, "restore-verify-report.json"), "utf8"));
    expect(report).toMatchObject({ ok: true, source: "offsite", tables: 4, rows: 141 });
    expect(JSON.stringify(report)).not.toMatch(/TOPSECRET|password/i);
  }, 300_000);
});
