import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch } from "@jarvis/policy";
import * as watchdogModule from "../src/index.ts";
import { MemoryAlertSink, STUCK_TASKS_MAX_TENANTS, STUCK_TASKS_READ_BUDGET_MS, Watchdog, stuckTasksAllTenantsCheck } from "../src/index.ts";

/**
 * WP-OPS2a fiks-runde 1 (review A-L3, A-L4, A-L5 og testhullene K09/K20/K23) for `stuckTasksAllTenantsCheck`. Alt mot ekte Postgres som en runtime-rolle UTEN BYPASSRLS (som `wpops2a-stuck-tasks-all-tenants.test.ts`).
 *  - A-L3: når ALLE tenants er uleselige (en RLS-/rettighetsfeil på `tasks`, en hengt lås) er vakthunden blind - det er `critical` (som den gamle sjekken, som kastet), ikke en `warning` som drukner. Delvis blindhet er fortsatt `warning`.
 *  - A-L4: en tenant-spørring som henger (ACCESS EXCLUSIVE på `tasks`) avbrytes av `SET LOCAL statement_timeout` og holder aldri en tilkobling for alltid.
 *  - A-L5: eierens tenant vurderes ALLTID (også når katalogen er lengre enn grensen og eieren sorterer sist).
 */
const A = "tenant-a"; // eierens tenant
const B = "tenant-b";
const C = "tenant-c";
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ops2a-fix1-st-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_ops2a_fix1 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_test_ops2a_fix1");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','Eier','person'), ('${B}','Bedrift B','business'), ('${C}','Bedrift C','business');
    INSERT INTO people (person_id, display_name) VALUES ('p-a','A'), ('p-b','B'), ('p-c','C');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-a','${A}'), ('p-b','${B}'), ('p-c','${C}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_ops2a_fix1", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

let seq = 0;
async function addTask(tenant: string, lease: "expired" | "valid", status = "running"): Promise<void> {
  seq += 1;
  const person = { [A]: "p-a", [B]: "p-b", [C]: "p-c" }[tenant]!;
  const leaseSql = lease === "expired" ? "now() - interval '1 minute'" : "now() + interval '10 minutes'";
  await admin.query(
    `INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, contract, status, worker_id, lease_expires_at) VALUES ($1, $2, $3, 'g', '{}'::jsonb, $4, 'w1', ${leaseSql})`,
    [`t-ops2a-fix1-${seq}`, tenant, person, status]
  );
}

interface ProxyOptions { catalog?: (limit: number) => string[]; catalogError?: Error; failTenants?: ReadonlySet<string> | "all"; reads?: string[]; sqls?: string[] }
function proxyPool(real: pg.Pool, opts: ProxyOptions = {}): pg.Pool {
  return {
    query: (sql: unknown, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("jarvis_list_all_tenant_ids")) {
        if (opts.catalogError) return Promise.reject(opts.catalogError);
        if (opts.catalog) return Promise.resolve({ rows: opts.catalog(Number(params?.[0])).map((tenant_id) => ({ tenant_id })) });
      }
      return (real.query as (...a: unknown[]) => Promise<unknown>)(sql, params);
    },
    connect: async () => {
      const client = await real.connect();
      let current = "";
      return new Proxy(client, {
        get(target, prop) {
          if (prop === "query") {
            return async (sql: unknown, params?: unknown[]) => {
              if (typeof sql === "string") opts.sqls?.push(sql);
              if (typeof sql === "string" && sql.includes("set_config('jarvis.tenant_id'")) current = String(params?.[0]);
              if (typeof sql === "string" && sql.includes("FROM tasks")) {
                opts.reads?.push(current);
                if (opts.failTenants === "all" || opts.failTenants?.has(current)) throw Object.assign(new Error(`permission denied for table tasks (tenant ${current})`), { code: "42501" });
              }
              return (target.query as (...a: unknown[]) => Promise<unknown>).call(target, sql, params);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  } as unknown as pg.Pool;
}

const logged: string[] = [];
beforeEach(async () => {
  await admin.query("DELETE FROM tasks");
  logged.length = 0;
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

describe("A-L3: alle tenants uleselige = critical (blindhet), delvis = warning (som før)", () => {
  it("én tenant som ikke kan leses (hele katalogen): critical - samme alvorlighet som den gamle sjekken, som kastet; meldingen har kun antall", async () => {
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A], failTenants: new Set([A]) })).run();
    expect(result).toEqual({ ok: false, severity: "critical", message: "1 av 1 tenants kunne ikke leses" });
    expect(JSON.stringify(result)).not.toContain(A);
    expect(JSON.stringify(result)).not.toContain("permission denied");
    expect(logged.some((l) => l.includes("watchdog_stuck_tasks_tenant_read_failed") && l.includes("42501"))).toBe(true);
  });

  it("alle tre tenants uleselige: critical «3 av 3»; to av tre uleselige: fortsatt warning «2 av 3»; ingen uleselige men fastlåst jobb: warning som før", async () => {
    expect(await stuckTasksAllTenantsCheck(proxyPool(app, { failTenants: "all" })).run()).toEqual({ ok: false, severity: "critical", message: "3 av 3 tenants kunne ikke leses" });
    expect(await stuckTasksAllTenantsCheck(proxyPool(app, { failTenants: new Set([B, C]) })).run()).toEqual({ ok: false, severity: "warning", message: "2 av 3 tenants kunne ikke leses" });
    await addTask(B, "expired");
    expect(await stuckTasksAllTenantsCheck(app).run()).toEqual({ ok: false, severity: "warning", message: "1 jobber med utløpt lease (i 1 tenant)" });
  });

  it("alle uleste fordi tidsbudsjettet gikk ut før første tenant: critical (ingenting ble vurdert); det samme gjelder avkortet katalog der alle 200 er uleselige", async () => {
    let clock = -1;
    const budgetAll = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A, B, C] }), { budgetMs: 100, now: () => { clock += 1000; return clock; } }).run();
    expect(budgetAll).toEqual({ ok: false, severity: "critical", message: "3 av 3 tenants kunne ikke leses" });
    const many = Array.from({ length: STUCK_TASKS_MAX_TENANTS + 1 }, (_, i) => `tenant-fake-${String(i).padStart(3, "0")}`);
    const truncatedAllUnread = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: (limit) => many.slice(0, limit), failTenants: "all" })).run();
    expect(truncatedAllUnread).toEqual({ ok: false, severity: "critical", message: "200 av 200 tenants kunne ikke leses; flere enn 200 tenants (de øvrige er ikke vurdert)" });
  });

  it("tom katalog og feilet opptelling er fortsatt `warning` (ingenting er forsøkt lest; ikke «alle uleselige»)", async () => {
    expect(await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [] })).run()).toMatchObject({ ok: false, severity: "warning" });
    expect(await stuckTasksAllTenantsCheck(proxyPool(app, { catalogError: new Error("boom") })).run()).toMatchObject({ ok: false, severity: "warning" });
  });

  it("i Watchdog gir én tenant som ikke kan leses et `critical`-varsel (samme nivå som den gamle sjekkens «sjekk feilet»)", async () => {
    const sink = new MemoryAlertSink();
    const wd = new Watchdog(sink, new KillSwitch());
    wd.register(stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A], failTenants: new Set([A]) })));
    await wd.tick();
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({ check: "stuck_tasks", severity: "critical", message: "1 av 1 tenants kunne ikke leses" });
  });
});

describe("A-L4: en hengende tenant-spørring avbrytes av statement_timeout og holder ikke en tilkobling for alltid", () => {
  it("standardgrensen er 8 s og settes med SET LOCAL FØR tellingen i samme tenant-transaksjon (ikke på tilkoblingen)", async () => {
    expect((watchdogModule as Record<string, unknown>)["STUCK_TASKS_STATEMENT_TIMEOUT_MS"]).toBe(8_000);
    const sqls: string[] = [];
    await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A], sqls })).run();
    const set = sqls.findIndex((s) => /^SET LOCAL statement_timeout = 8000$/.test(s));
    const count = sqls.findIndex((s) => s.includes("FROM tasks"));
    const begin = sqls.indexOf("BEGIN");
    expect(set).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(set);
    expect(set).toBeLessThan(count);
    expect(sqls.some((s) => /^SET statement_timeout/.test(s))).toBe(false); // aldri en SET som overlever transaksjonen
  });

  it("ACCESS EXCLUSIVE-lås på tasks: spørringen avbrytes av Postgres (57014) etter grensen, tenanten telles som ikke lest (critical), tilkoblingen frigis og grensen lekker ikke ut av transaksjonen", async () => {
    const locker = await admin.connect();
    let releaseTimer: NodeJS.Timeout | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE");
      // Sikkerhetsnett: låsen slippes uansett etter 6 s, så en feilet fiks gir en rød test, ikke en hengende en.
      releaseTimer = setTimeout(() => { void locker.query("ROLLBACK").catch(() => undefined); }, 6_000);
      const started = Date.now();
      const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A] }), { statementTimeoutMs: 300 }).run();
      const elapsed = Date.now() - started;
      expect(result).toEqual({ ok: false, severity: "critical", message: "1 av 1 tenants kunne ikke leses" });
      expect(elapsed).toBeLessThan(4_000);
      expect(logged.some((l) => l.includes("watchdog_stuck_tasks_tenant_read_failed") && l.includes("57014"))).toBe(true);
    } finally {
      if (releaseTimer) clearTimeout(releaseTimer);
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
    expect((await app.query("SHOW statement_timeout")).rows[0]).toEqual({ statement_timeout: "0" }); // SET LOCAL: grensen er borte etter transaksjonen
    expect(app.waitingCount).toBe(0);
    // Etter at låsen er slept, leser sjekken normalt igjen (ingen tilkobling ble stående hengende).
    expect(await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A] })).run()).toEqual({ ok: true, severity: "info", message: "" });
  }, 30_000);
});

describe("A-L5: eierens tenant vurderes alltid", () => {
  const fakes = (n: number): string[] => Array.from({ length: n }, (_, i) => `tenant-fake-${String(i).padStart(3, "0")}`);

  it("katalogen er lengre enn grensen og eieren sorterer sist (faller utenfor de første 201): eieren leses FØRST og fastlåste jobber der telles; resten meldes som ikke vurdert", async () => {
    await addTask(A, "expired");
    const catalog = [...fakes(STUCK_TASKS_MAX_TENANTS + 1), A]; // SQL-funksjonen gir de første 201 (sortert på tenant_id): eieren er ikke blant dem
    const reads: string[] = [];
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: (limit) => catalog.slice(0, limit), reads }), { ownerTenantId: A }).run();
    expect(reads[0]).toBe(A);
    expect(reads).toHaveLength(STUCK_TASKS_MAX_TENANTS);
    expect(reads.filter((r) => r === A)).toHaveLength(1);
    expect(result).toEqual({ ok: false, severity: "warning", message: "1 jobber med utløpt lease (i 1 tenant); flere enn 200 tenants (de øvrige er ikke vurdert)" });
  });

  it("uten ownerTenantId er oppførselen som før (eieren kan falle utenfor), og den har ingen tilleggsvirkning", async () => {
    await addTask(A, "expired");
    const catalog = [...fakes(STUCK_TASKS_MAX_TENANTS + 1), A];
    const reads: string[] = [];
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: (limit) => catalog.slice(0, limit), reads })).run();
    expect(reads).not.toContain(A);
    expect(result).toEqual({ ok: false, severity: "warning", message: "flere enn 200 tenants (de øvrige er ikke vurdert)" });
  });

  it("eieren som allerede står i katalogen leses første gang og aldri to ganger; rekkefølgen for de øvrige er katalogens", async () => {
    const reads: string[] = [];
    await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [B, A, C], reads }), { ownerTenantId: A }).run();
    expect(reads).toEqual([A, B, C]);
  });

  it("tom katalog er fortsatt «ingen tenants funnet» selv med eier (eieren fabrikkeres aldri inn i en tom katalog); tom eier-id regnes som ikke satt", async () => {
    expect(await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [] }), { ownerTenantId: A }).run()).toEqual({ ok: false, severity: "warning", message: "ingen tenants funnet - jobber med utløpt lease er ikke vurdert" });
    const reads: string[] = [];
    await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [B, C], reads }), { ownerTenantId: "" }).run();
    expect(reads).toEqual([B, C]);
  });

  it("med eieren først er meldingen for ÉN tenant fortsatt identisk med den gamle sjekken", async () => {
    await addTask(A, "expired");
    await addTask(A, "expired");
    const next = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A] }), { ownerTenantId: A }).run();
    expect(next).toEqual({ ok: false, severity: "warning", message: "2 jobber med utløpt lease" });
  });
});

describe("A-L8: testhull fra mutantene (K09, K20, K23)", () => {
  it("K20: tidsbudsjettet er 15 s og gjelder nøyaktig: 15 000 ms er fortsatt innenfor, 15 001 ms er utenfor; de uleste telles ALLE (K23: continue, ikke break)", async () => {
    expect(STUCK_TASKS_READ_BUDGET_MS).toBe(15_000);
    await addTask(A, "expired");
    const times = [0, 14_999, 15_000, 15_001, 99_999]; // start, tenant 1, tenant 2, tenant 3, tenant 4
    let i = 0;
    const reads: string[] = [];
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A, B, C, "tenant-d"], reads }), { now: () => times[Math.min(i++, times.length - 1)]! }).run();
    expect(reads).toEqual([A, B]); // standardbudsjettet (15 s): tenant 1 (14 999) og 2 (15 000) leses, 3 (15 001) og 4 er utenfor
    expect(result).toEqual({ ok: false, severity: "warning", message: "1 jobber med utløpt lease (i 1 tenant); 2 av 4 tenants kunne ikke leses" });
    expect(logged.some((l) => l.includes("watchdog_stuck_tasks_tenant_read_failed") && l.includes('"unread":2') && l.includes("budget"))).toBe(true);
  });

  it("K23: går budsjettet ut tidlig, regnes ALLE gjenværende som uleste (ikke bare den første)", async () => {
    let clock = 0;
    const times = [0, 10, 20_000, 30_000, 40_000, 50_000]; // start, tenant 1 OK, deretter utenfor
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => ["t1", "t2", "t3", "t4", "t5"] }), { now: () => times[Math.min(clock++, times.length - 1)]! }).run();
    expect(result).toEqual({ ok: false, severity: "warning", message: "4 av 5 tenants kunne ikke leses" });
  });

  it("K09: også ved grense 1 (en tenant vurdert, flere finnes) viser meldingen antall tenants med fastlåste jobber og at resten ikke er vurdert", async () => {
    await addTask(A, "expired");
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: (limit) => [A, B].slice(0, limit) }), { maxTenants: 1 }).run();
    expect(result).toEqual({ ok: false, severity: "warning", message: "1 jobber med utløpt lease (i 1 tenant); flere enn 1 tenants (de øvrige er ikke vurdert)" });
  });
});
