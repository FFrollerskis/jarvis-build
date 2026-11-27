import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDirectives, type ClassDirective, type DefinerDirective, type MalformedDirective } from "./directives.ts";
import { baselineClassMap, type Manifest } from "./manifest.ts";
import type { ClassInfo, Violation } from "./rules.ts";
import { SqlScanError, analyseSql, type SqlAnalysis } from "./sql-scan.ts";

/**
 * WP-MC8a: STATISK analyse av migrasjonsfilene (ingen database). Gjør det som kan avgjøres av teksten alene:
 *  - frosne filer (≤ `frozen_through_migration`) er uendret, ingen manglende og ingen innsatte (sjekksum per fil),
 *  - hver `CREATE TABLE` i en NY fil (> cut) har nøyaktig ett `-- jarvis-class:`-direktiv i SAMME fil, og omvendt,
 *  - hver ny `SECURITY DEFINER`-funksjon har et `-- jarvis-definer:`-direktiv,
 *  - baseline-tabellene er nøyaktig de frosne filene oppretter (baseline kan bare krympe, aldri vokse),
 *  - ustøttet DDL (RENAME, VIEW, annet skjema, partisjoner) og dynamisk `CREATE TABLE` avvises i nye filer.
 * Hva RLS/policyer/GRANT faktisk ble til avgjøres KUN av katalogsjekken mot en migrert database (RLS settes i gamle filer via EXECUTE-løkker).
 */

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

const MIGRATION_FILE = /^(\d{3})_.*\.sql$/;

/** Samme sjekksum som migratoren (`migrationChecksum`, D-395): SHA-256 over innholdet med CRLF normalisert til LF. En test låser likheten. */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function readMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

export interface FileAnalysis {
  readonly name: string;
  readonly prefix: number;
  readonly frozen: boolean;
  readonly sql: SqlAnalysis | null;
  readonly classDirectives: readonly ClassDirective[];
  readonly definerDirectives: readonly DefinerDirective[];
  readonly malformed: readonly MalformedDirective[];
}

export interface CreatedTable {
  readonly file: string;
  readonly line: number;
  readonly frozen: boolean;
}

export interface StaticAnalysis {
  readonly files: readonly FileAnalysis[];
  /** Tabellene migrasjonsfilene (statisk) etterlater seg, inkl. migratorens egne (bootstrap). */
  readonly tables: ReadonlyMap<string, CreatedTable>;
  /** Navn (små bokstaver) på DEFINER-funksjoner opprettet i NYE filer. */
  readonly newDefinerNames: ReadonlySet<string>;
  readonly violations: readonly Violation[];
}

const structure = (rule: string, table: string | null, detail: string, message: string): Violation => ({ rule, table, detail, message });

export function analyzeMigrations(files: readonly MigrationFile[], manifest: Manifest): StaticAnalysis {
  const violations: Violation[] = [];
  const analysed: FileAnalysis[] = [];
  const tables = new Map<string, CreatedTable>();
  const newDefinerNames = new Set<string>();
  for (const table of manifest.bootstrap_tables) tables.set(table, { file: "(migrator)", line: 0, frozen: true });
  const cut = manifest.frozen_through_migration;

  const present = new Set<string>();
  const byPrefix = new Map<string, string>();
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const m = MIGRATION_FILE.exec(file.name);
    if (m === null) {
      violations.push(structure("migration_file_name_invalid", null, file.name, `${file.name}: forventet NNN_navn.sql (migratoren feiler på filnavn som ikke følger mønsteret).`));
      continue;
    }
    present.add(file.name);
    const prefix = Number(m[1]);
    // Samme regel som migratoren (`listMigrationFiles`): to filer med samme 3-sifrede prefiks har tvetydig rekkefølge. Uten denne meldte kun full modus det (som en migratorfeil).
    const sameNumber = byPrefix.get(m[1] as string);
    if (sameNumber !== undefined) {
      violations.push(structure("migration_prefix_duplicate", null, m[1] as string, `${sameNumber} og ${file.name} har samme prefiks ${m[1]} - tvetydig rekkefølge (migratoren avviser det); gi den ene et nytt, unikt nummer.`));
    } else {
      byPrefix.set(m[1] as string, file.name);
    }
    const frozen = prefix <= cut;
    if (frozen) {
      const expected = manifest.frozen_migrations[file.name];
      if (expected === undefined) {
        violations.push(structure("frozen_migration_added", null, file.name, `${file.name}: nummer ≤ ${cut} men ikke i manifestet - en ny migrasjon skal ha nummer over ${cut} (eksisterende migrasjoner er append-only).`));
      } else if (checksumOf(file.sql) !== expected) {
        violations.push(structure("frozen_migration_changed", null, file.name, `${file.name}: innholdet avviker fra sjekksummen i manifestet - en allerede anvendt migrasjon må aldri endres; lag en NY migrasjon.`));
      }
    }
    let analysis: SqlAnalysis | null = null;
    try {
      analysis = analyseSql(file.sql);
    } catch (err) {
      const where = err instanceof SqlScanError ? `${err.kind}:linje ${err.line}` : (err as Error).message;
      violations.push(structure("unsupported_ddl", null, file.name, `${file.name}: kan ikke skannes (${where}).`));
    }
    const parsed = analysis !== null && !frozen ? parseDirectives(analysis.comments) : { directives: [], malformed: [] };
    const classDirectives = parsed.directives.filter((d): d is ClassDirective => d.kind === "class");
    const definerDirectives = parsed.directives.filter((d): d is DefinerDirective => d.kind === "definer");
    analysed.push({ name: file.name, prefix, frozen, sql: analysis, classDirectives, definerDirectives, malformed: parsed.malformed });
    if (analysis === null) continue;

    for (const e of analysis.events) {
      if (e.op === "create" && e.temporary) continue;
      const t = e.table;
      if (t.schema !== null && t.schema !== "public") {
        if (!frozen) violations.push(structure("unsupported_ddl", t.name, file.name, `${file.name}:${e.line}: tabell i skjemaet '${t.schema}' - kun public støttes av klassifiseringen.`));
        continue;
      }
      if (t.quoted) {
        if (!frozen) violations.push(structure("unsupported_ddl", t.name, file.name, `${file.name}:${e.line}: sitert tabellnavn "${t.name}" - bruk snake_case uten anførselstegn.`));
        continue;
      }
      if (e.op === "create") {
        if (!tables.has(t.name)) tables.set(t.name, { file: file.name, line: e.line, frozen });
      } else {
        tables.delete(t.name);
      }
    }
    if (!frozen) {
      for (const u of analysis.unsupported) violations.push(structure("unsupported_ddl", null, file.name, `${file.name}:${u.line}: ${u.what}`));
      for (const line of analysis.dynamicCreates) violations.push(structure("dynamic_create_table", null, file.name, `${file.name}:${line}: CREATE TABLE inni en streng (EXECUTE) i en DO-blokk kan ikke klassifiseres statisk - skriv CREATE TABLE som vanlig DDL.`));
      for (const mal of parsed.malformed) violations.push(structure("directive_malformed", null, file.name, `${file.name}:${mal.line}: «${mal.text}» - ${mal.problem}`));
      for (const fn of analysis.definerFunctions) newDefinerNames.add(fn.name);
    }
  }
  for (const name of Object.keys(manifest.frozen_migrations)) {
    if (!present.has(name)) violations.push(structure("frozen_migration_missing", null, name, `${name}: finnes i manifestet men ikke i migrasjonsmappen - en anvendt migrasjon kan ikke fjernes.`));
  }

  // Annotasjonene i nye filer mot CREATE TABLE i SAMME fil (nøyaktig ett direktiv per tabell).
  const declared = new Map<string, string>();
  for (const f of analysed.filter((a) => !a.frozen && a.sql !== null)) {
    const creates = new Set((f.sql?.events ?? []).filter((e) => e.op === "create" && !e.temporary && (e.table.schema === null || e.table.schema === "public") && !e.table.quoted).map((e) => e.table.name));
    const seenHere = new Set<string>();
    for (const d of f.classDirectives) {
      const where = `${f.name}:${d.line}`;
      if (seenHere.has(d.table) || declared.has(d.table)) {
        violations.push(structure("class_declared_twice", d.table, d.class, `${where}: ${d.table} har allerede en klasse (${declared.get(d.table) ?? f.name}) - nøyaktig ett direktiv per tabell.`));
        continue;
      }
      seenHere.add(d.table);
      declared.set(d.table, f.name);
      const created = tables.get(d.table);
      if (created !== undefined && created.frozen) {
        violations.push(structure("annotation_for_frozen_table", d.table, d.class, `${where}: ${d.table} er opprettet i en frossen migrasjon (${created.file}); klassen står i baseline-manifestet og kan ikke omklassifiseres her.`));
      } else if (!creates.has(d.table)) {
        violations.push(structure("annotation_unknown_table", d.table, d.class, `${where}: direktivet gjelder ${d.table}, men denne migrasjonsfilen har ingen CREATE TABLE ${d.table} (annotasjonen står i samme fil som tabellen opprettes).`));
      }
    }
    for (const name of creates) {
      const created = tables.get(name);
      if (created === undefined || created.file !== f.name) continue; // opprettet og senere droppet
      if (!seenHere.has(name)) {
        violations.push(structure("unclassified_table", name, f.name, `${f.name}:${created.line}: CREATE TABLE ${name} uten klasse. Legg til \`-- jarvis-class: ${name} <ORG_OWNED|USER_OWNED|GLOBAL|PLATFORM>\` i samme fil.`));
      }
    }
    for (const d of f.definerDirectives) {
      const fnCreatedHere = (f.sql?.definerFunctions ?? []).some((fn) => fn.name === d.name);
      if (!fnCreatedHere) violations.push(structure("definer_directive_unknown", null, d.signature, `${f.name}:${d.line}: direktivet gjelder ${d.signature}, men filen lager ingen SECURITY DEFINER-funksjon ${d.name}.`));
    }
    const baselineNames = new Set(manifest.definer_allowlist.map((e) => e.signature.slice(0, e.signature.indexOf("("))));
    for (const fn of f.sql?.definerFunctions ?? []) {
      const covered = f.definerDirectives.some((d) => d.name === fn.name) || baselineNames.has(fn.name);
      if (!covered) violations.push(structure("definer_directive_missing", null, fn.name, `${f.name}:${fn.line}: SECURITY DEFINER-funksjonen ${fn.name} mangler \`-- jarvis-definer: ${fn.name}(<typer>) reason="..."\` (default deny).`));
    }
  }

  // Baseline = nøyaktig tabellene de frosne filene lager (kan bare krympe).
  const baseline = baselineClassMap(manifest);
  for (const table of baseline.keys()) {
    const created = tables.get(table);
    if (created === undefined) {
      violations.push(structure("baseline_stale_table", table, "", `${table} står i baseline-manifestet men finnes ikke lenger (droppet): fjern den fra manifestet (baseline kan bare krympe).`));
    } else if (!created.frozen) {
      violations.push(structure("baseline_grew", table, created.file, `${table} står i baseline-manifestet, men opprettes av ${created.file} (> ${cut}). Nye tabeller annoteres i sin egen migrasjon; baseline kan aldri vokse.`));
    }
  }
  for (const [table, created] of tables) {
    if (created.frozen && !baseline.has(table)) {
      violations.push(structure("unclassified_table", table, created.file, `${table} (opprettet av ${created.file}) mangler i baseline-manifestet.`));
    }
  }
  return { files: analysed, tables, newDefinerNames, violations };
}

export interface ResolvedClasses {
  readonly classes: Map<string, ClassInfo>;
  readonly violations: Violation[];
}

/**
 * Setter sammen klassene: baseline for de frosne tabellene, annotasjoner for de nye. Med `dbTables` (tabellene i den migrerte databasen) sjekkes også at
 * databasen og den statiske analysen er enige, og at hver databasetabell har en klasse.
 */
export function resolveClasses(manifest: Manifest, analysis: StaticAnalysis, dbTables: readonly string[] | null): ResolvedClasses {
  const classes = new Map<string, ClassInfo>();
  const violations: Violation[] = [];
  for (const [table, klass] of baselineClassMap(manifest)) {
    const created = analysis.tables.get(table);
    if (created !== undefined && created.frozen) classes.set(table, { class: klass, tenantPayload: null });
  }
  for (const f of analysis.files) {
    for (const d of f.classDirectives) {
      const created = analysis.tables.get(d.table);
      if (created === undefined || created.frozen || created.file !== f.name || classes.has(d.table)) continue;
      classes.set(d.table, { class: d.class, tenantPayload: d.tenantPayload });
    }
  }
  if (dbTables !== null) {
    const db = new Set(dbTables);
    const onlyDb = dbTables.filter((t) => !analysis.tables.has(t)).sort();
    const onlyStatic = [...analysis.tables.keys()].filter((t) => !db.has(t)).sort();
    if (onlyDb.length > 0 || onlyStatic.length > 0) {
      violations.push(structure("static_db_mismatch", null, `db-only:${onlyDb.join(",")};static-only:${onlyStatic.join(",")}`, `Migrasjonsfilene og databasen er uenige om tabellene. Kun i databasen: [${onlyDb.join(", ")}] (opprettet dynamisk?). Kun i filene: [${onlyStatic.join(", ")}] (ikke anvendt?).`));
    }
    for (const t of onlyDb) {
      if (!classes.has(t)) violations.push(structure("unclassified_table", t, "db", `${t} finnes i databasen men har ingen klasse (opprettet utenom en annotert migrasjonsfil).`));
    }
    for (const t of dbTables) {
      if (!classes.has(t) && analysis.tables.has(t) && !violations.some((v) => v.rule === "unclassified_table" && v.table === t) && !analysis.violations.some((v) => v.rule === "unclassified_table" && v.table === t)) {
        violations.push(structure("unclassified_table", t, "db", `${t} har ingen klasse.`));
      }
    }
  }
  return { classes, violations };
}
