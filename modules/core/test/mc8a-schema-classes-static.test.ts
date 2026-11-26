import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXCEPTION_ELIGIBLE_RULES,
  RULES,
  RULE_IDS,
  SCHEMA_CLASSES,
  SqlScanError,
  analyseSql,
  analyzeMigrations,
  baselineTables,
  checksumOf,
  isTenantScoped,
  loadManifest,
  normalizeSignature,
  parseDirectives,
  readMigrationFiles,
  scanSql,
  splitStatements,
  validateManifest,
  type Manifest,
  type MigrationFile,
  type Violation
} from "@jarvis/core/testing";
import { migrationChecksum } from "../src/db/migrator.ts";

/**
 * WP-MC8a (HF3 MC-8 del a), STATISK del - ingen database: SQL-skanneren, annotasjonsgrammatikken, manifestvalideringen og den statiske analysen av
 * migrasjonsfilene (frosne filer, annotasjoner, baseline som kun kan krympe). Hver mutant under er en NY migrasjon eller et endret manifest som MÅ feile.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/check-schema-classes.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REAL = readMigrationFiles(MIGRATIONS_DIR);
const MANIFEST = loadManifest();

interface Draft {
  version: number;
  frozen_through_migration: number;
  frozen_migrations: Record<string, string>;
  bootstrap_tables: string[];
  classes: Record<string, string[]>;
  class_notes: Record<string, string>;
  definer_allowlist: Array<{ signature: string; reason: string }>;
  exceptions: Array<{ rule: string; table: string; detail?: string; reason: string; finding?: string }>;
  exception_ceiling: { total: number; per_rule: Record<string, number> };
}
function mutated(change: (m: Draft) => void): Manifest {
  const copy = JSON.parse(JSON.stringify(MANIFEST)) as Draft;
  change(copy);
  return copy as unknown as Manifest;
}
const withNew = (...extra: MigrationFile[]): MigrationFile[] => [...REAL, ...extra];
const ruleSet = (v: readonly Violation[]): string[] => [...new Set(v.map((x) => x.rule))].sort();
const analyse = (files: readonly MigrationFile[], manifest: Manifest = MANIFEST): readonly Violation[] => analyzeMigrations(files, manifest).violations;
const NEW = (sql: string, name = "149_mc8a_probe.sql"): MigrationFile => ({ name, sql });

describe("A: SQL-skanneren", () => {
  it("samler kommentarer med linjenummer og blanker dem ut (samme lengde, samme linjeskift)", () => {
    const sql = "SELECT 1; -- jarvis-class: x ORG_OWNED\nSELECT 2;";
    const scan = scanSql(sql);
    expect(scan.comments).toEqual([{ line: 1, text: " jarvis-class: x ORG_OWNED" }]);
    expect(scan.code).toHaveLength(sql.length);
    expect(scan.code).not.toContain("--");
    expect(scan.code.split("\n")).toHaveLength(2);
  });

  it("nestede blokkommentarer blankes og beholder linjetellingen", () => {
    const scan = scanSql("a /* x /* y\n */ z */ b;\nCREATE TABLE real_t (a int);");
    expect(scan.code).not.toContain("x");
    expect(scan.code).toContain("CREATE TABLE real_t");
    expect(splitStatements(scan).map((s) => s.line)).toEqual([1, 3]);
  });

  it("literaler: ';' og '--' inni en streng deler eller kommenterer ikke; '' og E'..\\'..' er escapes", () => {
    const scan = scanSql(String.raw`SELECT 'a;b -- c'; SELECT 'it''s; here'; SELECT E'q\'s;x'; SELECT 4;`);
    const statements = splitStatements(scan);
    expect(statements).toHaveLength(4);
    expect(scan.comments).toEqual([]);
  });

  it("dollar-siterte kropper blankes, men beholdes råt; $1 og identifikatorer med $ er ikke dollar-sitater", () => {
    const scan = scanSql("DO $body$ BEGIN CREATE TABLE hidden (a int); END $body$; SELECT $1, a$b$c FROM t;");
    expect(scan.dollarBlocks).toHaveLength(1);
    expect(scan.dollarBlocks[0]?.tag).toBe("body");
    expect(scan.dollarBlocks[0]?.body).toContain("CREATE TABLE hidden");
    expect(scan.code).not.toContain("hidden");
    expect(scan.code).toContain("$1");
    expect(splitStatements(scan)).toHaveLength(2);
  });

  it("uavsluttet streng/kommentar/dollar-sitat/identifikator feiler høyt med linjenummer", () => {
    const kind = (sql: string): string | undefined => {
      try {
        scanSql(sql);
      } catch (err) {
        return err instanceof SqlScanError ? `${err.kind}@${err.line}` : String(err);
      }
      return undefined;
    };
    expect(kind("SELECT 1;\nSELECT 'abc")).toBe("unterminated_string@2");
    expect(kind("/* aldri lukket")).toBe("unterminated_comment@1");
    expect(kind("DO $$ BEGIN")).toBe("unterminated_dollar_quote@1");
    expect(kind('SELECT "abc')).toBe("unterminated_identifier@1");
  });
});

describe("B: tabellhendelser, ustøttet DDL og DEFINER-funksjoner", () => {
  const creates = (sql: string): string[] => analyseSql(sql).events.filter((e) => e.op === "create").map((e) => `${e.table.schema ?? ""}.${e.table.name}${e.table.quoted ? "(q)" : ""}`);

  it("finner CREATE TABLE i alle former, men ikke i kommentarer eller strenger", () => {
    expect(creates("CREATE TABLE a (x int); create table if not exists B (x int);")).toEqual([".a", ".b"]);
    expect(creates("CREATE TABLE IF NOT EXISTS public.Foo (x int)")).toEqual(["public.foo"]);
    expect(creates('CREATE TABLE "MixedCase" (x int)')).toEqual([".MixedCase(q)"]);
    expect(creates("CREATE UNLOGGED TABLE u (x int)")).toEqual([".u"]);
    expect(creates("-- CREATE TABLE in_comment (x int)\n/* CREATE TABLE in_block (x int) */ SELECT 'CREATE TABLE in_string (x int)'")).toEqual([]);
    expect(analyseSql("CREATE TEMP TABLE t (x int)").events[0]).toMatchObject({ op: "create", temporary: true });
  });

  it("DROP TABLE (flere navn, IF EXISTS, CASCADE) gir én drop-hendelse per tabell", () => {
    const drops = analyseSql("DROP TABLE IF EXISTS a, public.b CASCADE; DROP TABLE c").events.filter((e) => e.op === "drop").map((e) => e.table.name);
    expect(drops).toEqual(["a", "b", "c"]);
  });

  it("ustøttet DDL rapporteres (RENAME TO, SET SCHEMA, VIEW, MATERIALIZED VIEW, FOREIGN TABLE, SCHEMA, PARTITION OF) - men RENAME COLUMN er greit", () => {
    const what = (sql: string): number => analyseSql(sql).unsupported.length;
    expect(what("ALTER TABLE a RENAME TO b")).toBe(1);
    expect(what("ALTER TABLE a RENAME COLUMN x TO y")).toBe(0);
    expect(what("ALTER TABLE a SET SCHEMA other")).toBe(1);
    expect(what("CREATE VIEW v AS SELECT 1")).toBe(1);
    expect(what("CREATE OR REPLACE VIEW v AS SELECT 1")).toBe(1);
    expect(what("CREATE MATERIALIZED VIEW v AS SELECT 1")).toBe(1);
    expect(what("CREATE FOREIGN TABLE f (x int) SERVER s")).toBe(1);
    expect(what("CREATE SCHEMA s")).toBe(1);
    expect(what("CREATE TABLE child PARTITION OF parent FOR VALUES IN (1)")).toBe(1);
    expect(what("CREATE INDEX i ON t (a)")).toBe(0);
  });

  it("DO-blokker: vanlig CREATE TABLE inni telles, EXECUTE-bygd CREATE TABLE meldes som dynamisk, RLS-løkker (EXECUTE format ALTER TABLE) er ikke dynamisk DDL", () => {
    const plain = analyseSql("DO $$\nBEGIN\n  CREATE TABLE inner_t (a int);\nEND\n$$;");
    expect(plain.events).toMatchObject([{ op: "create", viaDo: true }]);
    expect(plain.dynamicCreates).toEqual([]);
    const dynamic = analyseSql("DO $$\nDECLARE t text;\nBEGIN\n  FOREACH t IN ARRAY ARRAY['a','b'] LOOP\n    EXECUTE format('CREATE TABLE %I (id int)', t);\n  END LOOP;\nEND\n$$;");
    expect(dynamic.events).toEqual([]);
    expect(dynamic.dynamicCreates).toEqual([1]);
    const rls = analyseSql("DO $$\nDECLARE t text;\nBEGIN\n  FOREACH t IN ARRAY ARRAY['a'] LOOP\n    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);\n  END LOOP;\nEND\n$$;");
    expect(rls.dynamicCreates).toEqual([]);
  });

  it("SECURITY DEFINER-funksjoner: kun når nøkkelordene står i selve setningen (ikke i kropp eller kommentar)", () => {
    const names = (sql: string): string[] => analyseSql(sql).definerFunctions.map((f) => f.name);
    expect(names("CREATE OR REPLACE FUNCTION foo(a text) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$")).toEqual(["foo"]);
    expect(names("CREATE FUNCTION bar() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$ SECURITY DEFINER")).toEqual(["bar"]);
    expect(names("CREATE FUNCTION baz() RETURNS int LANGUAGE sql AS $$ SELECT 'SECURITY DEFINER' $$")).toEqual([]);
    expect(names("CREATE FUNCTION qux() RETURNS int LANGUAGE sql SECURITY INVOKER AS $$ SELECT 1 $$ -- SECURITY DEFINER")).toEqual([]);
  });
});

describe("C: annotasjonsgrammatikken (-- jarvis-class / -- jarvis-definer)", () => {
  const parse = (...lines: string[]) => parseDirectives(scanSql(lines.map((l) => `-- ${l}`).join("\n")).comments);

  it("gyldige direktiver (med og uten public.-prefiks, tenant-payload kun for GLOBAL)", () => {
    const p = parse(
      "jarvis-class: public.org_members ORG_OWNED",
      "jarvis-class: region_codes GLOBAL",
      'jarvis-class: shared_blob GLOBAL tenant-payload="Delt katalog med tenant-referanser, gjennomgått av eier"',
      "jarvis-class: user_prefs USER_OWNED",
      "jarvis-class: platform_ops PLATFORM",
      'jarvis-definer: prune_things(integer, text[]) reason="Retensjon med faste gulv, eid av definer-rollen"'
    );
    expect(p.malformed).toEqual([]);
    expect(p.directives).toMatchObject([
      { kind: "class", table: "org_members", class: "ORG_OWNED", tenantPayload: null },
      { kind: "class", table: "region_codes", class: "GLOBAL", tenantPayload: null },
      { kind: "class", table: "shared_blob", class: "GLOBAL", tenantPayload: "Delt katalog med tenant-referanser, gjennomgått av eier" },
      { kind: "class", table: "user_prefs", class: "USER_OWNED" },
      { kind: "class", table: "platform_ops", class: "PLATFORM" },
      { kind: "definer", signature: "prune_things(integer,text[])", name: "prune_things" }
    ]);
  });

  it("alt som ligner et direktiv men ikke følger grammatikken er en FEIL (aldri stille ignorert)", () => {
    const bad = [
      "jarvis-class: x org_owned", // små bokstaver
      "jarvis-class: x TENANT_OWNED", // ukjent klasse
      'jarvis-class: x ORG_OWNED tenant-payload="Lang nok begrunnelse her"', // tenant-payload kun for GLOBAL
      'jarvis-class: x GLOBAL tenant-payload="kort"', // for kort begrunnelse
      "jarvis-class public.x ORG_OWNED", // mangler kolon
      "jarvis_class: x ORG_OWNED", // understrek i stedet for bindestrek
      "jarvis-class: other.x ORG_OWNED", // annet skjema
      "jarvis-class: x ORG_OWNED ekstra", // rester
      "jarvis-class: X ORG_OWNED", // store bokstaver i tabellnavn
      "jarvis-definer: f(text)", // mangler reason
      'jarvis-definer: f(text) reason="kort"', // for kort reason
      'jarvis-definer: F(text) reason="Gyldig lang begrunnelse"', // store bokstaver i funksjonsnavn
      'jarvis-definer: f reason="Gyldig lang begrunnelse"' // mangler parenteser
    ];
    for (const line of bad) {
      const p = parse(line);
      expect(p.directives, line).toEqual([]);
      expect(p.malformed, line).toHaveLength(1);
    }
    expect(parse("en helt vanlig kommentar om jarvis og klasser").malformed).toEqual([]);
  });

  it("signaturer normaliseres til Postgres' regprocedure-form", () => {
    expect(normalizeSignature("Foo", " text ,  INTEGER , text[] ")).toBe("foo(text,integer,text[])");
    expect(normalizeSignature("f", "")).toBe("f()");
  });
});

describe("D: tenant-avgrenset uttrykk (isTenantScoped)", () => {
  const T = "(tenant_id = current_setting('jarvis.tenant_id'::text, true))";
  it("godtar den kanoniske formen og konjunksjoner med ekstra ledd; avviser alt annet", () => {
    expect(isTenantScoped(T)).toBe(true);
    expect(isTenantScoped(`(${T} AND (diagnosis_id IN ( SELECT d.diagnosis_id\n   FROM incident_diagnoses d\n  WHERE (d.tenant_id = current_setting('jarvis.tenant_id'::text, true)))))`)).toBe(true);
    expect(isTenantScoped("(current_setting('jarvis.tenant_id'::text, true) = tenant_id)")).toBe(true);
    expect(isTenantScoped(`(${T} OR true)`)).toBe(false);
    expect(isTenantScoped(`(true OR ${T})`)).toBe(false);
    expect(isTenantScoped(`(${T} OR (tenant_id = current_setting('jarvis.tenant_id'::text, true)))`)).toBe(true);
    expect(isTenantScoped("true")).toBe(false);
    expect(isTenantScoped(null)).toBe(false);
    expect(isTenantScoped("(tenant_id = current_setting('jarvis.other'::text, true))")).toBe(false);
    expect(isTenantScoped("(other_id = current_setting('jarvis.tenant_id'::text, true))")).toBe(false);
    expect(isTenantScoped("(tenant_id IS NOT NULL)")).toBe(false);
    expect(isTenantScoped(`(NOT ${T})`)).toBe(false);
  });
});

describe("E: manifestet (frosset baseline) er gyldig, og hver manifest-mutant avvises", () => {
  it("det ekte manifestet er gyldig; klassene dekker nøyaktig de frosne tabellene (183), og reglene er registrert", () => {
    expect(validateManifest(MANIFEST, EXCEPTION_ELIGIBLE_RULES)).toEqual([]);
    expect(baselineTables(MANIFEST).size).toBe(183);
    expect(SCHEMA_CLASSES.map((c) => MANIFEST.classes[c].length)).toEqual([2, 1, 173, 7]);
    expect(MANIFEST.frozen_through_migration).toBe(148);
    expect(Object.keys(MANIFEST.frozen_migrations)).toHaveLength(REAL.length);
    for (const ex of MANIFEST.exceptions) expect(RULE_IDS.has(ex.rule), ex.rule).toBe(true);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });

  const mutants: Array<[string, (m: Draft) => void, RegExp]> = [
    ["klasseliste ikke sortert", (m) => m.classes["ORG_OWNED"]?.reverse(), /not_sorted:ORG_OWNED/],
    ["tabell i to klasser", (m) => m.classes["GLOBAL"]?.push("tenants"), /in_two_classes:tenants/],
    ["ukjent klassenøkkel", (m) => (m.classes["SECRET"] = []), /unknown_class:SECRET/],
    ["manglende klasseliste", (m) => delete m.classes["PLATFORM"], /class_list_missing:PLATFORM/],
    ["ugyldig versjon", (m) => (m.version = 2), /version_unsupported/],
    ["ugyldig frozen_through", (m) => (m.frozen_through_migration = 0), /frozen_through_invalid/],
    ["ugyldig frossen filnavn", (m) => (m.frozen_migrations["bad.sql"] = "0".repeat(64)), /frozen_file_name_invalid:bad.sql/],
    ["ugyldig sjekksum", (m) => (m.frozen_migrations["001_identity.sql"] = "xyz"), /frozen_checksum_invalid:001_identity.sql/],
    ["frossen fil over cut", (m) => (m.frozen_migrations["200_x.sql"] = "0".repeat(64)), /frozen_file_above_cut:200_x.sql/],
    ["bootstrap-tabell uten klasse", (m) => m.bootstrap_tables.push("ghost"), /bootstrap_table_not_classified:ghost/],
    ["notat for ukjent tabell", (m) => (m.class_notes["ghost"] = "Notat om en tabell som ikke finnes"), /class_note_for_unknown_table:ghost/],
    ["for kort notat", (m) => (m.class_notes["people"] = "kort"), /class_note_too_short:people/],
    ["unntak med ukjent regel", (m) => m.exceptions.push({ rule: "no_such_rule", table: "tenants", reason: "En gyldig lang begrunnelse" }), /exception_unknown_rule:no_such_rule/],
    ["unntak for struktur-regel (kan aldri ha unntak)", (m) => m.exceptions.push({ rule: "unclassified_table", table: "tenants", reason: "En gyldig lang begrunnelse" }), /exception_unknown_rule:unclassified_table/],
    ["unntak for ukjent tabell", (m) => m.exceptions.push({ rule: "tenant_index_missing", table: "ghost", reason: "En gyldig lang begrunnelse" }), /exception_unknown_table:ghost/],
    ["unntak uten begrunnelse", (m) => m.exceptions.push({ rule: "tenant_index_missing", table: "tenants", reason: "kort" }), /exception_reason_missing/],
    ["duplisert unntak", (m) => m.exceptions.push(m.exceptions[0] as Draft["exceptions"][number]), /exception_duplicate/],
    ["unntak over totaltak (baseline vokser)", (m) => m.exceptions.push({ rule: "tenant_index_missing", table: "tenants", reason: "En gyldig lang begrunnelse" }), /exceptions_above_ceiling/],
    ["unntak over regeltak (baseline vokser)", (m) => {
      m.exception_ceiling.total += 1;
      m.exceptions.push({ rule: "tenant_index_missing", table: "tenants", reason: "En gyldig lang begrunnelse" });
    }, /exceptions_above_rule_ceiling:tenant_index_missing/],
    ["ugyldig definer-signatur", (m) => m.definer_allowlist.push({ signature: "Foo(text)", reason: "En gyldig lang begrunnelse" }), /definer_signature_invalid/],
    ["definer uten begrunnelse", (m) => m.definer_allowlist.push({ signature: "foo(text)", reason: "kort" }), /definer_reason_missing/]
  ];
  for (const [name, change, expected] of mutants) {
    it(`manifest-mutant avvises: ${name}`, () => {
      const problems = validateManifest(mutated(change), EXCEPTION_ELIGIBLE_RULES);
      expect(problems.join("\n")).toMatch(expected);
    });
  }
});

describe("F: statisk analyse av de EKTE migrasjonsfilene", () => {
  it("ingen brudd; statisk tabellsett = baseline (183 tabeller, inkl. migratorens egen schema_migrations)", () => {
    const a = analyzeMigrations(REAL, MANIFEST);
    expect(a.violations).toEqual([]);
    expect([...a.tables.keys()].sort()).toEqual([...baselineTables(MANIFEST)].sort());
    expect(a.tables.get("schema_migrations")?.file).toBe("(migrator)");
    expect(REAL.length).toBe(121);
  });

  it("sjekksummen er den samme som migratorens (migrationChecksum), også med CRLF", () => {
    for (const f of REAL) expect(checksumOf(f.sql), f.name).toBe(migrationChecksum(f.sql));
    expect(checksumOf("a\r\nb")).toBe(migrationChecksum("a\nb"));
  });

  it("ingen frossen fil har direktiver (kun nye filer annoteres)", () => {
    for (const f of analyzeMigrations(REAL, MANIFEST).files) {
      expect(f.classDirectives, f.name).toEqual([]);
      expect(f.definerDirectives, f.name).toEqual([]);
    }
  });
});

describe("G: statiske mutanter - en NY migrasjon (eller manifestendring) som MÅ feile", () => {
  it("kontroll: ny tabell MED direktiv er grønn", () => {
    expect(analyse(withNew(NEW("-- jarvis-class: probe_one ORG_OWNED\nCREATE TABLE probe_one (id text PRIMARY KEY, tenant_id text NOT NULL);")))).toEqual([]);
  });

  it("ny tabell uten klasse => unclassified_table med fil:linje og forslag", () => {
    const v = analyse(withNew(NEW("CREATE TABLE probe_one (id text PRIMARY KEY);")));
    expect(ruleSet(v)).toEqual(["unclassified_table"]);
    expect(v[0]?.message).toContain("149_mc8a_probe.sql:1");
    expect(v[0]?.message).toContain("jarvis-class: probe_one");
  });

  it("to tabeller, kun én annotert => nøyaktig den andre feiler", () => {
    const v = analyse(withNew(NEW("-- jarvis-class: probe_a GLOBAL\nCREATE TABLE probe_a (id text);\nCREATE TABLE probe_b (id text);")));
    expect(v.map((x) => `${x.rule}:${x.table}`)).toEqual(["unclassified_table:probe_b"]);
  });

  it("annotasjon for en tabell migrasjonen ikke oppretter => annotation_unknown_table", () => {
    expect(ruleSet(analyse(withNew(NEW("-- jarvis-class: ghost ORG_OWNED\nSELECT 1;"))))).toEqual(["annotation_unknown_table"]);
  });

  it("to klasser for samme tabell (samme fil og på tvers av filer) => class_declared_twice", () => {
    expect(ruleSet(analyse(withNew(NEW("-- jarvis-class: probe_a GLOBAL\n-- jarvis-class: probe_a ORG_OWNED\nCREATE TABLE probe_a (id text);"))))).toEqual(["class_declared_twice"]);
    const v = analyse(withNew(NEW("-- jarvis-class: probe_a GLOBAL\nCREATE TABLE probe_a (id text);"), NEW("-- jarvis-class: probe_a GLOBAL\nSELECT 1;", "150_mc8a_probe2.sql")));
    expect(ruleSet(v)).toContain("class_declared_twice");
  });

  it("omklassifisering av en frossen tabell via annotasjon => annotation_for_frozen_table", () => {
    expect(ruleSet(analyse(withNew(NEW("-- jarvis-class: tenants GLOBAL\nSELECT 1;"))))).toEqual(["annotation_for_frozen_table"]);
  });

  it("direktiv som ikke følger grammatikken => directive_malformed (aldri stille ignorert), og tabellen står uklassifisert", () => {
    const v = analyse(withNew(NEW("-- jarvis-class: probe_a org_owned\nCREATE TABLE probe_a (id text);")));
    expect(ruleSet(v)).toEqual(["directive_malformed", "unclassified_table"]);
  });

  it("en frossen migrasjon som endres => frozen_migration_changed (kun innholdet teller, ikke CRLF)", () => {
    const files = REAL.map((f) => (f.name === "005_rls.sql" ? { ...f, sql: `${f.sql}\n-- sniket inn` } : f));
    expect(analyse(files).map((x) => `${x.rule}:${x.detail}`)).toEqual(["frozen_migration_changed:005_rls.sql"]);
    expect(analyse(REAL.map((f) => (f.name === "005_rls.sql" ? { ...f, sql: f.sql.replace(/\n/g, "\r\n") } : f)))).toEqual([]);
  });

  it("en frossen migrasjon som fjernes => frozen_migration_missing", () => {
    const v = analyse(REAL.filter((f) => f.name !== "100_finance_reconciliation.sql"));
    expect(v.map((x) => `${x.rule}:${x.detail}`)).toContain("frozen_migration_missing:100_finance_reconciliation.sql");
  });

  it("en fil som settes inn i den frosne nummerrekken (≤ 148) => frozen_migration_added", () => {
    expect(ruleSet(analyse(withNew(NEW("SELECT 1;", "095_late_insert.sql"))))).toEqual(["frozen_migration_added"]);
  });

  it("filnavn som ikke følger NNN_navn.sql => migration_file_name_invalid", () => {
    expect(ruleSet(analyse(withNew(NEW("SELECT 1;", "150-feil-navn.sql"))))).toEqual(["migration_file_name_invalid"]);
  });

  it("baseline som vokser (en tabell fra en NY migrasjon føres inn i manifestet) => baseline_grew", () => {
    const grown = mutated((m) => m.classes["ORG_OWNED"]?.push("probe_a"));
    const v = analyse(withNew(NEW("-- jarvis-class: probe_a ORG_OWNED\nCREATE TABLE probe_a (id text, tenant_id text NOT NULL);")), grown);
    expect(v.map((x) => `${x.rule}:${x.table}`)).toContain("baseline_grew:probe_a");
  });

  it("baseline med en tabell som ikke finnes => baseline_stale_table; en droppet baseline-tabell likeså", () => {
    expect(analyse(REAL, mutated((m) => m.classes["GLOBAL"]?.push("ghost"))).map((x) => `${x.rule}:${x.table}`)).toEqual(["baseline_stale_table:ghost"]);
    const dropped = analyse(withNew(NEW("DROP TABLE situation_domain_pauses;")));
    expect(dropped.map((x) => `${x.rule}:${x.table}`)).toEqual(["baseline_stale_table:situation_domain_pauses"]);
  });

  it("migratorens egen tabell: uten bootstrap_tables i manifestet finnes schema_migrations ikke statisk", () => {
    const v = analyse(REAL, mutated((m) => (m.bootstrap_tables = [])));
    expect(v.map((x) => `${x.rule}:${x.table}`)).toEqual(["baseline_stale_table:schema_migrations"]);
  });

  it("ustøttet DDL i en ny migrasjon => unsupported_ddl (RENAME, VIEW, SCHEMA, annet skjema, sitert navn)", () => {
    for (const sql of [
      "ALTER TABLE tenants RENAME TO orgs;",
      "CREATE VIEW v AS SELECT 1;",
      "CREATE MATERIALIZED VIEW v AS SELECT 1;",
      "CREATE SCHEMA other;",
      "-- jarvis-class: t ORG_OWNED\nCREATE TABLE other.t (id text);",
      '-- jarvis-class: "T" ORG_OWNED\nCREATE TABLE "T" (id text);'
    ]) {
      expect(ruleSet(analyse(withNew(NEW(sql)))), sql).toContain("unsupported_ddl");
    }
  });

  it("CREATE TABLE bygd med EXECUTE i en DO-blokk => dynamic_create_table", () => {
    const sql = "DO $$\nDECLARE t text;\nBEGIN\n  FOREACH t IN ARRAY ARRAY['a'] LOOP\n    EXECUTE format('CREATE TABLE %I (id int)', t);\n  END LOOP;\nEND\n$$;";
    expect(ruleSet(analyse(withNew(NEW(sql))))).toEqual(["dynamic_create_table"]);
  });

  it("DEFINER-funksjon uten direktiv => definer_directive_missing; med direktiv grønn; direktiv uten funksjon => definer_directive_unknown", () => {
    const fn = "CREATE FUNCTION probe_fn(a text) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$;";
    expect(ruleSet(analyse(withNew(NEW(fn))))).toEqual(["definer_directive_missing"]);
    expect(analyse(withNew(NEW(`-- jarvis-definer: probe_fn(text) reason="Smal katalogfunksjon uten tenant-kontekst"\n${fn}`)))).toEqual([]);
    expect(ruleSet(analyse(withNew(NEW('-- jarvis-definer: probe_fn(text) reason="Smal katalogfunksjon uten tenant-kontekst"\nSELECT 1;'))))).toEqual(["definer_directive_unknown"]);
  });

  it("CREATE OR REPLACE av en allerede allowlistet DEFINER-funksjon trenger ikke nytt direktiv", () => {
    const sql = "CREATE OR REPLACE FUNCTION claim_next_task(a text, b integer, c text[]) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;";
    expect(analyse(withNew(NEW(sql)))).toEqual([]);
  });
});

describe("H: CLI (statisk modus) - `pnpm check:schema-classes --static`", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });

  it("exit 0 og oppsummering mot de ekte filene", () => {
    const r = run("--static");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("modus: static");
    expect(r.stdout).toContain("GLOBAL=2 USER_OWNED=1 ORG_OWNED=173 PLATFORM=7 (sum 183)");
    expect(r.stdout).toContain("schemaklassifisering OK");
  });

  it("exit 1 med regel-ID og fil:linje når en ny migrasjon mangler klasse (kopi av mappen + én ny fil)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-mc8a-cli-"));
    for (const f of REAL) await writeFile(join(dir, f.name), f.sql);
    await writeFile(join(dir, "149_cli_probe.sql"), "CREATE TABLE cli_probe (id text PRIMARY KEY);\n");
    const r = run("--static", "--migrations-dir", dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[unclassified_table] cli_probe");
    expect(r.stderr).toContain("149_cli_probe.sql:1");
    const json = run("--static", "--json", "--migrations-dir", dir);
    expect(json.status).toBe(1);
    expect((JSON.parse(json.stdout) as { failures: Array<{ rule: string }> }).failures.map((f) => f.rule)).toEqual(["unclassified_table"]);
  });

  it("exit 2 på et ukjent argument", () => {
    const r = run("--no-such-flag");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ukjent argument");
  });
});
