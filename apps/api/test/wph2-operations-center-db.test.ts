import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, composeInfraStatus, type ControlCenterReport, type InfraStatusReport } from "@jarvis/executive";
import type { BackupStatusRead } from "../src/backup-status.ts";
import { createOperationsCenter, readAllJobs, readDatabaseCapacity, readQueueCapacity, readRunbooks } from "../src/control-center/operations.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H2 Operations Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder). Beviser at:
 *  - runbook-, jobb-, kapasitets- og kø-lesingene kjører med rollens faktiske GRANT-er og kolonner (inkl. `pg_stat_activity`/`pg_database_size` som ikke-superbruker);
 *  - tenant-isolasjon: A ser kun egne runbooks og egen kø - aldri B sine; minnerom-RLS: health leses kun som antall i en egen lesing;
 *  - innholdsvern: runbook-titler og -innhold leses aldri og når aldri rapporten;
 *  - senteret skriver ingenting (radtall er uendret).
 */
let db: H0Db;
const TENANT_A = "tenant-op-a";
const TENANT_B = "tenant-op-b";
const NOW = new Date();
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const idA: IdentityContext = { person_id: "person-op-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-op-b", tenant_id: TENANT_B };
const SECRET_TITLE = "Hemmelig runbook-tittel med kontonummer 12345678901";
const SECRET_BODY = "Hemmelig innhold: passordet er aldri-vis-dette";

function infra(): InfraStatusReport {
  return composeInfraStatus({
    as_of: NOW,
    measurements: { incidents: { active: [], active_total: 0, by_phase: {}, resolved_last_7d: 0 }, last_changes: {}, producer_runs: [], errors: [] },
    producers_enabled: true, producers_interval_ms: 300_000, producer_names: ["scheduler"], infra_mode: "NORMAL", targets: []
  });
}
const noBackup = async (): Promise<BackupStatusRead> => ({ kind: "missing" });

const counts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of ["operations_runbooks", "scheduler_state", "tasks", "audit_events"]) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
};

beforeAll(async () => {
  db = await startH0Db("op");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }]);
  const runbook = (id: string, tenant: string, space: string, category: string, active: boolean): Promise<unknown> =>
    admin.query("INSERT INTO operations_runbooks (runbook_id, tenant_id, memory_space_id, title, category, content, is_active, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, tenant, space, SECRET_TITLE, category, SECRET_BODY, active, ago(2 * D)]);
  await runbook("rb-a-1", TENANT_A, "business", "incident_response", true);
  await runbook("rb-a-2", TENANT_A, "business", "incident_response", false);
  await runbook("rb-a-3", TENANT_A, "project", "general", true);
  await runbook("rb-a-health", TENANT_A, "health", "general", true);
  await runbook("rb-a-health-2", TENANT_A, "health", "maintenance", true);
  await runbook("rb-b-1", TENANT_B, "business", "incident_response", true);
  await runbook("rb-b-2", TENANT_B, "business", "onboarding", true);
  // planlagte jobber (globale): en frisk, en forsinket, en som feilet og venter
  const job = (name: string, runDate: string, completed: Date | null, attempts: number, error: string | null): Promise<unknown> =>
    admin.query("INSERT INTO scheduler_state (job_name, run_date, claimed_by, claimed_at, completed_at, attempts, last_error) VALUES ($1,$2::date,'test',$3,$4,$5,$6)", [name, runDate, ago(H), completed, attempts, error]);
  const today = NOW.toISOString().slice(0, 10);
  const fiveDaysAgo = new Date(NOW.getTime() - 5 * D).toISOString().slice(0, 10);
  await job("daily-brief", today, ago(2 * H), 1, null);
  await job("connector-health-sweep", fiveDaysAgo, ago(5 * D), 1, null);
  await job("memory-profile-sweep", today, null, 3, "intern feiltekst som aldri skal vises");
  // jobbkø: A har en klar, en i ventetid og en kjørende; B har tre klare
  const task = (id: string, tenant: string, status: string, notBefore: Date | null): Promise<unknown> =>
    admin.query("INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract, not_before) VALUES ($1,$2,$3,'mål',$4,'{\"agent_profile\":\"executive\"}'::jsonb,$5)", [id, tenant, tenant === TENANT_A ? idA.person_id : idB.person_id, status, notBefore]);
  await task("t-a-ready", TENANT_A, "created", null);
  await task("t-a-backoff", TENANT_A, "created", new Date(NOW.getTime() + H));
  await task("t-a-run", TENANT_A, "running", null);
  for (const n of [1, 2, 3]) await task(`t-b-${n}`, TENANT_B, "created", null);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("lesere som app-rolle", () => {
  it("runbooks: A ser kun egne (business/project), health som ETT antall - aldri B sine, og aldri tittel eller innhold", async () => {
    const a = await readRunbooks(db.appPool, TENANT_A);
    expect(a.by_category).toEqual([
      { category: "general", active: 1, inactive: 0, last_updated_at: expect.any(String) },
      { category: "incident_response", active: 1, inactive: 1, last_updated_at: expect.any(String) }
    ]);
    expect(a.health_space_count).toBe(2);
    const b = await readRunbooks(db.appPool, TENANT_B);
    expect(b.by_category.map((c) => [c.category, c.active])).toEqual([["incident_response", 1], ["onboarding", 1]]);
    expect(b.health_space_count).toBe(0);
    expect(JSON.stringify([a, b])).not.toContain("Hemmelig");
  });

  it("jobber: alle daglige jobber siste 14 døgn med siste tilstand (uten feilteksten)", async () => {
    const jobs = await readAllJobs(db.appPool);
    expect(jobs.map((j) => j.job_name)).toEqual(["connector-health-sweep", "daily-brief", "memory-profile-sweep"]);
    expect(jobs.find((j) => j.job_name === "memory-profile-sweep")).toMatchObject({ last_completed_at: null, last_open: true, last_had_error: true, last_attempts: 3 });
    expect(JSON.stringify(jobs)).not.toContain("intern feiltekst");
  });

  it("kapasitet som ikke-superbruker: databasestørrelse, tilkoblinger mot maks og Postgres' starttidspunkt", async () => {
    const cap = await readDatabaseCapacity(db.appPool);
    expect(cap.db_bytes).toBeGreaterThan(1_000_000);
    expect(cap.connections).toBeGreaterThanOrEqual(1);
    expect(cap.max_connections).toBeGreaterThanOrEqual(cap.connections);
    expect(Date.parse(cap.postmaster_started_at as string)).toBeLessThanOrEqual(Date.now());
  });

  it("kø: A sin kø er A sin alene (klar, i ventetid, kjørende) - aldri B sine tre", async () => {
    expect(await readQueueCapacity(db.appPool, TENANT_A, NOW.getTime())).toEqual({ ready: 1, running: 1, queued: 2 });
    expect(await readQueueCapacity(db.appPool, TENANT_B, NOW.getTime())).toEqual({ ready: 3, running: 0, queued: 3 });
  });
});

describe("senteret over den ekte databasen", () => {
  const build = async (identity: IdentityContext, opts: Partial<Parameters<typeof createOperationsCenter>[0]> = {}): Promise<ControlCenterReport> => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createOperationsCenter({ pool: db.appPool, infraStatus: async () => infra(), backupStatus: noBackup, processStartedAt: () => new Date(NOW.getTime() - 3 * H), maxActiveJobs: 3, ...opts }));
    return (await registry.report("operations", identity)) as ControlCenterReport;
  };
  const item = (r: ControlCenterReport, s: string, i: string) => r.sections.find((x) => x.id === s)!.items.find((x) => x.id === i)!;

  it("hver seksjon der kilden finnes er målt; backup uten statusfil er UKJENT; runbooks, jobber, oppetid og kapasitet kommer fra databasen", async () => {
    const r = await build(idA);
    for (const id of ["incidents", "targets", "producers", "runbooks", "jobs", "uptime", "capacity"]) expect(r.sections.find((s) => s.id === id)?.measured, id).toBe(true);
    for (const id of ["backups", "restore_drills"]) expect(r.sections.find((s) => s.id === id)).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(item(r, "runbooks", "incident_response_coverage")).toMatchObject({ status: "OK", facts: { active: 1 } });
    expect(item(r, "runbooks", "health_space").facts).toMatchObject({ count: 2 });
    expect(item(r, "jobs", "job:connector-health-sweep").status).toBe("WARN"); // fem døgn gammel
    expect(item(r, "jobs", "job:daily-brief").status).toBe("OK");
    expect(item(r, "jobs", "job:memory-profile-sweep").status).toBe("WARN"); // siste kjøring feilet
    expect(item(r, "capacity", "job_queue").facts).toMatchObject({ running: 1, ready: 1, queued: 2, max_active_jobs: 3 });
    expect(item(r, "capacity", "database_size").status).toBe("OK");
    expect(item(r, "uptime", "database").status).toBe("OK");
    expect(r.status).not.toBe("OK");
  });

  it("tenant-isolasjon i sluttrapporten: B ser kun B (to runbooks, tre klare jobber) og ingen av A sine tall", async () => {
    const r = await build(idB);
    expect(item(r, "runbooks", "category:incident_response").facts).toMatchObject({ active: 1, inactive: 0 });
    expect(r.sections.find((s) => s.id === "runbooks")?.items.find((i) => i.id === "health_space")).toBeUndefined();
    expect(item(r, "capacity", "job_queue").facts).toMatchObject({ ready: 3, queued: 3 });
  });

  it("innholdsvern: ingen runbook-tittel, -innhold, kontonummer, passord eller jobbfeiltekst i hele rapporten", async () => {
    const text = JSON.stringify(await build(idA));
    for (const secret of ["Hemmelig", "12345678901", "aldri-vis-dette", "intern feiltekst"]) expect(text, secret).not.toContain(secret);
  });

  it("kun lesing: radtall i runbooks, scheduler, jobber og revisjon er uendret etter flere bygginger", async () => {
    const before = await counts();
    await build(idA);
    await build(idB);
    expect(await counts()).toEqual(before);
  });
});
