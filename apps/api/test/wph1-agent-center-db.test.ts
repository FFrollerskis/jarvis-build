import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { AGENT_CENTER_MAX_ACTIVE_ROWS, createAgentCenter, readAgentAggregates } from "../src/control-center/agent.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H1 Agent Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder). Beviser at:
 *  - alle tellerne (kø, workere, leaser, forsøk, avbrytelser, artefakter, nettverksomfang, runner-utfall) kjører med rollens faktiske GRANT-er og kolonner (tasks, artifacts, audit_events);
 *  - ALLE kjørende jobber er dekket (JARVIS-087 del 2): opptil 200 rader, og resten telles og sies ifra om;
 *  - tenant-isolasjon: A ser aldri B sine jobber, workere, artefakter eller revisjonsrader;
 *  - innholdsvern: jobbtittel, resultat, sjekkpunkt, feiltekst, artefaktnavn/-innhold og nettverksmålene (vertsnavn) når aldri rapporten;
 *  - avbryt-handlingene er den eksisterende `executive.cancel_task` (kun for jobber som kan avbrytes); senteret skriver ingenting.
 */
let db: H0Db;
const TENANT_A = "tenant-ag-a";
const TENANT_B = "tenant-ag-b";
const TENANT_BIG = "tenant-ag-big";
const NOW = new Date();
const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const ahead = (ms: number): Date => new Date(NOW.getTime() + ms);
const idA: IdentityContext = { person_id: "person-ag-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-ag-b", tenant_id: TENANT_B };
const idBig: IdentityContext = { ...idA, person_id: "person-ag-big", tenant_id: TENANT_BIG };
const defs = productionToolDefinitions();
const HIDDEN_GOAL = "hemmelig jobbtittel som kan være skrevet av en modell";
const HIDDEN_RESULT = "hemmelig resultat";
const HIDDEN_ERROR = "hemmelig feiltekst med sti /etc/passwd";
const HIDDEN_HOST = "hemmelig-vert.example";
const HIDDEN_ARTIFACT = "hemmelig-artefaktnavn";
const HIDDEN_ARTIFACT_CONTENT = "hemmelig artefaktinnhold";

const TABLES_TOUCHED = ["tasks", "artifacts", "audit_events"] as const;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES_TOUCHED) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
}

interface TaskSeed {
  id: string; tenant: string; person: string; status: string; profile?: string; attempts?: number; maxAttempts?: number; worker?: string | null; lease?: Date | null; claimed?: Date | null;
  created?: Date; finished?: Date | null; cancel?: boolean; error?: string | null; notBefore?: Date | null; targets?: string[];
}
async function task(t: TaskSeed): Promise<void> {
  const contract = {
    task_id: t.id, goal: HIDDEN_GOAL, agent_profile: t.profile ?? "executive", retry_policy: { max_attempts: t.maxAttempts ?? 3, backoff_seconds: 5 }, allowed_network_targets: t.targets ?? [],
    input: { data: { delegated_from_chat: true }, trust_level: "trusted", provenance: "test" }
  };
  await db.adminPool.query(
    `INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract, attempts, claimed_at, finished_at, result, worker_id, lease_expires_at, cancel_requested, last_error, not_before, created_at, checkpoint)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17::jsonb)`,
    [t.id, t.tenant, t.person, HIDDEN_GOAL, t.status, JSON.stringify(contract), t.attempts ?? 0, t.claimed ?? null, t.finished ?? null, JSON.stringify({ hemmelig: HIDDEN_RESULT }), t.worker ?? null, t.lease ?? null,
      t.cancel ?? false, t.error ?? null, t.notBefore ?? null, t.created ?? ago(H), JSON.stringify({ hemmelig: HIDDEN_RESULT })]
  );
}

beforeAll(async () => {
  db = await startH0Db("ag");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }, { tenant_id: TENANT_BIG, person_id: idBig.person_id }]);
  const A = { tenant: TENANT_A, person: idA.person_id };
  await task({ ...A, id: "t-run-1", status: "running", attempts: 1, worker: "worker-1", lease: ahead(40_000), claimed: ago(20 * MIN) });
  await task({ ...A, id: "t-run-2", status: "running", profile: "coding", attempts: 2, worker: "worker-1", lease: ago(5 * MIN), claimed: ago(30 * MIN), cancel: true, targets: [HIDDEN_HOST, "b.example"] });
  await task({ ...A, id: "t-run-3", status: "running", profile: "research", attempts: 1, worker: "worker-2", lease: ahead(30_000), claimed: ago(3 * H), targets: [HIDDEN_HOST] });
  await task({ ...A, id: "t-q-1", status: "created", created: ago(40 * MIN) });
  await task({ ...A, id: "t-q-2", status: "created", attempts: 1, error: HIDDEN_ERROR, notBefore: ahead(10 * MIN), created: ago(5 * MIN) });
  await task({ ...A, id: "t-paused", status: "paused" });
  await task({ ...A, id: "t-done", status: "completed", profile: "coding", attempts: 1, finished: ago(2 * D), created: ago(2 * D) });
  await task({ ...A, id: "t-failed-1", status: "failed", profile: "coding", attempts: 3, maxAttempts: 3, finished: ago(D), created: ago(D), error: "host_job_runner_error:unreachable " + HIDDEN_ERROR });
  await task({ ...A, id: "t-failed-2", status: "failed", attempts: 3, maxAttempts: 1, finished: ago(2 * D), created: ago(2 * D), error: "lease_expired_claims_exhausted: " + HIDDEN_ERROR });
  await task({ ...A, id: "t-cancelled", status: "cancelled", finished: ago(5 * H), created: ago(6 * H) });
  const B = { tenant: TENANT_B, person: idB.person_id };
  await task({ ...B, id: "t-b-run", status: "running", attempts: 1, worker: "worker-b", lease: ahead(30_000), claimed: ago(MIN), targets: ["b-only.example"] });
  await task({ ...B, id: "t-b-failed", status: "failed", attempts: 1, finished: ago(D), created: ago(D), error: "host_job_runner_error:b" });
  // Stor tenant: 205 ikke-startede jobber (grensen er 200)
  await admin.query(
    `INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract, created_at)
     SELECT 't-big-' || g, $1, $2, 'g', 'created', jsonb_build_object('agent_profile', 'executive', 'allowed_network_targets', '[]'::jsonb), now() - interval '1 minute'
       FROM generate_series(1, 205) g`,
    [TENANT_BIG, idBig.person_id]
  );
  await admin.query(`INSERT INTO artifacts (artifact_id, task_id, tenant_id, kind, name, content, created_at) VALUES ('a-1', 't-run-1', $1, 'report', $2, $3, $4), ('a-2', 't-run-1', $1, 'report', $2, $3, $4), ('a-3', 't-done', $1, 'diff', $2, $3, $4), ('a-old', 't-done', $1, 'report', $2, $3, $5), ('a-b', 't-b-run', $6, 'report', $2, $3, $4)`,
    [TENANT_A, HIDDEN_ARTIFACT, HIDDEN_ARTIFACT_CONTENT, ago(H), ago(10 * D), TENANT_B]);
  await admin.query(`INSERT INTO audit_events (tenant_id, person_id, type, at, payload) VALUES ($1, $2, 'task.cancelled', $3, '{}'::jsonb), ($1, $2, 'task.cancelled', $4, '{}'::jsonb), ($5, $6, 'task.cancelled', $3, '{}'::jsonb)`, [TENANT_A, idA.person_id, ago(D), ago(20 * D), TENANT_B, idB.person_id]);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

function center(): ReturnType<typeof createAgentCenter> {
  return createAgentCenter({ pool: db.appPool, toolGateway: { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) } });
}
async function report(identity: IdentityContext): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center());
  return (await registry.report("agent", identity)) as ControlCenterReport;
}
const sec = (r: ControlCenterReport, id: string) => r.sections.find((s) => s.id === id)!;
const item = (r: ControlCenterReport, section: string, id: string) => sec(r, section).items.find((i) => i.id === id)!;

describe("tellerne som app-rolle (ekte SQL, ekte GRANT-er, RLS)", () => {
  it("kø, kjørende, leaser, forsøk, avbrytelser, nettverk og runner-utfall - kun A", async () => {
    const v = await readAgentAggregates(db.appPool, TENANT_A, NOW.getTime());
    expect(v.queue).toMatchObject({ queued: 2, ready: 1, in_backoff: 1, paused: 1 });
    expect(v.queue.oldest_ready_at).not.toBeNull();
    expect(v.running).toBe(3);
    expect(v.leases).toEqual({ renewed_ok: 2, expired: 1 });
    expect(v.last_claim_any_at).not.toBeNull();
    expect(v.retries).toEqual({ retrying: 1, failed_7d: 2, abandoned_7d: 1, exhausted_7d: 2 }); // kun t-run-2 er aktiv på forsøk nr. 2
    expect(v.cancellations).toMatchObject({ stop_pending: 1, cancelled_24h: 1, audit_7d: 1 }); // revisjonsraden fra for 20 døgn siden er utenfor, B sin er aldri med
    expect(v.network).toEqual({ jobs_with_network: 2, targets: 3 });
    expect(v.runner).toMatchObject({ coding_7d: 3, coding_completed_7d: 1, errors_7d: 1 });
    expect(v.runner.last_error_at).not.toBeNull();
    expect(v.workers.map((w) => `${w.worker_id}:${w.running}:${w.expired}`)).toEqual(["worker-1:2:1", "worker-2:1:0"]);
    expect(v.by_profile).toEqual(expect.arrayContaining([{ profile: "executive", status: "created", n: 2 }, { profile: "coding", status: "running", n: 1 }]));
    expect(v.artifacts.total).toBe(4);
    expect(v.artifacts.recent_by_kind).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "report", n: 2 }), expect.objectContaining({ kind: "diff", n: 1 })]));
  });

  it("B sine tall er B sine (A sine workere, artefakter og avbrudd lekker ikke)", async () => {
    const v = await readAgentAggregates(db.appPool, TENANT_B, NOW.getTime());
    expect(v.running).toBe(1);
    expect(v.workers.map((w) => w.worker_id)).toEqual(["worker-b"]);
    expect(v.artifacts.total).toBe(1);
    expect(v.cancellations.audit_7d).toBe(1);
    expect(v.runner.errors_7d).toBe(1);
  });
});

describe("senteret som helhet (registeret → rapport)", () => {
  it("sju seksjoner, alle målt", async () => {
    const r = await report(idA);
    expect(r.center).toBe("agent");
    expect(r.sections.map((s) => s.id)).toEqual(["workers", "jobs", "leases", "retries", "cancellations", "artifacts", "network"]);
    expect(r.sections.every((s) => s.measured)).toBe(true);
  });

  it("alle aktive jobber er dekket: tre kjørende + to ikke startet + én pauset; helse per jobb (utløpt lease, lenge kjørt, kø uten worker, avbrudd forespurt)", async () => {
    const r = await report(idA);
    const jobs = sec(r, "jobs");
    expect(jobs.items.map((i) => i.id).sort()).toEqual(["t-paused", "t-q-1", "t-q-2", "t-run-1", "t-run-2", "t-run-3"]);
    expect(jobs.items.find((i) => i.id === "t-run-1")?.status).toBe("OK");
    expect(jobs.items.find((i) => i.id === "t-run-2")?.status).toBe("WARN"); // utløpt lease + avbrudd forespurt
    expect(jobs.items.find((i) => i.id === "t-run-3")?.status).toBe("WARN"); // kjørt over to timer
    expect(jobs.items.find((i) => i.id === "t-q-1")?.status).toBe("WARN"); // 40 min i kø uten worker
    expect(jobs.items.find((i) => i.id === "t-run-2")?.facts).toMatchObject({ agent_profile: "coding", network_targets: 2, cancel_requested: true });
  });

  it("avbryt-handlingene er den eksisterende cancel_task: kun for jobber som kan avbrytes (ikke pauset, ikke allerede forespurt), klasse B uten step-up, kun eier", async () => {
    const r = await report(idA);
    expect(r.actions.map((a) => a.id).sort()).toEqual(["agent.cancel:t-q-1", "agent.cancel:t-q-2", "agent.cancel:t-run-1", "agent.cancel:t-run-3"]);
    for (const a of r.actions) {
      expect(a).toMatchObject({ endpoint: "/executive/mutate", risk_class: "B", requires_step_up: false, reversible: false, section_id: "jobs" });
      expect((a.body as { action: string }).action).toBe("cancel_task");
    }
  });

  it("workere og kø: kø uten worker er advarsel, utløpt lease på en worker er advarsel, nylig claim er bevis på at en worker lever", async () => {
    const r = await report(idA);
    expect(item(r, "workers", "queue").status).toBe("WARN");
    expect(item(r, "workers", "worker:worker-1")).toMatchObject({ status: "WARN", facts: { running: 2, expired_leases: 1 } });
    expect(item(r, "workers", "worker:worker-2").status).toBe("OK");
    expect(item(r, "workers", "worker_evidence").status).toBe("OK");
  });

  it("leaser, forsøk, avbrytelser og runner: utløpt lease, feilede/oppgitte jobber, avbrudd som venter og runner-feil gir advarsler", async () => {
    const r = await report(idA);
    expect(item(r, "leases", "leases_expired")).toMatchObject({ status: "WARN", facts: { expired: 1 } });
    expect(item(r, "retries", "failed_7d")).toMatchObject({ status: "WARN", facts: { failed: 2, retries_exhausted: 2, abandoned_after_lease_expiry: 1 } });
    expect(item(r, "cancellations", "stop_pending")).toMatchObject({ status: "WARN", facts: { pending: 1 } });
    expect(item(r, "network", "network_scopes").facts).toMatchObject({ jobs_with_network: 2, targets: 3 });
    expect(item(r, "network", "code_runner")).toMatchObject({ status: "WARN", facts: { runner_errors_7d: 1 } });
    expect(r.status).toBe("WARN");
  });

  it("tenant-isolasjon: B sin rapport viser kun B; A sin viser aldri B sine jobber, workere eller nettverksmål", async () => {
    const a = JSON.stringify(await report(idA));
    const bReport = await report(idB);
    const b = JSON.stringify(bReport);
    for (const id of ["t-b-run", "worker-b", "b-only.example"]) expect(a, id).not.toContain(id);
    for (const id of ["t-run-", "worker-1", "worker-2", "t-q-"]) expect(b, id).not.toContain(id);
    expect(sec(bReport, "jobs").items.map((i) => i.id)).toEqual(["t-b-run"]);
  });

  it("innholdsvern: jobbtittel, resultat, sjekkpunkt, feiltekst, artefaktnavn/-innhold og nettverksmål (vertsnavn) når aldri rapporten", async () => {
    const text = JSON.stringify(await report(idA));
    for (const secret of [HIDDEN_GOAL, HIDDEN_RESULT, HIDDEN_ERROR, HIDDEN_HOST, HIDDEN_ARTIFACT, HIDDEN_ARTIFACT_CONTENT, "/etc/passwd", "b.example"]) expect(text, secret).not.toContain(secret);
    expect(text.toLowerCase()).not.toContain("hemmelig");
  });

  it("senteret skriver ingenting: radtall i tasks, artifacts og audit_events er uendret etter flere bygginger", async () => {
    const before = await counts();
    await report(idA);
    await report(idB);
    expect(await counts()).toEqual(before);
  });

  it(`dekning: over ${AGENT_CENTER_MAX_ACTIVE_ROWS} aktive jobber vises ${AGENT_CENTER_MAX_ACTIVE_ROWS} og resten telles og sies ifra om (aldri en stille avkortning)`, async () => {
    const r = await report(idBig);
    expect(sec(r, "jobs").items).toHaveLength(AGENT_CENTER_MAX_ACTIVE_ROWS);
    expect(sec(r, "jobs").summary_no).toContain("5 flere finnes og vises ikke");
    expect(item(r, "workers", "queue").facts).toMatchObject({ queued: 205 });
  });

  it("en kilde som svikter gir UKJENT for de berørte seksjonene (aldri OK), mens jobblisten (egen lesing) fortsatt er målt", async () => {
    await db.adminPool.query("REVOKE SELECT ON artifacts FROM jarvis_app");
    try {
      const r = await report(idA);
      for (const id of ["workers", "leases", "retries", "cancellations", "artifacts", "network"]) expect(sec(r, id), id).toMatchObject({ status: "UNKNOWN", measured: false });
      expect(sec(r, "jobs").measured).toBe(true);
      expect(r.actions.length).toBe(4); // avbryt-handlingene kommer fra jobblisten og er uavhengige av tellerne
    } finally {
      await db.adminPool.query("GRANT SELECT ON artifacts TO jarvis_app");
    }
  });
});

describe("rene tilstander", () => {
  it("en tenant uten jobber: alt er målt (0); worker-helse og kodejobb-runner er UKJENT (aldri OK uten bevis)", async () => {
    await db.adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-ag-empty', 'e', 'business')");
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(center());
    const r = (await registry.report("agent", { ...idA, tenant_id: "tenant-ag-empty" })) as ControlCenterReport;
    expect(r.sections.every((s) => s.measured)).toBe(true);
    expect(sec(r, "jobs").summary_no).toContain("Ingen aktive agenter");
    expect(item(r, "workers", "worker_evidence").status).toBe("UNKNOWN");
    expect(item(r, "network", "code_runner").status).toBe("UNKNOWN");
    expect(item(r, "workers", "queue").status).toBe("OK");
    expect(r.actions).toEqual([]);
    expect(r.status).toBe("UNKNOWN");
  });
});
