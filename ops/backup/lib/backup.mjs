import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INVENTORY_SQL, PsqlSession, psqlOnce } from "./psql-session.mjs";
import { assertAgeRecipient, requireBinary, utcStamp } from "./tools.mjs";

export const MANIFEST_VERSION = 1;
/** Postgres sin `system_identifier` (pg_control): 64-bit heltall som er unikt per initdb og følger klyngen (også en fysisk standby). Heltall som tekst, evt. negativt (bigint). */
export const SYSTEM_IDENTIFIER_RE = /^-?\d{1,20}$/;
export const DEFAULT_DATABASES = ["jarvis", "infisical", "langfuse"];

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (d) => hash.update(d)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

/** dump-process stdout -> age -> encrypted file. The plaintext never touches disk. */
function pipeEncrypted(dumpCmd, recipient, outFile) {
  return new Promise((resolve, reject) => {
    const dump = spawn(dumpCmd.file, dumpCmd.args, { env: dumpCmd.env, stdio: ["ignore", "pipe", "pipe"] });
    const age = spawn(requireBinary("age"), ["-r", recipient, "-o", outFile], { stdio: ["pipe", "ignore", "pipe"] });
    let dumpErr = "";
    let ageErr = "";
    let dumpCode;
    let ageCode;
    dump.stderr.on("data", (d) => { dumpErr += d; });
    age.stderr.on("data", (d) => { ageErr += d; });
    dump.stdout.pipe(age.stdin);
    const finish = () => {
      if (dumpCode === undefined || ageCode === undefined) return;
      if (dumpCode === 0 && ageCode === 0) return resolve();
      rmSync(outFile, { force: true });
      reject(new Error(`backup step failed (dump exit ${dumpCode}, age exit ${ageCode}): ${(dumpErr + ageErr).trim().slice(0, 300)}`));
    };
    dump.on("error", (e) => reject(e));
    age.on("error", (e) => reject(e));
    dump.on("close", (c) => { dumpCode = c; finish(); });
    age.on("close", (c) => { ageCode = c; finish(); });
  });
}

/**
 * Review runde 2 (L1): kildeklyngens `system_identifier` lagres i manifestet, slik at restore-verifiseringen kan NEKTE en scratch-server som er SAMME klynge (alias-sikkert bevis -
 * `localhost`, DNS-navn og `docker-compose:postgres` mot `host:port` er alle samme `system_identifier`). Best effort: kan den ikke leses, utelates feltet (eldre sett har det ikke heller)
 * og backupen tas likevel - verifiseringen faller da tilbake på tom-sjekken alene.
 */
async function readSystemIdentifier(runner, database) {
  try {
    const out = (await psqlOnce(runner, database, "SELECT system_identifier FROM pg_control_system()")).trim();
    return SYSTEM_IDENTIFIER_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

async function snapshotAndInventory(runner, database) {
  const session = new PsqlSession(runner, database);
  try {
    await session.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await session.query("SELECT pg_export_snapshot()")).trim();
    const version = (await session.query("SHOW server_version")).trim();
    const tables = (await session.query(INVENTORY_SQL)).split("\n").filter(Boolean);
    const counts = [];
    for (const table of tables) {
      counts.push({ table, rows: Number((await session.query(`SELECT count(*) FROM ${table}`)).trim()) });
    }
    return { session, snapshot, version, counts };
  } catch (err) {
    await session.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Encrypted logical backup of every listed database plus cluster globals (roles).
 * Row counts in the manifest are read inside the SAME exported snapshot pg_dump uses, so a
 * restore verification can compare exact counts even while the source keeps changing.
 * Never inspects or records row data - only table names and counts.
 */
export async function runBackup({ runner, databases = DEFAULT_DATABASES, outDir, recipient, now = new Date(), log = () => undefined }) {
  assertAgeRecipient(recipient);
  requireBinary("age");
  const stamp = utcStamp(now);
  const setName = `jarvis-backup-${stamp}`;
  const setDir = join(outDir, setName);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (existsSync(setDir)) throw new Error(`backup set already exists: ${setDir}`);
  mkdirSync(setDir, { mode: 0o700 });
  const entries = [];
  try {
    for (const database of databases) {
      log(`backing up ${database}`);
      const { session, snapshot, version, counts } = await snapshotAndInventory(runner, database);
      const file = `${database}.dump.age`;
      const outFile = join(setDir, file);
      try {
        const dump = runner.command("pg_dump", ["-Fc", `--snapshot=${snapshot}`], { database });
        await pipeEncrypted(dump, recipient, outFile);
      } finally {
        await session.query("ROLLBACK").catch(() => undefined);
        await session.close().catch(() => undefined);
      }
      chmodSync(outFile, 0o600);
      entries.push({
        database,
        file,
        sha256: await sha256File(outFile),
        size_bytes: statSync(outFile).size,
        server_version: version,
        tables: counts
      });
    }
    const systemIdentifier = await readSystemIdentifier(runner, databases[0] ?? "postgres");
    if (systemIdentifier === null) log("could not read system_identifier from the source cluster - the manifest will not carry one");
    log("backing up cluster globals (roles)");
    const globalsFile = "globals.sql.age";
    await pipeEncrypted(runner.command("pg_dumpall", ["--globals-only"]), recipient, join(setDir, globalsFile));
    chmodSync(join(setDir, globalsFile), 0o600);
    const manifest = {
      manifest_version: MANIFEST_VERSION,
      created_at_utc: now.toISOString(),
      set: setName,
      source: { endpoint: runner.endpoint, mode: runner.mode, ...(systemIdentifier === null ? {} : { system_identifier: systemIdentifier }) },
      recipient_fingerprint: createHash("sha256").update(recipient).digest("hex").slice(0, 16),
      globals: { file: globalsFile, sha256: await sha256File(join(setDir, globalsFile)) },
      databases: entries
    };
    writeFileSync(join(setDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const sums = [...entries.map((e) => `${e.sha256}  ${e.file}`), `${manifest.globals.sha256}  ${globalsFile}`].join("\n");
    writeFileSync(join(setDir, "SHA256SUMS"), `${sums}\n`, { mode: 0o600 });
    return { setDir, manifest };
  } catch (err) {
    // A failed run must not leave a half-written set that looks like a backup.
    rmSync(setDir, { recursive: true, force: true });
    throw err;
  }
}
