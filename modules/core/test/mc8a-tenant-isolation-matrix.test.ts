import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import {
  DEFAULT_ISOLATION_CONTEXT,
  checkTableIsolation,
  createRuntimeLogin,
  extractCatalog,
  fingerprintRls,
  formatReport,
  loadManifest,
  poolRunner,
  readMigrationFiles,
  runSchemaClassChecks,
  seedIsolationRows,
  startLeasedEmbeddedPostgres,
  stripForIsolation,
  summarizeIsolation,
  type IsolationEnv,
  type RowFactory,
  type StripSummary,
  type TableIsolationReport
} from "@jarvis/core/testing";

/**
 * WP-MC8a K4: NEGATIV ORG-A/B-FIXTURE (HF3 §9.2 «negativ fixture», §9.3). For ALLE ORG_OWNED-tabeller i klassifiseringen (baseline + tabeller fra nye migrasjoner)
 * bevises tenant-isolasjon med runtime-rollen (et LOGIN-medlem av jarvis_app: NOSUPERUSER/NOBYPASSRLS) mot to seedede tenants A og B:
 * lesing, insert, update, flytting av en rad til en annen tenant og delete - hver med en kontroll (egen tenant virker) så beviset ikke er vakuøst.
 *
 * Dekning (skrives ut av testen, aldri skjult):
 *  - `auto`: raden syntetiseres fra katalogen (NOT NULL-fyll) mot en fixture-database der CHECK/FK er fjernet og brukertriggere er av (RLS/policyer/GRANT uendret,
 *     bevist med fingeravtrykk mot den strenge databasen),
 *  - `factory`: tabellspesifikk RowFactory (policyer som slår opp foreldrerader) - i fixture-databasen eller, for et utvalg, mot den STRENGE databasen med ekte
 *     constraints. Nye pakker legger en fil i `fixtures/isolation-factories/` (ingen delt fil => ingen flettekonflikt).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const FACTORY_DIR = fileURLToPath(new URL("./fixtures/isolation-factories", import.meta.url));
const FILES = readMigrationFiles(MIGRATIONS_DIR);
const MANIFEST = loadManifest();
const LOGIN = "jarvis_iso_app";
const LOGIN_PASSWORD = "iso-pw-2";
const CTX = DEFAULT_ISOLATION_CONTEXT;

interface FactoryModule {
  readonly iso?: Record<string, RowFactory>;
  readonly strict?: Record<string, RowFactory>;
}

let stop: (() => Promise<void>) | undefined;
let port = 0;
let adminIso: pg.Pool;
let adminStrict: pg.Pool;
let appIso: pg.Pool;
let appStrict: pg.Pool;
let isoEnv: IsolationEnv;
let strictEnv: IsolationEnv;
let strip: StripSummary;
let orgTables: string[] = [];
const isoFactories: Record<string, RowFactory> = {};
const strictFactories: Record<string, RowFactory> = {};
const reports = new Map<string, TableIsolationReport>();
const tier = new Map<string, "auto" | "factory-iso" | "strict">();
let classMap: ReadonlyMap<string, { readonly class: string }> = new Map();

const open = (database: string, user: string, password: string): pg.Pool => {
  const pool = new pg.Pool({ host: "127.0.0.1", port, database, user, password });
  pool.on("error", () => undefined);
  return pool;
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-mc8a-iso-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_base");
  const base = open("jarvis_base", "postgres", "pw");
  await runMigrations(base);
  await base.end();
  const maintenance = open("postgres", "postgres", "pw");
  await maintenance.query("CREATE DATABASE jarvis_iso TEMPLATE jarvis_base");
  await maintenance.query("CREATE DATABASE jarvis_strict TEMPLATE jarvis_base");
  await maintenance.end();
  adminIso = open("jarvis_iso", "postgres", "pw");
  adminStrict = open("jarvis_strict", "postgres", "pw");
  await createRuntimeLogin(adminIso, LOGIN, LOGIN_PASSWORD);
  strip = await stripForIsolation(adminIso);
  appIso = open("jarvis_iso", LOGIN, LOGIN_PASSWORD);
  appStrict = open("jarvis_strict", LOGIN, LOGIN_PASSWORD);
  isoEnv = { admin: adminIso, asRuntime: poolRunner(appIso, CTX.space), catalog: await extractCatalog(adminIso), ctx: CTX };
  strictEnv = { admin: adminStrict, asRuntime: poolRunner(appStrict, CTX.space), catalog: await extractCatalog(adminStrict), ctx: CTX };
  const classes = (await runSchemaClassChecks({ files: FILES, manifest: MANIFEST, db: adminIso })).classes;
  classMap = classes;
  orgTables = [...classes].filter(([, info]) => info.class === "ORG_OWNED").map(([table]) => table).sort();
  for (const file of (await readdir(FACTORY_DIR)).filter((f) => f.endsWith(".ts")).sort()) {
    const mod = (await import(pathToFileURL(join(FACTORY_DIR, file)).href)) as FactoryModule;
    for (const [table, factory] of Object.entries(mod.iso ?? {})) {
      if (isoFactories[table] !== undefined || strictFactories[table] !== undefined) throw new Error(`isolation_factory_duplicate:${table} (${file})`);
      isoFactories[table] = factory;
    }
    for (const [table, factory] of Object.entries(mod.strict ?? {})) {
      if (isoFactories[table] !== undefined || strictFactories[table] !== undefined) throw new Error(`isolation_factory_duplicate:${table} (${file})`);
      strictFactories[table] = factory;
    }
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([appIso?.end(), appStrict?.end()]);
  await Promise.all([adminIso?.end(), adminStrict?.end()]);
  await stop?.();
}, 120_000);

describe("A: fixture-databasen er en tro kopi av isolasjonsflaten", () => {
  it("constraints og brukertriggere er fjernet/av, men fingeravtrykket av RLS/policyer/GRANT/eierskap/DEFINER er IDENTISK med den strenge databasen", async () => {
    console.info(`[mc8a-iso] fixture: ${strip.tables} tabeller, CHECK droppet ${strip.checksDropped}, FK droppet ${strip.foreignKeysDropped}, exclusion ${strip.exclusionsDropped}, brukertriggere av ${strip.triggersDisabled.length}, triggere som leser jarvis.* holdt PÅ ${strip.triggersKept.length} (${strip.triggersKept.join(", ") || "ingen"})`);
    expect(strip.checksDropped).toBeGreaterThan(500);
    expect(strip.foreignKeysDropped).toBeGreaterThan(100);
    const a = fingerprintRls(isoEnv.catalog);
    const b = fingerprintRls(strictEnv.catalog);
    const onlyIso = a.lines.filter((l) => !b.lines.includes(l));
    const onlyStrict = b.lines.filter((l) => !a.lines.includes(l));
    expect({ onlyIso, onlyStrict }).toEqual({ onlyIso: [], onlyStrict: [] });
    expect(a.digest).toBe(b.digest);
  });

  it("runtime-innloggingen er et NOSUPERUSER/NOBYPASSRLS-medlem av jarvis_app som ikke eier noen tabell", async () => {
    const r = await adminIso.query("SELECT rolsuper, rolbypassrls, pg_has_role($1, 'jarvis_app', 'MEMBER') AS member FROM pg_roles WHERE rolname = $1", [LOGIN]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, member: true });
    const owned = await adminIso.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner WHERE o.rolname = $1", [LOGIN]);
    expect((owned.rows[0] as { n: number }).n).toBe(0);
    const who = await appIso.query("SELECT current_user AS u, current_setting('is_superuser') AS su");
    expect(who.rows[0]).toEqual({ u: LOGIN, su: "off" });
  });
});

describe("B: matrise - alle ORG_OWNED-tabeller", () => {
  it("fabrikkene gjelder kun ORG_OWNED-tabeller som finnes (ingen foreldede fabrikker), og hver tabell har høyst én fabrikk", () => {
    for (const table of [...Object.keys(isoFactories), ...Object.keys(strictFactories)]) expect(orgTables, `fabrikk for ${table}`).toContain(table);
    expect(Object.keys(strictFactories).length).toBeGreaterThanOrEqual(10);
  });

  it("hver ORG_OWNED-tabell er atferdsbevist (lese/insert/update/flytte/slette mot to tenants) med runtime-rollen", async () => {
    expect(orgTables.length).toBeGreaterThanOrEqual(173);
    const failures: string[] = [];
    for (const table of orgTables) {
      const strictFactory = strictFactories[table];
      const env = strictFactory === undefined ? isoEnv : strictEnv;
      const factory = strictFactory ?? isoFactories[table];
      tier.set(table, strictFactory !== undefined ? "strict" : factory !== undefined ? "factory-iso" : "auto");
      try {
        await seedIsolationRows(env, table, factory);
        reports.set(table, await checkTableIsolation(env, table, factory));
      } catch (err) {
        failures.push(`${table}: ${(err as Error).message}`);
      }
    }
    const all = [...reports.values()];
    for (const r of all) if (!r.ok) failures.push(`${r.table}:\n${formatReport(r)}`);
    const summary = summarizeIsolation(all);
    const count = (t: string): number => [...tier.values()].filter((v) => v === t).length;
    console.info(
      `[mc8a-iso] ORG_OWNED-tabeller: ${orgTables.length} | atferdsbevist med runtime-rollen: ${summary.behavioral} (auto-syntetisert rad i fixture-DB: ${count("auto")}; fabrikk i fixture-DB: ${count("factory-iso")}; ` +
        `fabrikk mot STRENG DB med ekte constraints: ${count("strict")}) | kun katalogbevist (policy/WITH CHECK i lint, ingen atferd): ${orgTables.length - summary.behavioral} | ` +
        `alle seks bevis PROVEN: ${summary.fullyProven} | tabeller med minst én operasjon avvist av GRANT (ingen RLS-bevis for akkurat den delen): ${summary.withGrantDenials}`
    );
    if (summary.grantDenials.length > 0) console.info(`[mc8a-iso] avvist av GRANT: ${summary.grantDenials.map((d) => `${d.table}[${d.ops.join(",")}]`).join(" ")}`);
    expect(failures).toEqual([]);
    expect(all.length).toBe(orgTables.length);
    expect(summary.failed).toEqual([]);
  }, 600_000);

  it("den strenge databasen (ekte constraints) gir samme utfall som fixture-databasen for de samme tabellene", async () => {
    const strictTables = [...tier].filter(([, t]) => t === "strict").map(([table]) => table).sort();
    expect(strictTables).toEqual(Object.keys(strictFactories).sort());
    for (const table of strictTables) {
      const strictReport = reports.get(table);
      expect(strictReport?.ok, table).toBe(true);
      // Samme tabell i fixture-databasen (auto-rad) må gi nøyaktig samme bevisstatus per operasjon.
      await seedIsolationRows(isoEnv, table);
      const iso = await checkTableIsolation(isoEnv, table);
      expect({ table, read: iso.read, noContext: iso.noContext, insert: iso.insert, update: iso.update, updateMove: iso.updateMove, delete: iso.delete }).toEqual({
        table,
        read: strictReport?.read,
        noContext: strictReport?.noContext,
        insert: strictReport?.insert,
        update: strictReport?.update,
        updateMove: strictReport?.updateMove,
        delete: strictReport?.delete
      });
    }
  }, 120_000);
});

describe("C: USER_OWNED (people) - isolasjon via medlemskap", () => {
  it("under kontekst A ses kun personer som er medlem av A; uten kontekst ingen; UPDATE/DELETE er ikke gitt til appen; INSERT uten medlemskap er det kjente, dokumenterte unntaket (D-364/Q-44, MC8a-F5)", async () => {
    expect(classMap.get("people")?.class).toBe("USER_OWNED");
    const [A, B] = [CTX.tenantA, CTX.tenantB];
    await adminStrict.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,'A','business'),($2,'B','business') ON CONFLICT DO NOTHING", [A, B]);
    await adminStrict.query("INSERT INTO people (person_id, display_name) VALUES ('iso-pa','PA'),('iso-pb','PB'),('iso-pc','PC') ON CONFLICT DO NOTHING");
    await adminStrict.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ('iso-pa',$1),('iso-pb',$2) ON CONFLICT DO NOTHING", [A, B]);
    const run = strictEnv.asRuntime;
    const visible = (tenant: string | null): Promise<string[]> => run(tenant, async (c) => (await c.query("SELECT person_id FROM people WHERE person_id LIKE 'iso-p_' ORDER BY 1")).rows.map((r) => String(r["person_id"])));
    expect(await visible(A)).toEqual(["iso-pa"]);
    expect(await visible(B)).toEqual(["iso-pb"]);
    expect(await visible(null)).toEqual([]);
    await expect(run(A, (c) => c.query("UPDATE people SET display_name = display_name WHERE person_id = 'iso-pb'"))).rejects.toThrow(/permission denied/);
    await expect(run(A, (c) => c.query("DELETE FROM people WHERE person_id = 'iso-pb'"))).rejects.toThrow(/permission denied/);
    // F5: WITH CHECK (true) - en person kan opprettes FØR medlemskapet finnes, men blir ikke synlig for noen tenant uten medlemskap.
    const created = await run(A, async (c) => {
      await c.query("INSERT INTO people (person_id, display_name) VALUES ('iso-pnew','N')");
      return (await c.query("SELECT count(*)::int AS n FROM people WHERE person_id = 'iso-pnew'")).rows[0]?.["n"];
    });
    expect(created).toBe(0);
  });
});

describe("D: GLOBAL og PLATFORM - observert tilgang for runtime-rollen (synlig i utskriften)", () => {
  const q = (id: string): string => `"${id}"`;
  async function observedPrivileges(table: string): Promise<string[]> {
    const col = strictEnv.catalog.columns.find((c) => c.table === table)?.name ?? "x";
    const probes: Array<[string, string]> = [
      ["SELECT", `SELECT 1 FROM ${q(table)} LIMIT 0`],
      ["INSERT", `INSERT INTO ${q(table)} DEFAULT VALUES`],
      ["UPDATE", `UPDATE ${q(table)} SET ${q(col)} = ${q(col)} WHERE false`],
      ["DELETE", `DELETE FROM ${q(table)} WHERE false`]
    ];
    const have: string[] = [];
    for (const [name, sql] of probes) {
      try {
        await strictEnv.asRuntime(CTX.tenantA, (c) => c.query(sql));
        have.push(name);
      } catch (err) {
        // Alt annet enn «permission denied» (NOT NULL, trigger, ...) kommer ETTER rettighetssjekken: runtime-rollen HAR rettigheten.
        if (!/permission denied/i.test((err as Error).message)) have.push(name);
      }
    }
    return have;
  }

  it("GLOBAL: kun lesing; PLATFORM: ingen tilgang unntatt de nummererte, kjente unntakene (som må stemme NØYAKTIG med det appen faktisk kan)", async () => {
    const lines: string[] = [];
    for (const [table, info] of [...classMap].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (info.class !== "GLOBAL" && info.class !== "PLATFORM") continue;
      const have = await observedPrivileges(table);
      const exception = MANIFEST.exceptions.find((e) => e.rule === "platform_app_access" && e.table === table);
      if (info.class === "GLOBAL") {
        expect(have.filter((p) => p !== "SELECT"), `GLOBAL ${table} skal være skrivebeskyttet for appen`).toEqual([]);
        lines.push(`${table}=GLOBAL[${have.join(",") || "ingen"}]`);
      } else {
        const expected = exception === undefined ? [] : (exception.detail ?? "").split(",").sort();
        expect([...have].sort(), `PLATFORM ${table}: observert tilgang må være lik baseline-unntaket`).toEqual(expected);
        lines.push(`${table}=PLATFORM[${have.join(",") || "ingen"}]${exception === undefined ? "" : ` KJENT ÅPEN (${exception.finding})`}`);
      }
    }
    console.info(`[mc8a-iso] GLOBAL/PLATFORM (observert med runtime-rollen): ${lines.join(" | ")}`);
    expect(lines.length).toBeGreaterThanOrEqual(9);
  });
});
