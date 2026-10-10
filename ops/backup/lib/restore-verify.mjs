import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_IDENTIFIER_RE, sha256File } from "./backup.mjs";
import { GLOBALS_MAX_BYTES, GlobalsRejectedError, sanitizeGlobals } from "./globals-filter.mjs";
import { INVENTORY_SQL, psqlOnce } from "./psql-session.mjs";
import { requireBinary, utcStamp } from "./tools.mjs";

export const SCRATCH_DB_PREFIX = "restore_verify_";
/** Systemdatabasene i enhver Postgres-klynge. De teller aldri som «innhold» når vi spør om scratch-serveren er tom. */
const SCRATCH_SYSTEM_DB = new Set(["postgres", "template0", "template1"]);
/**
 * Databasene en scratch-server får ha FØR verifiseringen: systemdatabasene og rester etter våre egne (avbrutte) kjøringer. Alt annet betyr at serveren
 * har et annet liv enn å være kastbar (typisk: `JARVIS_BACKUP_VERIFY_SCRATCH_HOST` peker på produksjon) - og da skal ingenting skrives dit.
 */
export const SCRATCH_ALLOWED_DB = /^(?:postgres|template0|template1|restore_verify_[a-z0-9_]+)$/;

// Settet er UBETRODD (age er ikke autentisert - alle med den offentlige nøkkelen kan lage et konsistent sett): alt som kommer fra manifestet og senere havner
// i SQL eller filstier valideres mot en lukket form FØR noe kjører. Meldingene under inneholder aldri verdier fra manifestet.
const SET_NAME = /^jarvis-backup-\d{8}T\d{6}Z$/;
const DB_NAME = /^[A-Za-z0-9_]{1,63}$/;
const AGE_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.age$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SQL_IDENT = String.raw`(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")`;
const TABLE_NAME = new RegExp(`^${SQL_IDENT}\\.${SQL_IDENT}$`);
const MAX_TABLES = 50_000;
const MAX_DATABASES = 32;

/**
 * Tom liste = manifestet har forventet form. `table` blir limt inn i `SELECT count(*) FROM <table>` og `database` i `CREATE DATABASE`, så begge må være
 * nøyaktig `schema.tabell` / et enkelt identifikatornavn (siterte identifikatorer tillatt) - ikke noe som kan åpne en ny setning.
 * @returns {string[]}
 */
export function manifestProblems(manifest) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObj(manifest)) return ["manifestet er ikke et objekt"];
  const problems = [];
  if (typeof manifest.set !== "string" || !SET_NAME.test(manifest.set)) problems.push("set har ugyldig navn");
  if (!isObj(manifest.source) || typeof manifest.source.endpoint !== "string") problems.push("source.endpoint mangler");
  else if (manifest.source.system_identifier !== undefined && (typeof manifest.source.system_identifier !== "string" || !SYSTEM_IDENTIFIER_RE.test(manifest.source.system_identifier))) problems.push("source.system_identifier er ugyldig");
  if (!isObj(manifest.globals) || typeof manifest.globals.file !== "string" || !AGE_FILE.test(manifest.globals.file) || !SHA256.test(String(manifest.globals.sha256))) {
    problems.push("globals har ugyldig fil eller sjekksum");
  }
  if (!Array.isArray(manifest.databases) || manifest.databases.length === 0 || manifest.databases.length > MAX_DATABASES) {
    problems.push("databases mangler eller har for mange oppføringer");
    return problems;
  }
  const seen = new Set();
  for (const [i, d] of manifest.databases.entries()) {
    if (!isObj(d)) {
      problems.push(`databases[${i}] er ikke et objekt`);
      continue;
    }
    if (typeof d.database !== "string" || !DB_NAME.test(d.database)) problems.push(`databases[${i}].database har ugyldig navn`);
    else if (seen.has(d.database.toLowerCase())) problems.push(`databases[${i}].database er oppgitt to ganger`);
    else seen.add(d.database.toLowerCase());
    if (typeof d.file !== "string" || !AGE_FILE.test(d.file)) problems.push(`databases[${i}].file har ugyldig navn`);
    if (typeof d.sha256 !== "string" || !SHA256.test(d.sha256)) problems.push(`databases[${i}].sha256 er ugyldig`);
    if (!Array.isArray(d.tables) || d.tables.length > MAX_TABLES) {
      problems.push(`databases[${i}].tables mangler eller er for stor`);
      continue;
    }
    for (const t of d.tables) {
      if (!isObj(t) || typeof t.table !== "string" || t.table.length > 200 || !TABLE_NAME.test(t.table) || !Number.isSafeInteger(t.rows) || t.rows < 0) {
        problems.push(`databases[${i}].tables har ugyldig tabellnavn eller radtall`);
        break;
      }
    }
  }
  return problems;
}

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

/** `age -d` til minnet (kun små filer som globals.sql). Overskrides `maxBytes`, drepes age og `GlobalsRejectedError` kastes. */
function decryptToString(identityFile, encryptedFile, maxBytes = GLOBALS_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const age = spawn(requireBinary("age"), ["-d", "-i", identityFile], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    let tooBig = false;
    let err = "";
    age.stdout.on("data", (d) => {
      size += d.length;
      if (size > maxBytes) {
        tooBig = true;
        age.kill("SIGKILL");
        return;
      }
      chunks.push(d);
    });
    age.stderr.on("data", (d) => { err += d; });
    age.stdin.on("error", () => undefined); // EPIPE hvis age avslutter (feil nøkkel) før all inndata er lest
    createReadStream(encryptedFile).on("error", reject).pipe(age.stdin);
    age.on("error", reject);
    age.on("close", (code) => {
      if (tooBig) return reject(new GlobalsRejectedError("for stor"));
      if (code !== 0) return reject(new Error(`restore step failed (age exit ${code}): ${err.trim().slice(0, 300)}`));
      return resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** Kjører ALLEREDE FILTRERT SQL (`sanitizeGlobals`) gjennom psql på stdin. ON_ERROR_STOP=0: en rolle som finnes fra før er greit. */
function runPsqlScript(runner, sql) {
  const cmd = runner.command("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=0", "-f", "-"], { database: "postgres" });
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-4096); });
    child.stdin.on("error", () => undefined);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`restore step failed (psql globals exit ${code}): ${err.trim().slice(0, 300)}`))));
    child.stdin.end(sql);
  });
}

/**
 * Det som regnes som «innhold» i `postgres`-databasen på scratch-serveren: tabeller, partisjonerte tabeller, VISNINGER, materialiserte visninger, fremmede tabeller og sekvenser
 * utenfor systemskjemaene (review runde 2, L1: en server med kun views/matviews i `postgres` passerte vakten når bare `r`/`p` ble talt).
 */
const GUARD_INVENTORY_SQL = `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  ORDER BY 1`;

/**
 * Review F1: scratch-vakten kan ikke være en strengsammenligning av endepunktene. `docker-compose:postgres` mot `host:port`, `localhost` mot `127.0.0.1` og
 * en DNS-alias gir alle ulike strenger for SAMME server - og da ville rolle- og passord-restoren gått mot produksjon (reprodusert av reviewer: admin-passordet
 * ble overskrevet til backup-tidens). FØR noe skrives kreves derfor at serveren faktisk ER en tom, kastbar instans: ingen databaser utenfor
 * postgres/template0/template1/restore_verify_* (og ingen med samme navn som en database i settet), og ingen tabeller/visninger/sekvenser i `postgres`-databasen.
 * Kun lesing. Svaret inneholder aldri verdier fra settet (databasenavnene kommer fra scratch-serveren).
 *
 * Review runde 2 (L1): to lag til. (1) Har manifestet kildeklyngens `system_identifier`, nektes en scratch-server med SAMME identifikator - alias-sikkert bevis for «samme klynge», uavhengig av
 * hva som ligger i den. Manglende felt (eldre sett) er ikke et krav; kallerens logg sier at kun tom-sjekken beskytter da. (2) Databasenavnene leses som `quote_ident(datname)` og sammenlignes UTEN
 * normalisering: en database som heter « postgres» (med mellomrom) ble tidligere trimmet til `postgres` og passerte. Roller sjekkes ikke: en varig scratch samler roller fra tidligere kjøringer
 * (CREATE ROLE kjøres med ON_ERROR_STOP=0), så rolle-tomhet kan ikke kreves.
 * @returns {Promise<{ ok: true, systemIdentifier: "checked" | "absent" } | { ok: false, error: string }>}
 */
export async function checkScratchServer(scratchRunner, manifest) {
  const short = (err) => String(err?.message ?? err).slice(0, 200);
  const expectedId = manifest.source?.system_identifier;
  if (typeof expectedId === "string") {
    let actualId;
    try {
      actualId = (await psqlOnce(scratchRunner, "postgres", "SELECT system_identifier FROM pg_control_system()")).trim();
    } catch (err) {
      return { ok: false, error: `kunne ikke lese system_identifier på scratch-serveren: ${short(err)}` };
    }
    if (!SYSTEM_IDENTIFIER_RE.test(actualId)) return { ok: false, error: "scratch-serveren ga ingen gyldig system_identifier - ikke en kjent Postgres-klynge" };
    if (actualId === expectedId) {
      return { ok: false, error: "scratch-serveren er SAMME Postgres-klynge som kilden (samme system_identifier) - ikke en tom, kastbar instans; peker JARVIS_BACKUP_VERIFY_SCRATCH_HOST på produksjon?" };
    }
  }
  let names;
  try {
    names = (await psqlOnce(scratchRunner, "postgres", "SELECT quote_ident(datname) FROM pg_database ORDER BY 1")).split("\n").filter(Boolean);
  } catch (err) {
    return { ok: false, error: `kunne ikke lese databaselisten på scratch-serveren: ${short(err)}` };
  }
  if (!names.includes("postgres")) return { ok: false, error: "scratch-serveren svarte ikke som en Postgres-server (ingen postgres-database)" };
  const wanted = new Set(manifest.databases.map((d) => d.database));
  const foreign = names.filter((n) => !SCRATCH_ALLOWED_DB.test(n) || (!SCRATCH_SYSTEM_DB.has(n) && wanted.has(n)));
  if (foreign.length > 0) {
    const sample = foreign.slice(0, 3).map((n) => n.slice(0, 40)).join(", ");
    return {
      ok: false,
      error: `scratch-serveren er ikke en tom, kastbar instans: ${foreign.length} database(r) utenfor systemdatabasene og restore_verify_-restene (f.eks. ${sample}) - peker JARVIS_BACKUP_VERIFY_SCRATCH_HOST på produksjon?`
    };
  }
  try {
    const objects = (await psqlOnce(scratchRunner, "postgres", GUARD_INVENTORY_SQL)).split("\n").filter(Boolean);
    if (objects.length > 0) return { ok: false, error: `postgres-databasen på scratch-serveren inneholder ${objects.length} tabell(er)/visning(er)/sekvens(er) - ikke en tom, kastbar instans` };
  } catch (err) {
    return { ok: false, error: `kunne ikke lese tabelloversikten på scratch-serveren: ${short(err)}` };
  }
  return { ok: true, systemIdentifier: typeof expectedId === "string" ? "checked" : "absent" };
}

/**
 * Restore every database of a backup set into a SCRATCH server and compare the restored table
 * inventory and exact row counts with the manifest. Never touches the source; only creates
 * (and afterwards drops) databases whose names start with `restore_verify_`. Reports names
 * and counts only - never row data.
 *
 * Rekkefølge (review F1/F2): manifestet valideres → endepunkt-sammenligning (billig førstelinje) → integritet (SHA-256 før dekryptering) →
 * scratch-serveren verifiseres TOM → først da skrives noe (roller fra det FILTRERTE globals.sql, så databasene). `allowSameServer` omgår KUN endepunkt-sammenligningen:
 * tom-sjekken er alltid på. Settet er ubetrodd; `pg_restore` kjører SQL fra dumpen som SUPERUSER på scratch-serveren (kan f.eks. `COPY … PROGRAM`), så scratch MÅ være en
 * kastbar instans (engangs-container uten nettverk) - globals-filteret beskytter verifisererens VERT (psql-metakommandoer), ikke scratch-serveren mot dumpen.
 */
export async function runRestoreVerify({ setDir, identityFile, scratchRunner, allowSameServer = false, keepScratch = false, now = new Date(), log = () => undefined }) {
  const manifestPath = join(setDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${setDir}`);
  const early = (stage, error, extra = {}) => ({ ok: false, stage, scratch_endpoint: scratchRunner.endpoint, error, integrity: [], databases: [], ...extra });
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return early("manifest", "manifest.json er ikke gyldig JSON");
  }
  const problems = manifestProblems(manifest);
  if (problems.length > 0) return early("manifest", `manifest.json har ugyldig form: ${problems.slice(0, 4).join("; ")}`);
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
  // 2. the scratch server must PROVE that it is disposable before anything is written to it (review F1)
  const guard = await checkScratchServer(scratchRunner, manifest);
  if (!guard.ok) return early("scratch_guard", guard.error, { set: manifest.set, integrity });
  if (guard.systemIdentifier === "absent") log("ingen system_identifier i manifestet (eldre sett): kun tom-sjekken beskytter mot en feilpekt scratch-server");
  const stamp = utcStamp(now);
  const report = { ok: true, stage: "complete", set: manifest.set, source_endpoint: manifest.source.endpoint.slice(0, 120), scratch_endpoint: scratchRunner.endpoint, integrity, databases: [] };
  const created = [];
  try {
    // 3. roles first (RLS policies and owners reference them). Pre-existing roles are fine.
    // Review F2: globals.sql er UBETRODD SQL (age er ikke autentisert). Den dekrypteres til MINNET, whitelist-filtreres (ingen psql-metakommandoer, kun kjente
    // rolle-setninger, passord-hasher fjernes) og psql får aldri annet enn den gjenoppbygde, validerte teksten.
    log("restoring cluster globals");
    // M1 (runde 2): filteret får rollen vi selv logger inn som og slipper aldri setninger som angår den gjennom (ellers kunne `ALTER ROLE postgres WITH NOLOGIN` låst oss ute midt i kjøringen).
    const globals = sanitizeGlobals(await decryptToString(identityFile, join(setDir, manifest.globals.file)), { loginRole: scratchRunner.user ?? "postgres" });
    report.globals = { statements: globals.statements, passwords_stripped: globals.passwordsStripped, login_role_statements_skipped: globals.skippedLoginRole };
    if (globals.sql !== "") await runPsqlScript(scratchRunner, globals.sql);
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
    report.stage = err instanceof GlobalsRejectedError ? "globals" : "restore";
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
