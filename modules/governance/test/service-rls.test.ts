import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DomainPauseRegistry, SituationEngine } from "@jarvis/situations";
import { GovernanceNotFoundError, GovernanceService } from "../src/service.ts";

/**
 * UA-11 Executive Mode "K2": ekte Postgres/RLS-integrasjonsbevis for
 * `GovernanceService` - SAMME mønster som
 * `modules/situations/test/service-rls.test.ts`: tenant-isolasjon,
 * memory-space-isolasjon (RLS), scope-safe sammensatt FK
 * (`decision_log.related_situation_id` -> `situations`), og korrekt
 * CRUD-oppførsel for alle fire entitetstyper - mot en EKTE
 * NOSUPERUSER/NOBYPASSRLS-rolle (ikke `adminPool`).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: GovernanceService;
let engine: SituationEngine;

const TENANT_A = "tenant-gov-svc-a";
const TENANT_B = "tenant-gov-svc-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-governance-svc-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_gov_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_gov_svc_test");
  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Governance Svc A', 'business'), ('${TENANT_B}', 'Governance Svc B', 'business')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_gov_svc_test", password: "pw2" });
  service = new GovernanceService(appPool);
  engine = new SituationEngine(appPool, new DomainPauseRegistry());
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: decision log - opprett/list/reverser", () => {
  it("createDecision skriver en rad med status='decided' som default, listDecisions ser den", async () => {
    const row = await service.createDecision(
      TENANT_A, "business",
      { title: "Velg Postgres over Supabase i kjernen", rationale: "D-9 lokal-først-prinsippet", decision_maker: "owner" },
      "person-creator"
    );
    expect(row.decision_id).toMatch(/^dec-/);
    expect(row.status).toBe("decided");
    expect(row.decided_at).toBeTruthy();
    const list = await service.listDecisions(TENANT_A, "business");
    expect(list.some((d) => d.decision_id === row.decision_id)).toBe(true);
  });

  it("createDecision med status='proposed' respekteres, listDecisions filtrert paa status ser kun den", async () => {
    const row = await service.createDecision(
      TENANT_A, "business",
      { title: "Vurder ny leverandør", rationale: "Ingen beslutning tatt ennå", decision_maker: "jarvis", status: "proposed" },
      "person-creator"
    );
    expect(row.status).toBe("proposed");
    const proposed = await service.listDecisions(TENANT_A, "business", { status: "proposed" });
    expect(proposed.some((d) => d.decision_id === row.decision_id)).toBe(true);
    const decided = await service.listDecisions(TENANT_A, "business", { status: "decided" });
    expect(decided.some((d) => d.decision_id === row.decision_id)).toBe(false);
  });

  it("reverseDecision setter status='reversed' og reversed_at, kaster GovernanceNotFoundError for ukjent id", async () => {
    const row = await service.createDecision(
      TENANT_A, "business", { title: "Skal reverseres", rationale: "Test", decision_maker: "owner" }, "person-creator"
    );
    const reversed = await service.reverseDecision(TENANT_A, "business", row.decision_id);
    expect(reversed.status).toBe("reversed");
    expect(reversed.reversed_at).not.toBeNull();
    await expect(service.reverseDecision(TENANT_A, "business", "dec-does-not-exist")).rejects.toThrow(GovernanceNotFoundError);
  });
});

describe("B: decision_log.related_situation_id - scope-safe sammensatt FK mot situations", () => {
  it("en related_situation_id i SAMME tenant+space aksepteres", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_A, "business", {
      domain: "spend", detection_key: "gov-svc:related-ok", priority: "normal", reason: "test"
    });
    const row = await service.createDecision(
      TENANT_A, "business",
      { title: "Koblet til situasjon", rationale: "test", decision_maker: "owner", related_situation_id: situation.situation_id },
      "person-creator"
    );
    expect(row.related_situation_id).toBe(situation.situation_id);
  });

  it("en related_situation_id fra et ANNET tenant avvises av databasen (FK-brudd), ingen rad skrives", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_B, "business", {
      domain: "spend", detection_key: "gov-svc:related-cross-tenant", priority: "normal", reason: "test"
    });
    await expect(
      service.createDecision(
        TENANT_A, "business",
        { title: "Skal avvises", rationale: "test", decision_maker: "owner", related_situation_id: situation.situation_id },
        "person-creator"
      )
    ).rejects.toThrow();
    const list = await service.listDecisions(TENANT_A, "business");
    expect(list.some((d) => d.title === "Skal avvises")).toBe(false);
  });

  it("en related_situation_id fra SAMME tenant men et ANNET memory_space avvises av databasen (FK-brudd)", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_A, "personal", {
      domain: "home", detection_key: "gov-svc:related-cross-space", priority: "normal", reason: "test"
    });
    await expect(
      service.createDecision(
        TENANT_A, "business",
        { title: "Skal ogsaa avvises", rationale: "test", decision_maker: "owner", related_situation_id: situation.situation_id },
        "person-creator"
      )
    ).rejects.toThrow();
  });
});

describe("C: scenarios - opprett/list/oppdater status", () => {
  it("createScenario default status='draft', updateScenarioStatus endrer til 'active'", async () => {
    const row = await service.createScenario(
      TENANT_A, "business",
      { title: "Hva hvis vi dobler markedsføringsbudsjettet", assumptions: "CAC forblir konstant", projected_outcome: "2x leads" },
      "person-creator"
    );
    expect(row.status).toBe("draft");
    const updated = await service.updateScenarioStatus(TENANT_A, "business", row.scenario_id, "active");
    expect(updated.status).toBe("active");
    const active = await service.listScenarios(TENANT_A, "business", { status: "active" });
    expect(active.some((s) => s.scenario_id === row.scenario_id)).toBe(true);
  });

  it("updateScenarioStatus paa ukjent id kaster GovernanceNotFoundError", async () => {
    await expect(service.updateScenarioStatus(TENANT_A, "business", "scn-does-not-exist", "archived")).rejects.toThrow(GovernanceNotFoundError);
  });
});

describe("D: risk register - opprett/list/oppdater (COALESCE delvis oppdatering)", () => {
  it("createRisk, updateRisk endrer KUN de oppgitte feltene, resten uendret", async () => {
    const row = await service.createRisk(
      TENANT_A, "business",
      { title: "Nøkkelperson-avhengighet", description: "Kun én person kan drifte NAS-en", severity: "high", probability: "medium" },
      "person-creator"
    );
    expect(row.status).toBe("identified");
    expect(row.mitigation_plan).toBeNull();
    const updated = await service.updateRisk(TENANT_A, "business", { risk_id: row.risk_id, mitigation_plan: "Dokumenter drift-runbook" });
    expect(updated.mitigation_plan).toBe("Dokumenter drift-runbook");
    expect(updated.severity).toBe("high"); // uendret - kun mitigation_plan ble oppgitt.
    expect(updated.probability).toBe("medium"); // uendret.
  });

  it("updateRisk med status='resolved' setter resolved_at automatisk", async () => {
    const row = await service.createRisk(
      TENANT_A, "business",
      { title: "Skal loeses", description: "test", severity: "low", probability: "low" },
      "person-creator"
    );
    expect(row.resolved_at).toBeNull();
    const resolved = await service.updateRisk(TENANT_A, "business", { risk_id: row.risk_id, status: "resolved" });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_at).not.toBeNull();
  });

  it("listRisks filtrert paa status ser kun matchende rader; updateRisk paa ukjent id kaster GovernanceNotFoundError", async () => {
    const mitigating = await service.createRisk(
      TENANT_A, "business", { title: "Under mitigering", description: "test", severity: "medium", probability: "high" }, "person-creator"
    );
    await service.updateRisk(TENANT_A, "business", { risk_id: mitigating.risk_id, status: "mitigating" });
    const list = await service.listRisks(TENANT_A, "business", { status: "mitigating" });
    expect(list.some((r) => r.risk_id === mitigating.risk_id)).toBe(true);
    await expect(service.updateRisk(TENANT_A, "business", { risk_id: "risk-does-not-exist" })).rejects.toThrow(GovernanceNotFoundError);
  });
});

describe("E: goals/OKRs - Objective + Key Results, ekte OKR-struktur", () => {
  it("createGoal starter med tomme key_results, addKeyResult legger til, listGoals henter BEGGE sammen", async () => {
    const goal = await service.createGoal(
      TENANT_A, "business", { title: "Fullfør K2-sliceen", description: "Decision log/scenarios/risk/OKR" }, "person-creator"
    );
    expect(goal.key_results).toEqual([]);
    const kr = await service.addKeyResult(TENANT_A, "business", { goal_id: goal.goal_id, title: "Alle fire tabeller migrert" });
    expect(kr.progress_percent).toBeDefined();
    expect(Number(kr.progress_percent)).toBe(0);
    const list = await service.listGoals(TENANT_A, "business");
    const found = list.find((g) => g.goal_id === goal.goal_id);
    expect(found?.key_results.map((k) => k.key_result_id)).toContain(kr.key_result_id);
  });

  it("addKeyResult for et UKJENT goal_id kaster GovernanceNotFoundError, ingen rad skrives", async () => {
    await expect(service.addKeyResult(TENANT_A, "business", { goal_id: "goal-does-not-exist", title: "x" })).rejects.toThrow(GovernanceNotFoundError);
  });

  it("updateKeyResultProgress oppdaterer fremdrift, avviser verdier utenfor [0,100]", async () => {
    const goal = await service.createGoal(TENANT_A, "business", { title: "Progress-test" }, "person-creator");
    const kr = await service.addKeyResult(TENANT_A, "business", { goal_id: goal.goal_id, title: "KR1" });
    const updated = await service.updateKeyResultProgress(TENANT_A, "business", kr.key_result_id, 50);
    expect(Number(updated.progress_percent)).toBe(50);
    await expect(service.updateKeyResultProgress(TENANT_A, "business", kr.key_result_id, -1)).rejects.toThrow(RangeError);
    await expect(service.updateKeyResultProgress(TENANT_A, "business", kr.key_result_id, 101)).rejects.toThrow(RangeError);
    await expect(service.updateKeyResultProgress(TENANT_A, "business", "kr-does-not-exist", 10)).rejects.toThrow(GovernanceNotFoundError);
  });

  it("updateGoalStatus endrer status og returnerer key_results uendret, kaster GovernanceNotFoundError for ukjent id", async () => {
    const goal = await service.createGoal(TENANT_A, "business", { title: "Status-test" }, "person-creator");
    await service.addKeyResult(TENANT_A, "business", { goal_id: goal.goal_id, title: "KR-status" });
    const updated = await service.updateGoalStatus(TENANT_A, "business", goal.goal_id, "achieved");
    expect(updated.status).toBe("achieved");
    expect(updated.key_results.length).toBe(1);
    await expect(service.updateGoalStatus(TENANT_A, "business", "goal-does-not-exist", "achieved")).rejects.toThrow(GovernanceNotFoundError);
  });
});

describe("F: tenant-isolasjon (RLS) - TENANT_B ser ALDRI TENANT_A sine governance-rader", () => {
  it("listDecisions/listScenarios/listRisks/listGoals for TENANT_B er tomme naar data KUN finnes under TENANT_A", async () => {
    await service.createDecision(TENANT_A, "business", { title: "Isolasjon-test", rationale: "test", decision_maker: "owner" }, "p");
    await service.createScenario(TENANT_A, "business", { title: "Isolasjon-test", assumptions: "a", projected_outcome: "b" }, "p");
    await service.createRisk(TENANT_A, "business", { title: "Isolasjon-test", description: "d", severity: "low", probability: "low" }, "p");
    await service.createGoal(TENANT_A, "business", { title: "Isolasjon-test" }, "p");

    expect((await service.listDecisions(TENANT_B, "business")).some((d) => d.title === "Isolasjon-test")).toBe(false);
    expect((await service.listScenarios(TENANT_B, "business")).some((s) => s.title === "Isolasjon-test")).toBe(false);
    expect((await service.listRisks(TENANT_B, "business")).some((r) => r.title === "Isolasjon-test")).toBe(false);
    expect((await service.listGoals(TENANT_B, "business")).some((g) => g.title === "Isolasjon-test")).toBe(false);
  });
});

describe("G: memory-space-RLS - en sesjon uten det aktuelle spacet ser INGENTING", () => {
  it("en sesjon scopet til KUN 'personal' ser null goals for 'business', selv om raden faktisk finnes", async () => {
    const goal = await service.createGoal(TENANT_A, "business", { title: "Space-RLS-test" }, "p");

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'personal', true)", [TENANT_A]);
      const visible = await client.query("SELECT goal_id FROM goals WHERE tenant_id = $1 AND goal_id = $2", [TENANT_A, goal.goal_id]);
      expect(visible.rows).toHaveLength(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // Kontroll: en sesjon MED 'business' i scope ser raden igjen.
    const withSpace = await service.listGoals(TENANT_A, "business");
    expect(withSpace.some((g) => g.goal_id === goal.goal_id)).toBe(true);
  });
});
