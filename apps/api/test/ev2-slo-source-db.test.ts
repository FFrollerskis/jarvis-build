import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { buildSloReaders, createDataQualityCounts, createSloReportProvider, createSloSource } from "../src/slo-source.ts";

/** EV-2 (D-417): SLO-kilden mot ekte Postgres (RLS som jarvis_app): vinduer fra cost_events/tool_executions/tasks og dataskvalitet fra memory_items. */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
const T = "tenant-ev2";
const NOW = new Date("2026-10-06T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ev2-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_ev2 LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_ev2");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','EV2','person'), ('tenant-annen','Annen','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${T}');
  `);
  // 12 CHAT-kall siste døgn (10 ok, 2 feilet), 3 BACKGROUND, 1 CHAT hos en annen tenant (skal ikke telle), og 1 gammelt CHAT-kall.
  for (let i = 0; i < 12; i++) {
    await admin.query(`INSERT INTO cost_events (at, tenant_id, kind, amount_ore, purpose, success, latency_ms, ttft_ms) VALUES ($1,$2,'model',$3,'CHAT',$4,$5,$6)`,
      [ago(1 + i), T, i === 0 ? 4 : 0, i >= 10 ? false : true, 1000 * (i + 1), 500 * (i + 1)]);
  }
  for (let i = 0; i < 3; i++) await admin.query(`INSERT INTO cost_events (at, tenant_id, kind, amount_ore, purpose, success, latency_ms) VALUES ($1,$2,'model',0,'EXTRACT',true,2000)`, [ago(2 + i), T]);
  await admin.query(`INSERT INTO cost_events (at, tenant_id, kind, amount_ore, purpose, success, latency_ms) VALUES ($1,'tenant-annen','model',0,'CHAT',false,99999)`, [ago(1)]);
  await admin.query(`INSERT INTO cost_events (at, tenant_id, kind, amount_ore, purpose, success, latency_ms) VALUES ($1,$2,'model',0,'CHAT',true,1000)`, [ago(24 * 3), T]);
  // minne: 2 aktive med samme innhold (duplikat), 1 med konflikt, 1 utløpt-men-aktiv, 1 gammelt karantene-forslag.
  await admin.query(`INSERT INTO memory_sources (source_id, tenant_id, kind, ref, trust_level) VALUES ('src-1','${T}','manual','x','trusted')`);
  const mem = (id: string, subject: string, content: string, extra: { status?: string; conflict?: boolean; validTo?: string; created?: string } = {}) =>
    admin.query(
      `INSERT INTO memory_items (memory_item_id, tenant_id, space, owner_person_id, type, subject, content, source_id, observed_at, valid_from, valid_to, trust_level, status, has_conflict, created_at)
       VALUES ($1,$2,'personal','person-tobias','semantic',$3,$4,'src-1', now(), now() - interval '30 days', $5, 'trusted', $6, $7, COALESCE($8::timestamptz, now()))`,
      [id, T, subject, content, extra.validTo ?? null, extra.status ?? "active", extra.conflict ?? false, extra.created ?? null]
    );
  await mem("m1", "a.1", "Tobias liker kaffe");
  await mem("m2", "a.2", "Tobias liker kaffe");
  await mem("m3", "a.3", "Bor i Oslo", { conflict: true });
  await mem("m4", "a.4", "Gammel avtale", { validTo: "2020-01-01T00:00:00Z" });
  await mem("m5", "a.5", "Forslag", { status: "quarantined", created: "2026-01-01T00:00:00Z" });
  app = createPool({ ...base, user: "jarvis_ev2", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("createSloSource (ekte Postgres)", () => {
  it("CHAT-vindu: antall, suksess, persentiler og kost kun for denne tenanten og dette vinduet", async () => {
    const w = await createSloSource(app, T).window("model:CHAT", new Date(ago(24)), NOW);
    expect(w.count).toBe(12);
    expect(w.ok).toBe(10);
    expect(w.cost_ore).toBe(4);
    expect(w.p95_ms).toBeGreaterThan(10_000);
    expect(w.ttft_p95_ms).toBeGreaterThan(5_000);
    expect(w.p50_ms).toBeGreaterThan(5_000);
  });
  it("BACKGROUND-vinduet teller kun bakgrunnsformål; tomme serier gir count 0 og null-persentiler", async () => {
    const src = createSloSource(app, T);
    const bg = await src.window("model:BACKGROUND", new Date(ago(24)), NOW);
    expect(bg).toMatchObject({ count: 3, ok: 3 });
    const tools = await src.window("tools", new Date(ago(24)), NOW);
    expect(tools).toMatchObject({ count: 0, ok: 0, p95_ms: null });
    const jobs = await src.window("jobs", new Date(ago(168)), NOW);
    expect(jobs.count).toBe(0);
  });
  it("dataskvalitet: duplikater, konflikt, utløpt, gammelt karantene-forslag telles (kun antall)", async () => {
    const c = createDataQualityCounts(app, T);
    expect(await c.duplicate()).toBe(1);
    expect(await c.contradictory()).toBe(1);
    expect(await c.expiredButActive()).toBe(1);
    expect(await c.staleQuarantine(14)).toBe(1);
  });
  it("rapport + lesere: SLO brutt (chat 10/12 < 95 %), data_quality DEGRADED, øvrige UNKNOWN - cachet i TTL", async () => {
    const report = createSloReportProvider(app, T, { now: () => NOW, ttlMs: 60_000 });
    const r = await report();
    expect(r.slos.find((s) => s.id === "chat_success")).toMatchObject({ status: "BREACH", samples: 12 });
    expect(r.slos.find((s) => s.id === "tools_success")?.status).toBe("UNKNOWN");
    expect(await report()).toBe(r);
    const readers = buildSloReaders(report);
    expect((await readers["slo"]!() as { status: string }).status).toBe("DEGRADED");
    expect((await readers["data_quality"]!() as { status: string }).status).toBe("DEGRADED");
    // For lite data i baseline for alle serier -> drift er UNKNOWN (ingen påstand om stabilitet).
    expect((await readers["drift"]!() as { status: string }).status).toBe("UNKNOWN");
  });
});
