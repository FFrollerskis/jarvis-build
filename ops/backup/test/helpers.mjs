import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Delte testhjelpere for WP-C2 (ikke en testfil selv: vitest tar kun `*.test.mjs`). */
export const AGE_HEADER = "age-encryption.org/v1\n-> X25519 AAAA\nBBBB\n--- CCCC\n";
export const RECIPIENT = `age1${"q".repeat(58)}`; // gyldig FORM på en offentlig nøkkel, ikke en ekte nøkkel

const dirs = [];
export function tempDir(prefix = "wpc2-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
export function cleanupTempDirs() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const stampOf = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
export const hoursAgo = (now, h) => new Date(now.getTime() - h * 3_600_000);

/** Et realistisk, KOMPLETT backup-sett (age-header + manifest med ekte SHA-256) uten Postgres/age. */
export function makeSet(outDir, createdAt, { databases = ["jarvis", "infisical", "langfuse"], withSums = true, systemIdentifier } = {}) {
  const name = `jarvis-backup-${stampOf(createdAt)}`;
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const database of databases) {
    const file = `${database}.dump.age`;
    const body = Buffer.concat([Buffer.from(AGE_HEADER), randomBytes(200 + database.length)]);
    writeFileSync(join(dir, file), body, { mode: 0o600 });
    entries.push({ database, file, sha256: sha256(body), size_bytes: body.length, server_version: "16.4", tables: [{ table: "public.tenants", rows: 2 }] });
  }
  const globals = Buffer.concat([Buffer.from(AGE_HEADER), randomBytes(80)]);
  writeFileSync(join(dir, "globals.sql.age"), globals, { mode: 0o600 });
  const manifest = {
    manifest_version: 1, created_at_utc: createdAt.toISOString(), set: name, source: { endpoint: "docker-compose:postgres", mode: "docker", ...(systemIdentifier === undefined ? {} : { system_identifier: systemIdentifier }) },
    recipient_fingerprint: "0123456789abcdef", globals: { file: "globals.sql.age", sha256: sha256(globals) }, databases: entries
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  if (withSums) writeFileSync(join(dir, "SHA256SUMS"), `${entries.map((e) => `${e.sha256}  ${e.file}`).join("\n")}\n${manifest.globals.sha256}  globals.sql.age\n`, { mode: 0o600 });
  return { name, dir, manifest };
}

/** Erstatter age-kryptering av manifestet i tester uten `age`: gyldig age-header + fast innhold. */
export async function fakeEncryptManifest({ setDir }) {
  writeFileSync(join(setDir, "manifest.json.age"), Buffer.concat([Buffer.from(AGE_HEADER), randomBytes(40)]), { mode: 0o600 });
}

/** Lokal HTTP-server på 127.0.0.1 som registrerer hver forespørsel (metode, sti, headere, kropp) - ingen nettverk ut av maskinen. */
export async function startServer(handler = (_req, res) => { res.statusCode = 200; res.end("OK"); }) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(req, res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    requests,
    port,
    url: (path = "/") => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

/** Skriver en kjørbar falsk binær (bash) i en egen mappe som kan legges først i PATH. */
export function fakeBinDir(binaries) {
  const dir = tempDir("wpc2-bin-");
  for (const [name, script] of Object.entries(binaries)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/**
 * En falsk Postgres-KLIENT for tester av restore-verifiseringen uten Postgres: `runner.command()` peker på et node-skript som svarer på de få spørringene
 * verifisereren stiller (databaselisten, tabelloversikten, radtall) og LOGGER hvert kall - også teksten som mates til `psql -f -`. `calls()` er beviset på hva som
 * ble skrevet til «serveren» og i hvilken rekkefølge. `state` kan endres underveis (`setState`).
 */
export function fakeScratchRunner({ endpoint = "127.0.0.1:55432", databases = ["postgres", "template0", "template1"], tables = {}, counts = {}, fail = false, systemIdentifier = "5000000000000000001" } = {}) {
  const dir = tempDir("wpc2-fakepg-");
  const script = join(dir, "fake-pg.mjs");
  const stateFile = join(dir, "state.json");
  const logFile = join(dir, "calls.jsonl");
  writeFileSync(logFile, "");
  writeFileSync(script, `
    import { appendFileSync, readFileSync } from "node:fs";
    const [tool, ...args] = process.argv.slice(2);
    const state = JSON.parse(readFileSync(process.env.FAKE_PG_STATE, "utf8"));
    const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
    const sql = flag("-c");
    const stdin = flag("-f") === "-" ? readFileSync(0, "utf8") : "";
    appendFileSync(process.env.FAKE_PG_LOG, JSON.stringify({ tool, database: flag("-d"), sql: sql ?? null, stdin }) + "\\n");
    if (state.fail) { console.error("psql: error: connection to server failed"); process.exit(2); }
    if (sql && /pg_control_system/.test(sql)) { if (state.systemIdentifier === null) { console.error("psql: error: function pg_control_system() does not exist"); process.exit(2); } console.log(state.systemIdentifier); process.exit(0); }
    if (sql && /FROM pg_database/.test(sql)) { console.log(state.databases.join("\\n")); process.exit(0); }
    if (sql && /FROM pg_class/.test(sql)) { console.log((state.tables[flag("-d")] ?? []).join("\\n")); process.exit(0); }
    if (sql && /^SELECT count/.test(sql)) { console.log(String(state.counts[sql.replace(/^SELECT count\\(\\*\\) FROM /, "")] ?? 0)); process.exit(0); }
    process.exit(0);
  `);
  const state = { databases, tables, counts, fail, systemIdentifier };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  save();
  const runner = {
    mode: "direct",
    endpoint,
    command: (tool, args, { database } = {}) => ({
      file: process.execPath,
      args: [script, tool, ...(database ? ["-d", database] : []), ...args],
      env: { ...process.env, FAKE_PG_STATE: stateFile, FAKE_PG_LOG: logFile }
    })
  };
  return {
    runner,
    setState: (patch) => { Object.assign(state, patch); save(); },
    calls: () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    /** Kall som ikke er rene lesespørringer (SELECT): CREATE/DROP/`-f -`-skript og alt annet som kan endre serveren. */
    writes: () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !(typeof c.sql === "string" && /^\s*SELECT\b/i.test(c.sql)))
  };
}

export const GLOBALS_DUMP_KEY = "4QFRA14JSOLA1lsdR7F8yQbvjm1BXi9OJR95sMdecEbDRQuY8h39i5WpxQLoAdQ";
const FAKE_HASH = "SCRAM-SHA-256$4096:not-real-salt$not-real-stored-key:not-real-server-key";

/** Faktisk utdata fra `pg_dumpall --globals-only` (PostgreSQL 16, med \restrict-linjene fra ≥ 16.10); passord-hashen er byttet ut med en åpenbar plassholder. */
export const REAL_GLOBALS_DUMP = String.raw`--
-- PostgreSQL database cluster dump
--

\restrict ${GLOBALS_DUMP_KEY}

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

CREATE ROLE "Weird Role;x";
ALTER ROLE "Weird Role;x" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 VALID UNTIL '2030-01-01 00:00:00+00';
CREATE ROLE jarvis_app;
ALTER ROLE jarvis_app WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD '${FAKE_HASH}';
COMMENT ON ROLE jarvis_app IS 'Appen: it''s fine -- ø æ å';
CREATE ROLE postgres;
ALTER ROLE postgres WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;
CREATE ROLE reader;
ALTER ROLE reader WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;

--
-- User Configurations
--

--
-- User Config "jarvis_app"
--

ALTER ROLE jarvis_app SET search_path TO 'myschema', 'public';

--
-- User Config "reader"
--

ALTER ROLE reader SET work_mem TO '64MB';


--
-- Role memberships
--

GRANT pg_read_all_data TO reader WITH INHERIT TRUE GRANTED BY postgres;
GRANT reader TO jarvis_app WITH ADMIN OPTION, INHERIT TRUE GRANTED BY postgres;






\unrestrict ${GLOBALS_DUMP_KEY}

--
-- PostgreSQL database cluster dump complete
--
`;
