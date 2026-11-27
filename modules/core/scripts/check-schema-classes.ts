// WP-MC8a (HF3 MC-8 del a): `pnpm check:schema-classes` - schemaklassifisering + migrasjonslint (HF3 §9.2/§17.2, D-MC-34).
//
//   pnpm check:schema-classes                          # statisk analyse + katalogsjekk mot en KORTLIVET, MIGRERT embedded Postgres (ikke som root)
//   pnpm check:schema-classes --static                 # kun statisk analyse (ingen database): filer + manifest + annotasjoner. Katalogreglene er IKKE kjørt.
//   pnpm check:schema-classes --database-url <url>     # statisk + katalogsjekk mot en EKSISTERENDE database (eierens NAS-trinn). KUN LESING (read-only transaksjon).
//                                                      #   URL kan også settes i env JARVIS_SCHEMA_CLASSES_DATABASE_URL (unngår passord i prosesslisten).
//
// Valg: --migrations-dir <mappe>  --manifest <fil>  --json  --verbose (lister også de kjente baseline-unntakene; sender Postgres-loggen til stderr)
// Exit 0 = grønt, 1 = brudd, 2 = kunne ikke kjøre (ugyldige argumenter, ødelagt manifest/migrasjon, root uten --static/--database-url, tilkoblingsfeil).
//
// Katalogsjekken (RLS/FORCE, policyer, GRANT, FK, indekser, DEFINER, roller) KAN IKKE gjøres statisk: RLS settes i de gamle migrasjonene via EXECUTE-løkker.
// Logikken ligger i `src/testing/schema-classes/cli.ts` (testbar); denne filen er kun inngangen.
// Prosessen avsluttes med `process.exit(code)` ETTER at stdout/stderr er tømt: `process.exitCode = code` ble overstyrt av `async-exit-hook` i embedded-postgres
// (som kaller `process.exit(0)` ved `beforeExit`), så full modus ga alltid exit 0 (HIGH-1, fiks-runde 1).
// Kjøres med Node >= 22 (`node --experimental-transform-types`: samme mønster som resten av repoet). CI-kobling er en senere eierhandling (.github/ er ikke berørt).
import { runCli } from "../src/testing/schema-classes/cli.ts";

const flush = (stream: NodeJS.WriteStream): Promise<void> => new Promise((resolve) => stream.write("", () => resolve()));

let code: number;
try {
  code = await runCli(process.argv.slice(2), {
    out: (text) => void process.stdout.write(`${text}\n`),
    err: (text) => void process.stderr.write(`${text}\n`),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    env: process.env
  });
} catch (err) {
  process.stderr.write(`check-schema-classes feilet: ${err instanceof Error ? err.message : String(err)}\n`);
  code = 2;
}
await Promise.all([flush(process.stdout), flush(process.stderr)]);
process.exit(code);
