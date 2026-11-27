import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import {
  DEFAULT_ISOLATION_CONTEXT,
  checkTableIsolation,
  createRuntimeLogin,
  extractCatalog,
  formatFailures,
  loadManifest,
  readMigrationFiles,
  runSchemaClassChecks,
  savepointRunner,
  seedIsolationRows,
  startLeasedEmbeddedPostgres,
  stripForIsolation,
  type Catalog,
  type IsolationEnv,
  type MigrationFile,
  type TableIsolationReport,
  type Violation
} from "@jarvis/core/testing";

/**
 * WP-MC8a K6: MUTANTER. Hver mutant er en ekte skjemaendring (DDL i en transaksjon som alltid rulles tilbake - DDL er transaksjonelt i Postgres) som bryter en
 * av isolasjonskontrollene. Linten (`runSchemaClassChecks` mot den STRENGE databasen) MÅ rapportere forventet regel på forventet tabell; for policy-mutantene som
 * åpner for lekkasje MÅ i tillegg atferdsharnisken (savepoint-runner mot fixture-databasen, runtime-rolle) feile. En mutant som ingen av delene fanger er en overlevende.
 *  - del A: mutanter mot det eksisterende skjemaet (FORCE, WITH CHECK, true-policyer, FK/indeks/NOT NULL, GRANT, eier, roller, DEFINER, klassebrudd, visning, skjema)
 *  - del B: mutanter som NYE migrasjoner (annotasjon + DDL): ny tabell uten klasse, uten RLS, feil klasse, PLATFORM med GRANT, lekk ny tabell, korrekt ny tabell (kontroll)
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const FILES = readMigrationFiles(MIGRATIONS_DIR);
const MANIFEST = loadManifest();
const CTX = DEFAULT_ISOLATION_CONTEXT;
const LOGIN = "jarvis_mut_app";
const TENANT = "tenant_id = current_setting('jarvis.tenant_id', true)";
const DEFINER_FN = "prune_policy_decisions(integer,integer)";

let stop: (() => Promise<void>) | undefined;
let port = 0;
let adminStrict: pg.Pool;
let adminIso: pg.Pool;
let catalogStrict: Catalog;
let catalogIso: Catalog;

interface Picks {
  /** ORG_OWNED-tabell med alle fire rettigheter, tenant_id utenfor primærnøkkelen og en direkte FK til tenants. */
  table: string;
  policy: string;
  fk: string;
  /** Tabell der en vanlig (ikke-PK) indeks er den ENESTE tenant-ledende. */
  indexTable: string;
  index: string;
}
let pick: Picks;

const open = (database: string, user = "postgres", password = "pw"): pg.Pool => {
  const pool = new pg.Pool({ host: "127.0.0.1", port, database, user, password });
  pool.on("error", () => undefined);
  return pool;
};

async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

const has = (failures: readonly Violation[], rule: string, table?: string | null): boolean => failures.some((f) => f.rule === rule && (table === undefined || f.table === table));

function choose(catalog: Catalog): Picks {
  const orgTables = catalog.columns.filter((c) => c.name === "tenant_id").map((c) => c.table);
  const priv = new Map(catalog.tablePrivileges.map((p) => [p.table, p]));
  const primaryCols = (t: string): readonly string[] => catalog.indexes.find((i) => i.table === t && i.primary)?.columns ?? [];
  const table = orgTables
    .filter((t) => t !== "tenants" && t !== "audit_events")
    .sort()
    .find((t) => {
      const p = priv.get(t);
      const fk = catalog.foreignKeys.find((f) => f.table === t && f.columns.length === 1 && f.columns[0] === "tenant_id" && f.refTable === "tenants");
      const pol = catalog.policies.find((x) => x.table === t && x.permissive && x.appliesToRuntime && x.command === "ALL");
      const notNullTenant = catalog.columns.find((c) => c.table === t && c.name === "tenant_id")?.notNull === true;
      // Kun den direkte FK-en forankrer tenant_id (ingen sammensatt FK med tenant_id): ellers er tabellen fortsatt forankret via en forelder når FK-en droppes.
      const soleAnchor = catalog.foreignKeys.filter((f) => f.table === t && f.columns.includes("tenant_id")).length === 1;
      return p?.select === true && p.insert && p.update && p.delete && fk !== undefined && pol !== undefined && notNullTenant && soleAnchor && !primaryCols(t).includes("tenant_id");
    });
  if (table === undefined) throw new Error("mutant_pick_failed:table");
  const policy = (catalog.policies.find((x) => x.table === table && x.permissive && x.appliesToRuntime && x.command === "ALL") as { name: string }).name;
  const fk = (catalog.foreignKeys.find((f) => f.table === table && f.columns.length === 1 && f.columns[0] === "tenant_id" && f.refTable === "tenants") as { name: string }).name;
  const indexed = orgTables
    .sort()
    .map((t) => ({ t, tenantIdx: catalog.indexes.filter((i) => i.table === t && i.valid && !i.partial && !i.hasExpressions && i.method === "btree" && i.columns[0] === "tenant_id") }))
    .find((x) => x.tenantIdx.length === 1 && !x.tenantIdx[0]?.primary && !x.tenantIdx[0]?.unique);
  if (indexed === undefined) throw new Error("mutant_pick_failed:index");
  return { table, policy, fk, indexTable: indexed.t, index: (indexed.tenantIdx[0] as { name: string }).name };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-mc8a-mut-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_base");
  const base = open("jarvis_base");
  await runMigrations(base);
  await base.end();
  const maintenance = open("postgres");
  await maintenance.query("CREATE DATABASE jarvis_strict TEMPLATE jarvis_base");
  await maintenance.query("CREATE DATABASE jarvis_iso TEMPLATE jarvis_base");
  await maintenance.end();
  adminStrict = open("jarvis_strict");
  adminIso = open("jarvis_iso");
  await createRuntimeLogin(adminIso, LOGIN, "mut-pw-3");
  await stripForIsolation(adminIso);
  catalogStrict = await extractCatalog(adminStrict);
  catalogIso = await extractCatalog(adminIso);
  pick = choose(catalogStrict);
  const isoEnv: IsolationEnv = { admin: adminIso, asRuntime: async () => Promise.reject(new Error("unused")), catalog: catalogIso, ctx: CTX };
  await seedIsolationRows(isoEnv, pick.table);
  console.info(`[mc8a-mut] valgt tabell for policy/atferd: ${pick.table} (policy ${pick.policy}, FK ${pick.fk}); indeks-tabell: ${pick.indexTable} (${pick.index}); DEFINER: ${DEFINER_FN}`);
}, 300_000);

afterAll(async () => {
  console.info(`[mc8a-mut] mutanter kjørt: ${results.length} | drept av lint: ${results.filter((r) => r.lint).length} | drept av atferdsharnisken (i tillegg): ${results.filter((r) => r.behavior).length} | overlevende: ${results.filter((r) => !r.lint && !r.behavior).length}`);
  await Promise.all([adminStrict?.end(), adminIso?.end()]);
  await stop?.();
}, 120_000);

const results: Array<{ id: string; lint: boolean; behavior: boolean }> = [];

type Op = "read" | "noContext" | "insert" | "update" | "updateMove" | "delete";
interface Mutant {
  readonly id: string;
  readonly desc: string;
  readonly sql: () => string;
  /** Regler linten MÅ rapportere (tabell og presis detalj valgfritt). */
  readonly lint: ReadonlyArray<{ rule: string; table?: () => string | null; detail?: string }>;
  /** Atferdsharnisken MÅ feile på disse operasjonene (kun policy-mutanter som er atferdsmessig synlige): kontroll (egen tenant virker ikke) eller lekkasje. */
  readonly behavior?: ReadonlyArray<Op>;
  /** Operasjoner der harnisken MÅ melde en LEKKASJE (angrepet lyktes), ikke bare en feilet kontroll. */
  readonly behaviorLeak?: ReadonlyArray<Op>;
  /** Atferdsmessig ekvivalent (kun lint kan drepe): harnisken skal fortsatt være grønn, og det dokumenteres. */
  readonly behaviorEquivalent?: boolean;
}

const T = (): string => pick.table;
const P = (): string => pick.policy;
const q = (id: string): string => `"${id}"`;

const MUTANTS: Mutant[] = [
  { id: "M01", desc: "FORCE ROW LEVEL SECURITY fjernet (eier omgår RLS)", sql: () => `ALTER TABLE ${q(T())} NO FORCE ROW LEVEL SECURITY`, lint: [{ rule: "rls_not_forced", table: T }], behaviorEquivalent: true },
  { id: "M02", desc: "RLS slått helt av", sql: () => `ALTER TABLE ${q(T())} DISABLE ROW LEVEL SECURITY`, lint: [{ rule: "rls_not_forced", table: T }], behavior: ["read", "noContext", "update", "delete"], behaviorLeak: ["read", "noContext", "update", "delete"] },
  { id: "M03", desc: "policy USING (true) WITH CHECK (true)", sql: () => `ALTER POLICY ${q(P())} ON ${q(T())} USING (true) WITH CHECK (true)`, lint: [{ rule: "policy_scope", table: T }, { rule: "policy_true", table: T }], behavior: ["read", "insert", "update", "delete"], behaviorLeak: ["read", "insert", "update", "delete"] },
  { id: "M04", desc: "WITH CHECK (true) (USING uendret)", sql: () => `ALTER POLICY ${q(P())} ON ${q(T())} WITH CHECK (true)`, lint: [{ rule: "policy_scope", table: T }, { rule: "policy_true", table: T }], behavior: ["insert", "updateMove"], behaviorLeak: ["insert", "updateMove"] },
  { id: "M05", desc: "WITH CHECK fjernet (kun USING; Postgres bruker USING som sjekk)", sql: () => `DROP POLICY ${q(P())} ON ${q(T())}; CREATE POLICY ${q(P())} ON ${q(T())} USING (${TENANT})`, lint: [{ rule: "policy_with_check_missing", table: T }], behaviorEquivalent: true },
  { id: "M06", desc: "policy med `OR true`", sql: () => `ALTER POLICY ${q(P())} ON ${q(T())} USING (${TENANT} OR true) WITH CHECK (${TENANT} OR true)`, lint: [{ rule: "policy_scope", table: T }], behavior: ["read", "insert", "update", "delete"], behaviorLeak: ["read", "insert", "update", "delete"] },
  { id: "M07", desc: "policy leser feil innstilling (jarvis.other)", sql: () => `ALTER POLICY ${q(P())} ON ${q(T())} USING (tenant_id = current_setting('jarvis.other', true)) WITH CHECK (tenant_id = current_setting('jarvis.other', true))`, lint: [{ rule: "policy_scope", table: T }], behavior: ["read", "insert"] },
  { id: "M08", desc: "tenant-policyen droppet (kun RESTRICTIVE igjen: default deny)", sql: () => `DROP POLICY ${q(P())} ON ${q(T())}`, lint: [{ rule: "policy_coverage_missing", table: T }], behavior: ["read", "insert"] },
  { id: "M09", desc: "kun SELECT-policy (INSERT/UPDATE/DELETE uten policy)", sql: () => `DROP POLICY ${q(P())} ON ${q(T())}; CREATE POLICY ${q(P())} ON ${q(T())} FOR SELECT USING (${TENANT})`, lint: [{ rule: "policy_coverage_missing", table: T }], behavior: ["insert", "update", "delete"] },
  {
    id: "M10",
    desc: "delte policyer, INSERT-policy med WITH CHECK (true)",
    sql: () =>
      `DROP POLICY ${q(P())} ON ${q(T())}; CREATE POLICY p_sel ON ${q(T())} FOR SELECT USING (${TENANT}); CREATE POLICY p_upd ON ${q(T())} FOR UPDATE USING (${TENANT}) WITH CHECK (${TENANT}); CREATE POLICY p_del ON ${q(T())} FOR DELETE USING (${TENANT}); CREATE POLICY p_ins ON ${q(T())} FOR INSERT WITH CHECK (true)`,
    lint: [{ rule: "policy_scope", table: T }, { rule: "policy_true", table: T }],
    behavior: ["insert"],
    behaviorLeak: ["insert"]
  },
  { id: "M11", desc: "ekstra PERMISSIVE policy USING (true) for PUBLIC", sql: () => `CREATE POLICY leak ON ${q(T())} USING (true) WITH CHECK (true)`, lint: [{ rule: "policy_true", table: T }, { rule: "policy_scope", table: T }], behavior: ["read", "update", "delete"], behaviorLeak: ["read", "update", "delete"] },
  { id: "M12", desc: "policyen flyttet til en annen rolle (runtime uten policy)", sql: () => `ALTER POLICY ${q(P())} ON ${q(T())} TO jarvis_definer`, lint: [{ rule: "policy_coverage_missing", table: T }], behavior: ["read", "insert"] },
  { id: "M13", desc: "tenant_id gjort nullable", sql: () => `ALTER TABLE ${q(T())} ALTER COLUMN tenant_id DROP NOT NULL`, lint: [{ rule: "tenant_id_nullable", table: T }], behaviorEquivalent: true },
  { id: "M14", desc: "FK fra tenant_id til tenants droppet", sql: () => `ALTER TABLE ${q(T())} DROP CONSTRAINT ${q(pick.fk)}`, lint: [{ rule: "tenant_fk_missing", table: T }] },
  { id: "M15", desc: "tenant-indeksen droppet", sql: () => `DROP INDEX ${q(pick.index)}`, lint: [{ rule: "tenant_index_missing", table: () => pick.indexTable }], behaviorEquivalent: true },
  { id: "M16", desc: "tenant_id-kolonnen droppet fra en ORG_OWNED-tabell", sql: () => `ALTER TABLE ${q(T())} DROP COLUMN tenant_id CASCADE`, lint: [{ rule: "org_no_tenant_id", table: T }] },
  { id: "M17", desc: "TRUNCATE gitt til runtime-rollen (omgår RLS)", sql: () => `GRANT TRUNCATE ON ${q(T())} TO jarvis_app`, lint: [{ rule: "app_dangerous_privilege", table: T }], behaviorEquivalent: true },
  { id: "M18", desc: "REFERENCES gitt til runtime-rollen (eksistensorakel)", sql: () => `GRANT REFERENCES ON ${q(T())} TO jarvis_app`, lint: [{ rule: "app_dangerous_privilege", table: T }], behaviorEquivalent: true },
  { id: "M19", desc: "TRIGGER gitt til runtime-rollen", sql: () => `GRANT TRIGGER ON ${q(T())} TO jarvis_app`, lint: [{ rule: "app_dangerous_privilege", table: T }], behaviorEquivalent: true },
  { id: "M20", desc: "runtime-rollen gjort til tabelleier", sql: () => `ALTER TABLE ${q(T())} OWNER TO jarvis_app`, lint: [{ rule: "owner_is_runtime", table: T }], behaviorEquivalent: true },
  { id: "M21", desc: "runtime-rollen får BYPASSRLS", sql: () => "ALTER ROLE jarvis_app BYPASSRLS", lint: [{ rule: "runtime_role_unsafe", table: () => null }] },
  { id: "M22", desc: "runtime-rollen gjort til superuser", sql: () => "ALTER ROLE jarvis_app SUPERUSER", lint: [{ rule: "runtime_role_unsafe", table: () => null }] },
  { id: "M23", desc: "et medlem av runtime-rollen med BYPASSRLS", sql: () => "CREATE ROLE mut_member NOLOGIN BYPASSRLS; GRANT jarvis_app TO mut_member", lint: [{ rule: "runtime_role_unsafe", table: () => null }] },
  { id: "M24", desc: "runtime-rollen kan opprette objekter i public", sql: () => "GRANT CREATE ON SCHEMA public TO jarvis_app", lint: [{ rule: "runtime_create_in_public", table: () => null }] },
  { id: "M25", desc: "ny SECURITY DEFINER-funksjon utenfor allowlisten", sql: () => "CREATE FUNCTION mut_definer() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$", lint: [{ rule: "definer_not_allowlisted", table: () => null }] },
  { id: "M26", desc: "allowlistet DEFINER-funksjon eid av en superuser", sql: () => `ALTER FUNCTION ${DEFINER_FN} OWNER TO postgres`, lint: [{ rule: "definer_owner_privileged", table: () => null }] },
  { id: "M27", desc: "allowlistet DEFINER-funksjon uten låst search_path", sql: () => `ALTER FUNCTION ${DEFINER_FN} RESET search_path`, lint: [{ rule: "definer_search_path", table: () => null }] },
  { id: "M28", desc: "allowlistet DEFINER-funksjon med EXECUTE for PUBLIC", sql: () => `GRANT EXECUTE ON FUNCTION ${DEFINER_FN} TO PUBLIC`, lint: [{ rule: "definer_public_execute", table: () => null }] },
  { id: "M29", desc: "allowlisten peker på en funksjon som ikke lenger er DEFINER", sql: () => `ALTER FUNCTION ${DEFINER_FN} SECURITY INVOKER`, lint: [{ rule: "definer_allowlist_stale", table: () => null }] },
  { id: "M30", desc: "PLATFORM-tabell får utvidet GRANT til runtime-rollen (utover baseline-unntaket)", sql: () => "GRANT DELETE ON evolution_change_ledger TO jarvis_app", lint: [{ rule: "platform_app_access", table: () => "evolution_change_ledger" }, { rule: "exception_stale", table: () => "evolution_change_ledger" }] },
  { id: "M31", desc: "GLOBAL-tabell skrivbar for runtime-rollen", sql: () => "GRANT INSERT ON capabilities TO jarvis_app", lint: [{ rule: "global_app_write", table: () => "capabilities" }] },
  { id: "M32", desc: "GLOBAL-tabell får tenant-nyttelast (tenant_id)", sql: () => "ALTER TABLE capabilities ADD COLUMN tenant_id text", lint: [{ rule: "global_tenant_payload", table: () => "capabilities" }] },
  { id: "M33", desc: "USER_OWNED-policy USING (true)", sql: () => "ALTER POLICY people_via_membership ON people USING (true)", lint: [{ rule: "policy_true", table: () => "people" }, { rule: "user_policy_context", table: () => "people" }] },
  { id: "M34", desc: "USER_OWNED-tabell får tenant_id", sql: () => "ALTER TABLE people ADD COLUMN tenant_id text", lint: [{ rule: "user_has_tenant_id", table: () => "people" }] },
  { id: "M35", desc: "visning over en tenant-tabell (RLS-omgåelse)", sql: () => `CREATE VIEW mut_view AS SELECT * FROM ${q(T())}`, lint: [{ rule: "unmanaged_relation", table: () => "mut_view" }] },
  { id: "M36", desc: "tabell i et annet skjema", sql: () => "CREATE SCHEMA mut_schema; CREATE TABLE mut_schema.t1 (a int)", lint: [{ rule: "unmanaged_relation", table: () => "t1" }] },
  { id: "M37", desc: "tabell opprettet utenom migrasjonene", sql: () => "CREATE TABLE mut_direct (id text)", lint: [{ rule: "static_db_mismatch", table: () => null }, { rule: "unclassified_table", table: () => "mut_direct" }] },
  {
    id: "M38",
    desc: "policyer for SELECT/INSERT/UPDATE men INGEN for DELETE",
    sql: () => `DROP POLICY ${q(P())} ON ${q(T())}; CREATE POLICY p_sel ON ${q(T())} FOR SELECT USING (${TENANT}); CREATE POLICY p_ins ON ${q(T())} FOR INSERT WITH CHECK (${TENANT}); CREATE POLICY p_upd ON ${q(T())} FOR UPDATE USING (${TENANT}) WITH CHECK (${TENANT})`,
    lint: [{ rule: "policy_coverage_missing", table: T, detail: "DELETE" }],
    behavior: ["delete"]
  },
  { id: "M39", desc: "GLOBAL-tabell får DELETE for runtime-rollen", sql: () => "GRANT DELETE ON capabilities TO jarvis_app", lint: [{ rule: "global_app_write", table: () => "capabilities", detail: "DELETE" }] },
  { id: "M40", desc: "GLOBAL-tabell får UPDATE for runtime-rollen", sql: () => "GRANT UPDATE ON capabilities TO jarvis_app", lint: [{ rule: "global_app_write", table: () => "capabilities", detail: "UPDATE" }] },
  { id: "M41", desc: "DEFINER-funksjon med search_path uten pg_temp sist", sql: () => `ALTER FUNCTION ${DEFINER_FN} SET search_path = pg_catalog, public`, lint: [{ rule: "definer_search_path", table: () => null }] },
  { id: "M42", desc: "kolonne-REFERENCES (kun én kolonne) gitt til runtime-rollen", sql: () => `GRANT REFERENCES (tenant_id) ON ${q(T())} TO jarvis_app`, lint: [{ rule: "app_dangerous_privilege", table: T, detail: "REFERENCES" }], behaviorEquivalent: true },
  {
    id: "M43",
    desc: "asymmetrisk policy: tenanten 'iso-tenant-b' ser ALT (A->B er tett, B->A lekker)",
    sql: () => `ALTER POLICY ${q(P())} ON ${q(T())} USING (${TENANT} OR current_setting('jarvis.tenant_id', true) = '${CTX.tenantB}') WITH CHECK (${TENANT})`,
    lint: [{ rule: "policy_scope", table: T }],
    behavior: ["read"],
    behaviorLeak: ["read"]
  }
];

describe("A: mutanter mot det eksisterende skjemaet (DDL i en transaksjon som rulles tilbake)", () => {
  it("kontroll: umutert skjema er grønt (lint mot streng DB, atferd mot fixture-DB)", async () => {
    const lint = await inTx(adminStrict, (c) => runSchemaClassChecks({ files: FILES, manifest: MANIFEST, db: c }));
    expect(formatFailures(lint.failures)).toBe("(ingen)");
    const behavior = await inTx(adminIso, async (c) => checkTableIsolation({ admin: c, asRuntime: savepointRunner(c, LOGIN, CTX.space), catalog: await extractCatalog(c), ctx: CTX }, pick.table));
    expect(behavior.ok, JSON.stringify(behavior)).toBe(true);
  });

  for (const m of MUTANTS) {
    it(`${m.id} drept: ${m.desc}`, async () => {
      const strictResult = await inTx(adminStrict, async (c) => {
        await c.query(m.sql());
        return runSchemaClassChecks({ files: FILES, manifest: MANIFEST, db: c });
      });
      for (const want of m.lint) {
        const table = want.table === undefined ? undefined : want.table();
        const hit = strictResult.failures.some((f) => f.rule === want.rule && (table === undefined || f.table === table) && (want.detail === undefined || f.detail === want.detail));
        expect(hit, `${m.id}: forventet [${want.rule}]${table === undefined ? "" : ` på ${table}`}${want.detail === undefined ? "" : ` (${want.detail})`} fra linten, fikk:\n${formatFailures(strictResult.failures)}`).toBe(true);
      }
      let behaviorKilled = false;
      if (m.behavior !== undefined || m.behaviorEquivalent === true) {
        const report: TableIsolationReport = await inTx(adminIso, async (c) => {
          await c.query(m.sql());
          return checkTableIsolation({ admin: c, asRuntime: savepointRunner(c, LOGIN, CTX.space), catalog: await extractCatalog(c), ctx: CTX }, pick.table);
        });
        if (m.behavior !== undefined) {
          for (const op of m.behavior) expect(report[op].startsWith("failed:"), `${m.id}: atferdsharnisken skal feile på ${op}, fikk ${report[op]}`).toBe(true);
          for (const op of m.behaviorLeak ?? []) expect(report[op], `${m.id}: ${op} skal melde en LEKKASJE (angrepet lyktes), ikke bare en feilet kontroll`).toMatch(/^failed:LEKKASJE/);
          behaviorKilled = true;
        } else {
          expect(report.ok, `${m.id} er ment atferdsmessig ekvivalent (kun lint kan drepe den), men harnisken feilet: ${JSON.stringify(report)}`).toBe(true);
        }
      }
      results.push({ id: m.id, lint: m.lint.length > 0, behavior: behaviorKilled });
    }, 120_000);
  }
});

describe("B: mutanter som NYE migrasjoner (annotasjon + DDL kjørt i transaksjonen)", () => {
  const file = (sql: string): MigrationFile => ({ name: "149_mutant.sql", sql });
  const OK_TABLE = (name: string, klass: string, extra = ""): string => `-- jarvis-class: ${name} ${klass}${extra}
CREATE TABLE ${name} (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  payload text NOT NULL DEFAULT ''
);
CREATE INDEX ${name}_tenant_idx ON ${name} (tenant_id);
ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${name}_tenant ON ${name} USING (${TENANT}) WITH CHECK (${TENANT});
GRANT SELECT, INSERT, UPDATE, DELETE ON ${name} TO jarvis_app;
`;

  async function runNew(sql: string): Promise<{ failures: readonly Violation[]; behavior: TableIsolationReport | null }> {
    return inTx(adminStrict, async (c) => {
      await c.query(sql);
      const checked = await runSchemaClassChecks({ files: [...FILES, file(sql)], manifest: MANIFEST, db: c });
      return { failures: checked.failures, behavior: null };
    });
  }

  it("N00 kontroll: en korrekt ny ORG_OWNED-tabell er grønn for linten OG bevist av A/B-harnisken (uten manuelt oppsett)", async () => {
    const sql = OK_TABLE("mut_ok", "ORG_OWNED");
    const out = await inTx(adminStrict, async (c) => {
      await c.query(sql);
      const checked = await runSchemaClassChecks({ files: [...FILES, file(sql)], manifest: MANIFEST, db: c });
      await c.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, 'A', 'business'), ($2, 'B', 'business')", [CTX.tenantA, CTX.tenantB]);
      const env: IsolationEnv = { admin: c, asRuntime: savepointRunner(c, "jarvis_app_probe", CTX.space), catalog: await extractCatalog(c), ctx: CTX };
      await c.query("CREATE ROLE jarvis_app_probe NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT jarvis_app TO jarvis_app_probe");
      await seedIsolationRows(env, "mut_ok");
      return { failures: checked.failures, report: await checkTableIsolation(env, "mut_ok") };
    });
    expect(formatFailures(out.failures)).toBe("(ingen)");
    expect(out.report, JSON.stringify(out.report)).toMatchObject({ ok: true, read: "proven", insert: "proven", update: "proven", updateMove: "proven", delete: "proven" });
  });

  it("N01 drept: ny tabell uten klasse (ingen annotasjon)", async () => {
    const sql = OK_TABLE("mut_new", "ORG_OWNED").replace(/^-- jarvis-class:.*\n/, "");
    const { failures } = await runNew(sql);
    expect(has(failures, "unclassified_table", "mut_new"), formatFailures(failures)).toBe(true);
    results.push({ id: "N01", lint: true, behavior: false });
  });

  it("N02 drept: ny ORG_OWNED-tabell uten RLS, policyer, GRANT-vern og indeks", async () => {
    const sql = "-- jarvis-class: mut_naked ORG_OWNED\nCREATE TABLE mut_naked (id text PRIMARY KEY, tenant_id text NOT NULL);\nGRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON mut_naked TO jarvis_app;\n";
    const { failures } = await runNew(sql);
    for (const rule of ["rls_not_forced", "policy_coverage_missing", "tenant_fk_missing", "tenant_index_missing", "app_dangerous_privilege"]) {
      expect(has(failures, rule, "mut_naked"), `${rule}\n${formatFailures(failures)}`).toBe(true);
    }
    results.push({ id: "N02", lint: true, behavior: false });
  });

  it("N03 drept: ny ORG_OWNED-tabell der RLS er på men IKKE forced", async () => {
    const sql = OK_TABLE("mut_noforce", "ORG_OWNED").replace("ALTER TABLE mut_noforce FORCE ROW LEVEL SECURITY;\n", "");
    const { failures } = await runNew(sql);
    expect(has(failures, "rls_not_forced", "mut_noforce"), formatFailures(failures)).toBe(true);
    results.push({ id: "N03", lint: true, behavior: false });
  });

  it("N04 drept: ny tabell med feil klasse - GLOBAL med tenant_id (uten tenant-payload-flagg)", async () => {
    const { failures } = await runNew(OK_TABLE("mut_global", "GLOBAL"));
    expect(has(failures, "global_tenant_payload", "mut_global"), formatFailures(failures)).toBe(true);
    results.push({ id: "N04", lint: true, behavior: false });
  });

  it("N05 kontroll: GLOBAL med eksplisitt tenant-payload-flagg + begrunnelse slipper gjennom tenant-payload-regelen, men en skrivbar GLOBAL-tabell feiler fortsatt", async () => {
    const flagged = OK_TABLE("mut_global_ok", "GLOBAL", ' tenant-payload="Delt oppslagstabell med tenant-referanse, gjennomgått"');
    const { failures } = await runNew(flagged);
    expect(has(failures, "global_tenant_payload", "mut_global_ok")).toBe(false);
    expect(has(failures, "global_app_write", "mut_global_ok"), formatFailures(failures)).toBe(true);
    const readOnly = flagged.replace("GRANT SELECT, INSERT, UPDATE, DELETE ON mut_global_ok TO jarvis_app;", "GRANT SELECT ON mut_global_ok TO jarvis_app;");
    expect(formatFailures((await runNew(readOnly)).failures)).toBe("(ingen)");
    results.push({ id: "N05", lint: true, behavior: false });
  });

  it("N06 drept: ny PLATFORM-tabell gitt til runtime-rollen (nye tabeller kan aldri ha baseline-unntak)", async () => {
    const sql = "-- jarvis-class: mut_platform PLATFORM\nCREATE TABLE mut_platform (id text PRIMARY KEY);\nGRANT SELECT ON mut_platform TO jarvis_app;\n";
    const { failures } = await runNew(sql);
    expect(has(failures, "platform_app_access", "mut_platform"), formatFailures(failures)).toBe(true);
    const clean = await runNew("-- jarvis-class: mut_platform PLATFORM\nCREATE TABLE mut_platform (id text PRIMARY KEY);\n");
    expect(formatFailures(clean.failures)).toBe("(ingen)");
    results.push({ id: "N06", lint: true, behavior: false });
  });

  it("N11 drept: ny PLATFORM-tabell med KUN et kolonne-GRANT (SELECT på én kolonne) til runtime-rollen", async () => {
    const sql = "-- jarvis-class: mut_platform_col PLATFORM\nCREATE TABLE mut_platform_col (id text PRIMARY KEY, secret text);\nGRANT SELECT (id) ON mut_platform_col TO jarvis_app;\n";
    const { failures } = await runNew(sql);
    expect(failures.some((f) => f.rule === "platform_app_access" && f.table === "mut_platform_col" && f.detail === "SELECT"), formatFailures(failures)).toBe(true);
    results.push({ id: "N11", lint: true, behavior: false });
  });

  it("N07 drept: ORG_OWNED-annotasjon på en tabell uten tenant_id, og USER_OWNED med tenant_id", async () => {
    const noTenant = (await runNew("-- jarvis-class: mut_wrong ORG_OWNED\nCREATE TABLE mut_wrong (id text PRIMARY KEY);\n")).failures;
    expect(has(noTenant, "org_no_tenant_id", "mut_wrong"), formatFailures(noTenant)).toBe(true);
    const userTenant = (await runNew(OK_TABLE("mut_user", "USER_OWNED"))).failures;
    expect(has(userTenant, "user_has_tenant_id", "mut_user"), formatFailures(userTenant)).toBe(true);
    results.push({ id: "N07", lint: true, behavior: false });
  });

  it("N08 drept: ny ORG_OWNED-tabell der policyen lekker (USING true) fanges av BÅDE linten og A/B-harnisken", async () => {
    const leaky = OK_TABLE("mut_leaky", "ORG_OWNED").replace(`USING (${TENANT}) WITH CHECK (${TENANT})`, "USING (true) WITH CHECK (true)");
    const out = await inTx(adminStrict, async (c) => {
      await c.query(leaky);
      const checked = await runSchemaClassChecks({ files: [...FILES, file(leaky)], manifest: MANIFEST, db: c });
      await c.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, 'A', 'business'), ($2, 'B', 'business')", [CTX.tenantA, CTX.tenantB]);
      await c.query("CREATE ROLE jarvis_app_probe NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT jarvis_app TO jarvis_app_probe");
      const env: IsolationEnv = { admin: c, asRuntime: savepointRunner(c, "jarvis_app_probe", CTX.space), catalog: await extractCatalog(c), ctx: CTX };
      await seedIsolationRows(env, "mut_leaky");
      return { failures: checked.failures, report: await checkTableIsolation(env, "mut_leaky") };
    });
    expect(has(out.failures, "policy_true", "mut_leaky")).toBe(true);
    expect(has(out.failures, "policy_scope", "mut_leaky")).toBe(true);
    expect(out.report.ok).toBe(false);
    expect(out.report.read).toMatch(/^failed:LEKKASJE/);
    results.push({ id: "N08", lint: true, behavior: true });
  });

  it("N09 drept: ny SECURITY DEFINER-funksjon uten allowlist-direktiv (statisk) og uten allowlist (katalog)", async () => {
    const sql = "CREATE FUNCTION mut_fn() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$;\n";
    const { failures } = await runNew(sql);
    expect(has(failures, "definer_directive_missing"), formatFailures(failures)).toBe(true);
    expect(has(failures, "definer_not_allowlisted"), formatFailures(failures)).toBe(true);
    const compliant = `-- jarvis-definer: mut_fn() reason="Smal katalogfunksjon uten tenant-kontekst, gjennomgått"\n${sql}ALTER FUNCTION mut_fn() OWNER TO jarvis_definer;\nREVOKE ALL ON FUNCTION mut_fn() FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION mut_fn() TO jarvis_app;\n`;
    const annotated = compliant;
    expect(formatFailures((await runNew(annotated)).failures)).toBe("(ingen)");
    results.push({ id: "N09", lint: true, behavior: false });
  });

  it("N10 drept: forsøk på å skjule et brudd ved å legge et unntak for en NY tabell i baseline-manifestet", async () => {
    const sql = "-- jarvis-class: mut_naked ORG_OWNED\nCREATE TABLE mut_naked (id text PRIMARY KEY, tenant_id text NOT NULL);\n";
    const hidden = { ...MANIFEST, exceptions: [...MANIFEST.exceptions, { rule: "rls_not_forced", table: "mut_naked", detail: "disabled,not-forced", reason: "Forsøk på å skjule et brudd for en ny tabell" }], exception_ceiling: { total: MANIFEST.exceptions.length + 1, per_rule: { ...MANIFEST.exception_ceiling.per_rule, rls_not_forced: 1 } } };
    const out = await inTx(adminStrict, async (c) => {
      await c.query(sql);
      return runSchemaClassChecks({ files: [...FILES, file(sql)], manifest: hidden, db: c });
    });
    // Selv et unntak som matcher bruddet NØYAKTIG kan ikke gjelde en ny tabell: manifestet avvises (unntak kun for frosne baseline-tabeller).
    expect(out.failures.filter((f) => f.rule === "manifest_invalid").map((f) => f.detail)).toEqual(["manifest_exception_unknown_table:mut_naked"]);
    results.push({ id: "N10", lint: true, behavior: false });
  });
});
