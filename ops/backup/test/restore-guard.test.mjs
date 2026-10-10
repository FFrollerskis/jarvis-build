import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SCRATCH_ALLOWED_DB, checkScratchServer, manifestProblems, runRestoreVerify } from "../lib/restore-verify.mjs";
import { cleanupTempDirs, fakeScratchRunner, makeSet, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const WHEN = new Date("2026-10-09T02:00:00.000Z");
const PRODUCTION_DBS = ["postgres", "template0", "template1", "jarvis", "infisical", "langfuse"];
const NO_IDENTITY = join(tempDir("wpc2-noid-"), "finnes-ikke.txt");

describe("WP-C2 review F1: manifestet er UBETRODD - alt som havner i SQL eller filstier valideres mot en lukket form", () => {
  const good = () => makeSet(tempDir(), WHEN).manifest;

  it("et ekte manifest (inkl. siterte identifikatorer og flere skjema) er gyldig", () => {
    const m = good();
    m.databases[0].tables = [
      { table: "public.tenants", rows: 2 }, { table: 'public."Odd Table"', rows: 3 }, { table: "extra.notes", rows: 0 }, { table: '"Mixed Case"."T$1"', rows: 9 },
      { table: 'public."a""; select 1; --"', rows: 1 } // ÉN siterte identifikator som inneholder en escapet anførselstegn og semikolon - fortsatt ÉN identifikator
    ];
    expect(manifestProblems(m)).toEqual([]);
  });

  it("injeksjon via tabellnavn avvises: alt som kan åpne en ny setning eller kommentere bort resten", () => {
    for (const table of [
      "public.t; DROP DATABASE postgres", "public.t) --", "public.t -- x", "t", "public.t.x", "public.", ".t", "public.t\nSELECT 1", 'public."a"; select 1; --"', "public.t;",
      "public.t UNION SELECT 1", "pg_catalog.pg_authid, pg_catalog.pg_class", "public.t/**/", "public.T", "PUBLIC.t", "public.1t", `public.${"a".repeat(300)}`, "", " public.t"
    ]) {
      const m = good();
      m.databases[0].tables = [{ table, rows: 1 }];
      expect(manifestProblems(m), table).toContain("databases[0].tables har ugyldig tabellnavn eller radtall");
    }
  });

  it("radtall må være et ikke-negativt, trygt heltall", () => {
    for (const rows of [-1, 1.5, "3", null, Number.NaN, 2 ** 60, undefined, [], {}]) {
      const m = good();
      m.databases[0].tables = [{ table: "public.t", rows }];
      expect(manifestProblems(m), String(rows)).not.toEqual([]);
    }
  });

  it("databasenavn må være et enkelt navn (de limes inn i CREATE DATABASE): ingen anførselstegn, semikolon, mellomrom, bindestrek, unicode, for lange eller dobbelte", () => {
    for (const database of ['jarvis"; DROP DATABASE postgres; --', "a;b", "a b", "a-b", "ø", "", "a".repeat(64), "x/../y", "x\ny"]) {
      const m = good();
      m.databases[0].database = database;
      expect(manifestProblems(m), database).toContain("databases[0].database har ugyldig navn");
    }
    const dup = good();
    dup.databases[1].database = dup.databases[0].database.toUpperCase();
    expect(manifestProblems(dup)).toContain("databases[1].database er oppgitt to ganger");
    expect(manifestProblems({ ...good(), databases: Array.from({ length: 33 }, (_, i) => ({ database: `db${i}`, file: `db${i}.dump.age`, sha256: "a".repeat(64), tables: [] })) })).toContain("databases mangler eller har for mange oppføringer");
  });

  it("filnavn og sjekksummer: sti-traversering, manglende .age, absolutte stier og ugyldig SHA-256 avvises (også for globals)", () => {
    for (const file of ["../../etc/passwd.age", "a/b.age", "/etc/shadow.age", "jarvis.dump", ".hidden.age", "x\n.age", "a".repeat(120) + ".age"]) {
      const m = good();
      m.databases[0].file = file;
      expect(manifestProblems(m), file).toContain("databases[0].file har ugyldig navn");
      const g = good();
      g.globals.file = file;
      expect(manifestProblems(g), file).toContain("globals har ugyldig fil eller sjekksum");
    }
    const sha = good();
    sha.databases[0].sha256 = "XYZ";
    expect(manifestProblems(sha)).toContain("databases[0].sha256 er ugyldig");
    const gsha = good();
    gsha.globals.sha256 = "g".repeat(64);
    expect(manifestProblems(gsha)).toContain("globals har ugyldig fil eller sjekksum");
  });

  it("feil form på toppnivå: ikke-objekt, ugyldig settnavn, manglende source/databases", () => {
    for (const bad of [null, undefined, [], "x", 5, true]) expect(manifestProblems(bad), String(bad)).toEqual(["manifestet er ikke et objekt"]);
    expect(manifestProblems({ ...good(), set: "jarvis-backup-evil" })).toContain("set har ugyldig navn");
    expect(manifestProblems({ ...good(), source: null })).toContain("source.endpoint mangler");
    expect(manifestProblems({ ...good(), source: { endpoint: 5 } })).toContain("source.endpoint mangler");
    expect(manifestProblems({ ...good(), databases: [] })).toContain("databases mangler eller har for mange oppføringer");
    expect(manifestProblems({ ...good(), databases: "jarvis" })).toContain("databases mangler eller har for mange oppføringer");
    expect(manifestProblems({ ...good(), databases: [null] })).toContain("databases[0] er ikke et objekt");
  });

  it("meldingene siterer ALDRI verdier fra manifestet (settet er ubetrodd tekst)", () => {
    const m = good();
    m.databases[0].database = "EVIL-SENTINEL-1;--";
    m.databases[0].file = "EVIL-SENTINEL-2";
    m.databases[0].sha256 = "EVIL-SENTINEL-3";
    m.databases[0].tables = [{ table: "EVIL-SENTINEL-4", rows: "EVIL-SENTINEL-5" }];
    m.globals.file = "EVIL-SENTINEL-6";
    m.set = "EVIL-SENTINEL-7";
    const text = manifestProblems(m).join("\n");
    expect(text).not.toContain("EVIL-SENTINEL");
    expect(manifestProblems(m).length).toBeGreaterThanOrEqual(5);
  });
});

describe("WP-C2 review F1: scratch-serveren må BEVISE at den er tom og kastbar før noe skrives (checkScratchServer)", () => {
  const manifest = () => makeSet(tempDir(), WHEN).manifest;

  it("en fersk klynge (postgres + template0/1) og rester etter våre egne avbrutte kjøringer er greit; kun lesing, ingenting skrives", async () => {
    const fresh = fakeScratchRunner();
    expect(await checkScratchServer(fresh.runner, manifest())).toEqual({ ok: true, systemIdentifier: "absent" });
    expect(fresh.writes()).toEqual([]);
    expect(fresh.calls().map((c) => c.database)).toEqual(["postgres", "postgres"]);

    const leftovers = fakeScratchRunner({ databases: [...PRODUCTION_DBS.slice(0, 3), "restore_verify_jarvis_20261008t020000z", "restore_verify_infisical_20261008t020000z"] });
    expect(await checkScratchServer(leftovers.runner, manifest())).toMatchObject({ ok: true });
  });

  it("en server med produksjonsdatabasene nektes - uansett hvordan endepunktet staves (poenget med F1)", async () => {
    const prod = fakeScratchRunner({ databases: PRODUCTION_DBS });
    const res = await checkScratchServer(prod.runner, manifest());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ikke en tom, kastbar instans");
    expect(res.error).toContain("3 database(r)");
    expect(res.error).toContain("jarvis");
    expect(prod.writes()).toEqual([]);
  });

  it("enhver fremmed database gjør serveren ikke-kastbar - også én som ikke står i manifestet", async () => {
    const other = fakeScratchRunner({ databases: ["postgres", "template0", "template1", "mine_data"] });
    expect(await checkScratchServer(other.runner, manifest())).toMatchObject({ ok: false, error: expect.stringContaining("mine_data") });
    const caps = fakeScratchRunner({ databases: ["postgres", "template0", "template1", "Restore_Verify_X"] }); // prefikset er case-sensitivt og kun små bokstaver
    expect((await checkScratchServer(caps.runner, manifest())).ok).toBe(false);
    const dashed = fakeScratchRunner({ databases: ["postgres", "template0", "template1", "restore_verify_a-b"] });
    expect((await checkScratchServer(dashed.runner, manifest())).ok).toBe(false);
    const multiline = fakeScratchRunner({ databases: ["postgres", "template0", "template1", "restore_verify_a\nrm"] });
    expect((await checkScratchServer(multiline.runner, manifest())).ok).toBe(false);
  });

  it("en rest med SAMME navn som en database i settet nektes; systemdatabasene teller aldri som treff, selv om settet har en database som heter `postgres`", async () => {
    const m = manifest();
    m.databases[0].database = "restore_verify_x";
    const clash = fakeScratchRunner({ databases: ["postgres", "template0", "template1", "restore_verify_x"] });
    expect((await checkScratchServer(clash.runner, m)).ok).toBe(false);
    const sys = manifest();
    sys.databases[0].database = "postgres";
    expect(await checkScratchServer(fakeScratchRunner().runner, sys)).toMatchObject({ ok: true });
  });

  it("tabeller i postgres-databasen (noen bruker den til data) gjør serveren ikke-kastbar", async () => {
    const used = fakeScratchRunner({ tables: { postgres: ["public.kunder"] } });
    expect(await checkScratchServer(used.runner, manifest())).toMatchObject({ ok: false, error: expect.stringContaining("1 tabell(er)") });
  });

  it("FAIL-CLOSED: kan serveren ikke leses, eller svarer den ikke som Postgres, er svaret nei (aldri «antagelig tom»)", async () => {
    const down = fakeScratchRunner({ fail: true });
    expect(await checkScratchServer(down.runner, manifest())).toMatchObject({ ok: false, error: expect.stringContaining("kunne ikke lese databaselisten") });
    const empty = fakeScratchRunner({ databases: [] });
    expect(await checkScratchServer(empty.runner, manifest())).toMatchObject({ ok: false, error: expect.stringContaining("ingen postgres-database") });
    const noInventory = fakeScratchRunner();
    let calls = 0;
    const flaky = { ...noInventory.runner, command: (tool, args, opts) => (++calls === 2 ? { file: "/finnes/ikke/psql", args: [], env: process.env } : noInventory.runner.command(tool, args, opts)) };
    expect(await checkScratchServer(flaky, manifest())).toMatchObject({ ok: false, error: expect.stringContaining("kunne ikke lese tabelloversikten") });
  });

  it("tillatelsesmønsteret er smalt: kun systemdatabasene og små bokstaver/tall/understrek etter restore_verify_", () => {
    for (const ok of ["postgres", "template0", "template1", "restore_verify_jarvis_20261009t020000z", "restore_verify_a1_b2"]) expect(SCRATCH_ALLOWED_DB.test(ok), ok).toBe(true);
    for (const bad of ["jarvis", "template2", "Postgres", "restore_verify_", "restore_verify_A", "xrestore_verify_a", "restore_verify_a b", "postgres2", "postgres\n", ""]) expect(SCRATCH_ALLOWED_DB.test(bad), bad).toBe(false);
  });
});

const manifest0 = () => makeSet(tempDir(), WHEN).manifest;

describe("WP-C2 review runde 2 L1: system_identifier (alias-sikkert «samme klynge»-bevis) og strengere tom-sjekk", () => {
  const SOURCE_ID = "7234567890123456789";
  const withId = (id = SOURCE_ID) => makeSet(tempDir(), WHEN, { systemIdentifier: id }).manifest;

  it("manifestet kan bære kildens system_identifier; ugyldig form avvises uten å sitere verdien", () => {
    expect(manifestProblems(withId())).toEqual([]);
    expect(manifestProblems(withId("-7234567890123456789"))).toEqual([]); // bigint kan være negativt
    for (const bad of ["", "abc", "1; DROP DATABASE postgres", "12 34", "1".repeat(21), 7234567890123456789, null, {}, ["1"], "EVIL-SENTINEL"]) {
      const m = makeSet(tempDir(), WHEN).manifest;
      m.source.system_identifier = bad;
      expect(manifestProblems(m), String(bad)).toEqual(["source.system_identifier er ugyldig"]);
    }
    const m = makeSet(tempDir(), WHEN).manifest;
    m.source.system_identifier = "EVIL-SENTINEL";
    expect(manifestProblems(m).join("\n")).not.toContain("SENTINEL");
  });

  it("SAMME system_identifier nektes - selv når scratch-serveren ser helt tom ut (de eneste kallene er identifikator-spørringen; ingenting skrives)", async () => {
    const same = fakeScratchRunner({ systemIdentifier: SOURCE_ID }); // fersk, tom klynge med kildens identifikator = kilden under et annet navn
    const res = await checkScratchServer(same.runner, withId());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("SAMME Postgres-klynge");
    expect(res.error).toContain("ikke en tom, kastbar instans");
    expect(same.calls().map((c) => c.sql)).toEqual(["SELECT system_identifier FROM pg_control_system()"]);
    expect(same.writes()).toEqual([]);
  });

  it("en ANNEN identifikator slipper gjennom til de øvrige kontrollene (som fortsatt gjelder); `checked` rapporteres", async () => {
    const other = fakeScratchRunner({ systemIdentifier: "5000000000000000001" });
    expect(await checkScratchServer(other.runner, withId())).toEqual({ ok: true, systemIdentifier: "checked" });
    expect(other.calls()).toHaveLength(3); // identifikator, databaseliste, objekt-oversikt
    const prod = fakeScratchRunner({ systemIdentifier: "5000000000000000001", databases: PRODUCTION_DBS });
    expect(await checkScratchServer(prod.runner, withId())).toMatchObject({ ok: false, error: expect.stringContaining("3 database(r)") }); // tom-sjekken er andre lag
  });

  it("FAIL-CLOSED: kan identifikatoren ikke leses (feil, tom eller ugyldig utdata), er svaret nei når manifestet har en", async () => {
    const down = fakeScratchRunner({ systemIdentifier: null });
    expect(await checkScratchServer(down.runner, withId())).toMatchObject({ ok: false, error: expect.stringContaining("kunne ikke lese system_identifier") });
    for (const garbage of ["", "ikke-et-tall", "1; select 1"]) {
      const odd = fakeScratchRunner({ systemIdentifier: garbage });
      expect(await checkScratchServer(odd.runner, withId()), garbage).toMatchObject({ ok: false, error: expect.stringContaining("ingen gyldig system_identifier") });
    }
    // uten felt i manifestet (eldre sett) spørres identifikatoren aldri - tom-sjekken er alene
    const old = fakeScratchRunner({ systemIdentifier: null });
    expect(await checkScratchServer(old.runner, makeSet(tempDir(), WHEN).manifest)).toEqual({ ok: true, systemIdentifier: "absent" });
    expect(old.calls().some((c) => /pg_control_system/.test(c.sql ?? ""))).toBe(false);
  });

  it("runRestoreVerify logger at eldre sett uten system_identifier kun har tom-sjekken, og nekter et sett med SAMME identifikator på trinn scratch_guard uten ett skrivekall", async () => {
    const logs = [];
    const oldSet = makeSet(tempDir(), WHEN);
    const scratch = fakeScratchRunner();
    await runRestoreVerify({ setDir: oldSet.dir, identityFile: NO_IDENTITY, scratchRunner: scratch.runner, now: WHEN, log: (m) => logs.push(m) });
    expect(logs.some((m) => m.includes("ingen system_identifier i manifestet"))).toBe(true);

    const set = makeSet(tempDir(), WHEN, { systemIdentifier: SOURCE_ID });
    const same = fakeScratchRunner({ systemIdentifier: SOURCE_ID });
    const report = await runRestoreVerify({ setDir: set.dir, identityFile: NO_IDENTITY, scratchRunner: same.runner, now: WHEN });
    expect(report).toMatchObject({ ok: false, stage: "scratch_guard", set: set.name });
    expect(report.error).toContain("samme system_identifier");
    expect(same.writes()).toEqual([]);
  });

  it("databasenavn sammenlignes UTEN normalisering: « postgres» (med mellomrom) er en fremmed database, ikke systemdatabasen (tidligere trimmet til `postgres` og passerte)", async () => {
    // midt i listen, så den ikke trimmes bort av psqlOnce sin trimming av hele utdata
    const sneaky = fakeScratchRunner({ databases: ["postgres", " postgres", "template0", "template1"] });
    const res = await checkScratchServer(sneaky.runner, withId("1"));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("1 database(r)") });
    const trailing = fakeScratchRunner({ databases: ["postgres", "postgres ", "template0", "template1"] });
    expect((await checkScratchServer(trailing.runner, manifest0())).ok).toBe(false);
    // og spørringen ber serveren sitere navnene (quote_ident), så en ekte server aldri leverer et navn med mellomrom uten sitat
    expect(sneaky.calls().find((c) => /FROM pg_database/.test(c.sql ?? "")).sql).toContain("quote_ident(datname)");
  });

  it("tom-sjekken teller også VISNINGER, materialiserte visninger, fremmede tabeller og sekvenser i postgres-databasen (ikke bare tabeller)", async () => {
    const used = fakeScratchRunner({ tables: { postgres: ["public.v"] } });
    expect(await checkScratchServer(used.runner, manifest0())).toMatchObject({ ok: false, error: expect.stringContaining("1 tabell(er)/visning(er)/sekvens(er)") });
    const sql = used.calls().find((c) => /FROM pg_class/.test(c.sql ?? "")).sql;
    for (const kind of ["'r'", "'p'", "'v'", "'m'", "'f'", "'S'"]) expect(sql, kind).toContain(kind);
    expect(sql).toContain("NOT IN ('pg_catalog','information_schema')");
  });
});

describe("WP-C2 review F1: runRestoreVerify skriver ALDRI til en server som ikke har bevist at den er kastbar", () => {
  const verify = (set, scratch, extra = {}) => runRestoreVerify({ setDir: set.dir, identityFile: NO_IDENTITY, scratchRunner: scratch.runner, now: WHEN, ...extra });

  it("alias-endepunktet slipper ikke lenger gjennom: `localhost` mot kilden `127.0.0.1` (samme server) nektes av tom-sjekken, uten ett eneste skrivekall", async () => {
    const set = makeSet(tempDir(), WHEN);
    set.manifest.source.endpoint = "127.0.0.1:5432";
    writeFileSync(join(set.dir, "manifest.json"), JSON.stringify(set.manifest));
    const prod = fakeScratchRunner({ endpoint: "localhost:5432", databases: PRODUCTION_DBS });
    const report = await verify(set, prod);
    expect(report).toMatchObject({ ok: false, stage: "scratch_guard", scratch_endpoint: "localhost:5432", set: set.name, databases: [] });
    expect(report.error).toContain("ikke en tom, kastbar instans");
    expect(prod.writes()).toEqual([]);
  });

  it("NAS-modus: kilden `docker-compose:postgres` mot en TCP-server (host:port) som ER produksjon nektes også", async () => {
    const set = makeSet(tempDir(), WHEN); // makeSet bruker source.endpoint = docker-compose:postgres
    const prod = fakeScratchRunner({ endpoint: "10.0.0.5:5432", databases: PRODUCTION_DBS });
    expect(await verify(set, prod)).toMatchObject({ ok: false, stage: "scratch_guard" });
    expect(prod.writes()).toEqual([]);
  });

  it("identisk endepunkt kaster som før; --allow-same-server omgår KUN den sammenligningen, tom-sjekken gjelder fortsatt", async () => {
    const set = makeSet(tempDir(), WHEN);
    const same = fakeScratchRunner({ endpoint: "docker-compose:postgres", databases: PRODUCTION_DBS });
    await expect(verify(set, same)).rejects.toThrow(/refusing to restore into the source server/);
    expect(same.calls()).toEqual([]);
    const report = await verify(set, same, { allowSameServer: true });
    expect(report).toMatchObject({ ok: false, stage: "scratch_guard" });
    expect(same.writes()).toEqual([]);
  });

  it("ugyldig manifest stopper FØR serveren er kontaktet (ingen kall), uten å sitere innholdet; korrupt JSON likeså", async () => {
    const set = makeSet(tempDir(), WHEN);
    set.manifest.databases[0].tables = [{ table: "public.t; DROP DATABASE postgres", rows: 1 }];
    writeFileSync(join(set.dir, "manifest.json"), JSON.stringify(set.manifest));
    const scratch = fakeScratchRunner();
    const report = await verify(set, scratch);
    expect(report).toMatchObject({ ok: false, stage: "manifest" });
    expect(report.error).toContain("ugyldig tabellnavn");
    expect(JSON.stringify(report)).not.toContain("DROP DATABASE");
    expect(scratch.calls()).toEqual([]);
    writeFileSync(join(set.dir, "manifest.json"), "{ikke json");
    expect(await verify(set, scratch)).toMatchObject({ ok: false, stage: "manifest" });
    expect(scratch.calls()).toEqual([]);
  });

  it("integritetssjekken kommer før serverkontakt: en endret fil stopper uten at scratch-serveren spørres", async () => {
    const set = makeSet(tempDir(), WHEN);
    writeFileSync(join(set.dir, "jarvis.dump.age"), "manipulert");
    const scratch = fakeScratchRunner();
    expect(await verify(set, scratch)).toMatchObject({ ok: false, stage: "integrity" });
    expect(scratch.calls()).toEqual([]);
  });

  it("er serveren tom, går det videre til selve restoren (her stoppet av manglende identitetsfil) - og da er det bare vakt-spørringene som kom først", async () => {
    const set = makeSet(tempDir(), WHEN);
    const scratch = fakeScratchRunner();
    const report = await verify(set, scratch);
    expect(report).toMatchObject({ ok: false, stage: "restore" });
    const calls = scratch.calls();
    expect(calls.slice(0, 2).map((c) => c.sql?.slice(0, 20))).toEqual(["SELECT quote_ident(d", "SELECT quote_ident(n"]);
    expect(calls.slice(0, 2).every((c) => c.stdin === "")).toBe(true);
  });
});
