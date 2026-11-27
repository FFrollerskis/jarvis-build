import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "./analysis.ts";
import { describeDatabaseUrl, withReadOnlyCatalogSession, type ReadOnlyPool } from "./live.ts";
import { loadManifest, type Manifest } from "./manifest.ts";
import { formatFailures, runSchemaClassChecks, summarize, type CheckResult } from "./run.ts";
import type { Queryable } from "./catalog.ts";

/**
 * WP-MC8a: logikken bak `pnpm check:schema-classes` (`modules/core/scripts/check-schema-classes.ts` er kun en tynn inngang som kaller `runCli` og avslutter prosessen).
 * Skilt ut slik at argumenttolking, meldinger og modusvalg kan testes uten å starte en prosess; selve EXIT-oppførselen (HIGH-1) testes med en ekte barneprosess.
 *
 * Moduser:
 *  - `--static`: kun statisk analyse (filer + manifest + annotasjoner). Katalogreglene (RLS/FORCE, policyer, GRANT, FK, indekser, DEFINER, roller) er IKKE kjørt.
 *  - (ingen): statisk + katalogsjekk mot en KORTLIVET, migrert embedded Postgres (må ikke være root).
 *  - `--database-url <url>` (eller env `JARVIS_SCHEMA_CLASSES_DATABASE_URL`): statisk + katalogsjekk mot en EKSISTERENDE database (eierens NAS-trinn). KUN LESING:
 *    ingen migrering, ingen DDL, alt i en `BEGIN READ ONLY`-transaksjon. Kan kjøres som root (ingen embedded Postgres).
 * Exit: 0 grønt, 1 brudd, 2 kunne ikke kjøre (ugyldige argumenter, ødelagt manifest/migrasjon, root uten --static, tilkoblingsfeil).
 */

export const DATABASE_URL_ENV = "JARVIS_SCHEMA_CLASSES_DATABASE_URL";

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** `process.getuid()` (undefined på plattformer uten uid). */
  readonly uid: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CliArgs {
  readonly staticOnly: boolean;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly migrationsDir: string;
  readonly manifestPath: string | undefined;
  readonly databaseUrl: string | undefined;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const USAGE = "gyldige: --static --json --verbose --migrations-dir <mappe> --manifest <fil> --database-url <url>";
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations", import.meta.url));

export function parseCliArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): CliArgs {
  let staticOnly = false;
  let json = false;
  let verbose = false;
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;
  let manifestPath: string | undefined;
  let databaseUrl: string | undefined;
  const value = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v === "" || v.startsWith("--")) throw new CliUsageError(`${flag} krever en verdi (${USAGE})`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--static") staticOnly = true;
    else if (a === "--json") json = true;
    else if (a === "--verbose") verbose = true;
    else if (a === "--migrations-dir") migrationsDir = value(a, i++);
    else if (a === "--manifest") manifestPath = value(a, i++);
    else if (a === "--database-url") databaseUrl = value(a, i++);
    else throw new CliUsageError(`ukjent argument: ${String(a)} (${USAGE})`);
  }
  const fromEnv = env[DATABASE_URL_ENV];
  if (databaseUrl === undefined && fromEnv !== undefined && fromEnv !== "") databaseUrl = fromEnv;
  if (staticOnly && databaseUrl !== undefined) {
    throw new CliUsageError("--static kjører ingen katalogsjekk, og --database-url (eller " + DATABASE_URL_ENV + ") gjelder kun katalogsjekken: bruk ett av dem");
  }
  return { staticOnly, json, verbose, migrationsDir, manifestPath, databaseUrl };
}

async function withMigratedDatabase<T>(migrationsDir: string, verbose: boolean, io: CliIo, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const { default: pg } = await import("pg");
  const { startLeasedEmbeddedPostgres } = await import("../index.ts");
  const { runMigrations } = await import("../../db/migrator.ts");
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-schema-classes-"));
  // Postgres-loggen går ALDRI til stdout (ville ødelagt `--json`); uten --verbose forkastes den, med --verbose går den til stderr.
  const log = verbose ? (m: unknown): void => io.err(String(m)) : (): void => undefined;
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false, onLog: log, onError: log }));
  const admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "check_schema_classes", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  try {
    await leased.postgres.createDatabase("check_schema_classes");
    await runMigrations(admin, migrationsDir);
    return await fn(admin);
  } finally {
    await admin.end().catch(() => undefined);
    await leased.stop().catch(() => undefined);
  }
}

async function withLiveDatabase<T>(url: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 1, application_name: "jarvis-check-schema-classes", connectionTimeoutMillis: 15_000 });
  pool.on("error", () => undefined);
  try {
    return await withReadOnlyCatalogSession(pool as unknown as ReadOnlyPool, fn);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

interface ReportContext {
  readonly args: CliArgs;
  /** Fritekstlinjer som forklarer HVA som er kjørt (vises før resultatet). */
  readonly notes: readonly string[];
  readonly catalogRulesRun: boolean;
  readonly database?: string;
}

function report(result: CheckResult, ctx: ReportContext, io: CliIo): void {
  const { args } = ctx;
  if (args.json) {
    io.out(
      JSON.stringify(
        {
          mode: result.mode,
          catalogRulesRun: ctx.catalogRulesRun,
          ...(ctx.database === undefined ? {} : { database: ctx.database, readOnly: true }),
          counts: result.counts,
          failures: result.failures,
          known: result.known.map((k) => ({ rule: k.violation.rule, table: k.violation.table, detail: k.violation.detail, finding: k.exception.finding ?? null }))
        },
        null,
        2
      )
    );
    return;
  }
  for (const line of ctx.notes) io.out(line);
  for (const line of summarize(result)) io.out(line);
  if (args.verbose) {
    for (const k of result.known) io.out(`  kjent [${k.violation.rule}] ${k.violation.table ?? "*"} ${k.violation.detail === "" ? "" : `(${k.violation.detail}) `}- ${k.exception.finding ?? "-"}`);
  }
  if (result.failures.length > 0) io.err(`\nschemaklassifisering BRUTT (${result.failures.length}):\n${formatFailures(result.failures)}`);
  else io.out(ctx.catalogRulesRun ? "schemaklassifisering OK" : "schemaklassifisering OK (kun statisk: katalogreglene er IKKE kjørt)");
}

const STATIC_NOTE = "MERK: kun statisk analyse (filer, manifest, annotasjoner). Katalogreglene (RLS/FORCE, policyer, GRANT, FK, indekser, DEFINER, roller) er IKKE kjørt.";
/** Regler der migratoren selv ville nektet å anvende mappen: da finnes ingen database å lese katalogen fra. */
const MIGRATOR_FATAL_RULES = new Set(["migration_file_name_invalid", "migration_prefix_duplicate"]);

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    let args: CliArgs;
    try {
      args = parseCliArgs(argv, io.env);
    } catch (err) {
      io.err(err instanceof Error ? err.message : String(err));
      return 2;
    }
    const manifest: Manifest = args.manifestPath === undefined ? loadManifest() : loadManifest(args.manifestPath);
    const files = readMigrationFiles(args.migrationsDir);

    if (args.staticOnly) {
      const result = await runSchemaClassChecks({ files, manifest });
      report(result, { args, notes: [STATIC_NOTE], catalogRulesRun: false }, io);
      return exitCodeOf(result);
    }
    if (args.databaseUrl !== undefined) {
      const database = describeDatabaseUrl(args.databaseUrl);
      const result = await withLiveDatabase(args.databaseUrl, (db) => runSchemaClassChecks({ files, manifest, db }));
      report(result, { args, notes: [`kilde: EKSISTERENDE database ${database} (KUN LESING: read-only transaksjon, ingen migrering, ingen DDL)`], catalogRulesRun: true, database }, io);
      return exitCodeOf(result);
    }
    // Full modus. Er migrasjonsmappen ugyldig for migratoren selv (filnavn, dupliserte prefikser), finnes ingen database å lese: rapporter det statiske bruddet.
    const staticResult = await runSchemaClassChecks({ files, manifest });
    if (staticResult.failures.some((f) => MIGRATOR_FATAL_RULES.has(f.rule))) {
      report(staticResult, { args, notes: ["MERK: migratoren kan ikke anvende mappen, så katalogreglene er IKKE kjørt (kun statisk analyse)."], catalogRulesRun: false }, io);
      return 1;
    }
    if (typeof io.uid === "number" && io.uid === 0) {
      io.err("katalogsjekken starter en embedded Postgres, som nekter å kjøre som root. Kjør som en vanlig bruker, bruk --database-url mot en eksisterende database, eller --static for kun den statiske sjekken (da er katalogreglene IKKE kjørt).");
      return 2;
    }
    const result = await withMigratedDatabase(args.migrationsDir, args.verbose, io, (db) => runSchemaClassChecks({ files, manifest, db }));
    report(result, { args, notes: [], catalogRulesRun: true }, io);
    return exitCodeOf(result);
  } catch (err) {
    io.err(`check-schema-classes feilet: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

export const exitCodeOf = (result: Pick<CheckResult, "failures">): number => (result.failures.length > 0 ? 1 : 0);
