import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { VALUE_METRIC_CATALOG, composeValueReport, describeValueLoops, evaluateBuilderLoopReadiness, proposeOpsActions, type ValueMeasurement, type ValueReport } from "@jarvis/executive";
import { VALUE_PROBES, VALUE_SOURCE_IDS, createValueMeasurementSource } from "../src/value-source.ts";

/**
 * WP-C4: Value Center-kilden mot ekte Postgres som app-rolle (RLS, kun lesing). Beviser: riktige tall per vindu (hele lokale døgn i Europe/Oslo), tenant- og rom-isolasjon, at en spørring som feiler kun gjør SINE
 * metrikker ikke målbare (aldri 0), at rapporten for en tenant med sensitive data KUN inneholder tall, og at kilden ikke skriver.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
const T = "tenant-wpc4";
const OTHER = "tenant-annen";
const EMPTY = "tenant-tom";
// 2026-10-09 10:00Z = 12:00 lokal tid (sommertid). 7-døgnsvinduet starter 03.10 00:00 lokal = 02.10 22:00Z; 30-døgnsvinduet 10.09 00:00 lokal = 09.09 22:00Z.
const NOW = new Date("2026-10-09T10:00:00.000Z");
const SENSITIVE = ["hunter2-HEMMELIG", "SENSITIVT-INNHOLD-X1", "diagnose-kreft-Y2", "passord-Z3", "TITTEL-LEKKASJE-W4"];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpc4-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpc4 LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_wpc4");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','WPC4','person'), ('${OTHER}','Annen','person'), ('${EMPTY}','Tom','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias'), ('person-annen','Annen');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${T}'), ('person-annen','${OTHER}');
    INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id, status) VALUES
      ('s1','${T}','person-tobias','web','d1','active'), ('s2','${T}','person-tobias','telegram','d1','closed'), ('s3','${OTHER}','person-annen','web','d9','active');
  `);
  const at = (iso: string) => iso;

  // ---- samtaler: brukermeldinger (assistent og andre tenanter skal ikke telle) ----
  const msg = (id: string, tenant: string, session: string, role: string, iso: string, content = "vanlig melding") =>
    admin.query(`INSERT INTO messages (message_id, tenant_id, session_id, role, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, tenant, session, role, content, at(iso)]);
  await msg("m1", T, "s1", "user", "2026-10-09T08:00:00Z", `Passordet mitt er ${SENSITIVE[0]}`);
  await msg("m2", T, "s1", "user", "2026-10-09T09:00:00Z", SENSITIVE[1]!);
  await msg("m3", T, "s2", "user", "2026-10-08T12:00:00Z", `Jeg har ${SENSITIVE[2]}`);
  await msg("m4", T, "s2", "user", "2026-10-05T12:00:00Z");
  await msg("m5", T, "s1", "user", "2026-10-02T22:30:00Z"); // 03.10 00:30 lokal: INNE i 7-døgnsvinduet (første lokale døgn)
  await msg("m6", T, "s1", "user", "2026-10-02T21:30:00Z"); // 02.10 23:30 lokal: UTE av 7 døgn, inne i 30
  await msg("m7", T, "s1", "user", "2026-09-20T12:00:00Z");
  await msg("m8", T, "s1", "user", "2026-09-09T21:00:00Z"); // 09.09 23:00 lokal: før 30-døgnsvinduet
  await msg("m9", T, "s1", "assistant", "2026-10-09T08:00:05Z", SENSITIVE[0]!);
  await msg("m10", OTHER, "s3", "user", "2026-10-09T08:00:00Z");

  // ---- kostnad og modellkall ----
  const cost = (iso: string, tenant: string, kind: string, ore: number, extra: { task?: string; purpose?: string; success?: boolean; tools?: number } = {}) =>
    admin.query(`INSERT INTO cost_events (at, tenant_id, task_id, kind, amount_ore, purpose, success, tool_calls) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [at(iso), tenant, extra.task ?? null, kind, ore, extra.purpose ?? null, extra.success ?? true, extra.tools ?? 0]);
  for (const iso of ["2026-10-09T05:00:00Z", "2026-10-09T05:30:00Z", "2026-10-08T05:00:00Z", "2026-10-07T05:00:00Z", "2026-10-05T05:00:00Z", "2026-09-25T05:00:00Z", "2026-09-20T05:00:00Z"]) await cost(iso, T, "brief:generation", 0);
  await cost("2026-10-09T05:00:00Z", OTHER, "brief:generation", 0);
  // CHAT: 7 d = 4 vellykkede (2 ba om verktøy) + 1 feilet; 30 d = 5 vellykkede (3 ba om verktøy). 5 øre per vellykket kall.
  await cost("2026-10-09T09:00:00Z", T, "model:local", 5, { purpose: "CHAT", tools: 2 });
  await cost("2026-10-09T09:01:00Z", T, "model:local", 5, { purpose: "CHAT", tools: 0 });
  await cost("2026-10-08T09:00:00Z", T, "model:local", 5, { purpose: "CHAT", tools: 1 });
  await cost("2026-10-08T09:05:00Z", T, "model:failed:timeout", 0, { purpose: "CHAT", success: false, tools: 3 });
  await cost("2026-10-05T09:00:00Z", T, "model:local", 5, { purpose: "CHAT", tools: 0 });
  await cost("2026-09-20T09:00:00Z", T, "model:local", 5, { purpose: "CHAT", tools: 1 });
  // Jobbkost: 120 + 80 siste 7 d, +100 i 30 d. Annens kost og rader utenfor 30 d skal ikke telle.
  await cost("2026-10-08T11:00:00Z", T, "model:anthropic", 120, { task: "t1", purpose: "BACKGROUND" });
  await cost("2026-10-09T08:30:00Z", T, "model:anthropic", 80, { task: "t2", purpose: "BACKGROUND" });
  await cost("2026-09-20T11:00:00Z", T, "model:anthropic", 100, { task: "t8", purpose: "BACKGROUND" });
  await cost("2026-09-01T11:00:00Z", T, "model:anthropic", 7777, { task: "t9", purpose: "BACKGROUND" });
  await cost("2026-10-09T08:30:00Z", OTHER, "model:anthropic", 999999, { task: "tx", purpose: "CHAT" });
  // Totalt T: 7 d = 5*3 (CHAT: 3 vellykkede à 5 + ... se beregning i testen) -> regnes i testen.

  // ---- levering av Daily Brief (tool_executions) ----
  const exec = (tenant: string, key: string, status: string, iso: string, tool = "telegram", action = "notify") =>
    admin.query(`INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, executed_at) VALUES ($1,$2,$3,$4,$5,$6)`, [tenant, key, tool, action, status, at(iso)]);
  await exec(T, "brief-2026-10-09T05:00:03.123Z-0", "succeeded", "2026-10-09T05:00:04Z");
  await exec(T, "brief-2026-10-09T05:00:03.123Z-1", "succeeded", "2026-10-09T05:00:05Z"); // del 2 av samme brief: teller ikke
  await exec(T, "brief-2026-10-08T05:00:02.000Z-0", "succeeded", "2026-10-08T05:00:03Z");
  await exec(T, "brief-2026-10-07T05:00:02.000Z-0", "failed", "2026-10-07T05:00:03Z");
  await exec(T, "brief-2026-09-20T05:00:00.000Z-0", "succeeded", "2026-09-20T05:00:01Z");
  await exec(T, `business-weekly-brief-${T}-2026-10-05T05:00:00.000Z-0`, "succeeded", "2026-10-05T05:00:01Z");
  await exec(T, "brief-2026-10-06T05:00:00.000Z-0", "succeeded", "2026-10-06T05:00:01Z", "email", "send"); // feil verktøy
  await exec(OTHER, "brief-2026-10-09T05:00:03.123Z-0", "succeeded", "2026-10-09T05:00:04Z");

  // ---- daglig løper (global tabell) ----
  const sched = (job: string, date: string, completed: string | null, attempts: number) =>
    admin.query(`INSERT INTO scheduler_state (job_name, run_date, claimed_by, completed_at, attempts) VALUES ($1,$2,'test',$3,$4)`, [job, date, completed, attempts]);
  await sched("daily-brief", "2026-10-09", null, 1); // i dag, ikke fullført: IKKE tapt
  await sched("daily-brief", "2026-10-08", "2026-10-08T05:01:00Z", 1);
  await sched("daily-brief", "2026-10-07", "2026-10-07T05:02:00Z", 2);
  await sched("daily-brief", "2026-10-06", null, 4); // tapt (ga opp)
  await sched("daily-brief", "2026-10-05", "2026-10-05T05:01:00Z", 1);
  await sched("daily-brief", "2026-09-20", "2026-09-20T05:01:00Z", 1);
  await sched("daily-brief", "2026-09-15", null, 4); // tapt, kun 30 d
  await sched("daily-brief", "2026-09-09", "2026-09-09T05:01:00Z", 1); // utenfor 30 d
  await sched("connector-health-sweep", "2026-10-08", null, 4); // annen jobb: ignoreres

  // ---- oppfølginger og løkker (rom-skopet) ----
  const fu = (id: string, tenant: string, space: string, status: string, due: string, created: string, extra: { completed?: string; cancelled?: string; title?: string } = {}) =>
    admin.query(
      `INSERT INTO business_followups (followup_id, tenant_id, memory_space_id, title, reason, due_at, status, created_at, completed_at, cancelled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, tenant, space, extra.title ?? SENSITIVE[4], SENSITIVE[3], at(due), status, at(created), extra.completed ? at(extra.completed) : null, extra.cancelled ? at(extra.cancelled) : null]
    );
  await fu("f1", T, "business", "open", "2026-10-07T10:00:00Z", "2026-10-01T10:00:00Z");
  await fu("f2", T, "personal", "open", "2026-10-12T10:00:00Z", "2026-10-08T10:00:00Z");
  await fu("f3", T, "business", "completed", "2026-10-01T10:00:00Z", "2026-09-25T10:00:00Z", { completed: "2026-10-08T10:00:00Z" });
  await fu("f4", T, "business", "cancelled", "2026-10-03T10:00:00Z", "2026-10-02T10:00:00Z", { cancelled: "2026-10-06T10:00:00Z" });
  await fu("f5", T, "health", "open", "2026-10-01T10:00:00Z", "2026-09-30T10:00:00Z"); // helse: leses aldri
  await fu("f6", OTHER, "business", "open", "2026-10-01T10:00:00Z", "2026-09-30T10:00:00Z");
  await fu("f7", T, "guest", "open", "2026-10-01T10:00:00Z", "2026-09-30T10:00:00Z"); // gjest: leses aldri
  const loop = (id: string, tenant: string, space: string, status: string, due: string | null, extra: { resolved?: string } = {}) =>
    admin.query(
      `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, priority, status, due_at, resolved_at) VALUES ($1,$2,$3,'overdue_followup',$4,$5,'normal',$6,$7,$8)`,
      [id, tenant, space, `k-${id}`, SENSITIVE[3], status, due ? at(due) : null, extra.resolved ? at(extra.resolved) : null]
    );
  await loop("ol1", T, "business", "open", "2026-10-08T10:00:00Z");
  await loop("ol2", T, "business", "open", null);
  await loop("ol3", T, "business", "resolved", "2026-10-01T10:00:00Z", { resolved: "2026-10-08T10:00:00Z" });
  await loop("ol4", T, "personal", "resolved", "2026-09-12T10:00:00Z", { resolved: "2026-09-15T10:00:00Z" });
  await loop("ol5", OTHER, "business", "open", "2026-10-01T10:00:00Z");
  await loop("ol6", T, "health", "open", "2026-10-01T10:00:00Z");

  // ---- påminnelser (push) i revisjonssporet ----
  const audit = (tenant: string, person: string, type: string, iso: string, payload: Record<string, unknown>) =>
    admin.query(`INSERT INTO audit_events (tenant_id, person_id, type, payload, at) VALUES ($1,$2,$3,$4,$5)`, [tenant, person, type, JSON.stringify(payload), at(iso)]);
  await audit(T, "person-tobias", "followup.push_sent", "2026-10-09T09:00:00Z", { count: 3, message_key: "k1" });
  await audit(T, "person-tobias", "followup.push_sent", "2026-10-08T09:00:00Z", { count: "abc" }); // ugyldig count: teller som melding, 0 løkker
  await audit(T, "person-tobias", "followup.push_sent", "2026-10-05T09:00:00Z", { count: 2 });
  await audit(T, "person-tobias", "followup.push_sent", "2026-09-20T09:00:00Z", { count: 4 });
  await audit(T, "person-tobias", "followup.push_reserved", "2026-10-09T08:59:00Z", { count: 9 }); // reservasjon: teller ikke
  await audit(OTHER, "person-annen", "followup.push_sent", "2026-10-09T09:00:00Z", { count: 50 });

  // ---- jobber ----
  const task = (id: string, tenant: string, status: string, created: string, finished: string | null, notBefore: string | null = null) =>
    admin.query(`INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract, created_at, finished_at, not_before) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, tenant, tenant === T ? "person-tobias" : "person-annen", `mål: ${SENSITIVE[0]}`, status, JSON.stringify({ input: { data: { prompt: SENSITIVE[2] } } }), at(created), finished ? at(finished) : null, notBefore ? at(notBefore) : null]);
  await task("t1", T, "completed", "2026-10-08T09:00:00Z", "2026-10-08T10:00:00Z");
  await task("t2", T, "completed", "2026-10-09T08:00:00Z", "2026-10-09T08:20:00Z");
  await task("t3", T, "failed", "2026-10-07T09:00:00Z", "2026-10-07T09:30:00Z");
  await task("t4", T, "created", "2026-10-09T09:00:00Z", null); // venter 60 min
  await task("t5", T, "created", "2026-10-09T09:50:00Z", null); // venter 10 min
  await task("t6", T, "created", "2026-10-09T08:00:00Z", null, "2026-10-10T08:00:00Z"); // utsatt
  await task("t7", T, "running", "2026-10-09T07:00:00Z", null);
  await task("t8", T, "completed", "2026-09-20T09:00:00Z", "2026-09-20T10:00:00Z");
  await task("t9", T, "failed", "2026-09-05T09:00:00Z", "2026-09-05T10:00:00Z"); // utenfor 30 d
  await task("tx", OTHER, "completed", "2026-10-08T09:00:00Z", "2026-10-08T10:00:00Z");

  // ---- bekreftelser og signerte godkjenninger ----
  const conf = (id: string, tenant: string, status: string, created: string, decided: string | null, expires: string) =>
    admin.query(
      `INSERT INTO action_confirmations (confirmation_id, tenant_id, person_id, tool_id, action, call_fingerprint, binding_hash, nonce, summary, expires_at, created_at, status, decided_at)
       VALUES ($1,$2,'person-tobias','business','create_followup','fp','bh',$3,$4,$5,$6,$7,$8)`,
      [id, tenant, `n-${id}`, JSON.stringify({ parameters_preview: SENSITIVE[3] }), at(expires), at(created), status, decided ? at(decided) : null]
    );
  await conf("c1", T, "consumed", "2026-10-09T09:00:00Z", "2026-10-09T09:01:00Z", "2026-10-09T09:05:00Z"); // 60 s
  await conf("c2", T, "rejected", "2026-10-08T09:00:00Z", "2026-10-08T09:03:00Z", "2026-10-08T09:05:00Z"); // 180 s
  await conf("c3", T, "pending", "2026-10-08T10:00:00Z", null, "2026-10-08T10:05:00Z"); // utløpt uten svar
  await conf("c4", T, "expired", "2026-10-05T12:00:00Z", null, "2026-10-05T12:05:00Z");
  await conf("c5", T, "expired", "2026-10-05T11:00:00Z", "2026-10-05T11:00:30Z", "2026-10-05T11:05:00Z"); // godkjent (30 s), så utløpt ubrukt
  await conf("c6", T, "consumed", "2026-09-20T12:00:00Z", "2026-09-20T12:02:00Z", "2026-09-20T12:05:00Z"); // 120 s
  await conf("c7", OTHER, "consumed", "2026-10-09T09:00:00Z", "2026-10-09T09:00:10Z", "2026-10-09T09:05:00Z");
  const approval = (nonce: string, tenant: string, iso: string) =>
    admin.query(`INSERT INTO approvals (nonce, tenant_id, action, parameters, approving_device_id, expires_at, consumed_at) VALUES ($1,$2,'docker.stop_container','{}','dev',$3,$3)`, [nonce, tenant, at(iso)]);
  await approval("a1", T, "2026-10-09T07:00:00Z");
  await approval("a2", T, "2026-10-05T07:00:00Z");
  await approval("a3", T, "2026-09-20T07:00:00Z");
  await approval("a4", OTHER, "2026-10-09T07:00:00Z");

  // ---- hendelser ----
  const inc = (id: string, tenant: string, space: string, status: string) =>
    admin.query(`INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, status) VALUES ($1,$2,$3,$4,$5)`, [id, tenant, space, SENSITIVE[4], status]);
  await inc("i1", T, "project", "open");
  await inc("i2", T, "project", "resolved");
  await inc("i3", T, "personal", "diagnosing");
  await inc("i4", T, "health", "open");
  await inc("i6", T, "guest", "open"); // gjest: leses aldri
  await inc("i5", OTHER, "project", "open");

  app = createPool({ ...base, user: "jarvis_wpc4", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const source = (over: { schedulerTenantId?: string | null; pool?: pg.Pool } = {}) =>
  createValueMeasurementSource(over.pool ?? app, { now: () => NOW, ttlMs: 60_000, schedulerTenantId: over.schedulerTenantId === undefined ? T : over.schedulerTenantId });
const byId = (ms: ValueMeasurement[]) => new Map(ms.map((m) => [m.id, m]));
function expectWin(ms: Map<string, ValueMeasurement>, id: string, d7: number | null, d30: number | null): void {
  expect(ms.get(id), id).toEqual({ id, state: "measured", last_7d: d7, last_30d: d30 });
}
function expectNow(ms: Map<string, ValueMeasurement>, id: string, now: number | null): void {
  expect(ms.get(id), id).toEqual({ id, state: "measured", now });
}

describe("dekning: kilden leverer nøyaktig det katalogen forventer", () => {
  it("probenes id-er er unike og dekker alle kildebaserte katalogmetrikker (ikke avledede, ikke «aldri målbare»)", () => {
    expect(new Set(VALUE_SOURCE_IDS).size).toBe(VALUE_SOURCE_IDS.length);
    const sourceBased = VALUE_METRIC_CATALOG.filter((d) => d.derive === undefined && d.never_measurable_reason_no === undefined).map((d) => d.id).sort();
    expect([...VALUE_SOURCE_IDS].sort()).toEqual(sourceBased);
    expect(VALUE_PROBES.length).toBeGreaterThan(10);
  });
});

describe("målinger (ekte Postgres, app-rolle, RLS)", () => {
  it("vinduer: hele lokale døgn i Europe/Oslo, i dag inkludert (sommertid)", async () => {
    const set = await source().measure(T);
    expect(set.windows.d7.from).toBe("2026-10-02T22:00:00.000Z");
    expect(set.windows.d30.from).toBe("2026-09-09T22:00:00.000Z");
    expect(set.windows.d7.to).toBe(NOW.toISOString());
  });

  it("vinduer følger vintertid (UTC+1) og overgangen: 28.10 kl. 12:00 lokal -> 7-døgnsvinduet starter 22.10 00:00 lokal = 21.10 22:00Z", async () => {
    const winter = createValueMeasurementSource(app, { now: () => new Date("2026-10-28T11:00:00Z"), ttlMs: 0 });
    const set = await winter.measure(T);
    expect(set.windows.d7.from).toBe("2026-10-21T22:00:00.000Z"); // 22.10 00:00 lokal (ennå sommertid til 25.10 03:00)
    expect(set.windows.d30.from).toBe("2026-09-28T22:00:00.000Z"); // 29.09 00:00 lokal (sommertid)
    const jan = createValueMeasurementSource(app, { now: () => new Date("2027-01-20T11:00:00Z"), ttlMs: 0 });
    const w2 = (await jan.measure(T)).windows;
    expect(w2.d7.from).toBe("2027-01-13T23:00:00.000Z"); // 14.01 00:00 lokal (UTC+1)
  });

  it("V1: briefer generert/levert, døgn med brief og daglig løper (global tabell, kun for eierens tenant)", async () => {
    const ms = byId((await source().measure(T)).measurements);
    expectWin(ms, "v1.briefs_generated", 5, 7);
    expectWin(ms, "v1.days_with_brief", 4, 6);
    expectWin(ms, "v1.briefs_delivered", 2, 3); // 09.10 og 08.10; 30 d + 20.09. Del -1, feilet, ukeskrift, feil verktøy og annen tenant teller ikke.
    expectWin(ms, "v1.runner_days_completed", 3, 4);
    expectWin(ms, "v1.runner_days_lost", 1, 2); // 06.10 (7 d) + 15.09 (30 d); i dag og andre jobber telles ikke
    expectWin(ms, "v1.runner_retry_days", 2, 3); // 07.10 (2 forsøk) og 06.10 (4 forsøk); 30 d: + 15.09 (4 forsøk)
  });

  it("den daglige løperen vises IKKE for en annen tenant (delt tabell uten tenant-skille) - og uten schedulerTenantId vises den aldri", async () => {
    const other = byId((await source().measure(OTHER)).measurements);
    for (const id of ["v1.runner_days_completed", "v1.runner_days_lost", "v1.runner_retry_days"]) {
      expect(other.get(id)).toMatchObject({ state: "not_measurable" });
      expect((other.get(id) as { reason_no: string }).reason_no).toContain("delt tabell uten tenant-skille");
    }
    const none = byId((await source({ schedulerTenantId: null }).measure(T)).measurements);
    expect(none.get("v1.runner_days_completed")).toMatchObject({ state: "not_measurable" });
  });

  it("V2: oppfølginger og løkker (alle rom unntatt helse/gjest), alder, fullførte/avbrutte og påminnelser", async () => {
    const ms = byId((await source().measure(T)).measurements);
    expectNow(ms, "v2.followups_open_now", 2); // f1 (business) + f2 (personal); f5 (helse) og f7 (gjest) leses aldri
    expectNow(ms, "v2.followups_overdue_now", 1);
    expectNow(ms, "v2.followups_avg_open_age_days", 4.5); // (8 + 1) / 2 døgn
    expectNow(ms, "v2.followups_max_overdue_days", 2);
    expectWin(ms, "v2.followups_created", 1, 4);
    expectWin(ms, "v2.followups_closed", 1, 1);
    expectWin(ms, "v2.followups_cancelled", 1, 1);
    expectNow(ms, "v2.open_loops_open_now", 2);
    expectNow(ms, "v2.open_loops_overdue_now", 1);
    expectWin(ms, "v2.open_loops_resolved", 1, 2);
    expectWin(ms, "v2.reminder_messages_sent", 3, 4);
    expectWin(ms, "v2.reminders_sent", 5, 9); // ugyldig count regnes som 0 løkker; reservasjoner og annens tenant telles ikke
  });

  it("jobber: opprettet/fullført/feilet, åpne nå og kø-stau (kun jobber som er klare og har ventet over 15 min)", async () => {
    const ms = byId((await source().measure(T)).measurements);
    expectWin(ms, "tasks.created", 7, 8);
    expectWin(ms, "tasks.completed", 2, 3);
    expectWin(ms, "tasks.failed", 1, 1);
    expectNow(ms, "tasks.open_now", 4); // t4, t5, t6, t7
    expectNow(ms, "ops.tasks_waiting_over_15m_now", 1); // t4; t5 har ventet 10 min, t6 er utsatt
    expectWin(ms, "tasks.cost_ore", 200, 300);
  });

  it("samtaler: meldinger fra eieren, økter og døgn med bruk (grensetilfeller rundt midnatt lokal tid)", async () => {
    const ms = byId((await source().measure(T)).measurements);
    expectWin(ms, "chat.user_messages", 5, 7); // m6 (23:30 lokal 02.10) er utenfor 7 d; m8 er før 30 d; assistent og annen tenant teller ikke
    expectWin(ms, "chat.sessions", 2, 2);
    expectWin(ms, "chat.active_days", 4, 6); // 7 d: 09.10, 08.10, 05.10, 03.10 · 30 d: + 02.10, 20.09
    expectWin(ms, "chat.model_calls", 4, 5);
    expectWin(ms, "chat.tool_requesting_calls", 2, 3); // feilet kall med verktøy teller ikke
  });

  it("bekreftelser: forespurt/godkjent/avvist/utløpt og gjennomsnittlig svartid (kun avgjorte); signerte godkjenninger", async () => {
    const ms = byId((await source().measure(T)).measurements);
    expectWin(ms, "approvals.confirmations_requested", 5, 6);
    expectWin(ms, "approvals.confirmations_approved", 2, 3); // c1, c5 (godkjent så utløpt) · + c6
    expectWin(ms, "approvals.confirmations_rejected", 1, 1);
    expectWin(ms, "approvals.confirmations_expired", 2, 2); // c3 (pending etter utløp), c4
    expectWin(ms, "approvals.avg_response_seconds", 90, 97.5);
    expectWin(ms, "approvals.signed_used", 2, 3);
  });

  it("kost og drift: total modellkost og åpne hendelser (rom-skopet, helse utelatt)", async () => {
    const ms = byId((await source().measure(T)).measurements);
    expectWin(ms, "cost.model_total_ore", 4 * 5 + 120 + 80, 5 * 5 + 120 + 80 + 100); // CHAT 4 (7 d) / 5 (30 d) à 5 øre + jobbkost; 7777 øre fra 01.09 og annens 999999 teller ikke
    expectNow(ms, "ops.incidents_open_now", 2); // i1 (project) + i3 (personal, diagnosing); i4 (helse) og i6 (gjest) leses aldri
  });

  it("avgjort ingen grunnlag: snitt/maks er null (aldri 0) når det ikke finnes åpne/forfalte/avgjorte rader", async () => {
    const ms = byId((await source({ schedulerTenantId: EMPTY }).measure(EMPTY)).measurements);
    expectNow(ms, "v2.followups_avg_open_age_days", null);
    expectNow(ms, "v2.followups_max_overdue_days", null);
    expectWin(ms, "approvals.avg_response_seconds", null, null);
    // ...mens tellinger er SANNE nuller (kilden er lesbar).
    expectWin(ms, "tasks.created", 0, 0);
    expectNow(ms, "v2.followups_open_now", 0);
  });
});

describe("tenant-isolasjon (RLS): en annen tenant ser kun sine egne rader", () => {
  it("annen tenant får sine egne tall - ingenting fra eierens tenant", async () => {
    const ms = byId((await source().measure(OTHER)).measurements);
    expectWin(ms, "chat.user_messages", 1, 1);
    expectWin(ms, "tasks.created", 1, 1);
    expectWin(ms, "tasks.completed", 1, 1);
    expectWin(ms, "approvals.confirmations_requested", 1, 1);
    expectWin(ms, "approvals.signed_used", 1, 1);
    expectWin(ms, "v1.briefs_generated", 1, 1);
    expectWin(ms, "v1.briefs_delivered", 1, 1);
    expectNow(ms, "v2.followups_open_now", 1);
    expectNow(ms, "v2.open_loops_open_now", 1);
    expectWin(ms, "v2.reminders_sent", 50, 50);
    expectNow(ms, "ops.incidents_open_now", 1);
  });

  it("en tenant uten data ser kun nuller/null - ingen rad lekker over", async () => {
    const ms = byId((await source().measure(EMPTY)).measurements);
    for (const m of ms.values()) {
      if (m.state !== "measured") continue;
      for (const v of [m.now, m.last_7d, m.last_30d]) expect(v === undefined || v === null || v === 0, `${m.id}=${v}`).toBe(true);
    }
  });

  it("en ukjent tenant-id (oppdiktet) ser ingenting", async () => {
    const ms = byId((await source().measure("tenant-finnes-ikke")).measurements);
    expectWin(ms, "chat.user_messages", 0, 0);
    expectNow(ms, "ops.incidents_open_now", 0);
  });
});

describe("feil i én spørring gjør kun SINE metrikker ikke målbare", () => {
  it("manglende SELECT-rettighet på approvals: signed_used er ikke målbar (feilkode 42501), alt annet er fortsatt målt - aldri 0", async () => {
    await admin.query("REVOKE SELECT ON approvals FROM jarvis_app");
    try {
      const fresh = createValueMeasurementSource(app, { now: () => NOW, ttlMs: 0, schedulerTenantId: T });
      const ms = byId((await fresh.measure(T)).measurements);
      expect(ms.get("approvals.signed_used")).toEqual({ id: "approvals.signed_used", state: "not_measurable", reason_no: "kilden er utilgjengelig (feilkode 42501)" });
      expectWin(ms, "tasks.created", 7, 8);
      expectWin(ms, "chat.user_messages", 5, 7);
      const report = composeValueReport({ as_of: NOW.toISOString(), windows: (await fresh.measure(T)).windows, measurements: [...ms.values()], loops: describeValueLoops(null), builder_loop: evaluateBuilderLoopReadiness({ constitution_verified: null, ledger_ok: null, change_freeze: null, github_connector_healthy: null, declared_gates: [] }), ops_proposals: proposeOpsActions({ enabled: false, slo: null, observations: null, connectors: null, tasks_waiting_over_15m: null }) });
      const metric = report.metrics.find((m) => m.id === "approvals.signed_used");
      expect(metric).toMatchObject({ state: "not_measurable", last_7d: null, last_30d: null });
      expect(report.summary_no).toContain("Signerte godkjenninger brukt (klasse D): ikke målbart (kilden er utilgjengelig (feilkode 42501))");
    } finally {
      await admin.query("GRANT SELECT ON approvals TO jarvis_app");
    }
  });

  it("feilmeldingen (som kan sitere SQL/data) når aldri rapporten - kun SQLSTATE", async () => {
    await admin.query("REVOKE SELECT ON incidents FROM jarvis_app");
    try {
      const ms = byId((await createValueMeasurementSource(app, { now: () => NOW, ttlMs: 0 }).measure(T)).measurements);
      const m = ms.get("ops.incidents_open_now") as { reason_no: string };
      expect(m.reason_no).toBe("kilden er utilgjengelig (feilkode 42501)");
      expect(m.reason_no).not.toMatch(/permission denied|incidents|relation/i);
    } finally {
      await admin.query("GRANT SELECT ON incidents TO jarvis_app");
    }
  });

  it("databasen helt nede: measure kaster (vinduene kan ikke regnes) - tjenesten gjør det om til «kilden er utilgjengelig» for hele rapporten", async () => {
    const dead = new pg.Pool({ host: "127.0.0.1", port: 1, database: "x", user: "x", connectionTimeoutMillis: 300 });
    dead.on("error", () => undefined);
    await expect(createValueMeasurementSource(dead, { now: () => NOW, ttlMs: 0 }).measure(T)).rejects.toThrow();
    await dead.end();
  });
});

describe("buffer: kort TTL per tenant", () => {
  it("samme tenant innen TTL gir samme objekt (én aggregering); en annen tenant får sin egen; utløpt TTL gir ny måling", async () => {
    let t = NOW.getTime();
    const s = createValueMeasurementSource(app, { now: () => new Date(t), ttlMs: 30_000, schedulerTenantId: T });
    const a = await s.measure(T);
    expect(await s.measure(T)).toBe(a);
    expect(await s.measure(OTHER)).not.toBe(a);
    t += 31_000;
    const b = await s.measure(T);
    expect(b).not.toBe(a);
    expect(b.measurements).toEqual(a.measurements);
  });
});

describe("ingen innhold i rapporten (sensitive data i kildene gir kun tall)", () => {
  async function fullReport(): Promise<ValueReport> {
    const set = await source().measure(T);
    return composeValueReport({
      as_of: NOW.toISOString(), windows: set.windows, measurements: set.measurements, loops: describeValueLoops(null),
      builder_loop: evaluateBuilderLoopReadiness({ constitution_verified: null, ledger_ok: null, change_freeze: null, github_connector_healthy: null, declared_gates: [] }),
      ops_proposals: proposeOpsActions({ enabled: false, slo: null, observations: null, connectors: null, tasks_waiting_over_15m: null })
    });
  }

  it("verken målingene eller den ferdige rapporten (JSON og norsk tekst) inneholder noe av det sensitive innholdet", async () => {
    const set = await source().measure(T);
    const report = await fullReport();
    const haystack = JSON.stringify(set) + JSON.stringify(report) + report.summary_no;
    for (const secret of SENSITIVE) expect(haystack, secret).not.toContain(secret);
    for (const word of ["Passordet", "Jeg har", "mål:", "create_followup", "docker.stop_container", "business-weekly"]) expect(haystack, word).not.toContain(word);
  });

  it("alle verdier i målingene er tall eller null; alle tekster er faste (id-er og årsaker fra koden)", async () => {
    const set = await source().measure(T);
    for (const m of set.measurements) {
      if (m.state === "measured") for (const v of [m.now, m.last_7d, m.last_30d]) expect(v === undefined || v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0), `${m.id}=${String(v)}`).toBe(true);
      else expect(m.reason_no).toMatch(/^[a-zæøå0-9 ()\-,.:]+$/i);
      expect(m.id).toMatch(/^[a-z0-9]+\.[a-z0-9_]+$/);
    }
  });

  it("SQL-en leser aldri en innholdskolonne: ingen content/goal/title/subject/summary/reason/contract/last_error/payload (unntatt payload->>'count') i spørringene", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/value-source.ts", import.meta.url)), "utf8");
    const sqls = [...src.matchAll(/`([^`]*\b(?:SELECT|FROM)\b[^`]*)`/g)].map((m) => m[1] as string).filter((s) => /\bSELECT\b/.test(s));
    expect(sqls.length).toBeGreaterThanOrEqual(15);
    for (const sql of sqls) {
      const cleaned = sql.replace(/payload->>'count'/g, "COUNTCOL");
      expect(cleaned, sql).not.toMatch(/\b(content|goal|title|subject|summary|reason|contract|last_error|payload|body|display_name|message|result|parameters|canonical_uri|next_action)\b/i);
      expect(cleaned, sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    }
  });
});

describe("kun lesing", () => {
  it("kilden skriver ingenting: radantall i alle berørte tabeller er uendret etter flere målinger", async () => {
    const tables = ["cost_events", "tool_executions", "scheduler_state", "messages", "tasks", "action_confirmations", "approvals", "audit_events", "business_followups", "business_open_loops", "incidents"];
    const count = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)])));
    const before = await count();
    const s = createValueMeasurementSource(app, { now: () => NOW, ttlMs: 0, schedulerTenantId: T });
    await s.measure(T);
    await s.measure(OTHER);
    expect(await count()).toEqual(before);
  });

  it("app-rollen kan ikke skrive til tabellene kilden leser fra den veien (append-only/ingen UPDATE) - kilden bruker kun SELECT", async () => {
    await expect(app.query("UPDATE messages SET content = 'x'")).rejects.toThrow();
    await expect(app.query("DELETE FROM audit_events")).rejects.toThrow();
  });
});
