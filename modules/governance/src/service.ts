import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import {
  CreateDecisionInputSchema,
  CreateGoalInputSchema,
  CreateRiskInputSchema,
  CreateScenarioInputSchema,
  AddKeyResultInputSchema,
  UpdateRiskInputSchema,
  type CreateDecisionInput,
  type CreateGoalInput,
  type CreateRiskInput,
  type CreateScenarioInput,
  type AddKeyResultInput,
  type UpdateRiskInput,
  type DecisionLogEntry,
  type DecisionStatus,
  type GoalKeyResult,
  type GoalStatus,
  type GoalWithKeyResults,
  type Risk,
  type Scenario,
  type ScenarioStatus
} from "./types.ts";

export class GovernanceNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`governance_not_found:${kind}:${id}`);
    this.name = "GovernanceNotFoundError";
  }
}

/**
 * UA-11 Executive Mode "K2" (D-64): ren journalførings-tjeneste for de fire
 * genuint nye kanoniske entitetstypene - se `059_governance.sql` sitt
 * filhode og `types.ts`. INGEN klasse D-handlings-claim-maskineri (dette
 * er interne journalposter, aldri en utløser for en ekstern mutasjon) -
 * samme RLS-skopet `withMemoryTransaction(pool, tenantId, [memorySpace], ...)`-
 * mønster som `@jarvis/situations`/`@jarvis/business` allerede bruker.
 */
export class GovernanceService {
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------
  // Decision log
  // ---------------------------------------------------------------------

  async createDecision(
    tenantId: string,
    memorySpace: MemorySpace,
    input: CreateDecisionInput,
    createdBy: string
  ): Promise<DecisionLogEntry> {
    const value = CreateDecisionInputSchema.parse(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO decision_log (decision_id, tenant_id, memory_space_id, title, rationale, decision_maker,
                                    status, related_situation_id, owner_person_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          `dec-${randomUUID()}`,
          tenantId,
          memorySpace,
          value.title,
          value.rationale,
          value.decision_maker,
          value.status ?? "decided",
          value.related_situation_id ?? null,
          value.owner_person_id ?? null,
          createdBy
        ]
      );
      return rows[0] as DecisionLogEntry;
    });
  }

  async listDecisions(
    tenantId: string,
    memorySpace: MemorySpace,
    filter: { status?: DecisionStatus } = {}
  ): Promise<DecisionLogEntry[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: string[] = [tenantId];
      if (filter.status) {
        params.push(filter.status);
        conditions.push(`status = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM decision_log WHERE ${conditions.join(" AND ")} ORDER BY decided_at DESC`,
        params
      );
      return rows as DecisionLogEntry[];
    });
  }

  async reverseDecision(tenantId: string, memorySpace: MemorySpace, decisionId: string): Promise<DecisionLogEntry> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE decision_log SET status = 'reversed', reversed_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND decision_id = $2 RETURNING *`,
        [tenantId, decisionId]
      );
      if (!rows[0]) throw new GovernanceNotFoundError("decision", decisionId);
      return rows[0] as DecisionLogEntry;
    });
  }

  // ---------------------------------------------------------------------
  // Scenarios
  // ---------------------------------------------------------------------

  async createScenario(
    tenantId: string,
    memorySpace: MemorySpace,
    input: CreateScenarioInput,
    createdBy: string
  ): Promise<Scenario> {
    const value = CreateScenarioInputSchema.parse(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO scenarios (scenario_id, tenant_id, memory_space_id, title, assumptions, projected_outcome, owner_person_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          `scn-${randomUUID()}`,
          tenantId,
          memorySpace,
          value.title,
          value.assumptions,
          value.projected_outcome,
          value.owner_person_id ?? null,
          createdBy
        ]
      );
      return rows[0] as Scenario;
    });
  }

  async listScenarios(
    tenantId: string,
    memorySpace: MemorySpace,
    filter: { status?: ScenarioStatus } = {}
  ): Promise<Scenario[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: string[] = [tenantId];
      if (filter.status) {
        params.push(filter.status);
        conditions.push(`status = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM scenarios WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`,
        params
      );
      return rows as Scenario[];
    });
  }

  async updateScenarioStatus(tenantId: string, memorySpace: MemorySpace, scenarioId: string, status: ScenarioStatus): Promise<Scenario> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE scenarios SET status = $3, updated_at = now() WHERE tenant_id = $1 AND scenario_id = $2 RETURNING *`,
        [tenantId, scenarioId, status]
      );
      if (!rows[0]) throw new GovernanceNotFoundError("scenario", scenarioId);
      return rows[0] as Scenario;
    });
  }

  // ---------------------------------------------------------------------
  // Risk register
  // ---------------------------------------------------------------------

  async createRisk(tenantId: string, memorySpace: MemorySpace, input: CreateRiskInput, createdBy: string): Promise<Risk> {
    const value = CreateRiskInputSchema.parse(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO risks (risk_id, tenant_id, memory_space_id, title, description, severity, probability, mitigation_plan, owner_person_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          `risk-${randomUUID()}`,
          tenantId,
          memorySpace,
          value.title,
          value.description,
          value.severity,
          value.probability,
          value.mitigation_plan ?? null,
          value.owner_person_id ?? null,
          createdBy
        ]
      );
      return rows[0] as Risk;
    });
  }

  async listRisks(
    tenantId: string,
    memorySpace: MemorySpace,
    filter: { status?: Risk["status"] } = {}
  ): Promise<Risk[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: string[] = [tenantId];
      if (filter.status) {
        params.push(filter.status);
        conditions.push(`status = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM risks WHERE ${conditions.join(" AND ")}
         ORDER BY (severity = 'critical') DESC, (severity = 'high') DESC, (severity = 'medium') DESC, identified_at DESC`,
        params
      );
      return rows as Risk[];
    });
  }

  async updateRisk(tenantId: string, memorySpace: MemorySpace, input: UpdateRiskInput): Promise<Risk> {
    const value = UpdateRiskInputSchema.parse(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE risks SET
           severity = COALESCE($3, severity),
           probability = COALESCE($4, probability),
           mitigation_plan = COALESCE($5, mitigation_plan),
           status = COALESCE($6, status),
           resolved_at = CASE WHEN $6 = 'resolved' THEN now() ELSE resolved_at END,
           updated_at = now()
         WHERE tenant_id = $1 AND risk_id = $2 RETURNING *`,
        [tenantId, value.risk_id, value.severity ?? null, value.probability ?? null, value.mitigation_plan ?? null, value.status ?? null]
      );
      if (!rows[0]) throw new GovernanceNotFoundError("risk", value.risk_id);
      return rows[0] as Risk;
    });
  }

  // ---------------------------------------------------------------------
  // Goals / OKRs
  // ---------------------------------------------------------------------

  async createGoal(tenantId: string, memorySpace: MemorySpace, input: CreateGoalInput, createdBy: string): Promise<GoalWithKeyResults> {
    const value = CreateGoalInputSchema.parse(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO goals (goal_id, tenant_id, memory_space_id, title, description, target_date, owner_person_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          `goal-${randomUUID()}`,
          tenantId,
          memorySpace,
          value.title,
          value.description ?? null,
          value.target_date ?? null,
          value.owner_person_id ?? null,
          createdBy
        ]
      );
      return { ...(rows[0] as Omit<GoalWithKeyResults, "key_results">), key_results: [] };
    });
  }

  async listGoals(
    tenantId: string,
    memorySpace: MemorySpace,
    filter: { status?: GoalStatus } = {}
  ): Promise<GoalWithKeyResults[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["g.tenant_id = $1"];
      const params: string[] = [tenantId];
      if (filter.status) {
        params.push(filter.status);
        conditions.push(`g.status = $${params.length}`);
      }
      const { rows: goalRows } = await client.query(
        `SELECT * FROM goals g WHERE ${conditions.join(" AND ")} ORDER BY g.target_date ASC NULLS LAST, g.created_at DESC`,
        params
      );
      if (goalRows.length === 0) return [];
      const goalIds = goalRows.map((r) => r["goal_id"] as string);
      const { rows: krRows } = await client.query(
        `SELECT * FROM goal_key_results WHERE tenant_id = $1 AND goal_id = ANY($2::text[]) ORDER BY created_at ASC`,
        [tenantId, goalIds]
      );
      const byGoal = new Map<string, GoalKeyResult[]>();
      for (const kr of krRows as GoalKeyResult[]) {
        const list = byGoal.get(kr.goal_id) ?? [];
        list.push(kr);
        byGoal.set(kr.goal_id, list);
      }
      return (goalRows as Omit<GoalWithKeyResults, "key_results">[]).map((g) => ({
        ...g,
        key_results: byGoal.get(g.goal_id) ?? []
      }));
    });
  }

  async updateGoalStatus(tenantId: string, memorySpace: MemorySpace, goalId: string, status: GoalStatus): Promise<GoalWithKeyResults> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE goals SET status = $3, updated_at = now() WHERE tenant_id = $1 AND goal_id = $2 RETURNING *`,
        [tenantId, goalId, status]
      );
      if (!rows[0]) throw new GovernanceNotFoundError("goal", goalId);
      const { rows: krRows } = await client.query(
        `SELECT * FROM goal_key_results WHERE tenant_id = $1 AND goal_id = $2 ORDER BY created_at ASC`,
        [tenantId, goalId]
      );
      return { ...(rows[0] as Omit<GoalWithKeyResults, "key_results">), key_results: krRows as GoalKeyResult[] };
    });
  }

  async addKeyResult(tenantId: string, memorySpace: MemorySpace, input: AddKeyResultInput): Promise<GoalKeyResult> {
    const value = AddKeyResultInputSchema.parse(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // D-64/D-68-disiplin: en Key Result MÅ tilhøre et Goal i SAMME
      // tenant+space - `goal_key_results_goal_scope_fk` (059_governance.sql)
      // håndhever dette i databasen selv, men vi sjekker eksplisitt her
      // FØRST for å kunne kaste en ærlig `GovernanceNotFoundError` fremfor
      // en rå FK-feil til kalleren.
      const goalCheck = await client.query(`SELECT 1 FROM goals WHERE tenant_id = $1 AND goal_id = $2`, [tenantId, value.goal_id]);
      if (goalCheck.rows.length === 0) throw new GovernanceNotFoundError("goal", value.goal_id);
      const { rows } = await client.query(
        `INSERT INTO goal_key_results (key_result_id, goal_id, tenant_id, memory_space_id, title)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [`kr-${randomUUID()}`, value.goal_id, tenantId, memorySpace, value.title]
      );
      return rows[0] as GoalKeyResult;
    });
  }

  async updateKeyResultProgress(
    tenantId: string,
    memorySpace: MemorySpace,
    keyResultId: string,
    progressPercent: number
  ): Promise<GoalKeyResult> {
    if (!Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100) {
      throw new RangeError("progress_percent_out_of_range");
    }
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE goal_key_results SET progress_percent = $3, updated_at = now()
         WHERE tenant_id = $1 AND key_result_id = $2 RETURNING *`,
        [tenantId, keyResultId, progressPercent]
      );
      if (!rows[0]) throw new GovernanceNotFoundError("key_result", keyResultId);
      return rows[0] as GoalKeyResult;
    });
  }
}
