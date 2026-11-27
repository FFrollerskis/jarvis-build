import { analyzeMigrations, resolveClasses, type MigrationFile, type StaticAnalysis } from "./analysis.ts";
import { extractCatalog, type Catalog, type Queryable } from "./catalog.ts";
import { SCHEMA_CLASSES, type SchemaClass } from "./directives.ts";
import { manifestShapeProblems, validateManifest, type BaselineException, type Manifest } from "./manifest.ts";
import { EXCEPTION_ELIGIBLE_RULES, RULE_IDS, lintCatalog, reconcileExceptions, type ClassInfo, type LintConfig, type Violation } from "./rules.ts";

/**
 * WP-MC8a: hele kontrollen i ett kall - brukes likt av CLI-en (`pnpm check:schema-classes`), vitest-matrisen og mutanttestene.
 *  - uten `db`: kun statisk analyse (filer + manifest),
 *  - med `db`: i tillegg katalogsjekken (RLS/policyer/GRANT/FK/indekser/DEFINER) mot en migrert database, avstemt mot baseline-unntakene.
 */

export interface CheckOptions {
  readonly files: readonly MigrationFile[];
  readonly manifest: Manifest;
  readonly db?: Queryable;
  readonly config?: Partial<LintConfig>;
}

export interface CheckResult {
  /** Alt som får kontrollen til å feile: strukturbrudd, NYE katalogbrudd og foreldede baseline-unntak. Tom liste = grønn. */
  readonly failures: Violation[];
  /** Kjente brudd (dekket av et begrunnet baseline-unntak) - rapporteres, feiler ikke. */
  readonly known: Array<{ violation: Violation; exception: BaselineException }>;
  readonly classes: ReadonlyMap<string, ClassInfo>;
  readonly counts: Readonly<Record<SchemaClass, number>>;
  readonly analysis: StaticAnalysis;
  readonly catalog: Catalog | null;
  readonly mode: "static" | "static+catalog";
}

export function definerAllowlist(manifest: Manifest, analysis: StaticAnalysis): Set<string> {
  const set = new Set(manifest.definer_allowlist.map((e) => e.signature));
  for (const f of analysis.files) for (const d of f.definerDirectives) set.add(d.signature);
  return set;
}

export async function runSchemaClassChecks(options: CheckOptions): Promise<CheckResult> {
  const { manifest } = options;
  const failures: Violation[] = [];
  for (const problem of validateManifest(manifest, EXCEPTION_ELIGIBLE_RULES)) {
    failures.push({ rule: "manifest_invalid", table: null, detail: problem, message: `Manifestet er ugyldig: ${problem}` });
  }
  if (manifestShapeProblems(manifest).length > 0) {
    // Strukturelt ødelagt manifest: analysen kan ikke leses videre uten å kaste en tilfeldig `TypeError`. Kun manifestfeilene rapporteres.
    const empty = Object.fromEntries(SCHEMA_CLASSES.map((c) => [c, 0])) as Record<SchemaClass, number>;
    return { failures, known: [], classes: new Map(), counts: empty, analysis: { files: [], tables: new Map(), newDefinerNames: new Set(), violations: [] }, catalog: null, mode: "static" };
  }
  const analysis = analyzeMigrations(options.files, manifest);
  failures.push(...analysis.violations);

  let catalog: Catalog | null = null;
  let dbTables: string[] | null = null;
  if (options.db !== undefined) {
    catalog = await extractCatalog(options.db, options.config?.runtimeRole === undefined ? {} : { runtimeRole: options.config.runtimeRole });
    dbTables = catalog.relations.filter((r) => r.schema === "public" && r.kind === "r").map((r) => r.name);
  }
  const resolved = resolveClasses(manifest, analysis, dbTables);
  failures.push(...resolved.violations);

  const known: CheckResult["known"] = [];
  if (catalog !== null) {
    const violations = lintCatalog({
      catalog,
      classes: resolved.classes,
      definerAllowlist: definerAllowlist(manifest, analysis),
      runtimeParentAllowlist: new Set(manifest.runtime_parent_allowlist.map((e) => e.role)),
      ...(options.config === undefined ? {} : { config: options.config })
    });
    const reconciled = reconcileExceptions(violations, manifest.exceptions);
    failures.push(...reconciled.unexpected);
    known.push(...reconciled.known);
    for (const ex of reconciled.stale) {
      failures.push({
        rule: "exception_stale",
        table: ex.table,
        detail: `${ex.rule}|${ex.detail ?? ""}`,
        message: `Baseline-unntaket ${ex.rule} på ${ex.table}${ex.detail === undefined ? "" : ` (${ex.detail})`} har ikke lenger et brudd - fjern det fra manifestet (baseline kan bare krympe).`
      });
    }
  }
  const counts = Object.fromEntries(SCHEMA_CLASSES.map((c) => [c, 0])) as Record<SchemaClass, number>;
  for (const info of resolved.classes.values()) counts[info.class] += 1;
  return { failures, known, classes: resolved.classes, counts, analysis, catalog, mode: catalog === null ? "static" : "static+catalog" };
}

/**
 * Tabellene som IKKE har en RLS-plikt: GLOBAL og PLATFORM (runtime-rollen har ikke tilgang, eller kun lesing av referansedata). Begrunnelsen er klassenotatet i baseline-manifestet
 * (frosne tabeller) eller en henvisning til annotasjonen (nye tabeller). Én kilde for `remediation-2-schema-invariants` B og klassifiseringen.
 */
export function rlsExemptTables(manifest: Manifest, classes: ReadonlyMap<string, ClassInfo>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [table, info] of [...classes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (info.class !== "GLOBAL" && info.class !== "PLATFORM") continue;
    out[table] = manifest.class_notes[table] ?? `annotert ${info.class} i en ny migrasjon`;
  }
  return out;
}

export function formatFailures(failures: readonly Violation[]): string {
  if (failures.length === 0) return "(ingen)";
  return failures.map((f) => `[${f.rule}]${f.table === null ? "" : ` ${f.table}`}: ${f.message}`).join("\n");
}

export function summarize(result: CheckResult): string[] {
  const lines = [
    `modus: ${result.mode}`,
    `tabeller per klasse: ${SCHEMA_CLASSES.map((c) => `${c}=${result.counts[c]}`).join(" ")} (sum ${result.classes.size})`
  ];
  if (result.mode === "static+catalog") {
    const byRule = new Map<string, number>();
    for (const k of result.known) byRule.set(k.violation.rule, (byRule.get(k.violation.rule) ?? 0) + 1);
    lines.push(`kjente baseline-unntak: ${result.known.length} (${[...byRule].sort().map(([r, n]) => `${r}=${n}`).join(", ") || "ingen"})`);
  }
  lines.push(`brudd (feiler): ${result.failures.length}`);
  return lines;
}

export const KNOWN_RULE_IDS = RULE_IDS;
