import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { PostgresOpsTransport, type PgOpsClient } from "../src/postgres-ops-transport.ts";
import { parsePostgresOpsConfig } from "../src/postgres-ops-target-policy.ts";

/**
 * Gjennomgang av PR #324, overlevende mutanter M12/M15 (+ L6 mot ekte Postgres).
 *
 * M12/M15 var EKVIVALENTE mutanter: `terminateBackend`/`cancelQuery` sjekker superbruker-/beskyttet-rolle-/backend_type-nektelsene to ganger - først i en preflight (`ineligibleReason`) og så på nytt i den ÅTOMISKE setningen som
 * sender signalet. Fjernes klausulen i den atomiske setningen, nektet preflighten fortsatt alt, så ingen test ble rød. Her isoleres hver klausul: pre-sjekkens rad MANIPULERES (via en klient-wrapper) til å se egnet ut, slik at KUN
 * den atomiske setningen står mellom signalet og et forbudt mål. Motsatt isoleres preflight-nektelsen `backend_type` ved at den atomiske setningen ikke får noe å si (raden påstår `walsender` for en ekte klientøkt).
 * Målene er ekte økter i embedded Postgres 16 med en minste-privilegium-rolle (`pg_monitor` + `pg_signal_backend`).
 *
 * MERK (ærlig): `a.backend_type = 'client backend'` i den atomiske setningen er funksjonelt REDUNDANT med `JOIN pg_roles ON rolname = a.usename` + `a.datname = $2` (ikke-klientprosesser har hverken `usename` eller `datname`) -
 * en ekte ikke-klientøkt med datname finnes ikke deterministisk, så den klausulen kan ikke isoleres; den er bevisst belte og bukseseler. Preflight-nektelsen er isolert under.
 */
const PW: Record<string, string> = { ops_c: "opsPw-c1", victim_c: "victimPw-c1", jarvis_runtime: "rtPw-c1", jarvis_migrate: "migPw-c1" };
const TS = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let port = 0;
const open: pg.Client[] = [];

const dsn = (user = "ops_c"): string => `postgresql://${user}:${encodeURIComponent(PW[user] ?? "")}@127.0.0.1:${port}/jarvis_test`;
const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("forventet avvisning, men kallet lyktes");
};

async function connectAs(user: string): Promise<pg.Client> {
  const c = new pg.Client(user === "postgres" ? { host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw" } : { host: "127.0.0.1", port, database: "jarvis_test", user, password: PW[user] });
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
async function startSleeper(user: string): Promise<{ client: pg.Client; pid: number; backend_start: string; query_start: string; running: Promise<string> }> {
  const client = await connectAs(user);
  const { pid, backend_start } = await sessionOf(client);
  const running = client.query("SELECT pg_sleep(60)").then(() => "done", (e: Error) => e.message);
  const row = await waitFor(async () => (await admin.query<{ query_start: string }>(
    `SELECT ${TS("query_start")} AS query_start FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query LIKE 'SELECT pg_sleep%'`, [pid])).rows[0], "sleeper active");
  return { client, pid, backend_start, query_start: row.query_start, running };
}

type Row = Record<string, unknown>;
/** En ekte `pg.Client` der resultatet av preflight-oppslaget (`backendSelect`) kan manipuleres. Alle andre spørringer - inkludert den atomiske setningen - går uendret mot ekte Postgres. */
function doctored(connection: string, doctor: (row: Row) => Row): (dsnArg: string) => PgOpsClient {
  return () => {
    const real = new pg.Client({ connectionString: connection, application_name: "jarvis-ops" });
    real.on("error", () => undefined);
    return {
      on: (event: "notice", listener: (notice: { message?: string }) => void) => real.on(event, listener as never),
      connect: () => real.connect(),
      end: () => real.end(),
      query: async <R = Row>(sql: string, params?: unknown[]) => {
        const res = await real.query(sql, params as never);
        const isPreflightLookup = /FROM pg_stat_activity a LEFT JOIN pg_roles r ON r\.rolname = a\.usename/.test(sql);
        return { rows: (isPreflightLookup ? res.rows.map((r) => doctor({ ...r })) : res.rows) as R[], rowCount: res.rowCount };
      }
    };
  };
}

const transportWith = (config: ReturnType<typeof parsePostgresOpsConfig>, createClient?: (d: string) => PgOpsClient): PostgresOpsTransport =>
  new PostgresOpsTransport({ config, ...(createClient ? { createClient } : {}) });

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-pgclauses-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  for (const [role, pw] of Object.entries(PW)) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query("GRANT pg_monitor, pg_signal_backend TO ops_c");
}, 240_000);

afterAll(async () => {
  for (const c of open) await c.end().catch(() => undefined);
  await admin?.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN ('victim_c','ops_c','jarvis_runtime','jarvis_migrate')").catch(() => undefined);
  await admin?.end();
  await stop?.();
}, 120_000);

describe("L6 mot ekte Postgres: jarvis_runtime og jarvis_migrate kan ikke termineres med standardkonfigurasjonen", () => {
  it("terminate_backend nektes med postgres_backend_role_protected for begge, og øktene lever; eligible_for_mutation er false", async () => {
    const config = parsePostgresOpsConfig({ databases: "jarvis_test" }); // ingen protectedRoles oppgitt = standardlisten
    for (const role of ["jarvis_runtime", "jarvis_migrate"]) {
      const victim = await connectAs(role);
      const s = await sessionOf(victim);
      const err = await rejection(transportWith(config).invoke("terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, dsn()));
      expect(err.message, role).toBe("postgres_backend_role_protected");
      expect((await victim.query("SELECT 1 AS ok")).rows[0], role).toEqual({ ok: 1 });
      const seen = (await transportWith(config).invoke("get_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, dsn())).data as { eligible_for_mutation: boolean; role: string };
      expect(seen, role).toMatchObject({ role, eligible_for_mutation: false });
    }
  });

  it("en vanlig rolle kan fortsatt termineres, og en eksplisitt liste ERSTATTER standarden (jarvis_runtime er da ikke lenger beskyttet)", async () => {
    const victim = await connectAs("victim_c");
    const s = await sessionOf(victim);
    const res = await transportWith(parsePostgresOpsConfig({ databases: "jarvis_test" })).invoke("terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, dsn());
    expect(res.data).toMatchObject({ signalled: true });
    const runtime = await connectAs("jarvis_runtime");
    const r = await sessionOf(runtime);
    const replaced = parsePostgresOpsConfig({ databases: "jarvis_test", protectedRoles: "annen_rolle" });
    expect(replaced.protectedRoles.has("jarvis_runtime")).toBe(false);
    const res2 = await transportWith(replaced).invoke("terminate_backend", { pid: r.pid, database: "jarvis_test", backend_start: r.backend_start }, dsn());
    expect(res2.data).toMatchObject({ signalled: true });
  });
});

describe("M12 isolert: den ATOMISKE setningen nekter superbruker-/beskyttet-rolle-økter også når preflight-raden påstår at målet er egnet", () => {
  const config = parsePostgresOpsConfig({ databases: "jarvis_test", protectedRoles: "victim_c" });
  /** Preflight-raden påstår: vanlig, ubeskyttet klientøkt (rolle `looks_fine`). */
  const looksEligible = (row: Row): Row => ({ ...row, is_superuser: false, usename: "looks_fine", backend_type: "client backend" });

  it("terminate: SUPERBRUKER-økt -> postgres_backend_changed (atomisk nektelse), og økten lever videre", async () => {
    const su = await connectAs("postgres");
    const s = await sessionOf(su);
    const err = await rejection(transportWith(config, doctored(dsn(), looksEligible)).invoke("terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, dsn()));
    expect(err.message).toBe("postgres_backend_changed");
    expect((await su.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
  });

  it("terminate: BESKYTTET rolle -> postgres_backend_changed (atomisk nektelse), og økten lever videre", async () => {
    const victim = await connectAs("victim_c");
    const s = await sessionOf(victim);
    const err = await rejection(transportWith(config, doctored(dsn(), looksEligible)).invoke("terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, dsn()));
    expect(err.message).toBe("postgres_backend_changed");
    expect((await victim.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
  });

  it("cancel: pågående spørring i en SUPERBRUKER-økt avbrytes ikke (postgres_query_changed)", async () => {
    const su = await connectAs("postgres");
    const { pid, backend_start } = await sessionOf(su);
    const running = su.query("SELECT pg_sleep(60)").then(() => "done", (e: Error) => e.message);
    const query_start = (await waitFor(async () => (await admin.query<{ q: string }>(`SELECT ${TS("query_start")} AS q FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query LIKE 'SELECT pg_sleep%'`, [pid])).rows[0], "su active")).q;
    const err = await rejection(transportWith(config, doctored(dsn(), looksEligible)).invoke("cancel_query", { pid, database: "jarvis_test", backend_start, query_start }, dsn()));
    expect(err.message).toBe("postgres_query_changed");
    expect((await admin.query("SELECT state FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]).toEqual({ state: "active" });
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await running;
  });

  it("cancel: pågående spørring i en BESKYTTET rolle avbrytes ikke (postgres_query_changed)", async () => {
    const s = await startSleeper("victim_c");
    const err = await rejection(transportWith(config, doctored(dsn(), looksEligible)).invoke("cancel_query", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start, query_start: s.query_start }, dsn()));
    expect(err.message).toBe("postgres_query_changed");
    expect((await admin.query("SELECT state FROM pg_stat_activity WHERE pid = $1", [s.pid])).rows[0]).toEqual({ state: "active" });
    await admin.query("SELECT pg_terminate_backend($1)", [s.pid]);
    await s.running;
  });

  it("kontroll: uten manipulasjon nekter PREFLIGHT det samme med presise koder (superbruker/beskyttet)", async () => {
    const su = await connectAs("postgres");
    const ssu = await sessionOf(su);
    expect((await rejection(transportWith(config).invoke("terminate_backend", { pid: ssu.pid, database: "jarvis_test", backend_start: ssu.backend_start }, dsn()))).message).toBe("postgres_backend_superuser_protected");
    const victim = await connectAs("victim_c");
    const sv = await sessionOf(victim);
    expect((await rejection(transportWith(config).invoke("terminate_backend", { pid: sv.pid, database: "jarvis_test", backend_start: sv.backend_start }, dsn()))).message).toBe("postgres_backend_role_protected");
  });
});

describe("M15 isolert: preflight-nektelsen `backend_type` (atomisk setning har ikke siste ord her)", () => {
  it("en rad som påstår at økten ikke er en klientøkt (walsender) -> postgres_backend_not_client, og den ekte klientøkten lever videre", async () => {
    const victim = await connectAs("victim_c");
    const s = await sessionOf(victim);
    const claimsWalsender = (row: Row): Row => ({ ...row, backend_type: "walsender" });
    const config = parsePostgresOpsConfig({ databases: "jarvis_test", protectedRoles: "annen_rolle" });
    const err = await rejection(transportWith(config, doctored(dsn(), claimsWalsender)).invoke("terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, dsn()));
    expect(err.message).toBe("postgres_backend_not_client");
    expect((await victim.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
    const cancelErr = await rejection(transportWith(config, doctored(dsn(), claimsWalsender)).invoke("cancel_query", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start, query_start: s.backend_start }, dsn()));
    expect(cancelErr.message).toBe("postgres_backend_not_client");
  });
});
