import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "./backup.mjs";
import { INVENTORY_SQL, psqlOnce } from "./psql-session.mjs";
import { requireBinary, utcStamp } from "./tools.mjs";

export const SCRATCH_DB_PREFIX = "restore_verify_";

function decryptTo(identityFile, encryptedFile, consumerCmd) {
  return new Promise((resolve, reject) => {
    const age = spawn(requireBinary("age"), ["-d", "-i", identityFile], { stdio: ["pipe", "pipe", "pipe"] });
    const consumer = spawn(consumerCmd.file, consumerCmd.args, { env: consumerCmd.env, stdio: ["pipe", "ignore", "pipe"] });
    let ageErr = "";
    let consumerErr = "";
    let ageCode;
    let consumerCode;
    age.stderr.on("data", (d) => { ageErr += d; });
    consumer.stderr.on("data", (d) => { consumerErr += d; });
    createReadStream(encryptedFile).pipe(age.stdin);
    age.stdout.pipe(consumer.stdin);
    const finish = () => {
      if (ageCode === undefined || consumerCode === undefined) return;
      if (ageCode === 0 && consumerCode === 0) return resolve({ stderr: consumerErr });
      reject(new Error(`restore step failed (age exit ${ageCode}, restore exit ${consumerCode}): ${(ageErr + consumerErr).trim().slice(0, 300)}`));
    };
    age.on("error", reject);
    consumer.on("error", reject);
    age.on("close", (c) => { ageCode = c; finish(); });
    consumer.on("close", (c) => { consumerCode = c; finish(); });
  });
}

/**
 * Restore every database of a backup set into a SCRATCH server and compare the restored table
 * inventory and exact row counts with the manifest. Never touches the source; only creates
 * (and afterwards drops) databases whose names start with `restore_verify_`. Reports names
 * and counts only - never row data.
 */
export async function runRestoreVerify({ setDir, identityFile, scratchRunner, allowSameServer = false, keepScratch = false, now = new Date(), log = () => undefined }) {
  const manifestPath = join(setDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${setDir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!allowSameServer && scratchRunner.endpoint === manifest.source.endpoint) {
    throw new Error(
      `refusing to restore into the source server (${scratchRunner.endpoint}); use a separate scratch server or --allow-same-server`
    );
  }
  // 1. integrity before any decryption
  const integrity = [];
  for (const e of [...manifest.databases, manifest.globals]) {
    const path = join(setDir, e.file);
    const actual = existsSync(path) ? await sha256File(path) : undefined;
    integrity.push({ file: e.file, ok: actual === e.sha256 });
  }
  if (integrity.some((i) => !i.ok)) {
    return { ok: false, stage: "integrity", integrity, databases: [] };
  }
  const stamp = utcStamp(now);
  const report = { ok: true, stage: "complete", set: manifest.set, source_endpoint: manifest.source.endpoint, scratch_endpoint: scratchRunner.endpoint, integrity, databases: [] };
  const created = [];
  try {
    // 2. roles first (RLS policies and owners reference them). Pre-existing roles are fine.
    log("restoring cluster globals");
    await decryptTo(identityFile, join(setDir, manifest.globals.file), scratchRunner.command("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=0", "-f", "-"], { database: "postgres" }));
    for (const entry of manifest.databases) {
      const scratchDb = `${SCRATCH_DB_PREFIX}${entry.database}_${stamp}`.toLowerCase();
      if (!scratchDb.startsWith(SCRATCH_DB_PREFIX)) throw new Error("internal: scratch name guard");
      log(`restoring ${entry.database} into ${scratchDb}`);
      await psqlOnce(scratchRunner, "postgres", `CREATE DATABASE "${scratchDb}"`);
      created.push(scratchDb);
      await decryptTo(
        identityFile,
        join(setDir, entry.file),
        scratchRunner.command("pg_restore", ["--exit-on-error", "--no-password"], { database: scratchDb })
      );
      const restoredTables = (await psqlOnce(scratchRunner, scratchDb, INVENTORY_SQL)).split("\n").filter(Boolean);
      const expectedTables = entry.tables.map((t) => t.table);
      const missing = expectedTables.filter((t) => !restoredTables.includes(t));
      const extra = restoredTables.filter((t) => !expectedTables.includes(t));
      const mismatches = [];
      for (const t of entry.tables) {
        if (!restoredTables.includes(t.table)) continue;
        const actual = Number(await psqlOnce(scratchRunner, scratchDb, `SELECT count(*) FROM ${t.table}`));
        if (actual !== t.rows) mismatches.push({ table: t.table, expected: t.rows, restored: actual });
      }
      const ok = missing.length === 0 && extra.length === 0 && mismatches.length === 0;
      if (!ok) report.ok = false;
      report.databases.push({
        database: entry.database,
        ok,
        tables_expected: expectedTables.length,
        tables_restored: restoredTables.length,
        total_rows_expected: entry.tables.reduce((a, t) => a + t.rows, 0),
        missing_tables: missing,
        extra_tables: extra,
        row_count_mismatches: mismatches
      });
    }
  } catch (err) {
    report.ok = false;
    report.stage = "restore";
    report.error = String(err.message).slice(0, 400);
  } finally {
    if (!keepScratch) {
      for (const db of created) {
        if (!db.startsWith(SCRATCH_DB_PREFIX)) continue;
        await psqlOnce(scratchRunner, "postgres", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined);
      }
    }
  }
  return report;
}

/** Newest complete backup set in a directory (or undefined). */
export function listBackupSets(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((n) => /^jarvis-backup-\d{8}T\d{6}Z$/.test(n) && existsSync(join(outDir, n, "manifest.json")))
    .sort()
    .map((n) => ({ name: n, dir: join(outDir, n), manifest: JSON.parse(readFileSync(join(outDir, n, "manifest.json"), "utf8")) }));
}

export function backupAgeHours(outDir, now = new Date()) {
  const sets = listBackupSets(outDir);
  if (sets.length === 0) return undefined;
  const newest = sets[sets.length - 1];
  return (now.getTime() - new Date(newest.manifest.created_at_utc).getTime()) / 3_600_000;
}

/** Retention: removes ONLY complete backup sets (matching the set-name pattern) older than `retainDays`, always keeping the newest. */
export function pruneBackupSets(outDir, retainDays, now = new Date(), remove) {
  const sets = listBackupSets(outDir);
  const cutoff = now.getTime() - retainDays * 86_400_000;
  const removable = sets.slice(0, -1).filter((s) => new Date(s.manifest.created_at_utc).getTime() < cutoff);
  for (const s of removable) remove(s.dir);
  return removable.map((s) => s.name);
}

export { statSync };
