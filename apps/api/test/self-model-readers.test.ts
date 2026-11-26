import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { buildSelfModelReaders, type SelfModelReaderDeps } from "../src/self-model-readers.ts";

/** EV-1 (D-412): leserne mot EKTE Postgres (RLS som jarvis_app) og fakes for resten. */
const TENANT = "tenant-selfmodel";
const OTHER_TENANT = "tenant-other";
const NOW = () => new Date("2026-10-07T10:30:00.000Z");
let adminPool: pg.Pool;
let appPool: pg.Pool;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-selfmodel-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sm_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sm_test");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'SM', 'person'), ('${OTHER_TENANT}', 'Other', 'person')`);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ('p-sm', 'Eier')");
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_sm_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
});

const baseDeps = (over: Partial<SelfModelReaderDeps> = {}): SelfModelReaderDeps => ({
  pool: appPool,
  tenantId: TENANT,
  now: NOW,
  meshStatus: () => ({ providers: [] }),
  controlState: async () => ({ kill_switch: { active: false }, frozen_connectors: [], revoked_credentials: [] }),
  connectorStatus: async () => [],
  ...over
});

describe("A: database / providers / controls / connectors / build", () => {
  it("A1: database svarer -> OK med latens og kilde", async () => {
    const o = (await buildSelfModelReaders(baseDeps()).database!()) as unknown as { status: string; source: string; data: { latency_ms: number } };
    expect(o.status).toBe("OK");
    expect(o.source).toBe("postgres SELECT 1");
    expect(o.data.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("A2: database nede -> leseren kaster (diagnosen gjør det til UNKNOWN, aldri OK)", async () => {
    const down = { query: async () => { throw new Error("connection refused"); } } as never;
    await expect(buildSelfModelReaders(baseDeps({ pool: down })).database!()).rejects.toThrow("connection refused");
  });

  it("A3: leverandører mappes ærlig: UNAVAILABLE=DOWN, DEGRADED/RATE_LIMITED=DEGRADED, ikke konfigurert=OK (bevisst), scripted utelates", async () => {
    const readers = buildSelfModelReaders(baseDeps({
      meshStatus: () => ({
        providers: [
          { provider: "anthropic", state: "UNAVAILABLE", failures: 3, success: 1 },
          { provider: "gemma_local", state: "LIVE", failures: 0, success: 40, avg_latency_ms: 900 },
          { provider: "openai", state: "RATE_LIMITED", failures: 1, success: 5 },
          { provider: "kimi", state: "NOT_CONFIGURED", failures: 0, success: 0 },
          { provider: "scripted", state: "LIVE", failures: 0, success: 0 }
        ]
      })
    }));
    const list = (await readers.providers!()) as unknown as Array<{ status: string; source: string }>;
    expect(list.map((o) => `${o.source.split(":")[1]}=${o.status}`)).toEqual(["anthropic=DOWN", "gemma_local=OK", "openai=DEGRADED", "kimi=OK"]);
  });

  it("A3b (WP-H0): en leverandør eieren har pauset er DEGRADED (eier-valg, ikke «nåbar») - uavhengig av god helse - og sier det", async () => {
    const readers = buildSelfModelReaders(baseDeps({
      meshStatus: () => ({ providers: [{ provider: "anthropic", state: "LIVE", failures: 0, success: 9, paused: true }, { provider: "gemma_local", state: "LIVE", failures: 0, success: 40 }] })
    }));
    const list = (await readers.providers!()) as unknown as Array<{ status: string; source: string; detail: string }>;
    expect(list.map((o) => `${o.source.split(":")[1]}=${o.status}`)).toEqual(["anthropic=DEGRADED", "gemma_local=OK"]);
    expect(list[0]?.detail).toContain("pauset av deg");
    expect(list[0]?.detail).not.toContain("nåbar");
  });

  it("A4: kill switch på -> DOWN; frosne/tilbakekalte -> DEGRADED; ellers OK", async () => {
    const mk = (s: { active: boolean }, frozen: number, revoked: number) =>
      buildSelfModelReaders(baseDeps({ controlState: async () => ({ kill_switch: s, frozen_connectors: new Array(frozen).fill({}), revoked_credentials: new Array(revoked).fill({}) }) })).controls!();
    expect(((await mk({ active: true }, 0, 0)) as unknown as { status: string }).status).toBe("DOWN");
    expect(((await mk({ active: false }, 1, 0)) as unknown as { status: string }).status).toBe("DEGRADED");
    expect(((await mk({ active: false }, 0, 0)) as unknown as { status: string }).status).toBe("OK");
  });

  it("A5: tilkoblinger - ikke-friske nevnes med navn; aldri-kalte telles som ukjent helse (ikke «frisk»)", async () => {
    const readers = buildSelfModelReaders(baseDeps({
      connectorStatus: async () => [
        { id: "github", configured: true, health: { state: "healthy" } },
        { id: "slack", configured: true, health: { state: "auth_failed" } },
        { id: "notion", configured: true, health: null },
        { id: "jira", configured: false, health: null }
      ]
    }));
    const o = (await readers.connectors!()) as unknown as { status: string; detail: string; data: Record<string, number> };
    expect(o.status).toBe("DEGRADED");
    expect(o.detail).toContain("slack (auth_failed)");
    expect(o.data).toMatchObject({ configured: 3, failing: 1, never_called: 1 });
    const healthy = buildSelfModelReaders(baseDeps({ connectorStatus: async () => [{ id: "notion", configured: true, health: null }] }));
    const h = (await healthy.connectors!()) as unknown as { status: string; detail: string };
    expect(h.status).toBe("OK");
    expect(h.detail).toContain("aldri kalt");
  });

  it("A6: bygg-sha satt -> OK; ikke satt -> UNKNOWN (aldri gjettet)", async () => {
    const set = (await buildSelfModelReaders(baseDeps({ build: () => ({ sha: "abcdef1234567", version: "0.1.0" }) })).build!()) as unknown as { status: string; detail: string };
    expect(set.status).toBe("OK");
    expect(set.detail).toContain("abcdef1");
    expect(((await buildSelfModelReaders(baseDeps()).build!()) as unknown as { status: string }).status).toBe("UNKNOWN");
  });

  it("A7: konstitusjon/register: ikke sjekket -> UNKNOWN; verifisert -> OK; usignert -> DEGRADED; ødelagt kjede -> DOWN; manglende tabell -> UNKNOWN", async () => {
    const mk = (s: ReturnType<NonNullable<SelfModelReaderDeps["ev0Status"]>>) => buildSelfModelReaders(baseDeps({ ev0Status: () => s }));
    expect(((await mk(null).constitution!()) as unknown as { status: string }).status).toBe("UNKNOWN");
    const good = mk({ constitution: { status: "verified", version: 1 }, ledger: { status: "ok", count: 3 } });
    expect(((await good.constitution!()) as unknown as { status: string }).status).toBe("OK");
    expect(((await good.ledger!()) as unknown as { status: string }).status).toBe("OK");
    const bad = mk({ constitution: { status: "not_verified", code: "constitution_unsigned" }, ledger: { status: "broken", broken_seq: "4" } });
    expect(((await bad.constitution!()) as unknown as { status: string; detail: string }).detail).toContain("constitution_unsigned");
    expect(((await bad.constitution!()) as unknown as { status: string }).status).toBe("DEGRADED");
    expect(((await bad.ledger!()) as unknown as { status: string; detail: string })).toMatchObject({ status: "DOWN" });
    const missing = mk({ constitution: { status: "not_verified" }, ledger: { status: "unavailable", error: "relation does not exist" } });
    expect(((await missing.ledger!()) as unknown as { status: string }).status).toBe("UNKNOWN");
  });
});

describe("B: jobber og verktøyfeil mot ekte Postgres (RLS, kun egen tenant)", () => {
  it("B1: jobb med utløpt lease -> DEGRADED; andre tenanters jobber telles ikke", async () => {
    const contract = JSON.stringify({ task_id: "x" });
    await adminPool.query(
      `INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract, lease_expires_at) VALUES
         ('t-stuck', '${TENANT}', 'p-sm', 'g', 'running', $1::jsonb, now() - interval '10 minutes'),
         ('t-ok', '${TENANT}', 'p-sm', 'g', 'running', $1::jsonb, now() + interval '10 minutes'),
         ('t-other', '${OTHER_TENANT}', 'p-sm', 'g', 'running', $1::jsonb, now() - interval '10 minutes')`, [contract]);
    const o = (await buildSelfModelReaders(baseDeps()).tasks!()) as unknown as { status: string; data: { stuck: number; running: number } };
    expect(o.status).toBe("DEGRADED");
    expect(o.data).toMatchObject({ stuck: 1, running: 2 });
  });

  it("B2: verktøyfeil - under minste utvalg ingen vurdering; over terskel -> DEGRADED; andre tenanter ignoreres", async () => {
    const small = (await buildSelfModelReaders(baseDeps()).errors!()) as unknown as { status: string; detail: string };
    expect(small.status).toBe("OK");
    expect(small.detail).toContain("Få verktøykall");
    const rows: string[] = [];
    for (let i = 0; i < 10; i++) rows.push(`('${TENANT}', 'k-${i}', 'github', 'read_issues', '${i < 4 ? "failed" : "succeeded"}')`);
    rows.push(...Array.from({ length: 20 }, (_, i) => `('${OTHER_TENANT}', 'o-${i}', 'github', 'read_issues', 'failed')`));
    await adminPool.query(`INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ${rows.join(",")}`);
    const o = (await buildSelfModelReaders(baseDeps()).errors!()) as unknown as { status: string; data: { total: number; failed: number } };
    expect(o.data).toEqual({ total: 10, failed: 4 });
    expect(o.status).toBe("DEGRADED");
  });

  it("B3: prosess - OK med målte felt; lite ledig minne/disk gir DEGRADED via terskler", async () => {
    const ok = (await buildSelfModelReaders(baseDeps({ limits: { diskFreeWarnBytes: 1, memFreeWarnRatio: 0 } })).process!()) as unknown as { status: string; data: { node: string; uptime_s: number } };
    expect(ok.status).toBe("OK");
    expect(ok.data.node).toMatch(/^v\d+/);
    const lowMem = (await buildSelfModelReaders(baseDeps({ limits: { diskFreeWarnBytes: 1, memFreeWarnRatio: 2 } })).process!()) as unknown as { status: string };
    expect(lowMem.status).toBe("DEGRADED");
    const lowDisk = (await buildSelfModelReaders(baseDeps({ limits: { diskFreeWarnBytes: Number.MAX_SAFE_INTEGER } })).process!()) as unknown as { status: string };
    expect(lowDisk.status).toBe("DEGRADED");
  });

  it("B4: ingen leser for backup uten statusfil (bevisst UKJENT); `watchdog` har en leser (WP-OPS2a K1) som uten registrerte tikk svarer UKJENT med årsaken - aldri OK", async () => {
    const readers = buildSelfModelReaders(baseDeps());
    expect(readers["backup"]).toBeUndefined();
    expect(readers["watchdog"]).toBeDefined();
    expect(await readers["watchdog"]!()).toMatchObject({ status: "UNKNOWN", observed_at: null, detail: "incident-produsentene er AV: vakthundens tikk registreres ikke varig" });
  });
});
