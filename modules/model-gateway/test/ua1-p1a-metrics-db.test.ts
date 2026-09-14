import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway } from "../src/index.ts";

/**
 * BO-11.1 §5: migrasjonsakseptanse for 016_cost_events_stream_metrics mot
 * EKTE Postgres (embedded): eksisterende data overlever, gamle inserts virker
 * med defaults, og et reelt streaming-kall gjennom ModelGateway kan verifiseres
 * via SQL på provider/model/purpose/ttft_ms/stream/tool_calls/kost.
 * (Docker-PG-runtime på hosten dekkes av delta-live-scriptet - samme SQL.)
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pgm16-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("BO-11.1 §5: migrasjon 016 på ekte Postgres", () => {
  it("gamle inserts (uten nye kolonner) virker fortsatt - defaults fyller stream/tool_calls/ttft", async () => {
    await adminPool.query(
      `INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ('tenant-a', 'model:legacy', 42)`
    );
    const row = await adminPool.query(
      `SELECT ttft_ms, stream, tool_calls FROM cost_events WHERE kind = 'model:legacy'`
    );
    expect(row.rows[0]).toEqual({ ttft_ms: null, stream: false, tool_calls: 0 });
  });

  it("ekte streaming-kall gjennom gateway → SQL-verifiserbar rad m/provider/model/purpose/ttft/stream/tool_calls/kost", async () => {
    const gateway = new ModelGateway({
      pool: appPool,
      trace: new MemoryTraceSink(),
      providers: [new ScriptedAdapter(() => "et streamet svar fra mesh")],
      rates: { scripted: { input_per_1k_ore: 10, output_per_1k_ore: 20 } }
    });
    const result = await gateway.stream(
      { tenant_id: "tenant-a", session_id: "sess-m16", purpose: "CHAT", request: { messages: [{ role: "user", content: "hei" }] } },
      () => undefined
    );
    expect(result.ttft_ms).toBeGreaterThanOrEqual(0);
    const row = await adminPool.query(
      `SELECT provider, model, purpose, ttft_ms, stream, tool_calls, amount_ore
         FROM cost_events WHERE session_id = 'sess-m16' AND kind = 'model:scripted'`
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]).toMatchObject({
      provider: "scripted",
      model: "scripted-1",
      purpose: "CHAT",
      stream: true,
      tool_calls: 0
    });
    expect(row.rows[0].ttft_ms).toBeGreaterThanOrEqual(0);
    expect(Number(row.rows[0].amount_ore)).toBeGreaterThan(0);
  });

  it("aggregering for P1B er SQL-spørrbar (avg ttft per provider/purpose)", async () => {
    const agg = await adminPool.query(
      `SELECT provider, purpose, avg(ttft_ms)::int AS avg_ttft, count(*) FILTER (WHERE stream) AS streamed
         FROM cost_events WHERE stream GROUP BY provider, purpose`
    );
    expect(agg.rowCount).toBeGreaterThanOrEqual(1);
    expect(agg.rows[0].avg_ttft).toBeGreaterThanOrEqual(0);
  });
});
