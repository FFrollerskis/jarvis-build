import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { CONNECTOR_REGISTRY } from "@jarvis/tool-gateway";
import { createIntegrationCenter, readJobs, readMaintenance, readProviderCalls, readToolAudit } from "../src/control-center/integration.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H0 Integration Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder). Beviser at:
 *  - alle fem lesespørringene kjører med rollens faktiske GRANT-er (ingen «permission denied»), og at kolonnene finnes;
 *  - tenant-isolasjon: eierens tenant ser kun egne revisjonsrader, kostnadsrader og vedlikeholdsrader - aldri en annen tenants;
 *  - `scheduler_state` (global driftstabell) leses uten tenant;
 *  - senteret skriver ingenting (radtall i alle berørte tabeller er uendret etter bygging).
 */
let db: H0Db;
const TENANT_A = "tenant-ic-a";
const TENANT_B = "tenant-ic-b";
const NOW = new Date();
const H = 3_600_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const idA: IdentityContext = { person_id: "person-ic-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-ic-b", tenant_id: TENANT_B };
const defs = productionToolDefinitions();
const allRefs = new Set(CONNECTOR_REGISTRY.flatMap((c) => c.credential_refs));

async function audit(tenant: string, person: string, type: string, tool: string, action: string, at: Date, reason: string | null = null): Promise<void> {
  await db.adminPool.query(
    "INSERT INTO audit_events (tenant_id, person_id, type, decision, reason, tool_id, action, at) VALUES ($1,$2,$3,'ALLOW',$4,$5,$6,$7)",
    [tenant, person, type, reason, tool, action, at]
  );
}

beforeAll(async () => {
  db = await startH0Db("ic");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }]);
  // A: GitHub ok for 2 t siden (+1 gammelt kall utenfor 7-døgnsvinduet), Gmail: ok for 10 t siden, FEIL (auth, med hemmelig tekst) for 1 t siden
  await audit(TENANT_A, idA.person_id, "tool.executed", "github", "read_issues", ago(2 * H));
  await audit(TENANT_A, idA.person_id, "tool.executed", "github", "read_issues", ago(10 * 24 * H));
  await audit(TENANT_A, idA.person_id, "tool.executed", "email", "read_inbox", ago(10 * H));
  await audit(TENANT_A, idA.person_id, "tool.failed", "email", "read_inbox", ago(1 * H), "gmail_http_401 Bearer sk-ant-api03-ABCDEFGHIJKLMNOP");
  await audit(TENANT_A, idA.person_id, "tool.denied", "github", "read_issues", ago(1 * H), "connector_frozen");
  // B: egne rader som A aldri skal se
  await audit(TENANT_B, idB.person_id, "tool.executed", "github", "read_issues", ago(1 * H));
  await audit(TENANT_B, idB.person_id, "tool.executed", "github", "read_issues", ago(3 * H));
  await db.adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore, provider, model, purpose, success, at) VALUES ($1,'model',5,'anthropic','m','CHAT',true,$2), ($1,'model',0,'anthropic','m','CHAT',false,$3), ($4,'model',5,'openai','m','CHAT',true,$2)", [TENANT_A, ago(3 * H), ago(1 * H), TENANT_B]);
  await db.adminPool.query("INSERT INTO connector_maintenance_log (tenant_id, connector_id, event_kind, minutes, reason, occurred_at, recorded_by) VALUES ($1,'github','api_change',100,'r',$2,'person-ic-a'), ($1,'email','credential_rotation',20,'r',$2,'person-ic-a'), ($3,'github','outage',999,'r',$2,'person-ic-b')", [TENANT_A, ago(24 * H), TENANT_B]);
  await db.adminPool.query("INSERT INTO scheduler_state (job_name, run_date, claimed_by, completed_at) VALUES ('business-events-sync', current_date, 'test', $1), ('conversation-graph-sync', current_date, 'test', $1), ('support-inbox-sync', current_date, 'test', NULL)", [ago(5 * H)]);
  await db.adminPool.query("UPDATE scheduler_state SET last_error = 'x', attempts = 2 WHERE job_name = 'support-inbox-sync'");
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

const center = () => createIntegrationCenter({
  pool: db.appPool,
  toolGateway: { secretPresence: async (ref: string) => allRefs.has(ref), health: new Map(), list: () => defs, get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) } as never,
  ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] }
});
async function report(identity: IdentityContext): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center());
  return (await registry.report("integration", identity)) as ControlCenterReport;
}
const item = (r: ControlCenterReport, section: string, id: string) => r.sections.find((s) => s.id === section)!.items.find((i) => i.id === id)!;

describe("lesespørringene som app-rolle (ekte SQL, ekte GRANT-er, RLS)", () => {
  it("revisjonssporet: A ser kun egne rader, siste 7 døgn, og feilkategorien (ikke teksten) utledes", async () => {
    const rows = await readToolAudit(db.appPool, TENANT_A, NOW.getTime());
    const gh = rows.find((r) => r.tool_id === "github")!;
    expect(gh.ok_24h).toBe(1);
    expect(new Date(gh.last_ok_at!).getTime()).toBe(ago(2 * H).getTime());
    const mail = rows.find((r) => r.tool_id === "email")!;
    expect(mail).toMatchObject({ ok_24h: 1, fail_24h: 1, fail_category: "auth" });
    expect(JSON.stringify(rows)).not.toContain("sk-ant");
    // tool.denied er ikke et helsesignal og telles ikke
    expect(rows.every((r) => r.ok_24h + r.fail_24h >= 0)).toBe(true);
    const b = await readToolAudit(db.appPool, TENANT_B, NOW.getTime());
    expect(b.find((r) => r.tool_id === "github")?.ok_24h).toBe(2);
    expect(b.find((r) => r.tool_id === "email")).toBeUndefined();
  });

  it("kostnadsrader: siste vellykkede/mislykkede kall per leverandør, kun egen tenant", async () => {
    const a = await readProviderCalls(db.appPool, TENANT_A, NOW.getTime());
    expect(a.map((r) => r.provider)).toEqual(["anthropic"]);
    expect(new Date(a[0]!.last_ok_at!).getTime()).toBe(ago(3 * H).getTime());
    expect(new Date(a[0]!.last_fail_at!).getTime()).toBe(ago(1 * H).getTime());
    const b = await readProviderCalls(db.appPool, TENANT_B, NOW.getTime());
    expect(b.map((r) => r.provider)).toEqual(["openai"]);
  });

  it("vedlikeholdslogg: summer og siste hendelse per connector, kun egen tenant", async () => {
    const a = await readMaintenance(db.appPool, TENANT_A, NOW.getTime());
    expect(a.find((r) => r.connector_id === "github")).toMatchObject({ events: 1, minutes: 100, last_kind: "api_change", last_by: "person-ic-a" });
    expect(a.find((r) => r.connector_id === "email")).toMatchObject({ minutes: 20 });
    const b = await readMaintenance(db.appPool, TENANT_B, NOW.getTime());
    expect(b.find((r) => r.connector_id === "github")).toMatchObject({ minutes: 999 });
    expect(b.find((r) => r.connector_id === "email")).toBeUndefined();
  });

  it("scheduler_state leses globalt: fullført, åpen med feil og manglende jobb skilles", async () => {
    const rows = await readJobs(db.appPool, ["business-events-sync", "support-inbox-sync", "connector-health-sweep"]);
    const byName = new Map(rows.map((r) => [r.job_name, r]));
    expect(byName.get("business-events-sync")).toMatchObject({ last_open: false, last_had_error: false });
    expect(byName.get("support-inbox-sync")).toMatchObject({ last_completed_at: null, last_open: true, last_had_error: true, last_attempts: 2 });
    expect(byName.has("connector-health-sweep")).toBe(false);
  });
});

describe("hele senteret mot ekte data", () => {
  it("A: tall fra kun A; Gmail FAIL (siste auth-feil er nyere enn siste OK) uten at teksten lekker; GitHub OK; synk-jobb med feil gir WARN", async () => {
    const r = await report(idA);
    const gh = item(r, "live", "github");
    expect(gh.facts).toMatchObject({ calls_ok_24h: 1, calls_failed_24h: 0, maintenance_minutes_30d: 100 });
    expect(gh.status).toBe("OK");
    const gmail = item(r, "live", "gmail");
    expect(gmail.status).toBe("FAIL");
    expect(gmail.facts).toMatchObject({ last_failure_category: "auth", calls_ok_24h: 1, calls_failed_24h: 1, maintenance_minutes_30d: 20 });
    expect(JSON.stringify(r)).not.toContain("sk-ant");
    expect(JSON.stringify(r)).not.toContain("Bearer");
    const jobs = r.sections.find((s) => s.id === "jobs")!;
    expect(jobs.items.find((i) => i.id === "business-events-sync")?.status).toBe("OK");
    expect(jobs.items.find((i) => i.id === "support-inbox-sync")?.status).toBe("WARN");
    expect(jobs.items.find((i) => i.id === "connector-health-sweep")?.status).toBe("UNKNOWN");
    // modellleverandør uten mesh: siste kostnadsrad er en feil → degradert
    expect(item(r, "configured_other", "anthropic").status).toBe("WARN");
  });

  it("B ser kun sine egne tall (999 min vedlikehold, to kall) - A's data er usynlig", async () => {
    const r = await report(idB);
    expect(item(r, "live", "github").facts).toMatchObject({ calls_ok_24h: 2, maintenance_minutes_30d: 999 });
    expect(item(r, "live", "gmail").facts).toMatchObject({ calls_ok_24h: 0, calls_failed_24h: 0, maintenance_minutes_30d: 0 });
    expect(item(r, "configured_other", "openai").status).toBe("OK");
    expect(r.sections.find((s) => s.id === "maintenance")!.summary_no).toContain("999 min");
  });

  it("senteret skriver ingenting: radtallet i alle berørte tabeller er uendret etter bygging", async () => {
    const count = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of ["audit_events", "cost_events", "connector_maintenance_log", "scheduler_state", "owner_control_state", "tool_executions"]) {
        out[t] = Number(((await db.adminPool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as { n: number }).n);
      }
      return out;
    };
    const before = await count();
    await report(idA);
    await report(idB);
    expect(await count()).toEqual(before);
  });

  it("en bruker uten tenant-kontekst ser ingenting: RLS gjelder for app-rollen selv uten tenant-filteret i spørringen", async () => {
    const client: pg.PoolClient = await db.appPool.connect();
    try {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM audit_events");
      expect((rows[0] as { n: number }).n).toBe(0);
      const maint = await client.query("SELECT count(*)::int AS n FROM connector_maintenance_log");
      expect((maint.rows[0] as { n: number }).n).toBe(0);
    } finally {
      client.release();
    }
  });
});
