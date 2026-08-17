import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { calculateLeadPriorityV1, calculateOpportunityRiskV1, LEAD_PRIORITY_RULE_VERSION, OPPORTUNITY_RISK_RULE_VERSION } from "./scoring-rules.ts";
import type {
  BusinessScore, LeadScoringSignals, ManualOverrideInput, OpportunityScoringSignals,
  RankedEntity, ScoreCalculation, ScoreEntityType, ScoreExplanation, ScoreType
} from "./scoring-types.ts";

/**
 * UA-3 profiling/scoring slice (D-61). Gjenbruker `withMemoryTransaction`
 * uendret (samme RLS-primitiv som resten av Business OS) - ingen ny
 * sikkerhetsmodell. Signal-innsamling spoerrer KUN business_leads/
 * business_opportunities/business_activities/business_followups/
 * business_open_loops - ALDRI business_contacts/people utover den
 * eksisterende owner_person_id-referansen som allerede er en identitet, ikke
 * et scoring-input (§4/§11 i byggeordren).
 *
 * Idempotens: `persistScore()` skriver via `ON CONFLICT (tenant_id,
 * entity_type, entity_id, score_type) DO UPDATE` - re-kjoering for SAMME
 * entitet oppdaterer SAMME rad, oppretter aldri en duplikat (samme monster
 * som `business_open_loops`/`business_activities`).
 *
 * INGEN ekstern handling/ToolGateway-kall skjer noensinne som resultat av en
 * beregnet score (§10 i byggeordren om hoy-konsekvens autonome person-
 * beslutninger) - denne tjenesten leser/skriver KUN egen
 * `business_scores`-tilstand, aldri en handling utenfor den.
 */
export class ScoringService {
  constructor(private readonly pool: pg.Pool) {}

  // ---- Lead-signaler + scoring -------------------------------------------------

  private async gatherLeadSignals(client: pg.PoolClient, tenantId: string, leadId: string): Promise<LeadScoringSignals | null> {
    const { rows: leadRows } = await client.query(
      `SELECT lead_id, status FROM business_leads WHERE tenant_id = $1 AND lead_id = $2`,
      [tenantId, leadId]
    );
    const lead = leadRows[0] as { lead_id: string; status: LeadScoringSignals["status"] } | undefined;
    if (!lead) return null;

    const { rows: oppRows } = await client.query(
      `SELECT 1 FROM business_opportunities WHERE tenant_id = $1 AND lead_id = $2 AND stage NOT IN ('won','lost') LIMIT 1`,
      [tenantId, leadId]
    );
    const { rows: activityRows } = await client.query(
      `SELECT activity_id FROM business_activities WHERE tenant_id = $1 AND lead_id = $2 AND occurred_at >= now() - interval '7 days'`,
      [tenantId, leadId]
    );
    const { rows: anyActivityRows } = await client.query(
      `SELECT 1 FROM business_activities WHERE tenant_id = $1 AND lead_id = $2 AND occurred_at >= now() - interval '30 days' LIMIT 1`,
      [tenantId, leadId]
    );
    const { rows: followupRows } = await client.query(
      `SELECT followup_id, due_at < now() AS overdue FROM business_followups WHERE tenant_id = $1 AND lead_id = $2 AND status = 'open'`,
      [tenantId, leadId]
    );

    const openFollowupIds = (followupRows as Array<{ followup_id: string; overdue: boolean }>).map((r) => r.followup_id);
    const hasOverdueFollowup = (followupRows as Array<{ followup_id: string; overdue: boolean }>).some((r) => r.overdue);

    return {
      lead_id: lead.lead_id,
      status: lead.status,
      has_active_opportunity: oppRows.length > 0,
      has_recent_activity_7d: activityRows.length > 0,
      is_stale_30d: anyActivityRows.length === 0 && lead.status !== "new",
      has_open_followup: openFollowupIds.length > 0,
      has_overdue_followup: hasOverdueFollowup,
      recent_activity_ids: (activityRows as Array<{ activity_id: string }>).map((r) => r.activity_id),
      open_followup_ids: openFollowupIds
    };
  }

  // ---- Opportunity-signaler + scoring -------------------------------------------

  private async gatherOpportunitySignals(client: pg.PoolClient, tenantId: string, opportunityId: string): Promise<OpportunityScoringSignals | null> {
    const { rows: oppRows } = await client.query(
      `SELECT opportunity_id, stage, updated_at < now() - interval '14 days' AS is_stale
       FROM business_opportunities WHERE tenant_id = $1 AND opportunity_id = $2`,
      [tenantId, opportunityId]
    );
    const opp = oppRows[0] as { opportunity_id: string; stage: OpportunityScoringSignals["stage"]; is_stale: boolean } | undefined;
    if (!opp) return null;

    const { rows: followupRows } = await client.query(
      `SELECT followup_id, due_at < now() AS overdue FROM business_followups WHERE tenant_id = $1 AND opportunity_id = $2 AND status = 'open'`,
      [tenantId, opportunityId]
    );
    const overdueFollowupIds = (followupRows as Array<{ followup_id: string; overdue: boolean }>)
      .filter((r) => r.overdue).map((r) => r.followup_id);
    const { rows: openLoopRows } = await client.query(
      `SELECT open_loop_id FROM business_open_loops
       WHERE tenant_id = $1 AND opportunity_id = $2 AND loop_type = 'stalled_opportunity' AND status = 'open'`,
      [tenantId, opportunityId]
    );

    return {
      opportunity_id: opp.opportunity_id,
      stage: opp.stage,
      is_stale_14d: opp.is_stale,
      has_open_followup: followupRows.length > 0,
      has_overdue_followup: overdueFollowupIds.length > 0,
      has_stalled_open_loop: openLoopRows.length > 0,
      overdue_followup_ids: overdueFollowupIds,
      stalled_open_loop_ids: (openLoopRows as Array<{ open_loop_id: string }>).map((r) => r.open_loop_id)
    };
  }

  /** Beregner OG persisterer scoren for én lead (idempotent). Returnerer null hvis leaden ikke finnes. */
  async recalculateLeadScore(tenantId: string, memorySpace: MemorySpace, leadId: string): Promise<BusinessScore | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const signals = await this.gatherLeadSignals(client, tenantId, leadId);
      if (!signals) return null;
      const calc = calculateLeadPriorityV1(signals);
      return persistScore(client, {
        tenant_id: tenantId, memory_space: memorySpace, entity_type: "lead", entity_id: leadId,
        score_type: "lead_priority", rule_version: LEAD_PRIORITY_RULE_VERSION, calc
      });
    });
  }

  /** Beregner OG persisterer scoren for én opportunity (idempotent). Returnerer null hvis den ikke finnes. */
  async recalculateOpportunityScore(tenantId: string, memorySpace: MemorySpace, opportunityId: string): Promise<BusinessScore | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const signals = await this.gatherOpportunitySignals(client, tenantId, opportunityId);
      if (!signals) return null;
      const calc = calculateOpportunityRiskV1(signals);
      return persistScore(client, {
        tenant_id: tenantId, memory_space: memorySpace, entity_type: "opportunity", entity_id: opportunityId,
        score_type: "opportunity_risk", rule_version: OPPORTUNITY_RISK_RULE_VERSION, calc
      });
    });
  }

  /** §23 i byggeordren: bounded, idempotent batch-rekalkulering - kalt av DailyScheduler, ingen ny koe. */
  async recalculateTenant(tenantId: string, memorySpace: MemorySpace): Promise<{ leads: number; opportunities: number }> {
    const { rows: leadRows } = await withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) =>
      client.query(`SELECT lead_id FROM business_leads WHERE tenant_id = $1 AND status NOT IN ('disqualified','converted') LIMIT 500`, [tenantId])
    );
    let leads = 0;
    for (const row of leadRows as Array<{ lead_id: string }>) {
      if (await this.recalculateLeadScore(tenantId, memorySpace, row.lead_id)) leads++;
    }
    const { rows: oppRows } = await withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) =>
      client.query(`SELECT opportunity_id FROM business_opportunities WHERE tenant_id = $1 AND stage NOT IN ('won','lost') LIMIT 500`, [tenantId])
    );
    let opportunities = 0;
    for (const row of oppRows as Array<{ opportunity_id: string }>) {
      if (await this.recalculateOpportunityScore(tenantId, memorySpace, row.opportunity_id)) opportunities++;
    }
    return { leads, opportunities };
  }

  // ---- Lesing / forklaring -------------------------------------------------------

  async explainScore(tenantId: string, memorySpace: MemorySpace, entityType: ScoreEntityType, entityId: string): Promise<ScoreExplanation | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const scoreType: ScoreType = entityType === "lead" ? "lead_priority" : "opportunity_risk";
      const { rows } = await client.query(
        `SELECT * FROM business_scores WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 AND score_type = $4`,
        [tenantId, entityType, entityId, scoreType]
      );
      const row = rows[0] as BusinessScore | undefined;
      if (!row) return null;
      return toExplanation(row);
    });
  }

  async rankLeads(tenantId: string, memorySpace: MemorySpace, limit = 20): Promise<RankedEntity[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT s.*, l.title FROM business_scores s
         JOIN business_leads l ON l.tenant_id = s.tenant_id AND l.lead_id = s.entity_id
         WHERE s.tenant_id = $1 AND s.entity_type = 'lead' AND s.score_type = 'lead_priority'
         ORDER BY (CASE WHEN s.manual_override THEN s.override_score ELSE s.score END) DESC
         LIMIT $2`,
        [tenantId, limit]
      );
      return (rows as Array<BusinessScore & { title: string }>).map(toRanked);
    });
  }

  async rankOpportunities(tenantId: string, memorySpace: MemorySpace, limit = 20): Promise<RankedEntity[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT s.*, o.title FROM business_scores s
         JOIN business_opportunities o ON o.tenant_id = s.tenant_id AND o.opportunity_id = s.entity_id
         WHERE s.tenant_id = $1 AND s.entity_type = 'opportunity' AND s.score_type = 'opportunity_risk'
         ORDER BY (CASE WHEN s.manual_override THEN s.override_score ELSE s.score END) DESC
         LIMIT $2`,
        [tenantId, limit]
      );
      return (rows as Array<BusinessScore & { title: string }>).map(toRanked);
    });
  }

  // ---- Manuell overstyring (§9/§18) -----------------------------------------------

  /** Eier-autorisert overstyring - overskriver ALDRI den beregnede scoren/faktorene, kun en separat visnings-/prioriteringsverdi. */
  async setManualOverride(
    tenantId: string, memorySpace: MemorySpace, entityType: ScoreEntityType, entityId: string, input: ManualOverrideInput
  ): Promise<BusinessScore | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const scoreType: ScoreType = entityType === "lead" ? "lead_priority" : "opportunity_risk";
      const { rows } = await client.query(
        `UPDATE business_scores SET manual_override = true, override_score = $1, override_reason = $2,
           override_by = $3, override_at = now(), updated_at = now()
         WHERE tenant_id = $4 AND entity_type = $5 AND entity_id = $6 AND score_type = $7
         RETURNING *`,
        [input.override_score, input.reason, input.actor_person_id ?? null, tenantId, entityType, entityId, scoreType]
      );
      const row = rows[0] as BusinessScore | undefined;
      return row ? parseScoreRow(row) : null;
    });
  }

  async clearManualOverride(tenantId: string, memorySpace: MemorySpace, entityType: ScoreEntityType, entityId: string): Promise<BusinessScore | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const scoreType: ScoreType = entityType === "lead" ? "lead_priority" : "opportunity_risk";
      const { rows } = await client.query(
        `UPDATE business_scores SET manual_override = false, override_score = NULL, override_reason = NULL,
           override_by = NULL, override_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 AND score_type = $4
         RETURNING *`,
        [tenantId, entityType, entityId, scoreType]
      );
      const row = rows[0] as BusinessScore | undefined;
      return row ? parseScoreRow(row) : null;
    });
  }
}

interface PersistScoreInput {
  tenant_id: string;
  memory_space: MemorySpace;
  entity_type: ScoreEntityType;
  entity_id: string;
  score_type: ScoreType;
  rule_version: string;
  calc: ScoreCalculation;
}

/** Idempotent UPSERT (§17): re-kalkulering for SAMME entitet oppdaterer SAMME rad, aldri en duplikat. Overstyring bevares uendret ved rekalkulering. */
async function persistScore(client: pg.PoolClient, input: PersistScoreInput): Promise<BusinessScore> {
  const { rows } = await client.query(
    `INSERT INTO business_scores
       (score_id, tenant_id, memory_space_id, entity_type, entity_id, score_type, rule_version, score, factor_summary, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, entity_type, entity_id, score_type) DO UPDATE SET
       rule_version = EXCLUDED.rule_version, score = EXCLUDED.score, factor_summary = EXCLUDED.factor_summary,
       evidence = EXCLUDED.evidence, calculated_at = now(), updated_at = now()
     RETURNING *`,
    [
      `biz-sc-${randomUUID()}`, input.tenant_id, input.memory_space, input.entity_type, input.entity_id,
      input.score_type, input.rule_version, input.calc.score,
      JSON.stringify(input.calc.factors), JSON.stringify(input.calc.evidence)
    ]
  );
  return parseScoreRow(rows[0] as BusinessScore);
}

/**
 * `numeric`-kolonner (`score`/`override_score`) returneres som TEKST av
 * node-postgres (unngår flyttall-presisjonstap for generelle numeric-typer)
 * - normaliserer til `number` her, ETT sted, for alle lesestier.
 */
function parseScoreRow<T extends { score: unknown; override_score: unknown }>(row: T): T & { score: number; override_score: number | null } {
  return {
    ...row,
    score: Number(row.score),
    override_score: row.override_score === null || row.override_score === undefined ? null : Number(row.override_score)
  };
}

function toExplanation(row: BusinessScore): ScoreExplanation {
  const parsed = parseScoreRow(row);
  return { ...parsed, effective_score: parsed.manual_override && parsed.override_score !== null ? parsed.override_score : parsed.score };
}

function toRanked(row: BusinessScore & { title: string }): RankedEntity {
  const parsed = parseScoreRow(row);
  const effective = parsed.manual_override && parsed.override_score !== null ? parsed.override_score : parsed.score;
  return {
    entity_id: parsed.entity_id, title: parsed.title, score: parsed.score, effective_score: effective,
    manual_override: parsed.manual_override, top_factors: [...parsed.factor_summary].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 3)
  };
}
