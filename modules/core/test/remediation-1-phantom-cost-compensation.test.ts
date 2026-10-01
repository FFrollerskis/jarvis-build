import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/index.ts";
import { startLeasedEmbeddedPostgres } from "../src/testing/index.ts";

/**
 * Remediation part 1 / JARVIS-006: the archive-then-zero compensation of phantom `gemma_local`
 * costs, executed against a real, fully migrated database. Proves: read-only plan, refusal without
 * the confirmation, only gemma_local is touched, originals are preserved in the archive, the
 * finance mirror is corrected, the budget sum drops, re-running is a no-op, and the revert restores
 * every original amount.
 */
const sqlFile = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../ops/remediation/phantom-cost/${name}`, import.meta.url)), "utf8");
const PLAN = sqlFile("01-plan.sql");
const APPLY = sqlFile("02-apply.sql");
const REVERT = sqlFile("03-revert.sql");
const CONFIRM_APPLY = "ARCHIVE_THEN_ZERO_GEMMA_LOCAL_COSTS";

let stop: (() => Promise<void>) | undefined;
let port = 0;
let admin: pg.Pool;

async function session<T>(settings: Record<string, string>, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await admin.connect();
  try {
    for (const [k, v] of Object.entries(settings)) await client.query(`SELECT set_config('${k}', '${v}', false)`);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

const one = async (sql: string) => (await admin.query(sql)).rows[0] as Record<string, string | number>;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-phantom-"));
  const leased = await startLeasedEmbeddedPostgres(
    (p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false })
  );
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-a','A','person'), ('t-b','B','business');
    -- phantom gemma_local rows (billed at default_rate), a legitimate paid row, a zero-cost local row, and a failed attempt
    INSERT INTO cost_events (tenant_id, kind, amount_ore, provider, model, input_tokens, output_tokens) VALUES
      ('t-a','model:gemma_local', 1500, 'gemma_local', 'gemma-local', 48000, 900),
      ('t-a','model:gemma_local', 2400, 'gemma_local', 'gemma-local', 50000, 1200),
      ('t-b','model:gemma_local', 700,  'gemma_local', 'gemma-local', 20000, 300),
      ('t-a','model:anthropic', 321, 'anthropic', 'claude-sonnet-5', 1000, 200),
      ('t-a','model:gemma_local', 0, 'gemma_local', 'gemma-local', 10, 0);
    INSERT INTO finance_spend_records (spend_record_id, tenant_id, source_family, source_record_id, occurred_at, amount_ore, category, source_provider, source_model_or_service)
    SELECT 'fin-' || cost_id, tenant_id, 'model_cost', cost_id::text, at, amount_ore, 'ai_api_cost', provider, model FROM cost_events;
  `);
}, 240_000);

afterAll(async () => {
  await admin?.end();
  await stop?.();
}, 120_000);

describe("fantomkostnad for gemma_local: plan -> apply -> revert", () => {
  it("01-plan er skrivebeskyttet og rapporterer bare tall (ingen radinnhold)", async () => {
    const before = await one("SELECT count(*)::int AS n, sum(amount_ore)::int AS s FROM cost_events");
    const results = (await admin.query(PLAN)) as unknown as pg.QueryResult | pg.QueryResult[];
    const last = Array.isArray(results) ? results[results.length - 1]! : results; // CREATE FUNCTION + SELECT => one result per statement
    const report = JSON.parse(String((last.rows[0] as Record<string, unknown>)[Object.keys(last.rows[0] as object)[0] as string]));
    expect(report.previous_compensations).toEqual([]);
    expect(report.cost_events).toMatchObject({ rows_with_cost: 3, rows_total: 4, sum_amount_ore: 4600, input_tokens: 118010 });
    expect(report.finance_mirror).toMatchObject({ rows_with_cost: 3, sum_amount_ore: 4600 });
    expect(report.by_tenant_month.map((r: { tenant_id: string; sum_amount_ore: number }) => [r.tenant_id, r.sum_amount_ore]).sort()).toEqual([["t-a", 3900], ["t-b", 700]]);
    expect(JSON.stringify(report)).not.toContain("gemma-local"); // modellnavn/innhold er ikke med, kun tall og provider-scope
    const after = await one("SELECT count(*)::int AS n, sum(amount_ore)::int AS s FROM cost_events");
    expect(after).toEqual(before);
    expect(await one("SELECT to_regclass('remediation_cost_events_archive') AS t")).toEqual({ t: null });
  });

  it("02-apply nekter uten eksplisitt bekreftelse og endrer ingenting", async () => {
    await session({}, async (c) => {
      await expect(c.query(APPLY)).rejects.toThrow(/refusing to run/);
    });
    await session({ "jarvis.remediation_confirm": "ja" }, async (c) => {
      await expect(c.query(APPLY)).rejects.toThrow(/refusing to run/);
    });
    expect((await one("SELECT sum(amount_ore)::int AS s FROM cost_events WHERE provider = 'gemma_local'"))["s"]).toBe(4600);
  });

  let compensationId = "";

  it("02-apply med bekreftelse: kun gemma_local nullstilles, originalene arkiveres, speilet rettes, revisjonsspor skrives", async () => {
    await session({ "jarvis.remediation_confirm": CONFIRM_APPLY }, async (c) => {
      await c.query(APPLY);
    });
    expect((await one("SELECT sum(amount_ore)::int AS s FROM cost_events WHERE provider = 'gemma_local'"))["s"]).toBe(0);
    expect((await one("SELECT amount_ore::int AS s FROM cost_events WHERE provider = 'anthropic'"))["s"]).toBe(321); // urørt
    const archive = await admin.query("SELECT compensation_id, amount_ore::int, tenant_id FROM remediation_cost_events_archive ORDER BY cost_id");
    expect(archive.rows.map((r) => r.amount_ore)).toEqual([1500, 2400, 700]); // originalene bevart
    compensationId = String(archive.rows[0]?.compensation_id);
    expect(compensationId).toMatch(/^phantom-gemma-local-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    const mirror = await one("SELECT sum(amount_ore)::int AS s, count(*) FILTER (WHERE source_correction_state = 'corrected')::int AS corrected FROM finance_spend_records WHERE source_provider = 'gemma_local'");
    expect(mirror).toEqual({ s: 0, corrected: 3 });
    const mirrorArchive = await one("SELECT sum(amount_ore)::int AS s FROM remediation_finance_spend_records_archive");
    expect(mirrorArchive["s"]).toBe(4600);
    const audit = await admin.query("SELECT tenant_id, payload FROM audit_events WHERE type = 'remediation.phantom_cost_compensation' ORDER BY tenant_id");
    expect(audit.rows.map((r) => [r.tenant_id, r.payload.rows, r.payload.original_sum_ore])).toEqual([["t-a", 2, 3900], ["t-b", 1, 700]]);
    // månedens budsjettgrunnlag (BudgetGuard-spørringen) har falt til den ene legitime posten
    expect((await one("SELECT coalesce(sum(amount_ore),0)::int AS s FROM cost_events WHERE at >= date_trunc('month', now())"))["s"]).toBe(321);
  });

  it("01-plan etter apply: viser tidligere kompensasjon og ingen gjenstående fantomkostnad", async () => {
    const results = (await admin.query(PLAN)) as unknown as pg.QueryResult | pg.QueryResult[];
    const last = Array.isArray(results) ? results[results.length - 1]! : results;
    const report = JSON.parse(String((last.rows[0] as Record<string, unknown>)[Object.keys(last.rows[0] as object)[0] as string]));
    expect(report.previous_compensations).toEqual([compensationId]);
    expect(report.cost_events.rows_with_cost).toBe(0);
    expect(report.finance_mirror.sum_amount_ore).toBe(0);
  });

  it("02-apply er idempotent: en andre kjøring finner ingenting å endre og dupliserer ikke arkivet", async () => {
    await session({ "jarvis.remediation_confirm": CONFIRM_APPLY }, async (c) => {
      await c.query(APPLY);
    });
    expect((await one("SELECT count(*)::int AS n FROM remediation_cost_events_archive"))["n"]).toBe(3);
    expect((await one("SELECT count(*)::int AS n FROM audit_events WHERE type = 'remediation.phantom_cost_compensation'"))["n"]).toBe(2);
  });

  it("03-revert nekter uten bekreftelse/id, og gjenoppretter ellers ALLE originalbeløp", async () => {
    await session({ "jarvis.remediation_confirm": "RESTORE_GEMMA_LOCAL_COSTS" }, async (c) => {
      await expect(c.query(REVERT)).rejects.toThrow(/compensation_id/);
    });
    await session({ "jarvis.remediation_confirm": "RESTORE_GEMMA_LOCAL_COSTS", "jarvis.compensation_id": "finnes-ikke" }, async (c) => {
      await expect(c.query(REVERT)).rejects.toThrow(/no archived rows/);
    });
    await session({ "jarvis.remediation_confirm": "RESTORE_GEMMA_LOCAL_COSTS", "jarvis.compensation_id": compensationId }, async (c) => {
      await c.query(REVERT);
    });
    expect((await one("SELECT sum(amount_ore)::int AS s FROM cost_events WHERE provider = 'gemma_local'"))["s"]).toBe(4600);
    expect((await one("SELECT sum(amount_ore)::int AS s FROM finance_spend_records WHERE source_provider = 'gemma_local'"))["s"]).toBe(4600);
    expect((await one("SELECT count(*)::int AS n FROM finance_spend_records WHERE source_correction_state = 'corrected'"))["n"]).toBe(0);
    expect((await one("SELECT count(*)::int AS n FROM audit_events WHERE type = 'remediation.phantom_cost_compensation_reverted'"))["n"]).toBe(2);
  });
});
