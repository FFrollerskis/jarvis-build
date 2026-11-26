// WP-MC8a (HF3 MC-8 del a): `pnpm check:schema-classes` - schemaklassifisering + migrasjonslint (HF3 §9.2/§17.2, D-MC-34).
//
//   pnpm check:schema-classes             # statisk analyse av migrasjonsfilene + katalogsjekk mot en MIGRERT embedded Postgres
//   pnpm check:schema-classes --static    # kun statisk analyse (ingen database): filer + manifest + annotasjoner
//
// Valg: --migrations-dir <mappe>  --manifest <fil>  --json  --verbose (lister også de kjente baseline-unntakene)
// Exit 0 = grønt, 1 = brudd, 2 = kunne ikke kjøre (f.eks. katalogsjekk som root: embedded Postgres nekter å starte som root).
//
// Katalogsjekken (RLS/FORCE, policyer, GRANT, FK, indekser, DEFINER) KAN IKKE gjøres statisk: RLS settes i de gamle migrasjonene via EXECUTE-løkker.
// Derfor starter fullmodus en kortlivet embedded Postgres, kjører migrasjonene og leser katalogen. `--static` er kun forhåndssjekken.
// Kjøres med Node >= 22 (`node --experimental-transform-types`: samme mønster som resten av repoet). CI-kobling er en senere eierhandling (.github/ er ikke berørt).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatFailures, loadManifest, readMigrationFiles, runSchemaClassChecks, summarize, type CheckResult, type Queryable } from "../src/testing/schema-classes/index.ts";

interface Args {
  readonly staticOnly: boolean;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly migrationsDir: string;
  readonly manifestPath: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let staticOnly = false;
  let json = false;
  let verbose = false;
  let migrationsDir = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
  let manifestPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--static") staticOnly = true;
    else if (a === "--json") json = true;
    else if (a === "--verbose") verbose = true;
    else if (a === "--migrations-dir") migrationsDir = argv[(i += 1)] ?? "";
    else if (a === "--manifest") manifestPath = argv[(i += 1)];
    else throw new Error(`ukjent argument: ${String(a)} (gyldige: --static --json --verbose --migrations-dir <mappe> --manifest <fil>)`);
  }
  return { staticOnly, json, verbose, migrationsDir, manifestPath };
}

async function withMigratedDatabase<T>(migrationsDir: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const { default: pg } = await import("pg");
  const { startLeasedEmbeddedPostgres } = await import("../src/testing/index.ts");
  const { runMigrations } = await import("../src/db/migrator.ts");
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-schema-classes-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
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

function report(result: CheckResult, args: Args): void {
  if (args.json) {
    console.log(JSON.stringify({ mode: result.mode, counts: result.counts, failures: result.failures, known: result.known.map((k) => ({ rule: k.violation.rule, table: k.violation.table, detail: k.violation.detail, finding: k.exception.finding ?? null })) }, null, 2));
    return;
  }
  for (const line of summarize(result)) console.log(line);
  if (args.verbose) {
    for (const k of result.known) console.log(`  kjent [${k.violation.rule}] ${k.violation.table ?? "*"} ${k.violation.detail === "" ? "" : `(${k.violation.detail}) `}- ${k.exception.finding ?? "-"}`);
  }
  if (result.failures.length > 0) console.error(`\nschemaklassifisering BRUTT (${result.failures.length}):\n${formatFailures(result.failures)}`);
  else console.log("schemaklassifisering OK");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = args.manifestPath === undefined ? loadManifest() : loadManifest(args.manifestPath);
  const files = readMigrationFiles(args.migrationsDir);
  if (args.staticOnly) {
    const result = await runSchemaClassChecks({ files, manifest });
    report(result, args);
    return result.failures.length > 0 ? 1 : 0;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.error("katalogsjekken starter en embedded Postgres, som nekter å kjøre som root. Kjør som en vanlig bruker, eller bruk --static for kun den statiske sjekken (da er katalogreglene IKKE kjørt).");
    return 2;
  }
  const result = await withMigratedDatabase(args.migrationsDir, (db) => runSchemaClassChecks({ files, manifest, db }));
  report(result, args);
  return result.failures.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`check-schema-classes feilet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
);
