import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCHEMA_CLASSES, isSchemaClass, type SchemaClass } from "./directives.ts";

/**
 * WP-MC8a: den frosne BASELINE-manifestfilen (`src/db/schema-classes.baseline.json`) for ALLE tabeller som finnes etter migrasjon
 * `frozen_through_migration` (148). Eksisterende migrasjoner er append-only og sjekksum-låst, så de kan ikke annoteres: klassene deres står her.
 * Tabeller fra NYE migrasjoner (> 148) annoteres i selve migrasjonsfilen (`directives.ts`) og kan ALDRI stå i denne filen.
 *
 * Mønsteret er «baseline kan bare krympe» (som `d395-erasure-coverage` og `scope-fk-baseline`):
 *  - `exceptions`: kjente brudd mot lint-reglene, hver med begrunnelse. Hvert unntak må matche et FAKTISK brudd nøyaktig (regel + tabell + detalj),
 *    og et unntak som ikke lenger brytes SKAL fjernes. `exception_ceiling` er et tak per regel som ikke kan overskrides: nye brudd kan ikke
 *    skjules ved å legge til et unntak uten å heve taket (en synlig, bevisst endring i diffen).
 *  - `frozen_migrations`: sjekksum per frosne migrasjonsfil, slik at CI også ser en redigert gammel fil (migratoren ser det kun på en database
 *    som allerede har anvendt filen).
 */

export const MANIFEST_PATH = fileURLToPath(new URL("../../db/schema-classes.baseline.json", import.meta.url));

export interface BaselineException {
  readonly rule: string;
  readonly table: string;
  /** Presis detalj for regelen (f.eks. privilegiesettet); utelatt hvis regelen ikke har detalj. */
  readonly detail?: string;
  readonly reason: string;
  /** Funn-ID (K5) som rapporten foreslår migrasjon for. */
  readonly finding?: string;
}

export interface DefinerAllowEntry {
  readonly signature: string;
  readonly reason: string;
}

export interface Manifest {
  readonly version: 1;
  readonly frozen_through_migration: number;
  readonly frozen_migrations: Readonly<Record<string, string>>;
  /** Tabeller opprettet av migratoren selv (ikke av en `.sql`-fil). */
  readonly bootstrap_tables: readonly string[];
  readonly classes: Readonly<Record<SchemaClass, readonly string[]>>;
  readonly class_notes: Readonly<Record<string, string>>;
  readonly definer_allowlist: readonly DefinerAllowEntry[];
  readonly exceptions: readonly BaselineException[];
  readonly exception_ceiling: { readonly total: number; readonly per_rule: Readonly<Record<string, number>> };
}

export function loadManifest(path: string = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function exceptionKey(rule: string, table: string, detail: string | undefined): string {
  return `${rule}|${table}|${detail ?? ""}`;
}

/** Tabell → klasse for baseline-tabellene (første treff vinner; duplikater rapporteres av `validateManifest`). */
export function baselineClassMap(manifest: Manifest): Map<string, SchemaClass> {
  const map = new Map<string, SchemaClass>();
  for (const klass of SCHEMA_CLASSES) {
    for (const table of manifest.classes[klass] ?? []) if (!map.has(table)) map.set(table, klass);
  }
  return map;
}

export function baselineTables(manifest: Manifest): Set<string> {
  return new Set(baselineClassMap(manifest).keys());
}

/** Strukturell validering av selve manifestfilen (uavhengig av databasen). Tom liste = gyldig. */
export function validateManifest(manifest: Manifest, knownRules: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (manifest.version !== 1) problems.push(`manifest_version_unsupported:${String(manifest.version)}`);
  if (!Number.isInteger(manifest.frozen_through_migration) || manifest.frozen_through_migration < 1) problems.push("manifest_frozen_through_invalid");
  const seen = new Map<string, string>();
  for (const key of Object.keys(manifest.classes)) {
    if (!isSchemaClass(key)) problems.push(`manifest_unknown_class:${key}`);
  }
  for (const klass of SCHEMA_CLASSES) {
    const list = manifest.classes[klass];
    if (!Array.isArray(list)) {
      problems.push(`manifest_class_list_missing:${klass}`);
      continue;
    }
    const sorted = [...list].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(list)) problems.push(`manifest_class_list_not_sorted:${klass}`);
    for (const table of list) {
      const prior = seen.get(table);
      if (prior !== undefined) problems.push(`manifest_table_in_two_classes:${table} (${prior}, ${klass})`);
      seen.set(table, klass);
    }
  }
  for (const [file, sum] of Object.entries(manifest.frozen_migrations)) {
    if (!/^\d{3}_.*\.sql$/.test(file)) problems.push(`manifest_frozen_file_name_invalid:${file}`);
    if (!/^[0-9a-f]{64}$/.test(sum)) problems.push(`manifest_frozen_checksum_invalid:${file}`);
    else if (Number(file.slice(0, 3)) > manifest.frozen_through_migration) problems.push(`manifest_frozen_file_above_cut:${file}`);
  }
  for (const table of manifest.bootstrap_tables) if (!seen.has(table)) problems.push(`manifest_bootstrap_table_not_classified:${table}`);
  for (const [table, note] of Object.entries(manifest.class_notes)) {
    if (!seen.has(table)) problems.push(`manifest_class_note_for_unknown_table:${table}`);
    if (note.trim().length < 10) problems.push(`manifest_class_note_too_short:${table}`);
  }
  const keys = new Set<string>();
  const perRule = new Map<string, number>();
  for (const ex of manifest.exceptions) {
    if (!knownRules.has(ex.rule)) problems.push(`manifest_exception_unknown_rule:${ex.rule}`);
    if (!seen.has(ex.table)) problems.push(`manifest_exception_unknown_table:${ex.table}`);
    if (ex.reason.trim().length < 10) problems.push(`manifest_exception_reason_missing:${ex.rule}:${ex.table}`);
    const key = exceptionKey(ex.rule, ex.table, ex.detail);
    if (keys.has(key)) problems.push(`manifest_exception_duplicate:${key}`);
    keys.add(key);
    perRule.set(ex.rule, (perRule.get(ex.rule) ?? 0) + 1);
  }
  if (manifest.exceptions.length > manifest.exception_ceiling.total) {
    problems.push(`manifest_exceptions_above_ceiling:${manifest.exceptions.length}>${manifest.exception_ceiling.total} (baseline kan bare krympe - fiks bruddet i en NY migrasjon i stedet for å legge til et unntak)`);
  }
  for (const [rule, count] of perRule) {
    const ceiling = manifest.exception_ceiling.per_rule[rule] ?? 0;
    if (count > ceiling) problems.push(`manifest_exceptions_above_rule_ceiling:${rule} ${count}>${ceiling}`);
  }
  for (const entry of manifest.definer_allowlist) {
    if (!/^[a-z_][a-z0-9_]*\([^()]*\)$/.test(entry.signature)) problems.push(`manifest_definer_signature_invalid:${entry.signature}`);
    if (entry.reason.trim().length < 10) problems.push(`manifest_definer_reason_missing:${entry.signature}`);
  }
  return problems;
}
