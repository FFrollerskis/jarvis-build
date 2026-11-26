import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankSqlNoise, parseMigration, parseMigrationSet } from "../src/program/sql-schema.ts";

/**
 * WP-PGA / PG1: SQL-lesing for eierskapsskanningen. Ikke en SQL-parser, men en støy-fri skanner: kommentarer og strenginnhold blankes før vi leter etter CREATE TABLE / ALTER TABLE / DROP TABLE,
 * så en tabell «nevnt» i en kommentar eller en streng aldri teller. Differensialtesten under sammenlikner med d420-reglene (`modules/core/test/d420-processing-inventory.test.ts`) mot de ekte migrasjonene.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIGRATIONS = join(ROOT, "modules/core/src/db/migrations");

describe("blankSqlNoise", () => {
  it("beholder lengde og linjeskift (posisjoner kan brukes mot originalen)", () => {
    const sql = "a -- kommentar\nb /* blokk\nover to linjer */ c 'streng' d";
    const out = blankSqlNoise(sql);
    expect(out.length).toBe(sql.length);
    expect([...out].filter((c) => c === "\n").length).toBe(2);
  });

  it("blanker linjekommentarer, blokkkommentarer (også nøstede) og innholdet i enkeltapostrofstrenger", () => {
    expect(blankSqlNoise("x -- CREATE TABLE a (b int)\ny")).not.toMatch(/CREATE/);
    expect(blankSqlNoise("x /* CREATE TABLE a (b int) */ y")).not.toMatch(/CREATE/);
    expect(blankSqlNoise("x /* ytre /* indre CREATE TABLE */ fortsatt kommentar CREATE TABLE b */ y")).not.toMatch(/CREATE/);
    expect(blankSqlNoise("INSERT INTO t VALUES ('CREATE TABLE fake (a int)')")).not.toMatch(/CREATE/);
    expect(blankSqlNoise("SELECT 'it''s CREATE TABLE fake' ")).not.toMatch(/CREATE/);
  });

  it("kommentartegn inne i en streng er ikke en kommentar, og anførselstegn i en kommentar åpner ingen streng", () => {
    expect(blankSqlNoise("SELECT '--'; CREATE TABLE real_one (a int);")).toMatch(/CREATE TABLE real_one/);
    expect(blankSqlNoise("-- det er en apostrof: '\nCREATE TABLE real_two (a int);")).toMatch(/CREATE TABLE real_two/);
    expect(blankSqlNoise("/* ' */ CREATE TABLE real_three (a int);")).toMatch(/CREATE TABLE real_three/);
  });

  it("E-strenger med backslash-apostrof lukkes ikke for tidlig", () => {
    expect(blankSqlNoise("SELECT E'it\\'s CREATE TABLE fake'; CREATE TABLE real_e (a int);")).not.toMatch(/fake/);
    expect(blankSqlNoise("SELECT E'it\\'s CREATE TABLE fake'; CREATE TABLE real_e (a int);")).toMatch(/real_e/);
  });

  it("anførte identifikatorer beholdes (tabellnavn kan stå i anførselstegn)", () => {
    expect(blankSqlNoise('CREATE TABLE "Quoted_Name" (a int);')).toContain('"Quoted_Name"');
  });

  it("dollar-siterte blokker leses som kode (DO-blokker med statiske ALTER), men en apostrof i teksten lekker ikke ut av blokken", () => {
    expect(blankSqlNoise("DO $$ BEGIN ALTER TABLE t ADD COLUMN c int; END $$;")).toMatch(/ALTER TABLE t/);
    expect(blankSqlNoise("DO $tag$ BEGIN ALTER TABLE t2 ADD COLUMN c int; END $tag$;")).toMatch(/ALTER TABLE t2/);
    const leaky = blankSqlNoise("SELECT $$ it's text $$; CREATE TABLE after_dollar (a int);");
    expect(leaky).toMatch(/CREATE TABLE after_dollar/);
  });

  it("parameter-plassholdere ($1) er ikke dollar-sitering", () => {
    expect(blankSqlNoise("SELECT $1, $2; CREATE TABLE after_param (a int);")).toMatch(/CREATE TABLE after_param/);
  });
});

describe("parseMigration: CREATE TABLE", () => {
  it("finner tabell og kolonner, og hopper over tabellbegrensninger", () => {
    const m = parseMigration(
      "001_a.sql",
      `CREATE TABLE tenants (
         tenant_id text PRIMARY KEY,
         name text NOT NULL CHECK (name <> ''),
         kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'org,x', 'a)b')),
         created_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT tenants_name_uq UNIQUE (name),
         UNIQUE (tenant_id, kind),
         FOREIGN KEY (tenant_id) REFERENCES other (id),
         PRIMARY KEY (tenant_id),
         CHECK (kind <> ''),
         EXCLUDE USING gist (name WITH =),
         LIKE template_table INCLUDING ALL
       );`
    );
    expect(m.created).toMatchObject([{ name: "tenants", columns: ["tenant_id", "name", "kind", "created_at"], temporary: false, if_not_exists: false }]);
  });

  it("IF NOT EXISTS, skjemaprefiks, anførte navn og store bokstaver normaliseres til små bokstaver uten skjema", () => {
    const m = parseMigration("001_a.sql", `CREATE TABLE IF NOT EXISTS public.Foo (a int); CREATE TABLE "Bar_Baz" (b int); create table   spaced_name   (c int);`);
    expect(m.created.map((t) => t.name)).toEqual(["foo", "bar_baz", "spaced_name"]);
    expect(m.created[0]?.if_not_exists).toBe(true);
  });

  it("midlertidige tabeller er ikke tilstand (merkes temporary); UNLOGGED er ekte tabeller", () => {
    const m = parseMigration("001_a.sql", `CREATE TEMP TABLE tmp_a (a int); CREATE TEMPORARY TABLE tmp_b (a int); CREATE GLOBAL TEMPORARY TABLE tmp_c (a int); CREATE UNLOGGED TABLE keep_me (a int);`);
    expect(m.created.map((t) => [t.name, t.temporary])).toEqual([["tmp_a", true], ["tmp_b", true], ["tmp_c", true], ["keep_me", false]]);
  });

  it("CREATE TABLE ... AS SELECT (uten kolonneliste) er likevel en tabell, med ukjente kolonner", () => {
    const m = parseMigration("001_a.sql", `CREATE TABLE snapshot_a AS SELECT 1 AS x;`);
    expect(m.created).toMatchObject([{ name: "snapshot_a", columns: [], temporary: false, if_not_exists: false }]);
  });

  it("en kolonne som starter som et nøkkelord (primary_contact, checked) er en kolonne, ikke en begrensning", () => {
    const m = parseMigration("001_a.sql", `CREATE TABLE t (primary_contact text, checked boolean, unique_code text, like_count int, constraint_name text, exclusive bool);`);
    expect(m.created[0]?.columns).toEqual(["primary_contact", "checked", "unique_code", "like_count", "constraint_name", "exclusive"]);
  });

  it("CREATE TABLE i kommentarer og strenger teller ikke", () => {
    const m = parseMigration("001_a.sql", `-- CREATE TABLE ghost1 (a int);\n/* CREATE TABLE ghost2 (a int); */\nINSERT INTO t VALUES ('CREATE TABLE ghost3 (a int)');\nCREATE TABLE real_table (a int);`);
    expect(m.created.map((t) => t.name)).toEqual(["real_table"]);
  });

  it("flere tabeller i samme fil beholder rekkefølgen", () => {
    const m = parseMigration("001_a.sql", `CREATE TABLE a (x int);\nCREATE TABLE b (y int);\nCREATE TABLE c (z int);`);
    expect(m.created.map((t) => t.name)).toEqual(["a", "b", "c"]);
  });
});

describe("parseMigration: ALTER, DROP, RENAME", () => {
  it("ALTER TABLE (ONLY, IF EXISTS, skjemaprefiks, anført, inne i DO-blokk) gir tabellen; dynamisk format('ALTER TABLE %I') gir ingenting", () => {
    const m = parseMigration(
      "002_b.sql",
      `ALTER TABLE a ADD COLUMN x int;
       ALTER TABLE ONLY b ADD COLUMN y int;
       ALTER TABLE IF EXISTS public.c ADD COLUMN z int;
       ALTER TABLE "D_Table" ADD COLUMN w int;
       DO $$ BEGIN ALTER TABLE e ADD COLUMN v int; END $$;
       DO $$ BEGIN EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); END $$;
       -- ALTER TABLE ghost ADD COLUMN q int;`
    );
    expect(m.altered).toEqual(["a", "b", "c", "d_table", "e"]);
  });

  it("DROP TABLE med IF EXISTS, flere navn og CASCADE", () => {
    const m = parseMigration("003_c.sql", `DROP TABLE IF EXISTS a, public.b CASCADE; DROP TABLE c;`);
    expect(m.dropped).toEqual(["a", "b", "c"]);
  });

  it("RENAME TO", () => {
    const m = parseMigration("004_d.sql", `ALTER TABLE old_name RENAME TO new_name;`);
    expect(m.renamed).toEqual([{ from: "old_name", to: "new_name" }]);
    expect(m.altered).toContain("old_name");
  });
});

describe("parseMigrationSet: effektive tabeller etter DROP og RENAME, i filrekkefølge", () => {
  const set = (files: Array<[string, string]>) => parseMigrationSet(files.map(([name, sql]) => ({ name, sql })));

  it("tabellen kommer fra filen som lager den, med kolonner", () => {
    const r = set([["001_a.sql", "CREATE TABLE a (x int, y int);"], ["002_b.sql", "CREATE TABLE b (z int);"]]);
    expect([...r.tables.keys()].sort()).toEqual(["a", "b"]);
    expect(r.tables.get("a")).toMatchObject({ created_in: "001_a.sql", columns: ["x", "y"] });
  });

  it("en senere DROP fjerner tabellen fra den effektive mengden, men opprettelsen huskes", () => {
    const r = set([["001_a.sql", "CREATE TABLE a (x int);"], ["002_b.sql", "DROP TABLE a;"]]);
    expect(r.tables.has("a")).toBe(false);
    expect(r.created).toEqual([{ name: "a", file: "001_a.sql", dropped_in: "002_b.sql" }]);
  });

  it("RENAME flytter tabellen (med kolonner) til nytt navn", () => {
    const r = set([["001_a.sql", "CREATE TABLE a (x int);"], ["002_b.sql", "ALTER TABLE a RENAME TO a2;"]]);
    expect(r.tables.has("a")).toBe(false);
    expect(r.tables.get("a2")).toMatchObject({ created_in: "001_a.sql", columns: ["x"] });
  });

  it("filrekkefølgen er navnet (NNN_...), ikke rekkefølgen filene oppgis i", () => {
    const r = set([["002_b.sql", "DROP TABLE a;"], ["001_a.sql", "CREATE TABLE a (x int);"]]);
    expect(r.tables.has("a")).toBe(false);
  });

  it("opprettet to ganger uten DROP i mellom er en duplikat (IF NOT EXISTS er det ikke)", () => {
    const dup = set([["001_a.sql", "CREATE TABLE a (x int);"], ["002_b.sql", "CREATE TABLE a (x int);"]]);
    expect(dup.duplicates).toEqual([{ table: "a", files: ["001_a.sql", "002_b.sql"] }]);
    const ok = set([["001_a.sql", "CREATE TABLE a (x int);"], ["002_b.sql", "CREATE TABLE IF NOT EXISTS a (x int);"]]);
    expect(ok.duplicates).toEqual([]);
    const redo = set([["001_a.sql", "CREATE TABLE a (x int);"], ["002_b.sql", "DROP TABLE a;"], ["003_c.sql", "CREATE TABLE a (x int);"]]);
    expect(redo.duplicates).toEqual([]);
    expect(redo.tables.get("a")?.created_in).toBe("003_c.sql");
  });

  it("alters kobler hver ALTER til filen, og midlertidige tabeller er ikke i den effektive mengden", () => {
    const r = set([["001_a.sql", "CREATE TABLE a (x int); CREATE TEMP TABLE t (x int);"], ["002_b.sql", "ALTER TABLE a ADD COLUMN y int;"]]);
    expect(r.alters).toEqual([{ table: "a", file: "002_b.sql" }]);
    expect(r.tables.has("t")).toBe(false);
  });
});

describe("differensial mot de ekte migrasjonene", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));
  const result = parseMigrationSet(files);

  it("tabellmengden er identisk med d420-testens regex (^CREATE TABLE [IF NOT EXISTS] navn) - ingen tabell mistet eller funnet opp", () => {
    const d420 = new Set<string>();
    for (const f of files) for (const m of f.sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z_0-9]+)/gm)) d420.add(m[1]!);
    expect(d420.size).toBeGreaterThan(150);
    expect([...result.tables.keys()].sort()).toEqual([...d420].sort());
    expect(result.duplicates).toEqual([]);
  });

  it("hver tabell har kolonner (ingen CREATE TABLE ... AS i dag), og tenant-tabellene har tenant_id", () => {
    for (const [name, t] of result.tables) expect(t.columns.length, name).toBeGreaterThan(0);
    expect(result.tables.get("audit_events")?.columns).toContain("tenant_id");
    expect(result.tables.get("tenants")?.columns).toEqual(expect.arrayContaining(["tenant_id", "name"]));
    expect(result.tables.get("session_grants")?.created_in).toBe("053_session_grants.sql");
  });

  it("ingen tabell i dag er droppet eller omdøpt, og alterlisten er ikke tom (migrasjoner utvider tabeller)", () => {
    expect(result.created.every((c) => c.dropped_in === undefined)).toBe(true);
    expect(result.alters.length).toBeGreaterThan(20);
  });
});
