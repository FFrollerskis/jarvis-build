import { readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { PostgresOpsTransport, type PgOpsClient } from "../src/postgres-ops-transport.ts";
import { parsePostgresOpsConfig } from "../src/postgres-ops-target-policy.ts";

/**
 * WP-E1: `PostgresOpsTransport` mot EKTE Postgres 16 (embedded) som en MINSTE-PRIVILEGIUM-rolle (`pg_monitor` + `pg_signal_backend`, ikke superbruker).
 * Bevist: diagnostikk uten data i utdata, at terminate/cancel bare rammer akkurat den identifiserte økten (pid + backend_start + query_start + database),
 * at superbruker-/ikke-klient-/beskyttede/uautoriserte økter aldri røres, at VACUUM kun rører navngitte tabeller i autorisert skjema (identifikator-injeksjon avvises),
 * at hopp-over av VACUUM pga. manglende eierskap rapporteres som feil, og at passord aldri lekker i feil.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../core/src/db/migrations/", import.meta.url));
const PW: Record<string, string> = { ops_t: "opsPw-1234", victim_t: "victimPw-1", victim2_t: "victimPw-2", limited_t: "limitedPw-1" };
const TS = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let port = 0;
const open: pg.Client[] = [];

const dsn = (user = "ops_t", db = "jarvis_test", password = PW[user], p = port): string => `postgresql://${user}:${encodeURIComponent(password ?? "")}@127.0.0.1:${p}/${db}`;
const transport = (config = parsePostgresOpsConfig({ databases: "jarvis_test", protectedRoles: "victim2_t" })): PostgresOpsTransport => new PostgresOpsTransport({ config });
const call = async <T = Record<string, unknown>>(t: PostgresOpsTransport, action: string, params: Record<string, JsonValue> = {}, credential = dsn()): Promise<T> =>
  ((await t.invoke(action, params, credential)).data ?? null) as unknown as T;
const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("forventet avvisning, men kallet lyktes");
};

async function connectAs(user: string, db = "jarvis_test"): Promise<pg.Client> {
  const c = new pg.Client({ host: "127.0.0.1", port, database: db, user, password: PW[user] ?? "pw" });
  c.on("error", () => undefined);
  await c.connect();
  open.push(c);
  return c;
}

async function sessionOf(client: pg.Client): Promise<{ pid: number; backend_start: string }> {
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const row = (await admin.query<{ backend_start: string }>(`SELECT ${TS("backend_start")} AS backend_start FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0]!;
  return { pid, backend_start: row.backend_start };
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Åpner en økt som kjører `pg_sleep(60)` og venter til serveren ser den som aktiv. */
async function startSleeper(user = "victim_t", db = "jarvis_test", tag = "sleeper"): Promise<{ client: pg.Client; pid: number; backend_start: string; query_start: string; running: Promise<string> }> {
  const client = await connectAs(user, db);
  const { pid, backend_start } = await sessionOf(client);
  const running = client.query(`SELECT pg_sleep(60), '${tag}-hemmelig-12345' AS marker`).then(() => "done", (e: Error) => e.message);
  const row = await waitFor(async () => (await admin.query<{ query_start: string }>(
    `SELECT ${TS("query_start")} AS query_start FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query LIKE 'SELECT pg_sleep%'`, [pid])).rows[0], "sleeper active");
  return { client, pid, backend_start, query_start: row.query_start, running };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-pgops-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_test");
  await leased.postgres.createDatabase("other_db");
  admin = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  for (const [role, pw] of Object.entries(PW)) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query("GRANT pg_monitor, pg_signal_backend TO ops_t");
  await admin.query("GRANT SELECT ON schema_migrations TO ops_t");
  await admin.query(`
    CREATE TABLE public.ops_owned (id int, payload text);
    ALTER TABLE public.ops_owned OWNER TO ops_t;
    CREATE TABLE public.not_owned (id int);
    CREATE TABLE public.lock_demo (id int);
    GRANT ALL ON public.lock_demo TO victim_t, victim2_t;
    CREATE TABLE public.bloat_demo (id int, pad text) WITH (autovacuum_enabled = false);
    GRANT ALL ON public.bloat_demo TO victim_t;
    GRANT CONNECT ON DATABASE other_db TO victim_t;
  `);
}, 240_000);

afterAll(async () => {
  for (const c of open) await c.end().catch(() => undefined);
  await admin?.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN ('victim_t','victim2_t','ops_t','limited_t')").catch(() => undefined);
  await admin?.end();
  await stop?.();
}, 120_000);

describe("A: diagnostikk (klasse A) - ingen data i utdata", () => {
  it("get_connections: tilstand/database/rolle/applikasjon mot max_connections, full synlighet for pg_monitor-rollen", async () => {
    await connectAs("victim_t");
    const r = await call<{ visibility: string; connected_as: string; max_connections: number; client_backends: number; utilization_pct: number; by_role: Array<{ name: string; count: number }>; by_application: Array<{ name: string }> }>(transport(), "get_connections");
    expect(r).toMatchObject({ visibility: "full", connected_as: "ops_t" });
    expect(r.max_connections).toBeGreaterThan(0);
    expect(r.client_backends).toBeGreaterThanOrEqual(2);
    expect(r.utilization_pct).toBeGreaterThan(0);
    expect(r.by_role.some((x) => x.name === "victim_t")).toBe(true);
    expect(r.by_application.some((x) => x.name === "jarvis-ops")).toBe(true);
    expect(JSON.stringify(r)).not.toContain(PW["ops_t"]!);
  });

  it("get_long_running_queries: normalisert tekst (ingen literaler), klokke-/identitetsfelt for terminate/cancel, og eligible_for_mutation", async () => {
    const s = await startSleeper();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const r = await call<{ count: number; backends: Array<Record<string, unknown>> }>(transport(), "get_long_running_queries", { min_seconds: 1 });
    const mine = r.backends.find((b) => b["pid"] === s.pid)!;
    expect(mine).toMatchObject({ role: "victim_t", database: "jarvis_test", state: "active", backend_start: s.backend_start, query_start: s.query_start, eligible_for_mutation: true, is_superuser: false });
    expect(mine["query"]).toBe("SELECT pg_sleep(?), ? AS marker");
    expect(JSON.stringify(r)).not.toContain("hemmelig-12345");
    expect(mine["duration_s"] as number).toBeGreaterThanOrEqual(1);
    await admin.query("SELECT pg_terminate_backend($1)", [s.pid]);
    await s.running;
  });

  it("økter i databaser eieren ikke har autorisert får INGEN spørringstekst og er ikke egnet for mutasjon", async () => {
    const s = await startSleeper("victim_t", "other_db", "annen-db");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const r = await call<{ backends: Array<Record<string, unknown>> }>(transport(), "get_long_running_queries", { min_seconds: 1 });
    const mine = r.backends.find((b) => b["pid"] === s.pid)!;
    expect(mine).toMatchObject({ database: "other_db", query: null, eligible_for_mutation: false });
    expect(JSON.stringify(r)).not.toContain("annen-db-hemmelig");
    await admin.query("SELECT pg_terminate_backend($1)", [s.pid]);
    await s.running;
  });

  it("get_locks: hvem blokkerer hvem, med normalisert tekst", async () => {
    const holder = await connectAs("victim_t");
    const waiter = await connectAs("victim2_t");
    const holderS = await sessionOf(holder);
    const waiterS = await sessionOf(waiter);
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE public.lock_demo IN ACCESS EXCLUSIVE MODE");
    const blocked = waiter.query("SELECT * FROM public.lock_demo WHERE id = 42").catch(() => undefined);
    const r = await waitFor(async () => {
      const x = await call<{ blocked: Array<Record<string, unknown>> }>(transport(), "get_locks");
      return x.blocked.find((b) => b["blocked_pid"] === waiterS.pid) ? x : undefined;
    }, "låsepar");
    const pair = r.blocked.find((b) => b["blocked_pid"] === waiterS.pid)!;
    expect(pair).toMatchObject({ blocking_pid: holderS.pid, blocked_role: "victim2_t", blocking_role: "victim_t" });
    expect(pair["blocked_query"]).toBe("SELECT * FROM public.lock_demo WHERE id = ?");
    await holder.query("ROLLBACK");
    await blocked;
  });

  it("get_table_sizes og get_bloat_estimate: størrelser sortert, bloat som estimat (døde/levende) - ikke eksakt", async () => {
    const w = await connectAs("victim_t");
    await w.query("INSERT INTO public.bloat_demo SELECT g, repeat('x', 200) FROM generate_series(1, 5000) g");
    await w.query("DELETE FROM public.bloat_demo WHERE id <= 4000");
    await w.end(); // statistikk flushes når økten avsluttes
    const sizes = await call<{ tables: Array<Record<string, unknown>> }>(transport(), "get_table_sizes", { limit: 50 });
    const bytes = sizes.tables.map((t) => t["total_bytes"] as number);
    expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
    const demo = await waitFor(async () => {
      const b = await call<{ estimate: boolean; method: string; tables: Array<Record<string, unknown>> }>(transport(), "get_bloat_estimate", { min_dead_tuples: 100, limit: 50 });
      const row = b.tables.find((t) => t["table"] === "bloat_demo");
      return row ? { b, row } : undefined;
    }, "bloat-statistikk");
    expect(demo.b.estimate).toBe(true);
    expect(demo.b.method).toMatch(/estimat/i);
    expect(demo.row["n_dead_tup"] as number).toBeGreaterThanOrEqual(3000);
    expect(demo.row["dead_ratio"] as number).toBeGreaterThan(0.5);
    await expect(call(transport(), "get_table_sizes", { limit: 51 })).rejects.toThrow("postgres_ops_invalid_limit");
  });

  it("get_replication_status: enkelt-node er et gyldig svar (primær, ingen replikaer)", async () => {
    const r = await call<{ role: string; replicas: number; slots: unknown[]; note: string | null }>(transport(), "get_replication_status");
    expect(r).toMatchObject({ role: "primary", replicas: 0 });
    expect(r.note).toMatch(/enkelt-node/);
  });

  it("get_migration_state: i synk etter runMigrations; en ukjent rad i databasen slår ut in_sync (eldre kode mot nyere skjema)", async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const ok = await call<{ initialized: boolean; in_sync: boolean; applied: number; pending_count: number; latest: { name: string } }>(transport(), "get_migration_state");
    expect(ok).toMatchObject({ initialized: true, in_sync: true, applied: files.length, pending_count: 0 });
    expect(files).toContain(ok.latest.name);
    await admin.query("INSERT INTO schema_migrations (name, checksum) VALUES ('999_ukjent_fremtid.sql', 'x')");
    try {
      const drift = await call<{ in_sync: boolean; unknown_applied: string[] }>(transport(), "get_migration_state");
      expect(drift.in_sync).toBe(false);
      expect(drift.unknown_applied).toContain("999_ukjent_fremtid.sql");
    } finally {
      await admin.query("DELETE FROM schema_migrations WHERE name = '999_ukjent_fremtid.sql'");
    }
  });

  it("uten pg_monitor ser rollen bare egne økter, og synligheten meldes som «limited» (aldri en falsk full oversikt)", async () => {
    const r = await call<{ visibility: string }>(transport(), "get_connections", {}, dsn("limited_t"));
    expect(r.visibility).toBe("limited");
  });
});

describe("B: terminate_backend - akkurat den identifiserte økten, aldri en annen", () => {
  it("terminerer økten (pid + backend_start + database), og get_backend viser den som borte", async () => {
    const victim = await connectAs("victim_t");
    const s = await sessionOf(victim);
    const params = { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start };
    const before = await call<Record<string, unknown>>(transport(), "get_backend", params);
    expect(before).toMatchObject({ pid: s.pid, role: "victim_t", backend_type: "client backend", eligible_for_mutation: true });
    const res = await transport().invoke("terminate_backend", params, dsn());
    expect(res).toMatchObject({ external_id: `pid:${s.pid}`, data: { signalled: true } });
    await expect(victim.query("SELECT 1")).rejects.toThrow(/terminat|Connection terminated|connection error|not queryable/i);
    await waitFor(async () => (await call(transport(), "get_backend", params)) === null, "økt borte");
  });

  it("feil backend_start (pid-gjenbruk) -> ingenting skjer, økten lever", async () => {
    const victim = await connectAs("victim_t");
    const s = await sessionOf(victim);
    const err = await rejection(transport().invoke("terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: "2020-01-01T00:00:00.000000Z" }, dsn()));
    expect(err.message).toBe("postgres_backend_not_found");
    expect((await victim.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
  });

  it("SUPERBRUKER-økter nektes (og den kjører videre)", async () => {
    const su = new pg.Client({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw" });
    su.on("error", () => undefined);
    await su.connect();
    open.push(su);
    const s = await sessionOf(su);
    const err = await rejection(transport().invoke("terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, dsn()));
    expect(err.message).toBe("postgres_backend_superuser_protected");
    expect((await su.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
  });

  it("database utenfor eierens liste nektes (tredjeparts-eide databaser er ikke «tenant-eide mål»)", async () => {
    const victim = await connectAs("victim_t", "other_db");
    const s = await sessionOf(victim);
    const err = await rejection(transport().invoke("terminate_backend", { pid: s.pid, database: "other_db", backend_start: s.backend_start }, dsn()));
    expect(err.message).toBe("postgres_database_not_authorized");
    expect((await victim.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
  });

  it("beskyttet rolle (JARVIS_POSTGRES_OPS_PROTECTED_ROLES) nektes", async () => {
    const victim = await connectAs("victim2_t");
    const s = await sessionOf(victim);
    const err = await rejection(transport().invoke("terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, dsn()));
    expect(err.message).toBe("postgres_backend_role_protected");
    expect((await victim.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
  });

  it("ikke-klient-prosesser (checkpointer, autovacuum …) kan aldri termineres", async () => {
    const bg = (await admin.query<{ pid: number; backend_start: string }>(`SELECT pid, ${TS("backend_start")} AS backend_start FROM pg_stat_activity WHERE backend_type = 'checkpointer'`)).rows[0]!;
    const err = await rejection(transport().invoke("terminate_backend", { pid: bg.pid, database: "jarvis_test", backend_start: bg.backend_start }, dsn()));
    expect(err.message).toBe("postgres_backend_not_found");
    const alive = await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_type = 'checkpointer'", [bg.pid]);
    expect(alive.rowCount).toBe(1);
  });

  it("ugyldig inndata avvises før noe leses (pid, tidsstempel, database)", async () => {
    for (const bad of [{ pid: "1" }, { pid: 0 }, { backend_start: "i går" }, { database: "a;b" }]) {
      const p = { pid: 1, database: "jarvis_test", backend_start: "2026-10-09T12:00:00.000000Z", ...bad } as Record<string, JsonValue>;
      await expect(transport().invoke("terminate_backend", p, dsn()), JSON.stringify(bad)).rejects.toThrow(/postgres_ops_invalid_/);
    }
  });
});

describe("C: cancel_query - bare spørringen som ble inspisert", () => {
  it("avbryter den pågående spørringen; økten lever videre", async () => {
    const s = await startSleeper();
    const params = { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start, query_start: s.query_start };
    const res = await transport().invoke("cancel_query", params, dsn());
    expect(res.data).toMatchObject({ signalled: true });
    expect(await s.running).toMatch(/canceling statement due to user request/);
    expect((await s.client.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
    const state = await call<{ present: boolean; state: string }>(transport(), "get_query_state", params);
    expect(state.present).toBe(true);
    expect(state.state).not.toBe("active");
  });

  it("en spørring som ikke lenger er den inspiserte (query_start avviker) røres ikke", async () => {
    const s = await startSleeper();
    const err = await rejection(transport().invoke("cancel_query", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start, query_start: "2020-01-01T00:00:00.000000Z" }, dsn()));
    expect(err.message).toBe("postgres_query_changed");
    const still = await admin.query("SELECT state FROM pg_stat_activity WHERE pid = $1", [s.pid]);
    expect((still.rows[0] as { state: string }).state).toBe("active");
    await admin.query("SELECT pg_terminate_backend($1)", [s.pid]);
    await s.running;
  });

  it("en økt som ikke er aktiv kan ikke «avbrytes», og beskyttede økter nektes", async () => {
    const idle = await connectAs("victim_t");
    const s = await sessionOf(idle);
    const err = await rejection(transport().invoke("cancel_query", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start, query_start: s.backend_start }, dsn()));
    expect(err.message).toBe("postgres_backend_not_active");
    const prot = await startSleeper("victim2_t");
    const err2 = await rejection(transport().invoke("cancel_query", { pid: prot.pid, database: "jarvis_test", backend_start: prot.backend_start, query_start: prot.query_start }, dsn()));
    expect(err2.message).toBe("postgres_backend_role_protected");
    await admin.query("SELECT pg_terminate_backend($1)", [prot.pid]);
    await prot.running;
  });

  it("get_query_state er alltid et objekt (present:false når økten er borte)", async () => {
    const victim = await connectAs("victim_t");
    const s = await sessionOf(victim);
    await admin.query("SELECT pg_terminate_backend($1)", [s.pid]);
    await waitFor(async () => (await call<{ present: boolean }>(transport(), "get_query_state", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start })).present === false, "present:false");
  });
});

describe("D: vacuum_analyze - kun navngitte tabeller i autorisert skjema", () => {
  const v = (extra: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ database: "jarvis_test", schema: "public", table: "ops_owned", ...extra });

  it("VACUUM (ANALYZE) på en tabell rollen eier: statistikken viser at den nettopp er vacuumet/analysert", async () => {
    const w = await connectAs("postgres");
    await w.query("INSERT INTO public.ops_owned SELECT g, 'x' FROM generate_series(1, 200) g");
    await w.query("DELETE FROM public.ops_owned WHERE id <= 150");
    const before = await call<Record<string, unknown>>(transport(), "get_table_stats", v());
    expect(before["table"]).toBe("ops_owned");
    const res = await transport().invoke("vacuum_analyze", v(), dsn());
    expect(res).toMatchObject({ external_id: "vacuum:public.ops_owned", data: { done: true, analyze_only: false } });
    const after = await call<{ seconds_since_vacuum: number; seconds_since_analyze: number; last_vacuum: string }>(transport(), "get_table_stats", v());
    expect(after.seconds_since_vacuum).toBeLessThan(60);
    expect(after.seconds_since_analyze).toBeLessThan(60);
    expect(after.last_vacuum).toMatch(/Z$/);
  });

  it("analyze_only kjører bare ANALYZE", async () => {
    const res = await transport().invoke("vacuum_analyze", v({ analyze_only: true }), dsn());
    expect(res).toMatchObject({ external_id: "analyze:public.ops_owned", data: { analyze_only: true } });
  });

  it("en tabell rollen IKKE eier hoppes over av Postgres med bare en advarsel - rapporteres som feil, aldri som utført", async () => {
    const err = await rejection(transport().invoke("vacuum_analyze", v({ table: "not_owned" }), dsn()));
    expect(err.message).toBe("postgres_vacuum_skipped_insufficient_privilege");
  });

  it("ukjent tabell, ukjent skjema og feil database nektes presist", async () => {
    expect((await rejection(transport().invoke("vacuum_analyze", v({ table: "finnes_ikke" }), dsn()))).message).toBe("postgres_table_not_found");
    expect((await rejection(transport().invoke("vacuum_analyze", v({ schema: "pg_catalog", table: "pg_class" }), dsn()))).message).toBe("postgres_schema_not_authorized");
    const wide = parsePostgresOpsConfig({ databases: "jarvis_test,other_db" });
    expect((await rejection(transport(wide).invoke("vacuum_analyze", v({ database: "other_db" }), dsn()))).message).toBe("postgres_ops_database_mismatch");
    expect((await rejection(transport().invoke("vacuum_analyze", v({ database: "other_db" }), dsn()))).message).toBe("postgres_database_not_authorized");
  });

  it("IDENTIFIKATOR-INJEKSJON avvises før noe kjøres - ingenting droppes", async () => {
    for (const evil of ['ops_owned"; DROP TABLE public.ops_owned; --', "ops_owned; DROP TABLE public.not_owned", 'a" b', "ops_owned\nVACUUM FULL"]) {
      await expect(transport().invoke("vacuum_analyze", v({ table: evil }), dsn()), evil).rejects.toThrow(/postgres_ops_invalid_table/);
    }
    const tables = (await admin.query("SELECT relname FROM pg_class WHERE relname IN ('ops_owned','not_owned') ORDER BY 1")).rows.map((r) => (r as { relname: string }).relname);
    expect(tables).toEqual(["not_owned", "ops_owned"]);
  });
});

describe("E: feilhåndtering og hemmelighetshygiene", () => {
  it("feil passord -> postgres_ops_auth_failed, og passordet står ikke i feilen", async () => {
    const bad = dsn("ops_t", "jarvis_test", "feil-passord-xyz");
    const err = await rejection(transport().invoke("get_connections", {}, bad));
    expect(err.message).toBe("postgres_ops_auth_failed");
    expect(err.message).not.toContain("feil-passord-xyz");
  });

  it("ingen lytter på porten -> postgres_ops_unreachable (ikke en hengende tilkobling)", async () => {
    const err = await rejection(transport().invoke("get_connections", {}, dsn("ops_t", "jarvis_test", PW["ops_t"], 1)));
    expect(err.message).toMatch(/^postgres_ops_unreachable:/);
  });

  it("en klientfeil som inneholder tilkoblingsstrengen/passordet vaskes før den forlater transporten", async () => {
    const secretDsn = dsn("ops_t", "jarvis_test", "SuperSecretPw-9");
    const leaky: PgOpsClient = {
      connect: async () => { throw Object.assign(new Error(`getaddrinfo failed for ${secretDsn} (pw=SuperSecretPw-9)`), { code: "XX000" }); },
      query: async () => ({ rows: [], rowCount: 0 }), end: async () => undefined
    };
    const t = new PostgresOpsTransport({ config: parsePostgresOpsConfig(), createClient: () => leaky });
    const err = await rejection(t.invoke("get_connections", {}, secretDsn));
    expect(err.message).not.toContain("SuperSecretPw-9");
    expect(err.message).toContain("[REDACTED]");
  });

  it("ugyldig tilkoblingsstreng og ukjent handling avvises uten å røre noe", async () => {
    await expect(transport().invoke("get_connections", {}, "mysql://u:p@h/db")).rejects.toThrow("postgres_ops_dsn_invalid");
    await expect(transport().invoke("get_connections", {}, "postgresql://u:p@h/db?options=-c%20search_path%3Devil")).rejects.toThrow("postgres_ops_dsn_unsupported_parameter");
    await expect(transport().invoke("drop_database", {}, dsn())).rejects.toThrow("postgres_ops_unsupported_action_drop_database");
    await expect(transport().invoke("get_long_running_queries", { min_seconds: 0 }, dsn())).rejects.toThrow("postgres_ops_invalid_min_seconds");
    await expect(transport().invoke("get_long_running_queries", { limit: 500 }, dsn())).rejects.toThrow("postgres_ops_invalid_limit");
  });
});
