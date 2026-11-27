import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DYNAMIC_DDL_ALLOWLIST } from "../src/program/frozen-rules.ts";
import { scanProgramIndex } from "../src/program/scan.ts";
import { blankSqlNoise, parseMigration, parseMigrationSet } from "../src/program/sql-schema.ts";
import { runProgramIndex } from "../src/program/run.ts";
import { cleanWorld, cloneWorld, toScanInput, type World } from "./program-index-fixtures.ts";
import { json, miniRepo, put } from "./program-index-minirepo.ts";

/**
 * WP-PGA fiks 1 (M4, review-funn «SQL-leseren skjuler tabeller på to udokumenterte måter»): (1) setningene prosesseres i TEKSTREKKEFØLGE (ikke create -> alter -> rename -> drop per fil);
 * (2) `EXECUTE` mot en streng med CREATE/ALTER/DROP TABLE er dynamisk DDL som ingen statisk skanning ser: den flagges (`migration_dynamic_ddl`) med en eksplisitt, begrunnet allowlist (RLS-hjelperne
 * som mønster, ellers per fil); (3) CREATE INDEX, CREATE POLICY, CREATE TRIGGER ... ON <tabell> og INSERT INTO <tabell> teller som endring som krever eierens kvittering (som ALTER).
 * Reviewerens prober (Q01, Q01b, Q02-Q06, Q15) er flyttet hit.
 */
const set = (files: Array<[string, string]>) => parseMigrationSet(files.map(([name, sql]) => ({ name, sql })));

describe("tekstrekkefølge innen en fil (Q01, Q01b, Q15)", () => {
  it("Q01: DROP TABLE IF EXISTS x; CREATE TABLE x ... i samme fil gir tabellen x (før: x forsvant)", () => {
    const r = set([["001_a.sql", "DROP TABLE IF EXISTS sneaky;\nCREATE TABLE sneaky (a int);"]]);
    expect([...r.tables.keys()]).toEqual(["sneaky"]);
    expect(r.tables.get("sneaky")).toMatchObject({ created_in: "001_a.sql", columns: ["a"] });
    expect(r.duplicates).toEqual([]);
    expect(r.created).toEqual([{ name: "sneaky", file: "001_a.sql" }]);
  });

  it("Q01b: samme idiom når tabellen fantes fra en tidligere fil: ingen falsk duplikat, ny opprettelse, den gamle er droppet", () => {
    const r = set([["001_a.sql", "CREATE TABLE sneaky (a int);"], ["002_b.sql", "DROP TABLE IF EXISTS sneaky;\nCREATE TABLE sneaky (b int);"]]);
    expect(r.duplicates).toEqual([]);
    expect(r.tables.get("sneaky")).toMatchObject({ created_in: "002_b.sql", columns: ["b"] });
    expect(r.created).toEqual([
      { name: "sneaky", file: "001_a.sql", dropped_in: "002_b.sql" },
      { name: "sneaky", file: "002_b.sql" }
    ]);
  });

  it("Q15: RENAME bort et navn og opprett det på nytt i samme fil: begge tabellene finnes", () => {
    const r = set([["001_a.sql", "CREATE TABLE r1 (a int);"], ["002_b.sql", "ALTER TABLE r1 RENAME TO r1_old;\nCREATE TABLE r1 (b int);"]]);
    expect([...r.tables.keys()].sort()).toEqual(["r1", "r1_old"]);
    expect(r.tables.get("r1_old")).toMatchObject({ created_in: "001_a.sql", columns: ["a"] });
    expect(r.tables.get("r1")).toMatchObject({ created_in: "002_b.sql", columns: ["b"] });
    expect(r.duplicates).toEqual([]);
  });

  it("CREATE før DROP i tekstrekkefølgen: tabellen er borte; DROP før CREATE: tabellen finnes", () => {
    expect(set([["001_a.sql", "CREATE TABLE y (a int);\nDROP TABLE y;"]]).tables.has("y")).toBe(false);
    expect(set([["001_a.sql", "DROP TABLE y;\nCREATE TABLE y (a int);"]]).tables.has("y")).toBe(true);
  });

  it("ALTER etter RENAME treffer det nye navnet (kolonnen går ikke tapt); ALTER før RENAME følger med", () => {
    const after = set([["001_a.sql", "CREATE TABLE a (x int);"], ["002_b.sql", "ALTER TABLE a RENAME TO b;\nALTER TABLE b ADD COLUMN c int;"]]);
    expect(after.tables.get("b")?.columns).toEqual(["x", "c"]);
    expect(after.tables.has("a")).toBe(false);
    const before = set([["001_a.sql", "CREATE TABLE a (x int);"], ["002_b.sql", "ALTER TABLE a ADD COLUMN c int;\nALTER TABLE a RENAME TO b;"]]);
    expect(before.tables.get("b")?.columns).toEqual(["x", "c"]);
  });

  it("flere filer er fortsatt i filnavnrekkefølge, og hver fil i tekstrekkefølge", () => {
    const r = set([["002_b.sql", "DROP TABLE IF EXISTS q;\nCREATE TABLE q (b int);"], ["001_a.sql", "CREATE TABLE q (a int);"]]);
    expect(r.tables.get("q")?.created_in).toBe("002_b.sql");
    expect(r.duplicates).toEqual([]);
  });

  it("parseMigration gir hendelsene i tekstrekkefølge", () => {
    const m = parseMigration("001_a.sql", "DROP TABLE a;\nCREATE TABLE b (x int);\nALTER TABLE b ADD COLUMN y int;\nALTER TABLE b RENAME TO c;\nCREATE INDEX i ON c (y);");
    expect(m.events.map((e) => e.kind)).toEqual(["drop", "create", "alter", "alter", "rename", "touch"]);
    const pos = m.events.map((e) => e.pos);
    expect([...pos].sort((x, y) => x - y)).toEqual(pos);
  });
});

describe("dynamisk DDL: EXECUTE mot en streng med CREATE/ALTER/DROP TABLE (Q02-Q05)", () => {
  const dyn = (sql: string) => parseMigration("001_a.sql", sql).dynamic_ddl.filter((d) => !d.rls_helper);

  it("Q02: EXECUTE 'CREATE TABLE literal ...' (enkeltapostrof) er usynlig for den statiske skanningen, men flagges som dynamisk DDL", () => {
    const sql = "DO $$ BEGIN EXECUTE 'CREATE TABLE sneaky_lit (a int)'; END $$;";
    expect(parseMigration("001_a.sql", sql).created).toEqual([]);
    expect(dyn(sql)).toHaveLength(1);
    expect(dyn(sql)[0]?.statement).toContain("CREATE TABLE sneaky_lit");
  });

  it("Q03: EXECUTE format('CREATE TABLE %I ...', navn) flagges", () => {
    expect(dyn("DO $$ BEGIN EXECUTE format('CREATE TABLE %I (a int)', 'sneaky_fmt'); END $$;")).toHaveLength(1);
  });

  it("Q04: EXECUTE $q$CREATE TABLE ...$q$ (dollar-sitert) SES av den statiske skanningen (som kode) OG flagges som dynamisk DDL", () => {
    const sql = "DO $$ BEGIN EXECUTE $q$CREATE TABLE sneaky_dq (a int)$q$; END $$;";
    expect(parseMigration("001_a.sql", sql).created.map((c) => c.name)).toEqual(["sneaky_dq"]);
    expect(dyn(sql)).toHaveLength(1);
  });

  it("Q05: dynamisk ALTER TABLE mot en annen tabell og dynamisk DROP TABLE flagges", () => {
    expect(dyn("DO $$ BEGIN EXECUTE 'ALTER TABLE t_b ADD COLUMN z int'; END $$;")).toHaveLength(1);
    expect(dyn("DO $$ BEGIN EXECUTE 'DROP TABLE t_b'; END $$;")).toHaveLength(1);
    expect(dyn("DO $$ BEGIN EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (a)', t, n); END $$;")).toHaveLength(1);
  });

  it("flere dynamiske setninger i én fil gir flere fakta (skanningen slår dem sammen til ett funn per fil)", () => {
    expect(dyn("DO $$ BEGIN EXECUTE 'DROP TABLE a'; EXECUTE 'DROP TABLE b'; END $$;")).toHaveLength(2);
  });

  it("RLS-hjelperne (ENABLE/FORCE ROW LEVEL SECURITY) er eksplisitt unntatt som mønster; alt annet er ikke det", () => {
    const rls = (sql: string) => parseMigration("001_a.sql", sql).dynamic_ddl;
    const enable = "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['a','b'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); END LOOP; END $$;";
    const force = "DO $$ BEGIN EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl); END $$;";
    const spaced = "DO $$ BEGIN EXECUTE   format(\n  'ALTER TABLE %I ENABLE ROW LEVEL SECURITY' ,\n  t\n); END $$;";
    for (const sql of [enable, force, spaced]) {
      expect(rls(sql)).toHaveLength(1);
      expect(rls(sql)[0]?.rls_helper).toBe(true);
    }
    for (const sql of [
      "DO $$ BEGIN EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t); END $$;",
      "DO $$ BEGIN EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t); END $$;",
      "DO $$ BEGIN EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY; ALTER TABLE %I ADD COLUMN x int', t, t); END $$;",
      "DO $$ BEGIN EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t) || ' ; DROP TABLE x'; END $$;",
      "DO $$ BEGIN EXECUTE 'ALTER TABLE ' || t || ' ENABLE ROW LEVEL SECURITY'; END $$;"
    ]) {
      expect(dyn(sql), sql).toHaveLength(1);
    }
  });

  it("RLS-unntaket gjelder HELE setningen: en setning som også inneholder annen dynamisk DDL slipper ikke unna fordi en RLS-hjelper står bak i den", () => {
    const sql = "DO $$ BEGIN EXECUTE 'DROP TABLE a' EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); END $$;";
    const all = parseMigration("001_a.sql", sql).dynamic_ddl;
    expect(all.map((d) => d.rls_helper)).toEqual([false, true]);
    expect(dyn(sql)).toHaveLength(1);
  });

  it("det som IKKE er dynamisk tabell-DDL gir ingenting: trigger-EXECUTE FUNCTION/PROCEDURE, GRANT/REVOKE EXECUTE, dynamisk POLICY, midlertidige tabeller, kommentarer, strenger og identifikatorer", () => {
    for (const sql of [
      "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();",
      "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE PROCEDURE f();",
      "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f('ALTER TABLE x');",
      "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE PROCEDURE f('DROP TABLE x');",
      'GRANT EXECUTE ON FUNCTION "drop table"() TO r;',
      'REVOKE EXECUTE ON FUNCTION "alter table x"() FROM r;',
      "GRANT EXECUTE ON FUNCTION f() TO r;",
      "REVOKE EXECUTE ON FUNCTION f() FROM r;",
      "DO $$ BEGIN EXECUTE format('CREATE POLICY %I ON %I USING (true)', t, t); END $$;",
      "DO $$ BEGIN EXECUTE 'CREATE TEMP TABLE scratch (a int)'; END $$;",
      "-- EXECUTE 'CREATE TABLE x (a int)'\nSELECT 1;",
      "/* EXECUTE 'DROP TABLE x' */ SELECT 1;",
      "INSERT INTO log VALUES ('EXECUTE ''CREATE TABLE x''');",
      "CREATE TABLE tool_log (executed_at timestamptz, tool_execute text, execute_count int);",
      "DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;",
      "DO $$ BEGIN EXECUTE v; END $$;"
    ]) {
      expect(parseMigration("001_a.sql", sql).dynamic_ddl, sql).toEqual([]);
    }
  });

  it("parseMigrationSet samler kun de IKKE-unntatte dynamiske setningene, med filnavn", () => {
    const r = set([
      ["001_a.sql", "DO $$ BEGIN EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); END $$;"],
      ["002_b.sql", "DO $$ BEGIN EXECUTE 'ALTER TABLE t_b ADD COLUMN z int'; END $$;"]
    ]);
    expect(r.dynamic_ddl.map((d) => d.file)).toEqual(["002_b.sql"]);
    expect(r.dynamic_ddl[0]?.statement).toContain("ALTER TABLE t_b");
  });

  it("blankSqlNoise: ENKELTAPOSTROF-strenger blankes (derfor må dynamisk DDL leses fra teksten med strenger beholdt), mens dollar-siterte blokker leses som kode", () => {
    expect(blankSqlNoise("EXECUTE 'CREATE TABLE a (x int)';")).not.toMatch(/CREATE/);
    expect(blankSqlNoise("EXECUTE $q$CREATE TABLE a (x int)$q$;")).toMatch(/CREATE TABLE a/);
    expect(blankSqlNoise("EXECUTE 'CREATE TABLE a (x int)';", { keepStrings: true })).toMatch(/CREATE TABLE a/);
  });

  it("M81: en vanlig streng som ender i backslash ('a\\') lukkes av neste apostrof (standard_conforming_strings), så CREATE TABLE etterpå er synlig", () => {
    const r = parseMigration("001_a.sql", "INSERT INTO t VALUES ('a\\');\nCREATE TABLE after_s (x int);");
    expect(r.created.map((c) => c.name)).toEqual(["after_s"]);
    const e = parseMigration("001_a.sql", "SELECT E'a\\'b';\nCREATE TABLE after_e (x int);");
    expect(e.created.map((c) => c.name)).toEqual(["after_e"]);
  });
});

describe("kvitteringskrav: CREATE INDEX, CREATE POLICY, CREATE TRIGGER ... ON og INSERT INTO teller som endring (Q06a-c)", () => {
  const touches = (sql: string) => parseMigration("002_b.sql", sql).events.flatMap((e) => (e.kind === "touch" ? [`${e.touch.kind}:${e.touch.table}`] : []));

  it("CREATE INDEX i alle former (UNIQUE, CONCURRENTLY, IF NOT EXISTS, uten navn, ONLY, skjemaprefiks, anførte navn)", () => {
    expect(touches("CREATE INDEX i1 ON t_b (c);")).toEqual(["index:t_b"]);
    expect(touches("CREATE UNIQUE INDEX i2 ON t_b (c);")).toEqual(["index:t_b"]);
    expect(touches("CREATE INDEX CONCURRENTLY i3 ON t_b (c);")).toEqual(["index:t_b"]);
    expect(touches("CREATE INDEX IF NOT EXISTS i4 ON t_b (c);")).toEqual(["index:t_b"]);
    expect(touches("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i5 ON ONLY t_b USING btree (c);")).toEqual(["index:t_b"]);
    expect(touches("CREATE INDEX ON t_b (c);")).toEqual(["index:t_b"]);
    expect(touches("CREATE INDEX i6 ON public.T_B (c);")).toEqual(["index:t_b"]);
    expect(touches('CREATE INDEX "I 7" ON "t_b" (c);')).toEqual(["index:t_b"]);
    expect(touches("create index online_idx on t_b (c);")).toEqual(["index:t_b"]);
    expect(touches("CREATE INDEX on_x ON t_b (c);")).toEqual(["index:t_b"]);
  });

  it("CREATE POLICY og CREATE TRIGGER (alle tidspunkter og hendelser) ... ON tabellen", () => {
    expect(touches("CREATE POLICY p1 ON t_b USING (true);")).toEqual(["policy:t_b"]);
    expect(touches('CREATE POLICY "p 2" ON public.t_b AS RESTRICTIVE FOR SELECT USING (true);')).toEqual(["policy:t_b"]);
    expect(touches("CREATE TRIGGER g1 BEFORE INSERT ON t_b FOR EACH ROW EXECUTE FUNCTION f();")).toEqual(["trigger:t_b"]);
    expect(touches("CREATE TRIGGER g2 AFTER INSERT OR UPDATE OF a, b OR DELETE ON t_b FOR EACH ROW EXECUTE FUNCTION f();")).toEqual(["trigger:t_b"]);
    expect(touches("CREATE OR REPLACE TRIGGER g3 INSTEAD OF UPDATE ON t_b FOR EACH ROW EXECUTE FUNCTION f();")).toEqual(["trigger:t_b"]);
    expect(touches("CREATE CONSTRAINT TRIGGER g4 AFTER INSERT ON t_b DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f();")).toEqual(["trigger:t_b"]);
  });

  it("INSERT INTO tabellen (også etter WITH og med skjemaprefiks)", () => {
    expect(touches("INSERT INTO t_b (a) VALUES (1);")).toEqual(["insert:t_b"]);
    expect(touches("INSERT INTO public.t_b SELECT 1;")).toEqual(["insert:t_b"]);
    expect(touches("WITH x AS (SELECT 1 AS a) INSERT INTO t_b (a) SELECT a FROM x;")).toEqual(["insert:t_b"]);
    expect(touches("insert into t_b values (1) on conflict do nothing;")).toEqual(["insert:t_b"]);
  });

  it("ikke i kommentarer eller strenger; dollar-siterte funksjonskropper leses som kode (kjent grense: de teller selv om de bare kjøres senere)", () => {
    expect(touches("-- CREATE INDEX i ON t_b (c);\n/* INSERT INTO t_b VALUES (1) */ SELECT 'INSERT INTO t_b VALUES (1)';")).toEqual([]);
    expect(touches("CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ INSERT INTO t_b VALUES (1) $$;")).toEqual(["insert:t_b"]);
  });

  it("parseMigrationSet legger dem i alters med `via`; en vanlig ALTER har ingen `via` (formen er uendret)", () => {
    const r = set([
      ["001_a.sql", "CREATE TABLE t_b (c int);"],
      ["002_b.sql", "ALTER TABLE t_b ADD COLUMN d int;\nCREATE INDEX i ON t_b (c);\nCREATE POLICY p ON t_b USING (true);\nCREATE TRIGGER g BEFORE INSERT ON t_b FOR EACH ROW EXECUTE FUNCTION f();\nINSERT INTO t_b (c) VALUES (1);"]
    ]);
    expect(r.alters).toEqual([
      { table: "t_b", file: "002_b.sql" },
      { table: "t_b", file: "002_b.sql", via: "index" },
      { table: "t_b", file: "002_b.sql", via: "policy" },
      { table: "t_b", file: "002_b.sql", via: "trigger" },
      { table: "t_b", file: "002_b.sql", via: "insert" }
    ]);
  });
});

describe("skanningen: kvittering og dynamisk DDL (migration_not_acknowledged, migration_dynamic_ddl)", () => {
  const ids = (w: World): string[] => scanProgramIndex(toScanInput(w)).map((f) => f.id);
  const edit = (fn: (w: World) => void): World => {
    const w = cloneWorld(cleanWorld());
    fn(w);
    return w;
  };
  const comp = (w: World, id: string) => w.components.find((c) => c.component_id === id)!;

  it("en fremmed indeks/policy/trigger/insert på en annen eiers tabell må kvitteres av eieren, med melding som sier hva den gjør", () => {
    const text: Record<string, string> = { index: "indeks", policy: "policy", trigger: "trigger", insert: "setter inn" };
    for (const via of ["index", "policy", "trigger", "insert"] as const) {
      const w = edit((x) => {
        x.repo.migration_files.push("003_c.sql");
        comp(x, "core.beta").state_store.migrations.push("003_c.sql");
        x.repo.alters.push({ table: "t_a", file: "003_c.sql", via });
      });
      expect(ids(w), via).toEqual(["migration_not_acknowledged:core.alpha:003_c.sql"]);
      expect(scanProgramIndex(toScanInput(w))[0]?.message, via).toContain(text[via] as string);
      comp(w, "core.alpha").state_store.migrations.push("003_c.sql");
      expect(ids(w), via).toEqual([]);
    }
  });

  it("en indeks på EGEN tabell eller på en tabell uten entydig eier gir ingen ekstra funn", () => {
    expect(ids(edit((x) => { x.repo.migration_files.push("003_c.sql"); comp(x, "core.alpha").state_store.migrations.push("003_c.sql"); x.repo.alters.push({ table: "t_a", file: "003_c.sql", via: "index" }); }))).toEqual([]);
  });

  it("migration_dynamic_ddl: en fil med dynamisk tabell-DDL utenfor allowlisten gir ÉTT funn per fil; en allowlistet fil gir ingenting", () => {
    const stmt = "EXECUTE 'ALTER TABLE t_b ADD COLUMN z int'";
    const w = edit((x) => {
      x.repo.migration_files.push("003_c.sql");
      comp(x, "core.beta").state_store.migrations.push("003_c.sql");
      x.repo.dynamic_ddl.push({ file: "003_c.sql", statement: stmt }, { file: "003_c.sql", statement: "EXECUTE 'DROP TABLE t_b'" });
    });
    const f = scanProgramIndex(toScanInput(w));
    expect(f.map((x) => x.id)).toEqual(["migration_dynamic_ddl:003_c.sql"]);
    expect(f[0]?.message).toContain("2 setninger");
    expect(f[0]?.message).toContain(stmt);
    const allowed = DYNAMIC_DDL_ALLOWLIST[0]!.file;
    const ok = edit((x) => {
      x.repo.migration_files.push(allowed);
      comp(x, "core.beta").state_store.migrations.push(allowed);
      x.repo.dynamic_ddl.push({ file: allowed, statement: stmt });
    });
    expect(ids(ok)).toEqual([]);
  });

  it("allowlisten er eksplisitt og begrunnet: gyldige migrasjonsfilnavn, unike, med begrunnelse, og bare filer som FAKTISK har dynamisk tabell-DDL i repoet (se differensialen)", () => {
    expect(DYNAMIC_DDL_ALLOWLIST.length).toBeGreaterThan(0);
    const files = DYNAMIC_DDL_ALLOWLIST.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
    for (const e of DYNAMIC_DDL_ALLOWLIST) {
      expect(e.file).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
      expect(e.reason.length).toBeGreaterThanOrEqual(20);
    }
    expect(Object.isFrozen(DYNAMIC_DDL_ALLOWLIST)).toBe(true);
  });
});

describe("differensial mot de ekte migrasjonene: tekstrekkefølge og nye regler endrer ikke virkeligheten", () => {
  const MIGRATIONS = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "modules/core/src/db/migrations");
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));
  const result = parseMigrationSet(files);

  it("fortsatt nøyaktig 182 tabeller, ingen duplikat, ingen droppet eller omdøpt (samme som d420-regelen og en uavhengig telling mot embedded Postgres)", () => {
    expect(result.tables.size).toBe(182);
    expect(result.duplicates).toEqual([]);
    expect(result.created.every((c) => c.dropped_in === undefined)).toBe(true);
  });

  it("dynamisk tabell-DDL utenfor RLS-hjelperne står i NØYAKTIG de allowlistede filene (ingen ny og ingen utdatert oppføring)", () => {
    const actual = [...new Set(result.dynamic_ddl.map((d) => d.file))].sort();
    expect(actual).toEqual(DYNAMIC_DDL_ALLOWLIST.map((e) => e.file).sort());
  });

  it("RLS-hjelperne er repoets standardmønster (minst 40 setninger i minst 20 filer) og regnes ikke som dynamisk DDL", () => {
    let statements = 0;
    let withRls = 0;
    for (const f of files) {
      const n = parseMigration(f.name, f.sql).dynamic_ddl.filter((d) => d.rls_helper).length;
      statements += n;
      if (n > 0) withRls += 1;
    }
    expect(statements).toBeGreaterThanOrEqual(40);
    expect(withRls).toBeGreaterThanOrEqual(20);
    expect(result.dynamic_ddl.every((d) => !/ROW LEVEL SECURITY', ?[a-z_]+\)$/.test(d.statement))).toBe(true);
  });

  it("indeks-, policy-, trigger- og insert-endringer er med i alters (de teller som endring), og vanlige ALTER har ingen via", () => {
    const kinds = new Set(result.alters.map((a) => a.via ?? "alter"));
    expect([...kinds].sort()).toEqual(["alter", "index", "insert", "policy", "trigger"]);
  });
});

describe("gjennom lasteren (mini-repo på disk): fakta fra migrasjonsfilene når skanningen", () => {
  const withMigration = (sql: string, claimBy: string[] = ["core.alpha"]) => {
    const { root } = miniRepo();
    put(root, "db/003_c.sql", sql);
    for (const id of claimBy) {
      const path = `config/program/components/${id}.json`;
      const c = JSON.parse(readFileSync(join(root, path), "utf8")) as { state_store: { migrations: string[] } };
      c.state_store.migrations.push("003_c.sql");
      put(root, path, json(c));
    }
    return root;
  };
  const found = (root: string) => runProgramIndex({ root, env: undefined, origin: [] }).findings.map((f) => f.id);

  it("dynamisk ALTER i en ny migrasjon gir migration_dynamic_ddl; RLS-hjelperen gir ingenting", () => {
    expect(found(withMigration("DO $$ BEGIN EXECUTE 'ALTER TABLE t_a ADD COLUMN z int'; END $$;"))).toEqual(["migration_dynamic_ddl:003_c.sql"]);
    expect(found(withMigration("DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['t_a'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); END LOOP; END $$;"))).toEqual([]);
  });

  it("en indeks på en annen eiers tabell må kvitteres av eieren (før: usynlig); kvittert av begge gir ingen funn", () => {
    expect(found(withMigration("CREATE INDEX i ON t_b (label);"))).toEqual(["migration_not_acknowledged:core.beta:003_c.sql"]);
    expect(found(withMigration("CREATE INDEX i ON t_b (label);", ["core.alpha", "core.beta"]))).toEqual([]);
    expect(found(withMigration("CREATE INDEX i ON t_a (name);"))).toEqual([]);
  });

  it("DROP TABLE IF EXISTS + CREATE TABLE i samme fil: tabellen finnes, og den nye tabellen uten eier gir table_orphan (før: usynlig)", () => {
    expect(found(withMigration("DROP TABLE IF EXISTS sneaky;\nCREATE TABLE sneaky (a int);"))).toEqual(["table_orphan:sneaky"]);
  });
});
