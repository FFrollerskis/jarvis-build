import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { createPrivacyCenter, parseProcessingInventory, readLiveTables, readRetentionBacklog } from "../src/control-center/privacy.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H2 Privacy Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder) og mot det EKTE behandlingsoversikt-dokumentet. Beviser at:
 *  - de levende tabellene i databasen (pg_tables) alle står i `docs/security/PROCESSING_INVENTORY.md` - runtime-ekvivalenten til CI-vakten D-420, mot den faktiske skjemaversjonen;
 *  - oppbevaringsetterslepet og de eldste radene leses tenant-isolert (A ser aldri B sine rader), og sveipjobbene leses fra scheduler_state;
 *  - slettebevisene (erasure_requests/-fingerprints) er A sine alene;
 *  - innholdsvern: ingen revisjons-/slette-innhold når rapporten; senteret skriver ingenting.
 */
let db: H0Db;
const TENANT_A = "tenant-pv-a";
const TENANT_B = "tenant-pv-b";
const NOW = new Date();
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const idA: IdentityContext = { person_id: "person-pv-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "dev-pv-a", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-pv-b", tenant_id: TENANT_B, device_id: "dev-pv-b" };
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SECRET_SCOPE = "scope-med-personnavn-Hemmelig-Person";

const counts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of ["tool_executions", "session_grants", "erasure_requests", "erasure_fingerprints", "audit_events", "cost_events"]) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
};

beforeAll(async () => {
  db = await startH0Db("pv");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }]);
  // verktøyutføringer: A har 2 som er for gamle (over 182 d) og 1 ferskt; B har 5 for gamle
  const exec = (tenant: string, key: string, status: string, executedAt: Date): Promise<unknown> =>
    admin.query("INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, executed_at) VALUES ($1,$2,'t','a',$3,$4)", [tenant, key, status, executedAt]);
  await exec(TENANT_A, "a-old-1", "succeeded", ago(300 * D));
  await exec(TENANT_A, "a-old-2", "failed", ago(200 * D));
  await exec(TENANT_A, "a-fresh", "succeeded", ago(2 * D));
  for (let i = 0; i < 5; i += 1) await exec(TENANT_B, `b-old-${i}`, "succeeded", ago(400 * D));
  // grants som er utløpt for lenge siden (A: 1, B: 2) - krever enhet og sesjon
  for (const [tenant, person, dev, sess] of [[TENANT_A, idA.person_id, "dev-pv-a", "sess-pv-a"], [TENANT_B, idB.person_id, "dev-pv-b", "sess-pv-b"]] as const) {
    await admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,'web','pem')", [dev, tenant, person]);
    await admin.query("INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES ($1,$2,$3,'active','web',$4)", [sess, tenant, person, dev]);
  }
  const grant = (id: string, tenant: string, person: string, dev: string, sess: string, expires: Date): Promise<unknown> =>
    admin.query("INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,'personal','web','signed','fp',$6,$7)", [id, tenant, person, dev, sess, ago(200 * D), expires]);
  await grant("g-a-old", TENANT_A, idA.person_id, "dev-pv-a", "sess-pv-a", ago(100 * D));
  await grant("g-a-live", TENANT_A, idA.person_id, "dev-pv-a", "sess-pv-a", new Date(NOW.getTime() + D));
  await grant("g-b-old-1", TENANT_B, idB.person_id, "dev-pv-b", "sess-pv-b", ago(90 * D));
  await grant("g-b-old-2", TENANT_B, idB.person_id, "dev-pv-b", "sess-pv-b", ago(80 * D));
  // eldste rader i tabellene uten automatisk sletting
  await admin.query("INSERT INTO audit_events (tenant_id, person_id, type, at, payload) VALUES ($1,$2,'tool.executed',$3,'{\"hemmelig\":\"Hemmelig-revisjonsinnhold\"}'::jsonb), ($1,$2,'tool.executed',$4,'{}'::jsonb), ($5,$6,'tool.executed',$7,'{}'::jsonb)", [TENANT_A, idA.person_id, ago(120 * D), ago(D), TENANT_B, idB.person_id, ago(900 * D)]);
  await admin.query("INSERT INTO cost_events (tenant_id, kind, amount_ore, at) VALUES ($1,'chat',10,$2), ($3,'chat',10,$4)", [TENANT_A, ago(75 * D), TENANT_B, ago(700 * D)]);
  // retensjonssveip (globale)
  const today = NOW.toISOString().slice(0, 10);
  for (const name of ["operational-retention-sweep", "memory-retention-sweep"]) await admin.query("INSERT INTO scheduler_state (job_name, run_date, claimed_by, completed_at) VALUES ($1,$2::date,'test',$3)", [name, today, ago(2 * H)]);
  // slettebevis: A har fullført + feilet + et fingeravtrykk; B har en fullført
  const erasure = (id: string, tenant: string, status: string, startedAt: Date, completedAt: Date | null): Promise<unknown> =>
    admin.query("INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status, started_at, completed_at) VALUES ($1,$2,'person',$3::jsonb,$4,$5,$6)", [id, tenant, JSON.stringify({ navn: SECRET_SCOPE }), status, startedAt, completedAt]);
  await erasure("er-a-ok", TENANT_A, "completed", ago(30 * D), ago(30 * D));
  await erasure("er-a-failed", TENANT_A, "failed", ago(3 * D), null);
  await erasure("er-b-ok", TENANT_B, "completed", ago(10 * D), ago(10 * D));
  await admin.query("INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id) VALUES ('fp-a','tenant-pv-a','gmail','i1','er-a-ok'), ('fp-b1','tenant-pv-b','gmail','i1','er-b-ok'), ('fp-b2','tenant-pv-b','gmail','i2','er-b-ok')");
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("lesere som app-rolle", () => {
  it("de levende tabellene kan leses av app-rollen, og ALLE står i behandlingsoversikten (D-420 mot den faktiske skjemaversjonen)", async () => {
    const live = await readLiveTables(db.appPool);
    expect(live.length).toBeGreaterThan(100);
    expect(live).toEqual(expect.arrayContaining(["audit_events", "tool_executions", "erasure_requests", "operations_runbooks"]));
    const parsed = parseProcessingInventory(readFileSync(`${REPO_ROOT}docs/security/PROCESSING_INVENTORY.md`, "utf8"));
    const documented = new Set(parsed.documented_tables);
    expect(live.filter((t) => !documented.has(t)), "levende tabeller uten rad i docs/security/PROCESSING_INVENTORY.md").toEqual([]);
  });

  it("oppbevaringsetterslepet er tenant-isolert: A har 2 verktøyutføringer og 1 grant som henger etter - B sine 5 og 2 er aldri med", async () => {
    const a = await readRetentionBacklog(db.appPool, TENANT_A, NOW.getTime());
    expect(a).toMatchObject({ tool_executions_overdue: 2, session_grants_overdue: 1 });
    const b = await readRetentionBacklog(db.appPool, TENANT_B, NOW.getTime());
    expect(b).toMatchObject({ tool_executions_overdue: 5, session_grants_overdue: 2 });
  });

  it("de eldste radene i tabellene uten automatisk sletting er A sine egne (revisjon 120 d, kostnad 75 d) - ikke B sine (900/700 d)", async () => {
    const a = await readRetentionBacklog(db.appPool, TENANT_A, NOW.getTime());
    const days = (iso: string | null): number => Math.round((NOW.getTime() - Date.parse(iso as string)) / D);
    expect(days(a.audit_oldest_at)).toBe(120);
    expect(days(a.cost_oldest_at)).toBe(75);
  });
});

describe("senteret over den ekte databasen og det ekte dokumentet", () => {
  const build = async (identity: IdentityContext, repoRoot = REPO_ROOT): Promise<ControlCenterReport> => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createPrivacyCenter({ pool: db.appPool, env: {}, repoRoot }));
    return (await registry.report("privacy", identity)) as ControlCenterReport;
  };
  const item = (r: ControlCenterReport, s: string, i: string) => r.sections.find((x) => x.id === s)!.items.find((x) => x.id === i)!;

  it("alle fem seksjonene er målt; dekningen er 100 % (ingen levende tabell uten rad i oversikten); oversikten er et UTKAST og alle DPIA-ene er ikke godkjent (advarsel, aldri OK)", async () => {
    const r = await build(idA);
    expect(r.sections.map((s) => s.id)).toEqual(["inventory", "processors", "dpia", "retention", "deletion_evidence"]);
    expect(r.sections.every((s) => s.measured)).toBe(true);
    expect(item(r, "inventory", "coverage")).toMatchObject({ status: "OK", facts: { undocumented: 0 } });
    expect(item(r, "inventory", "inventory_doc").status).toBe("WARN");
    expect(r.sections.find((s) => s.id === "dpia")?.items.every((i) => i.status === "WARN")).toBe(true);
    expect(r.sections.find((s) => s.id === "dpia")?.items.every((i) => (i.facts as { missing_documents: number }).missing_documents === 0)).toBe(true);
    expect(r.status).toBe("FAIL"); // A har en mislykket sletting
  });

  it("oppbevaring og slettebevis for A: etterslep som advarsel, ingen automatisk sletting for revisjon/kostnad, mislykket sletting som FEIL, og kun A sine fingeravtrykk", async () => {
    const r = await build(idA);
    expect(item(r, "retention", "backlog_tool_executions")).toMatchObject({ status: "WARN", facts: { overdue: 2 } });
    expect(item(r, "retention", "backlog_session_grants")).toMatchObject({ status: "WARN", facts: { overdue: 1 } });
    expect(item(r, "retention", "job:operational-retention-sweep").status).toBe("OK");
    expect(item(r, "retention", "job:location-retention-sweep").status).toBe("UNKNOWN"); // aldri kjørt i denne databasen
    expect(item(r, "deletion_evidence", "failed")).toMatchObject({ status: "FAIL", facts: { failed: 1 } });
    expect(item(r, "deletion_evidence", "completed").facts).toMatchObject({ completed: 1 });
    expect(item(r, "deletion_evidence", "fingerprints").facts).toMatchObject({ fingerprints: 1 });
  });

  it("tenant-isolasjon: B ser sine egne tall (5 etterslep, 2 fingeravtrykk, ingen mislykket sletting) og er ikke FEIL", async () => {
    const r = await build(idB);
    expect(item(r, "retention", "backlog_tool_executions").facts).toMatchObject({ overdue: 5 });
    expect(item(r, "deletion_evidence", "fingerprints").facts).toMatchObject({ fingerprints: 2 });
    expect(item(r, "deletion_evidence", "failed").status).toBe("OK");
    expect(r.status).not.toBe("FAIL");
  });

  it("uten dokumentet (docs/ ikke i imaget) er dokumentdelen UKJENT, mens databasedelene måles likevel", async () => {
    const r = await build(idA, "/finnes/ikke");
    expect(r.sections.find((s) => s.id === "processors")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(r.sections.find((s) => s.id === "dpia")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(r.sections.find((s) => s.id === "retention")?.measured).toBe(true);
    expect(item(r, "inventory", "coverage").status).toBe("UNKNOWN");
  });

  it("innholdsvern: revisjonsinnhold, slettemål (personnavn) og scope vises aldri; senteret skriver ingenting", async () => {
    const before = await counts();
    const text = JSON.stringify(await build(idA)) + JSON.stringify(await build(idB));
    for (const secret of ["Hemmelig-revisjonsinnhold", "Hemmelig-Person", SECRET_SCOPE]) expect(text, secret).not.toContain(secret);
    expect(await counts()).toEqual(before);
  });
});
