import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { RunRateService, RunRateTransport, renderRunRateNo, runRateToolDefinitions } from "../src/run-rate.ts";

/** D-421 (UA0-RUNRATE): run-rate og connector maintenance ledger mot ekte Postgres (RLS som jarvis_app, append-only). */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
const T = "tenant-rr";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d421-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_rr LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_rr");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','RR','person'), ('tenant-annen','Annen','person')`);
  const ev = (tenant: string, hoursAgo: number, provider: string, model: string, purpose: string, ore: number, success = true) =>
    admin.query(
      `INSERT INTO cost_events (at, tenant_id, kind, amount_ore, provider, model, purpose, success, input_tokens, output_tokens)
       VALUES (now() - make_interval(hours => $1::int), $2, $3, $4, $5, $6, $7, $8, 100, 50)`,
      [hoursAgo, tenant, `model:${provider}`, ore, provider, model, purpose, success]
    );
  // 5 dager med anthropic-bruk (20 øre/døgn) + lokal modell uten kost; 1 feilet; en fremmed tenant skal ikke telle.
  for (let d = 0; d < 5; d++) await ev(T, 2 + d * 24, "anthropic", "sonnet", "CHAT", 20);
  await ev(T, 3, "gemma_local", "llama3.1:8b", "CHAT", 0);
  await ev(T, 4, "gemma_local", "llama3.1:8b", "EXTRACT", 0, false);
  await ev("tenant-annen", 1, "openai", "gpt", "CHAT", 99999);
  app = createPool({ ...base, user: "jarvis_rr", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("RunRateService (ekte Postgres)", () => {
  it("summerer kostnad per vindu/leverandør/formål kun for denne tenanten; prognose = snitt siste 7 døgn × 30", async () => {
    const r = await new RunRateService(app).report(T);
    expect(r.totals.last_30d_ore).toBe(100);
    expect(r.totals.last_7d_ore).toBe(100);
    expect(r.totals.projected_month_ore).toBe(Math.round((100 / 5) * 30));
    const sonnet = r.by_provider.find((p) => p.provider === "anthropic");
    expect(sonnet).toMatchObject({ local: false, calls: 5, ore: 100, tokens_in: 500, tokens_out: 250 });
    const local = r.by_provider.find((p) => p.provider === "gemma_local");
    expect(local).toMatchObject({ local: true, calls: 2, failed_calls: 1, ore: 0 });
    expect(r.cloud_share_30d).toBe(1);
    expect(r.by_purpose.find((p) => p.purpose === "CHAT")).toMatchObject({ calls: 6, ore: 100 });
    expect(r.by_provider.some((p) => p.provider === "openai")).toBe(false);
    expect(r.daily.length).toBeGreaterThanOrEqual(5);
    expect(r.not_measured.join(" ")).toContain("STT/TTS");
  });
  it("norsk oppsummering sier kostnad, prognose, sky-andel, hva som ikke er målt", async () => {
    const r = await new RunRateService(app).report(T);
    expect(r.summary_no).toContain("Månedsprognose");
    expect(r.summary_no).toContain("skyleverandører");
    expect(r.summary_no).toContain("Ikke målt");
    expect(renderRunRateNo({ ...r, totals: { ...r.totals, projected_month_ore: null } })).toContain("for lite data");
  });
  it("vedlikeholdsregisteret: registrering, summering per connector, tenant-isolert og append-only", async () => {
    const svc = new RunRateService(app);
    await svc.recordMaintenance(T, "person-tobias", { connector_id: "gmail", event_kind: "credential_rotation", minutes: 25, reason: "Roterte token. sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" });
    await svc.recordMaintenance(T, "person-tobias", { connector_id: "gmail", event_kind: "incident", minutes: 15, reason: "OAuth-feil" });
    await svc.recordMaintenance("tenant-annen", "x", { connector_id: "slack", event_kind: "outage", minutes: 999, reason: "annen tenant" });
    const r = await svc.report(T);
    expect(r.maintenance.minutes_30d).toBe(40);
    expect(r.maintenance.by_connector).toEqual([{ connector_id: "gmail", events: 2, minutes: 40 }]);
    expect(r.maintenance.recent[0]?.reason).not.toContain("sk-ant-api03");
    expect(r.summary_no).toContain("gmail 40 min");
    await expect(app.query("UPDATE connector_maintenance_log SET minutes = 0")).rejects.toThrow();
    await expect(admin.query("DELETE FROM connector_maintenance_log")).rejects.toThrow(/append_only_table/);
    await expect(admin.query("TRUNCATE connector_maintenance_log")).rejects.toThrow(/append_only_table/);
    await expect(svc.recordMaintenance(T, "p", { connector_id: "gmail", event_kind: "incident", minutes: -1, reason: "x" })).rejects.toThrow();
  });
  it("transport: les-handlinger og skriv-handling; manglende kontekst og ugyldig event_kind avvises", async () => {
    const svc = new RunRateService(app);
    const t = new RunRateTransport(svc);
    const ctx = { identity: { tenant_id: T, person_id: "person-tobias", memory_space_id: "personal", device_id: "d", session_id: "s" } } as never;
    await expect(t.invoke("get_cost_overview", {}, "")).rejects.toThrow("run_rate_missing_invocation_context");
    expect(((await t.invoke("get_cost_overview", {}, "", ctx)).data as { totals: unknown }).totals).toBeDefined();
    expect(((await t.invoke("list_connector_maintenance", {}, "", ctx)).data as { minutes_30d: number }).minutes_30d).toBe(40);
    await expect(t.invoke("record_connector_maintenance", { connector_id: "gmail", event_kind: "bogus", minutes: 1, reason: "x" }, "", ctx)).rejects.toThrow("invalid_event_kind");
    const ok = await t.invoke("record_connector_maintenance", { connector_id: "drive", event_kind: "api_change", minutes: 10, reason: "scope endret" }, "", ctx);
    expect((ok.data as { log_id: string }).log_id).toMatch(/^\d+$/);
    const defs = runRateToolDefinitions(t);
    expect(defs.map((d) => `${d.action}:${d.capability_class}`)).toEqual(["get_cost_overview:A", "list_connector_maintenance:A", "record_connector_maintenance:B"]);
  });
});
