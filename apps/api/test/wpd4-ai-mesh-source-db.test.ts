import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { MeshProviderDetail } from "@jarvis/model-gateway";
import { createAiMeshReportProvider } from "../src/ai-mesh-source.ts";

/**
 * WP-D4 (JARVIS-033/036/078): AI Mesh-kilden mot ekte Postgres som en `jarvis_app`-avledet rolle (RLS): SQL-en mot `cost_events` er riktig, tenant-skopet, vindu-avgrenset og kun lesende.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
const T = "tenant-wpd4";
const OTHER = "tenant-annen";
const NOW = new Date("2026-10-15T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

interface Seed {
  tenant?: string; provider: string; ok?: boolean; fallback?: boolean; latency?: number | null; ore?: number; tin?: number; tout?: number; hours?: number; kind?: string; critic?: boolean;
}
async function seed(s: Seed): Promise<void> {
  const ok = s.ok ?? true;
  await admin.query(
    `INSERT INTO cost_events (at, tenant_id, kind, amount_ore, provider, model, input_tokens, output_tokens, purpose, success, fallback, critic, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CHAT',$9,$10,$11,$12)`,
    [hoursAgo(s.hours ?? 1), s.tenant ?? T, s.kind ?? (ok ? `model:${s.provider}` : "model:failed:auth"), ok ? (s.ore ?? 0) : 0, s.provider, ok ? "m" : "(failed)", ok ? (s.tin ?? 0) : 0, ok ? (s.tout ?? 0) : 0, ok, s.fallback ?? false, s.critic ?? false, s.latency === undefined ? null : s.latency]
  );
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd4-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd4 LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_wpd4");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','WPD4','person'), ('${OTHER}','Annen','person')`);
  // kimi: tre vellykkede (100/200/300 ms), én feilet rad; én vellykket reserve-rad (fallback) for hermes; gamle og urelaterte rader som IKKE skal telle.
  await seed({ provider: "kimi", latency: 100, ore: 50, tin: 10, tout: 20, hours: 5 });
  await seed({ provider: "kimi", latency: 200, ore: 50, tin: 10, tout: 20, hours: 4 });
  await seed({ provider: "kimi", latency: 300, ore: 50, tin: 10, tout: 20, hours: 2 });
  await seed({ provider: "kimi", ok: false, fallback: true, hours: 0.5 }); // nyere enn siste suksess; en feilet rad teller aldri som vellykket reserve eller som siste suksess
  await seed({ provider: "hermes", fallback: true, latency: 900, ore: 7, tin: 4, tout: 6, hours: 1 });
  await seed({ provider: "kimi", latency: 99_999, ore: 99_999, hours: 24 * 8 }); // utenfor 7-døgnsvinduet
  await seed({ provider: "kimi", latency: 99_999, ore: 99_999, kind: "connector_maintenance", hours: 1 }); // ikke en modellrad
  await seed({ tenant: OTHER, provider: "kimi", latency: 55_555, ore: 55_555, hours: 1 }); // en annen tenant
  app = createPool({ ...base, user: "jarvis_wpd4", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const detail = (provider: string, over: Partial<MeshProviderDetail> = {}): MeshProviderDetail => ({
  provider, model: `${provider}-m`, configured: true, locality: "cloud", capabilities: ["text"], hosted_free_tier: false,
  state: "LIVE", success: 1, failures: 0, consecutive_failures: 0, solo_samples: 0, parallel_samples: 0, ...over
});
const source = (tenantId = T) => createAiMeshReportProvider({
  pool: app, tenantId, now: () => NOW, mesh: () => ({ router: "HEALTHY", fallback: "READY" }),
  details: () => [detail("kimi"), detail("hermes"), detail("anthropic", { configured: false, state: "NOT_CONFIGURED" })]
});

describe("AI Mesh-kilden mot ekte Postgres (RLS)", () => {
  it("tall per leverandør: kall, feil, kostnad, tokens, p50 og siste suksess - kun denne tenanten, kun 7 døgn, kun modellrader", async () => {
    const report = await source()();
    const kimi = report.providers.find((p) => p.provider === "kimi")?.usage_7d;
    expect(kimi).toEqual({
      calls: 4, ok_calls: 3, failed_calls: 1, fallback_ok_calls: 0, cost_ore: 150, tokens_in: 30, tokens_out: 60, p50_latency_ms: 200, last_success_at: hoursAgo(2)
    });
    const hermes = report.providers.find((p) => p.provider === "hermes")?.usage_7d;
    expect(hermes).toMatchObject({ calls: 1, ok_calls: 1, fallback_ok_calls: 1, cost_ore: 7, p50_latency_ms: 900 });
    expect(report.providers.find((p) => p.provider === "anthropic")?.usage_7d).toMatchObject({ calls: 0, ok_calls: 0, cost_ore: 0, p50_latency_ms: null });
  });

  it("fallback-bevis fra databasen teller i akseptansen (én vellykket rad med fallback=true)", async () => {
    const report = await source()();
    expect(report.acceptance.fallback_ok_calls_7d).toBe(1);
    expect(report.acceptance.live).toEqual(["kimi", "hermes"]);
    expect(report.acceptance.verdict).toBe("NOT_MET"); // bare to av tre er bevist live
    expect(report.acceptance.missing.join(" ")).toContain("Bare 2 av 3");
  });

  it("det eksplisitte tenant-filteret skoper også uten RLS (superbruker-tilkobling): forsvar i dybden, aldri avhengig av ett lag", async () => {
    const withoutRls = createAiMeshReportProvider({ pool: admin, tenantId: T, now: () => NOW, mesh: () => ({ router: "HEALTHY", fallback: "READY" }), details: () => [detail("kimi")] });
    const kimi = (await withoutRls()).providers[0]?.usage_7d;
    expect(kimi).toMatchObject({ calls: 4, cost_ore: 150, p50_latency_ms: 200 });
  });

  it("en annen tenant ser kun sine egne rader (både eksplisitt filter og RLS), og aldri denne tenantens", async () => {
    const other = await source(OTHER)();
    const kimi = other.providers.find((p) => p.provider === "kimi")?.usage_7d;
    expect(kimi).toMatchObject({ calls: 1, cost_ore: 55_555, p50_latency_ms: 55_555 });
    expect(other.providers.find((p) => p.provider === "hermes")?.usage_7d).toMatchObject({ calls: 0 });
  });

  it("RLS alene: uten det eksplisitte tenant-filteret ville app-rollen fortsatt bare se egne rader (rollen kan ikke lese andres)", async () => {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true)", [T]);
      const rows = (await client.query("SELECT DISTINCT tenant_id FROM cost_events")).rows as Array<{ tenant_id: string }>;
      await client.query("COMMIT");
      expect(rows.map((r) => r.tenant_id)).toEqual([T]);
    } finally {
      client.release();
    }
  });

  it("kilden er kun lesende: raddantallet i cost_events er uendret etter flere rapporter", async () => {
    const count = async () => Number(((await admin.query("SELECT count(*)::int AS n FROM cost_events")).rows[0] as { n: number }).n);
    const before = await count();
    await source()();
    await source()();
    expect(await count()).toBe(before);
  });

  it("en leverandør uten bruk gir 0 kall, og et tomt vindu (alle rader for gamle) gir nullstilt bruk, ikke feil", async () => {
    const later = createAiMeshReportProvider({
      pool: app, tenantId: T, now: () => new Date(NOW.getTime() + 30 * 86_400_000), mesh: () => ({ router: "HEALTHY", fallback: "READY" }), details: () => [detail("kimi")]
    });
    const report = await later();
    expect(report.providers[0]?.usage_7d).toMatchObject({ calls: 0, cost_ore: 0, last_success_at: null });
  });
});
