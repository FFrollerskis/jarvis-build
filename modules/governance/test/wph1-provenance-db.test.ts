import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { GovernanceService } from "../src/service.ts";
import type { GovernanceProvenance } from "../src/types.ts";

/**
 * WP-H1 (JARVIS-087 del 2) - migrasjon 102: proveniens på styringsjournalen, bevist mot EKTE Postgres som app-rolle (NOSUPERUSER/NOBYPASSRLS):
 *  - alle fem tabeller får proveniens i SAMME INSERT som journalraden (ingen senere oppdatering), stemplet med den injiserte klokken;
 *  - uten proveniens er alle fem kolonner NULL (eldre oppførsel; eldre rader bakdateres aldri);
 *  - databasen håndhever alt-eller-ingenting og enum-verdiene (CHECK) - selv for en rå INSERT;
 *  - tenant-isolasjon er uendret: B ser aldri A sin journal eller proveniens.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: GovernanceService;
const TENANT_A = "tenant-prov-a";
const TENANT_B = "tenant-prov-b";
const CLOCK = new Date("2026-11-14T10:00:00.000Z");
const PROV: GovernanceProvenance = { channel: "web", session_id: "sess-prov-1", task_id: null, origin: "owner_direct" };
const JOB_PROV: GovernanceProvenance = { channel: "system", session_id: "job:task-42", task_id: "task-42", origin: "model" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-governance-prov-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_gov_prov LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_gov_prov");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'A', 'business'), ('${TENANT_B}', 'B', 'business')`);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ('person-creator', 'Creator')");
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_gov_prov", password: "pw2" });
  service = new GovernanceService(appPool, { now: () => CLOCK });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const cols = (row: Record<string, unknown>) => ({ prov_channel: row["prov_channel"], prov_session_id: row["prov_session_id"], prov_task_id: row["prov_task_id"], prov_origin: row["prov_origin"], prov_recorded_at: row["prov_recorded_at"] === null || row["prov_recorded_at"] === undefined ? null : new Date(row["prov_recorded_at"] as string).toISOString() });
const NONE = { prov_channel: null, prov_session_id: null, prov_task_id: null, prov_origin: null, prov_recorded_at: null };

describe("alle fem journaltyper skriver proveniens i samme INSERT", () => {
  it("beslutning, scenario, risiko, mål og nøkkelresultat bærer kanal, sesjon, jobb, opphav og tidspunkt", async () => {
    const d = await service.createDecision(TENANT_A, "business", { title: "T", rationale: "R", decision_maker: "owner" }, "person-creator", PROV);
    expect(cols(d as unknown as Record<string, unknown>)).toEqual({ prov_channel: "web", prov_session_id: "sess-prov-1", prov_task_id: null, prov_origin: "owner_direct", prov_recorded_at: CLOCK.toISOString() });
    const s = await service.createScenario(TENANT_A, "business", { title: "T", assumptions: "A", projected_outcome: "P" }, "person-creator", JOB_PROV);
    expect(cols(s as unknown as Record<string, unknown>)).toEqual({ prov_channel: "system", prov_session_id: "job:task-42", prov_task_id: "task-42", prov_origin: "model", prov_recorded_at: CLOCK.toISOString() });
    const r = await service.createRisk(TENANT_A, "business", { title: "T", description: "D", severity: "low", probability: "low" }, "person-creator", PROV);
    expect(cols(r as unknown as Record<string, unknown>).prov_origin).toBe("owner_direct");
    const g = await service.createGoal(TENANT_A, "business", { title: "Mål" }, "person-creator", PROV);
    expect(cols(g as unknown as Record<string, unknown>).prov_session_id).toBe("sess-prov-1");
    const kr = await service.addKeyResult(TENANT_A, "business", { goal_id: g.goal_id, title: "KR" }, JOB_PROV);
    expect(cols(kr as unknown as Record<string, unknown>)).toMatchObject({ prov_task_id: "task-42", prov_origin: "model" });
  });

  it("uten proveniens (flagget av) er alle fem kolonner NULL - akkurat som før migrasjonen", async () => {
    const d = await service.createDecision(TENANT_A, "business", { title: "uten", rationale: "R", decision_maker: "jarvis" }, "person-creator");
    expect(cols(d as unknown as Record<string, unknown>)).toEqual(NONE);
    const g = await service.createGoal(TENANT_A, "business", { title: "uten" }, "person-creator");
    expect(cols(g as unknown as Record<string, unknown>)).toEqual(NONE);
    const kr = await service.addKeyResult(TENANT_A, "business", { goal_id: g.goal_id, title: "kr uten" });
    expect(cols(kr as unknown as Record<string, unknown>)).toEqual(NONE);
  });

  it("listene bærer proveniens-kolonnene (additivt), og en eldre rad (rå INSERT uten proveniens) står med NULL - aldri bakdatert", async () => {
    await adminPool.query(
      "INSERT INTO decision_log (decision_id, tenant_id, title, rationale, decision_maker) VALUES ('dec-legacy', $1, 'eldre', 'R', 'owner')", [TENANT_A]
    );
    const list = await service.listDecisions(TENANT_A, "business");
    const legacy = list.find((d) => d.decision_id === "dec-legacy");
    expect(legacy).toBeDefined();
    expect(cols(legacy as unknown as Record<string, unknown>)).toEqual(NONE);
    expect(list.some((d) => d.prov_origin === "owner_direct")).toBe(true);
    const goals = await service.listGoals(TENANT_A, "business");
    expect(goals.find((g) => g.title === "Mål")?.key_results[0]?.prov_origin).toBe("model");
  });
});

describe("databasen håndhever proveniensen (CHECK), også for en rå INSERT", () => {
  const insert = (table: string, extra: string, values: unknown[]) => {
    const common: Record<string, string> = {
      decision_log: "decision_id, tenant_id, title, rationale, decision_maker",
      scenarios: "scenario_id, tenant_id, title, assumptions, projected_outcome",
      risks: "risk_id, tenant_id, title, description, severity, probability",
      goals: "goal_id, tenant_id, title"
    };
    return adminPool.query(`INSERT INTO ${table} (${common[table]}, ${extra}) VALUES (${[...values].map((_, i) => `$${i + 1}`).join(", ")})`, values);
  };

  it("kun prov_origin uten resten (delvis proveniens) avvises", async () => {
    await expect(insert("decision_log", "prov_origin", ["dec-x1", TENANT_A, "t", "r", "owner", "owner_direct"])).rejects.toThrow(/decision_log_prov_all_or_none_check/);
  });

  it("ukjent opphav avvises i alle fire entitetstabellene", async () => {
    const t = new Date();
    await expect(insert("decision_log", "prov_channel, prov_session_id, prov_origin, prov_recorded_at", ["dec-x2", TENANT_A, "t", "r", "owner", "web", "s", "bruker_sa_det", t])).rejects.toThrow(/decision_log_prov_origin_check/);
    await expect(insert("scenarios", "prov_channel, prov_session_id, prov_origin, prov_recorded_at", ["scn-x", TENANT_A, "t", "a", "p", "web", "s", "falsk", t])).rejects.toThrow(/scenarios_prov_origin_check/);
    await expect(insert("risks", "prov_channel, prov_session_id, prov_origin, prov_recorded_at", ["risk-x", TENANT_A, "t", "d", "low", "low", "web", "s", "falsk", t])).rejects.toThrow(/risks_prov_origin_check/);
    await expect(insert("goals", "prov_channel, prov_session_id, prov_origin, prov_recorded_at", ["goal-x", TENANT_A, "t", "web", "s", "falsk", t])).rejects.toThrow(/goals_prov_origin_check/);
  });

  it("et fullt sett aksepteres, et tomt sett aksepteres - alt annet ikke", async () => {
    const t = new Date();
    await expect(insert("decision_log", "prov_channel, prov_session_id, prov_origin, prov_recorded_at", ["dec-ok", TENANT_A, "t", "r", "owner", "web", "s", "unspecified", t])).resolves.toBeDefined();
    await expect(insert("decision_log", "prov_channel, prov_origin, prov_recorded_at", ["dec-nosess", TENANT_A, "t", "r", "owner", "web", "unspecified", t])).rejects.toThrow(/all_or_none/);
  });
});

describe("tenant-isolasjon er uendret", () => {
  it("B ser verken A sin journal eller A sin proveniens; en journalpost for B bærer kun B sin egen", async () => {
    await service.createDecision(TENANT_B, "business", { title: "B", rationale: "R", decision_maker: "owner" }, "person-creator", { channel: "telegram", session_id: "sess-b", task_id: null, origin: "unspecified" });
    const b = await service.listDecisions(TENANT_B, "business");
    expect(b).toHaveLength(1);
    expect(JSON.stringify(b)).not.toContain("sess-prov-1");
    const a = await service.listDecisions(TENANT_A, "business");
    expect(JSON.stringify(a)).not.toContain("sess-b");
  });
});
