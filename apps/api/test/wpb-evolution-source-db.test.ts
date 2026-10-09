import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ChangeLedger } from "@jarvis/self-modification";
import type { SloReport } from "@jarvis/executive";
import type { MeshStatus } from "@jarvis/model-gateway";
import { boundariesSection, buildEvolutionReport, costSection, maintenanceSection, memorySection, proposalsSection, type EvolutionContext, type EvolutionSourceDeps } from "../src/evolution-source.ts";

/**
 * WP-B (D-452): evolusjonskildene mot ekte Postgres som `jarvis_app`-avledet rolle (RLS): SQL-en mot endringsregisteret, cost_events, scheduler_state og incidents er riktig, tenant-skopet og kun lesende.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
const T = "tenant-wpb";
const NOW = new Date("2026-10-15T12:00:00.000Z");
const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T10:00:00.000Z`;
const DIGEST = "a".repeat(64);

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpb-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpb LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_wpb");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','WPB','person'), ('tenant-annen','Annen','person')`);
  // Kostnad: 6 rolige dager (100 øre/dag) hos anthropic, en kraftig topp i dag, og en annen tenant som ikke skal telle.
  for (let d = 8; d <= 13; d++) await admin.query(`INSERT INTO cost_events (at, tenant_id, kind, amount_ore, provider, model) VALUES ($1,$2,'model',100,'anthropic','claude')`, [day(d), T]);
  await admin.query(`INSERT INTO cost_events (at, tenant_id, kind, amount_ore, provider, model) VALUES ($1,$2,'model',2500,'anthropic','claude')`, ["2026-10-15T09:00:00.000Z", T]);
  await admin.query(`INSERT INTO cost_events (at, tenant_id, kind, amount_ore, provider, model) VALUES ($1,'tenant-annen','model',999999,'anthropic','claude')`, ["2026-10-15T09:00:00.000Z"]);
  // Planlagte jobber: connector-helse kjørt for 3 timer siden; daglig brief aldri.
  await admin.query(`INSERT INTO scheduler_state (job_name, run_date, claimed_by, completed_at) VALUES ('connector-health-sweep', '2026-10-15', 'test', $1)`, [new Date(NOW.getTime() - 3 * 3_600_000).toISOString()]);
  // Hendelse: én åpen i prosjekt-rommet for denne tenanten, én løst, og én åpen hos en annen tenant.
  await admin.query(`INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, status) VALUES ('i1','${T}','project','Åpen','open'), ('i2','${T}','project','Løst','resolved'), ('i3','tenant-annen','project','Annens','open')`);
  // Endringsregister: ett forslag som venter, ett avvist (blocked).
  const ledger = new ChangeLedger(admin);
  await ledger.append({ change_id: "p1", change_class: "E1", decision: "proposed", constitution_digest: DIGEST, subject: "Ny tone", paths: ["config/charlie-personality.json"], branch: "", head_sha: null, evidence: {}, recorded_by: "test" });
  await ledger.append({ change_id: "p2", change_class: "E2", decision: "blocked", constitution_digest: DIGEST, subject: "Avhengighet", paths: ["package.json"], branch: "", head_sha: null, evidence: {}, recorded_by: "test" });
  // Minne: to identiske aktive minner (duplikat), ett utløpt-men-aktivt, ett i helse-rommet (skal ikke vurderes), og ett hos en annen tenant.
  await admin.query(`INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias')`);
  await admin.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${T}')`);
  await admin.query(`INSERT INTO memory_sources (source_id, tenant_id, kind, ref, trust_level) VALUES ('src-1','${T}','conversation','s1','trusted'), ('src-2','tenant-annen','conversation','s2','trusted')`);
  const mem = (id: string, tenant: string, space: string, subject: string, content: string, source: string, validTo: string | null = null) =>
    admin.query(
      `INSERT INTO memory_items (memory_item_id, tenant_id, space, owner_person_id, type, subject, content, source_id, observed_at, valid_from, valid_to, trust_level, status, has_conflict)
       VALUES ($1,$2,$3,'person-tobias','semantic',$4,$5,$6, now(), now() - interval '30 days', $7, 'trusted', 'active', false)`,
      [id, tenant, space, subject, content, source, validTo]
    );
  await admin.query(`INSERT INTO people (person_id, display_name) VALUES ('person-annen','Annen') ON CONFLICT DO NOTHING`);
  await mem("m1", T, "personal", "a.1", "Tobias liker kaffe", "src-1");
  await mem("m2", T, "personal", "a.2", "Tobias liker kaffe", "src-1");
  await mem("m3", T, "personal", "a.3", "Gammel avtale", "src-1", "2020-01-01T00:00:00Z");
  await mem("m4", T, "health", "h.1", "Helse-innhold som aldri skal vurderes", "src-1");
  await mem("m5", "tenant-annen", "personal", "z.1", "Annens minne", "src-2");
  app = createPool({ ...base, user: "jarvis_wpb", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const slo: SloReport = { as_of: NOW.toISOString(), slos: [], not_measured: [], drift: null, data_quality: null, summary_no: "" };
const mesh: MeshStatus = { providers: [{ provider: "gemma_local", model: "g", state: "LIVE", success: 1, failures: 0 }], router: "HEALTHY", fallback: "LOGIC_ONLY", critic: "READY_SELECTIVE" };
function deps(over: Partial<EvolutionSourceDeps> = {}): EvolutionSourceDeps {
  return {
    pool: app, tenantId: T, now: () => NOW, env: {},
    ev0Status: () => ({ constitution: { status: "not_verified", code: "constitution_unsigned" }, ledger: { status: "ok", count: 2, head_hash: "h" } }),
    slo: async () => slo, connectors: async () => [], killSwitchActive: async () => false, mesh: () => mesh, ...over
  };
}
const ctx = (d: EvolutionSourceDeps): EvolutionContext => ({ pool: d.pool, tenantId: d.tenantId, now: NOW, env: d.env ?? {}, deps: d });

describe("evolusjonskildene mot ekte Postgres", () => {
  it("EV-5: endringsregisteret leses som app-rollen: ett forslag venter, ett er avvist", async () => {
    const s = await proposalsSection(ctx(deps()));
    expect(s.summary_no).toContain("1 forslag venter på deg");
    expect(s.findings.join("\n")).toMatch(/1 blocked, 1 proposed/);
  });

  it("EV-16: kostnad kun for denne tenanten; avviket i dag oppdages og månedssummen er tenantens egen", async () => {
    const s = await costSection(ctx(deps()));
    expect(s.status).toBe("ATTENTION");
    expect(s.findings.join("\n")).toContain("Uvanlig kostnad i dag hos anthropic: 25 kr");
    expect(s.findings.join("\n")).toContain("Hittil i måneden: 31 kr");
    expect(JSON.stringify(s)).not.toContain("9999");
  });

  it("EV-19: scheduler_state gir sist kjørt; nylig kjørt jobb er ikke forfalt, jobben som aldri har kjørt er det", async () => {
    const s = await maintenanceSection(ctx(deps()));
    const text = s.findings.join("\n");
    expect(text).toContain("Forfalt nå:");
    expect(text).toContain("failed_jobs_review");
    expect(text).not.toMatch(/Forfalt nå:[^.]*health_check/);
  });

  it("EV-0/EV-8: åpne hendelser telles per tenant og rom (RLS) og slår på change freeze", async () => {
    const s = await boundariesSection(ctx(deps()));
    expect(s.findings.join("\n")).toContain("incident_open");
    expect(s.status).toBe("ATTENTION");
    expect(s.findings.join("\n")).toContain("constitution_unsigned");
  });

  it("EV-10: kun denne tenantens aktive minner i tillatte rom vurderes (helse utelatt); duplikat og utløpt oppdages; innhold lekker ikke", async () => {
    const s = await memorySection(ctx(deps()));
    const text = s.findings.join("\n");
    expect(text).toContain("Vurdert: 3 aktive minner");
    expect(text).toContain("utløpt 1");
    expect(text).toContain("1 duplikatgrupper kan slås sammen");
    expect(JSON.stringify(s)).not.toMatch(/kaffe|Helse-innhold|Annens/);
  });

  it("hele rapporten bygges mot databasen uten at noen seksjon blir UNKNOWN, og ingenting skrives (rader før = rader etter)", async () => {
    const count = async () => Number((await admin.query(`SELECT (SELECT count(*) FROM evolution_change_ledger) + (SELECT count(*) FROM cost_events) + (SELECT count(*) FROM scheduler_state) + (SELECT count(*) FROM incidents) AS n`)).rows[0].n);
    const before = await count();
    const report = await buildEvolutionReport(deps());
    expect(report.sections.filter((s) => s.status === "UNKNOWN").map((s) => `${s.ev}: ${s.summary_no}`)).toEqual([]);
    expect(report.acts).toBe(false);
    expect(await count()).toBe(before);
  });
});
