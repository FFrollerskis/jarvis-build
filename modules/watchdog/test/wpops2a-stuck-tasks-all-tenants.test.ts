import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch } from "@jarvis/policy";
import { MemoryAlertSink, STUCK_TASKS_MAX_TENANTS, Watchdog, stuckTasksAllTenantsCheck, stuckTasksCheck } from "@jarvis/watchdog";

/**
 * WP-OPS2a K2 (JARVIS-041-resten): `stuck_tasks` ser ALLE tenants. Workeren claimer på tvers av tenants (007_claim_function.sql), men `stuckTasksCheck(pool, tenantId)` teller kun eier-tenanten - en fastlåst jobb i en business-tenant var
 * usynlig. Alt mot ekte Postgres som en runtime-rolle UTEN BYPASSRLS (som D-393-blokken i fase10-ops.test.ts): `tasks` har FORCE ROW LEVEL SECURITY.
 */
const A = "tenant-a"; // eierens tenant
const B = "tenant-b"; // business
const C = "tenant-c"; // business
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ops2a-st-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_ops2a_st LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_test_ops2a_st");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','Eier','person'), ('${B}','Bedrift B','business'), ('${C}','Bedrift C','business');
    INSERT INTO people (person_id, display_name) VALUES ('p-a','A'), ('p-b','B'), ('p-c','C');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-a','${A}'), ('p-b','${B}'), ('p-c','${C}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_ops2a_st", password: "pw2" });
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
    [`t-ops2a-${seq}`, tenant, person, status]
  );
}

/**
 * En pool som delegerer til den ekte, men kan: (a) overstyre tenant-katalogen (færre tenants, feil, 201 tenants), (b) la lesingen av `tasks` feile for bestemte tenants (feilteksten bærer tenant-id-en, for å bevise at den aldri siteres).
 */
interface ProxyOptions { catalog?: (limit: number) => string[]; catalogError?: Error; failTenants?: ReadonlySet<string>; reads?: string[] }
function proxyPool(real: pg.Pool, opts: ProxyOptions = {}): pg.Pool {
  return {
    query: (sql: unknown, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("jarvis_list_all_tenant_ids")) {
        if (opts.catalogError) return Promise.reject(opts.catalogError);
        if (opts.catalog) return Promise.resolve({ rows: opts.catalog(Number(params?.[0])).map((tenant_id) => ({ tenant_id })) }); // som SQL-funksjonen: LIMIT p_limit
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
              if (typeof sql === "string" && sql.includes("set_config('jarvis.tenant_id'")) current = String(params?.[0]);
              if (typeof sql === "string" && sql.includes("FROM tasks")) {
                opts.reads?.push(current);
                if (opts.failTenants?.has(current)) throw Object.assign(new Error(`permission denied for table tasks (tenant ${current})`), { code: "42501" });
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

describe("kontroll: den opprinnelige feilen (uten tenant-kontekst ser runtime-rollen ingenting)", () => {
  it("rå spørring uten tenant-kontekst gir 0 selv om tre jobber har utløpt lease; den gamle sjekken ser kun eier-tenanten", async () => {
    await addTask(A, "expired");
    await addTask(B, "expired");
    await addTask(C, "expired");
    const raw = await app.query("SELECT count(*)::int AS n FROM tasks WHERE status = 'running' AND lease_expires_at < now()");
    expect((raw.rows[0] as { n: number }).n).toBe(0); // RLS-blindhet: nøyaktig det D-393 rettet for én tenant
    const old = await stuckTasksCheck(app, A).run();
    expect(old).toEqual({ ok: false, severity: "warning", message: "1 jobber med utløpt lease" }); // kun A
  });
});

describe("telling på tvers av tenants (ekte RLS-rolle)", () => {
  it("to tenants med utløpt lease -> 2 jobber, og meldingen sier hvor mange tenants (i 2 tenants)", async () => {
    await addTask(A, "expired");
    await addTask(B, "expired");
    expect(await stuckTasksAllTenantsCheck(app).run()).toEqual({ ok: false, severity: "warning", message: "2 jobber med utløpt lease (i 2 tenants)" });
  });

  it("RØD FØRST: kun business-tenanten har en fastlåst jobb -> den gamle sjekken er OK (blind), den nye feiler", async () => {
    await addTask(B, "expired");
    expect(await stuckTasksCheck(app, A).run()).toEqual({ ok: true, severity: "info", message: "" }); // den gamle ser ingenting
    expect(await stuckTasksAllTenantsCheck(app).run()).toEqual({ ok: false, severity: "warning", message: "1 jobber med utløpt lease (i 1 tenant)" });
  });

  it("flere jobber i samme tenant telles alle; to jobber i B og én i C gir 3 i 2 tenants", async () => {
    await addTask(B, "expired");
    await addTask(B, "expired");
    await addTask(C, "expired");
    expect((await stuckTasksAllTenantsCheck(app).run()).message).toBe("3 jobber med utløpt lease (i 2 tenants)");
  });

  it("ikke-utløpt lease og andre statuser telles ikke (0 -> ok)", async () => {
    await addTask(A, "valid");
    await addTask(B, "valid");
    await addTask(C, "expired", "completed");
    await addTask(C, "expired", "failed");
    expect(await stuckTasksAllTenantsCheck(app).run()).toEqual({ ok: true, severity: "info", message: "" });
  });

  it("samme navn, runbook og nedkjøling som den gamle sjekken (varsel- og hendelsesnøkkelen `stuck_tasks` er uendret)", () => {
    const next = stuckTasksAllTenantsCheck(app);
    const old = stuckTasksCheck(app, A);
    expect(next.name).toBe("stuck_tasks");
    expect(next.name).toBe(old.name);
    expect(next.runbook).toBe(old.runbook);
    expect(next.cooldownMs).toBeUndefined();
    expect(old.cooldownMs).toBeUndefined();
  });
});

describe("én tenant: meldingen er IDENTISK med den gamle (drift uendret så lenge det bare finnes én tenant)", () => {
  it("katalogen har bare eier-tenanten: samme melding som stuckTasksCheck, uten suffiks - og varselet i Watchdog dempes av samme nedkjøling", async () => {
    await addTask(A, "expired");
    await addTask(A, "expired");
    const single = proxyPool(app, { catalog: () => [A] });
    const next = await stuckTasksAllTenantsCheck(single).run();
    expect(next).toEqual(await stuckTasksCheck(app, A).run());
    expect(next.message).toBe("2 jobber med utløpt lease");
    const sink = new MemoryAlertSink();
    const watchdog = new Watchdog(sink, new KillSwitch());
    watchdog.register(stuckTasksAllTenantsCheck(single));
    await watchdog.tick();
    await watchdog.tick();
    expect(sink.alerts).toHaveLength(1); // D-395: identisk gjentakelse innenfor nedkjølingen sendes ikke på nytt
    expect(sink.alerts[0]).toMatchObject({ check: "stuck_tasks", severity: "warning", message: "2 jobber med utløpt lease", runbook: "docs/runbooks/TIER1_RUNBOOKS.md#worker" });
  });

  it("én tenant uten fastlåste jobber: ok, og ingen melding", async () => {
    expect(await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [A] })).run()).toEqual({ ok: true, severity: "info", message: "" });
  });
});

describe("delvis blindhet er aldri «0 = frisk»", () => {
  it("opptellingsfeil (AllTenantEnumerationError): ok:false (warning), ingen tenant-id, ingen feiltekst i meldingen", async () => {
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalogError: new Error("connection refused password=hunter2 tenant-b") })).run();
    expect(result.ok).toBe(false);
    expect(result.severity).toBe("warning");
    expect(result.message).toBe("tenant-oppregning feilet - jobber med utløpt lease er ikke vurdert");
    expect(result.message).not.toContain("hunter2");
    expect(logged.join("\n")).not.toContain("hunter2");
    expect(logged.join("\n")).not.toContain("tenant-b");
  });

  it("en tenant som ikke kan leses gir ok:false selv om ingen andre har fastlåste jobber - og de andre tenantene leses likevel (en feilende tenant stopper ikke de øvrige)", async () => {
    const reads: string[] = [];
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { failTenants: new Set([B]), reads })).run();
    expect(result).toEqual({ ok: false, severity: "warning", message: "1 av 3 tenants kunne ikke leses" });
    expect(reads.sort()).toEqual([A, B, C]); // C (etter B) ble lest, selv om B feilet
  });

  it("feilende tenant + fastlåste jobber i de andre: begge deler står i meldingen (tellingen av de lesbare bevares)", async () => {
    await addTask(A, "expired");
    await addTask(C, "expired");
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { failTenants: new Set([B]) })).run();
    expect(result.ok).toBe(false);
    expect(result.message).toBe("2 jobber med utløpt lease (i 2 tenants); 1 av 3 tenants kunne ikke leses");
  });

  it("ingen tenant-id og ingen rå feiltekst i verken melding eller logg (kun antall og SQLSTATE)", async () => {
    await addTask(C, "expired");
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { failTenants: new Set([B]) })).run();
    const everything = `${JSON.stringify(result)}\n${logged.join("\n")}`;
    for (const id of [A, B, C]) expect(everything).not.toContain(id);
    expect(everything).not.toContain("permission denied");
    expect(logged.some((l) => l.includes("watchdog_stuck_tasks_tenant_read_failed") && l.includes("42501"))).toBe(true);
  });

  it("tom tenant-katalog er ikke «frisk»: ok:false (ingenting ble vurdert)", async () => {
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: () => [] })).run();
    expect(result).toEqual({ ok: false, severity: "warning", message: "ingen tenants funnet - jobber med utløpt lease er ikke vurdert" });
  });

  it("mer enn 200 tenants: de første 200 leses, men sjekken sier fra at resten ikke er vurdert (aldri en stille avkorting)", async () => {
    const many = Array.from({ length: STUCK_TASKS_MAX_TENANTS + 1 }, (_, i) => `tenant-fake-${String(i).padStart(3, "0")}`);
    const reads: string[] = [];
    const result = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: (limit) => many.slice(0, limit), reads })).run();
    expect(STUCK_TASKS_MAX_TENANTS).toBe(200);
    expect(reads).toHaveLength(200);
    expect(result).toEqual({ ok: false, severity: "warning", message: "flere enn 200 tenants (de øvrige er ikke vurdert)" });
    const exactly = await stuckTasksAllTenantsCheck(proxyPool(app, { catalog: (limit) => many.slice(0, Math.min(limit, 200)) })).run();
    expect(exactly).toEqual({ ok: true, severity: "info", message: "" });
  });

  it("tidsbudsjettet: går det ut midt i løkken, regnes de uleste som ikke lest (ok:false) i stedet for å la sjekken henge", async () => {
    await addTask(A, "expired");
    let clock = 0;
    const reads: string[] = [];
    const proxy = proxyPool(app, { catalog: () => [A, B, C], reads });
    const result = await stuckTasksAllTenantsCheck(proxy, { budgetMs: 1000, now: () => { const t = clock; clock += 600; return t; } }).run();
    expect(reads.length).toBeLessThan(3);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/kunne ikke leses/);
  });
});

describe("opptellingen er stille (ingen ny loggrad hvert minutt)", () => {
  it("en vellykket kjøring skriver ingenting til loggen - `all_tenants_enumerated` er dempet for denne kalleren, men ikke for de andre", async () => {
    await stuckTasksAllTenantsCheck(app).run();
    expect(logged).toEqual([]);
    const { listAllTenantIds } = await import("@jarvis/core");
    await listAllTenantIds(app, 200);
    expect(logged.some((l) => l.includes("all_tenants_enumerated"))).toBe(true); // standardoppførselen er uendret for sveipene
  });
});
