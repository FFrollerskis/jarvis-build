import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { assertValidCampaignTransition, assertValidExperimentTransition } from "./state-machine.ts";
import type {
  Attribution,
  AttributeFromTrackingInput,
  AttributeToCampaignInput,
  Campaign,
  CampaignChannel,
  CampaignEvent,
  CampaignEventType,
  CampaignPerformance,
  CampaignStatus,
  CampaignTrackingTag,
  CreateCampaignInput,
  CreateExperimentInput,
  Experiment,
  ExperimentStatus,
  RecordSpendEventInput,
  RegisterCampaignTrackingTagInput,
  SpendEvent,
  TrackingLookup
} from "./types.ts";

export interface SearchCampaignsFilter {
  status?: CampaignStatus;
  channel?: CampaignChannel;
  owner_person_id?: string;
  /** Fritekst-substring mot `name` - deterministisk `ILIKE`, ingen semantisk søk (samme prinsipp som contract.search_contracts). */
  name_contains?: string;
  limit?: number;
}

/**
 * UA-4 Native Jarvis Growth Core (D-74): kjerne-domenetjeneste for
 * kampanje-lifecycle/utgiftsledger/attribusjon/eksperimentregister.
 * Gjenbruker `withMemoryTransaction` (SAMME RLS-primitiv som resten av
 * Business OS/Support/Contracts) - ingen ny sikkerhetsmodell. Attribusjon
 * peker til de EKSISTERENDE `business_leads`/`business_opportunities`-
 * entitetene - ingen ny lead-/opportunity-tabell/-tjeneste.
 */
export class GrowthService {
  constructor(private readonly pool: pg.Pool) {}

  async createCampaign(tenantId: string, memorySpace: MemorySpace, input: CreateCampaignInput): Promise<Campaign> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const campaign = await insertCampaign(client, tenantId, memorySpace, input);
      await insertEvent(client, tenantId, memorySpace, {
        campaign_id: campaign.campaign_id,
        event_type: "campaign_created",
        summary: `Kampanje opprettet: ${input.name} (${input.channel})`,
        actor_person_id: input.actor_person_id ?? null,
        metadata: {}
      });
      return campaign;
    });
  }

  async getCampaign(tenantId: string, memorySpace: MemorySpace, campaignId: string): Promise<Campaign | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.readForUpdate(client, tenantId, campaignId, false));
  }

  async listCampaigns(tenantId: string, memorySpace: MemorySpace, status: CampaignStatus | "all" = "active"): Promise<Campaign[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM marketing_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])
          : await client.query(`SELECT * FROM marketing_campaigns WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC`, [tenantId, status]);
      return rows as Campaign[];
    });
  }

  /** Deterministisk filter/søk - ingen LLM nødvendig for et strukturert oppslag. */
  async searchCampaigns(tenantId: string, memorySpace: MemorySpace, filter: SearchCampaignsFilter): Promise<Campaign[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const clauses = ["tenant_id = $1"];
      const params: unknown[] = [tenantId];
      const push = (clause: string, value: unknown) => {
        params.push(value);
        clauses.push(clause.replace("$N", `$${params.length}`));
      };
      if (filter.status !== undefined) push("status = $N", filter.status);
      if (filter.channel !== undefined) push("channel = $N", filter.channel);
      if (filter.owner_person_id !== undefined) push("owner_person_id = $N", filter.owner_person_id);
      if (filter.name_contains !== undefined) push("name ILIKE $N", `%${filter.name_contains}%`);
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
      const { rows } = await client.query(
        `SELECT * FROM marketing_campaigns WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
        params
      );
      return rows as Campaign[];
    });
  }

  /**
   * "Hva skjer med kunde X?" for vekst-domenet: kampanjer er BEVISST IKKE
   * direkte koblet til ett selskap (en kampanje sikter mot fremtidige/
   * ukjente leads) - dette spør i stedet GJENNOM attribusjon: selskapets
   * EKSISTERENDE leads/opportunities (business_leads.company_id/
   * business_opportunities.company_id) -> marketing_attributions -> kampanje.
   */
  async listByCompany(tenantId: string, memorySpace: MemorySpace, companyId: string): Promise<Campaign[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT DISTINCT c.* FROM marketing_campaigns c
         JOIN marketing_attributions a ON a.tenant_id = c.tenant_id AND a.campaign_id = c.campaign_id
         WHERE c.tenant_id = $1 AND (
           (a.entity_type = 'lead' AND a.entity_id IN (SELECT lead_id FROM business_leads WHERE tenant_id = $1 AND company_id = $2))
           OR (a.entity_type = 'opportunity' AND a.entity_id IN (SELECT opportunity_id FROM business_opportunities WHERE tenant_id = $1 AND company_id = $2))
         )
         ORDER BY c.created_at DESC`,
        [tenantId, companyId]
      );
      return rows as Campaign[];
    });
  }

  /** Deterministisk lifecycle-overgang håndheves i state-machine.ts - ugyldig overgang kaster, endrer INGENTING. */
  async setStatus(tenantId: string, memorySpace: MemorySpace, campaignId: string, status: CampaignStatus, actorPersonId?: string): Promise<Campaign | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, campaignId, true);
      if (!current) return null;
      assertValidCampaignTransition(current.status, status);
      const endedAtClause = status === "ended" ? ", ended_at = now()" : "";
      const startedAtClause = status === "active" && current.started_at === null ? ", started_at = now()" : "";
      const { rows } = await client.query(
        `UPDATE marketing_campaigns SET status = $1, updated_at = now()${endedAtClause}${startedAtClause} WHERE tenant_id = $2 AND campaign_id = $3 RETURNING *`,
        [status, tenantId, campaignId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        campaign_id: campaignId, event_type: "status_changed", summary: `Status endret: ${current.status} -> ${status}`,
        actor_person_id: actorPersonId ?? null, metadata: { from: current.status, to: status }
      });
      return rows[0] as Campaign;
    });
  }

  async setBudget(tenantId: string, memorySpace: MemorySpace, campaignId: string, budgetAmountOre: number | null, actorPersonId?: string): Promise<Campaign | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, campaignId, true);
      if (!current) return null;
      const { rows } = await client.query(
        `UPDATE marketing_campaigns SET budget_amount_ore = $1, updated_at = now() WHERE tenant_id = $2 AND campaign_id = $3 RETURNING *`,
        [budgetAmountOre, tenantId, campaignId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        campaign_id: campaignId, event_type: "budget_changed", summary: `Budsjett endret til ${budgetAmountOre ?? "(fjernet)"}`,
        actor_person_id: actorPersonId ?? null, metadata: { from: current.budget_amount_ore, to: budgetAmountOre }
      });
      return rows[0] as Campaign;
    });
  }

  /**
   * Idempotent utgifts-ingestion (§ i byggeordren: "write actions are
   * idempotent, auditable and have before/after state"). Annonseplattformer
   * rapporterer utgift PER KAMPANJE PER DAG - ON CONFLICT (tenant_id,
   * campaign_id, event_date, source_type) DO UPDATE oppdaterer SAMME rad
   * (aldri en duplikat), before/after-verdier logges eksplisitt på
   * `spend_recorded`-hendelsen.
   */
  async recordSpendEvent(tenantId: string, memorySpace: MemorySpace, campaignId: string, input: RecordSpendEventInput): Promise<SpendEvent> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, campaignId, true);
      if (!current) throw new Error("campaign_not_found");
      const sourceType = input.source_type ?? "manual";
      const { rows: beforeRows } = await client.query(
        `SELECT spend_amount_ore FROM marketing_spend_events WHERE tenant_id = $1 AND campaign_id = $2 AND event_date = $3 AND source_type = $4`,
        [tenantId, campaignId, input.event_date, sourceType]
      );
      const before = (beforeRows[0] as { spend_amount_ore: string } | undefined)?.spend_amount_ore ?? null;
      const spend_event_id = `grw-se-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO marketing_spend_events
           (spend_event_id, tenant_id, memory_space_id, campaign_id, event_date, spend_amount_ore, currency, clicks, impressions, source_type, source_pointer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, campaign_id, event_date, source_type) DO UPDATE SET
           spend_amount_ore = EXCLUDED.spend_amount_ore, currency = EXCLUDED.currency,
           clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, source_pointer = EXCLUDED.source_pointer, updated_at = now()
         RETURNING *`,
        [
          spend_event_id, tenantId, memorySpace, campaignId, input.event_date, input.spend_amount_ore,
          input.currency ?? "NOK", input.clicks ?? null, input.impressions ?? null, sourceType, input.source_pointer ?? null
        ]
      );
      await insertEvent(client, tenantId, memorySpace, {
        campaign_id: campaignId, event_type: "spend_recorded",
        summary: `Utgift registrert for ${input.event_date}: ${input.spend_amount_ore} øre`,
        actor_person_id: input.actor_person_id ?? null,
        metadata: { event_date: input.event_date, before_spend_amount_ore: before, after_spend_amount_ore: input.spend_amount_ore, source_type: sourceType }
      });
      return rows[0] as SpendEvent;
    });
  }

  async listSpendEvents(tenantId: string, memorySpace: MemorySpace, campaignId: string): Promise<SpendEvent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM marketing_spend_events WHERE tenant_id = $1 AND campaign_id = $2 ORDER BY event_date DESC`,
        [tenantId, campaignId]
      );
      return rows as SpendEvent[];
    });
  }

  /**
   * Deterministisk kobling til EKSISTERENDE CRM-entitet - EKSPLISITT av
   * kaller, ALDRI AI-utledet (Q-26-grensen: ingen inferert kausal påstand).
   */
  async attributeToCampaign(tenantId: string, memorySpace: MemorySpace, campaignId: string, input: AttributeToCampaignInput): Promise<Attribution> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, campaignId, true);
      if (!current) throw new Error("campaign_not_found");
      const attribution_id = `grw-at-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO marketing_attributions (attribution_id, tenant_id, memory_space_id, campaign_id, entity_type, entity_id, attribution_model, source_pointer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, entity_type, entity_id, campaign_id, attribution_model) DO UPDATE SET source_pointer = EXCLUDED.source_pointer
         RETURNING *`,
        [
          attribution_id, tenantId, memorySpace, campaignId, input.entity_type, input.entity_id,
          input.attribution_model ?? "first_touch", input.source_pointer ?? null
        ]
      );
      await insertEvent(client, tenantId, memorySpace, {
        campaign_id: campaignId, event_type: "attribution_created",
        summary: `${input.entity_type} ${input.entity_id} tilskrevet kampanje`,
        actor_person_id: input.actor_person_id ?? null, metadata: { entity_type: input.entity_type, entity_id: input.entity_id }
      });
      return rows[0] as Attribution;
    });
  }

  async listAttributions(tenantId: string, memorySpace: MemorySpace, campaignId: string): Promise<Attribution[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM marketing_attributions WHERE tenant_id = $1 AND campaign_id = $2 ORDER BY attributed_at DESC`,
        [tenantId, campaignId]
      );
      return rows as Attribution[];
    });
  }

  /**
   * D-82: deterministisk auto-attribusjon-fundament. Registrerer én
   * sporingstagg (klikk-ID ELLER full utm-triplett, ALDRI begge) på en
   * kampanje - idempotent via ON CONFLICT (samme tagg registrert på nytt
   * oppdaterer samme rad), databasens partial UNIQUE-indekser garanterer at
   * en tagg-verdi ALDRI kan tilhøre to kampanjer samtidig (ambiguity umulig).
   */
  async registerCampaignTrackingTag(
    tenantId: string,
    memorySpace: MemorySpace,
    campaignId: string,
    input: RegisterCampaignTrackingTagInput
  ): Promise<CampaignTrackingTag> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, campaignId, true);
      if (!current) throw new Error("campaign_not_found");
      const tag_id = `grw-tt-${randomUUID()}`;
      const isClickId = "click_id_param" in input;
      const conflictTarget = isClickId
        ? "(tenant_id, click_id_param, click_id_value) WHERE tag_type = 'click_id'"
        : "(tenant_id, utm_source, utm_medium, utm_campaign) WHERE tag_type = 'utm'";
      const { rows } = await client.query(
        `INSERT INTO marketing_campaign_tracking_tags
           (tag_id, tenant_id, memory_space_id, campaign_id, tag_type, click_id_param, click_id_value, utm_source, utm_medium, utm_campaign)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT ${conflictTarget} DO UPDATE SET campaign_id = EXCLUDED.campaign_id
         RETURNING *`,
        [
          tag_id, tenantId, memorySpace, campaignId, isClickId ? "click_id" : "utm",
          isClickId ? input.click_id_param : null, isClickId ? input.click_id_value : null,
          isClickId ? null : input.utm_source, isClickId ? null : input.utm_medium, isClickId ? null : input.utm_campaign
        ]
      );
      const tag = rows[0] as CampaignTrackingTag;
      await insertEvent(client, tenantId, memorySpace, {
        campaign_id: campaignId, event_type: "tracking_tag_registered",
        summary: isClickId ? `Sporingstagg registrert: ${input.click_id_param}` : `Sporingstagg registrert: utm ${input.utm_source}/${input.utm_medium}/${input.utm_campaign}`,
        actor_person_id: input.actor_person_id ?? null,
        metadata: isClickId
          ? { tag_type: "click_id", click_id_param: input.click_id_param }
          : { tag_type: "utm", utm_source: input.utm_source, utm_medium: input.utm_medium, utm_campaign: input.utm_campaign }
      });
      return tag;
    });
  }

  async listCampaignTrackingTags(tenantId: string, memorySpace: MemorySpace, campaignId: string): Promise<CampaignTrackingTag[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM marketing_campaign_tracking_tags WHERE tenant_id = $1 AND campaign_id = $2 ORDER BY created_at DESC`,
        [tenantId, campaignId]
      );
      return rows as CampaignTrackingTag[];
    });
  }

  /**
   * Deterministisk oppslag - ALDRI fuzzy/sannsynlighetsbasert. Returnerer
   * `null` (ikke en gjettet kampanje) når ingen EKSAKT match finnes -
   * samme "udefinert forblir udefinert"-prinsipp som `campaignPerformance()`
   * sin `cac_ore`/`roas` (Q-26-grensen).
   */
  async resolveCampaignFromTracking(tenantId: string, memorySpace: MemorySpace, tracking: TrackingLookup): Promise<string | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        "click_id_param" in tracking
          ? await client.query(
              `SELECT campaign_id FROM marketing_campaign_tracking_tags WHERE tenant_id = $1 AND tag_type = 'click_id' AND click_id_param = $2 AND click_id_value = $3`,
              [tenantId, tracking.click_id_param, tracking.click_id_value]
            )
          : await client.query(
              `SELECT campaign_id FROM marketing_campaign_tracking_tags WHERE tenant_id = $1 AND tag_type = 'utm' AND utm_source = $2 AND utm_medium = $3 AND utm_campaign = $4`,
              [tenantId, tracking.utm_source, tracking.utm_medium, tracking.utm_campaign]
            );
      return (rows[0] as { campaign_id: string } | undefined)?.campaign_id ?? null;
    });
  }

  /**
   * D-82 kjerne-vertikal: løser kampanje deterministisk fra sporingsparametre,
   * kaller SÅ den EKSISTERENDE `attributeToCampaign()` uendret (ingen ny
   * attribusjonsmekanisme - kun en ny, deterministisk vei INN til den
   * samme). Kaster `no_matching_campaign_for_tracking` (aldri en gjettet
   * kampanje) når ingen registrert tagg matcher - fail-closed, samme
   * prinsipp som `attributeToCampaign()` sin `campaign_not_found`.
   */
  async attributeFromTracking(tenantId: string, memorySpace: MemorySpace, input: AttributeFromTrackingInput): Promise<Attribution> {
    const campaignId = await this.resolveCampaignFromTracking(tenantId, memorySpace, input.tracking);
    if (!campaignId) throw new Error("no_matching_campaign_for_tracking");
    const sourcePointer =
      "click_id_param" in input.tracking
        ? `tracking:${input.tracking.click_id_param}=${input.tracking.click_id_value}`
        : `tracking:utm_source=${input.tracking.utm_source};utm_medium=${input.tracking.utm_medium};utm_campaign=${input.tracking.utm_campaign}`;
    return this.attributeToCampaign(tenantId, memorySpace, campaignId, {
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      ...(input.attribution_model !== undefined ? { attribution_model: input.attribution_model } : {}),
      source_pointer: sourcePointer,
      ...(input.actor_person_id !== undefined ? { actor_person_id: input.actor_person_id } : {})
    });
  }

  /**
   * UA-4 akseptansekriterium 1 ("CAC/ROAS knyttes til real CRM/revenue").
   * `won_opportunities`/`attributed_revenue_ore` kommer FRA
   * `business_opportunities.stage='won'`/`value_ore` (ekte CRM-data,
   * ALDRI fabrikkert). `cac_ore`/`roas` er `null` (ikke `0`/en gjettet
   * verdi) når nevneren er `0` - ratio er udefinert, ALDRI stille avrundet
   * (Q-26-grensen: ingen fabrikkert tall når data mangler).
   */
  async campaignPerformance(tenantId: string, memorySpace: MemorySpace, campaignId: string): Promise<CampaignPerformance | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, campaignId, false);
      if (!current) return null;
      const { rows } = await client.query(
        `SELECT
           COALESCE((SELECT SUM(spend_amount_ore) FROM marketing_spend_events WHERE tenant_id = $1 AND campaign_id = $2), 0) AS total_spend_ore,
           COUNT(DISTINCT CASE WHEN a.entity_type = 'lead' THEN a.entity_id END) AS attributed_leads,
           COUNT(DISTINCT CASE WHEN a.entity_type = 'opportunity' THEN a.entity_id END) AS attributed_opportunities,
           COUNT(DISTINCT CASE WHEN a.entity_type = 'opportunity' AND o.stage = 'won' THEN a.entity_id END) AS won_opportunities,
           COALESCE(SUM(CASE WHEN a.entity_type = 'opportunity' AND o.stage = 'won' THEN o.value_ore ELSE 0 END), 0) AS attributed_revenue_ore
         FROM marketing_attributions a
         LEFT JOIN business_opportunities o ON o.tenant_id = a.tenant_id AND o.opportunity_id = a.entity_id AND a.entity_type = 'opportunity'
         WHERE a.tenant_id = $1 AND a.campaign_id = $2`,
        [tenantId, campaignId]
      );
      const row = rows[0] as {
        total_spend_ore: string; attributed_leads: string; attributed_opportunities: string; won_opportunities: string; attributed_revenue_ore: string;
      };
      const totalSpend = Number(row.total_spend_ore);
      const wonOpportunities = Number(row.won_opportunities);
      const attributedRevenue = Number(row.attributed_revenue_ore);
      return {
        campaign_id: campaignId,
        total_spend_ore: row.total_spend_ore,
        attributed_leads: Number(row.attributed_leads),
        attributed_opportunities: Number(row.attributed_opportunities),
        won_opportunities: wonOpportunities,
        attributed_revenue_ore: row.attributed_revenue_ore,
        cac_ore: wonOpportunities > 0 ? totalSpend / wonOpportunities : null,
        roas: totalSpend > 0 ? attributedRevenue / totalSpend : null
      };
    });
  }

  async createExperiment(tenantId: string, memorySpace: MemorySpace, input: CreateExperimentInput): Promise<Experiment> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const experiment_id = `grw-ex-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO marketing_experiments (experiment_id, tenant_id, memory_space_id, campaign_id, name, hypothesis, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [experiment_id, tenantId, memorySpace, input.campaign_id ?? null, input.name, input.hypothesis ?? null, input.owner_person_id ?? null]
      );
      const experiment = rows[0] as Experiment;
      if (input.campaign_id) {
        await insertEvent(client, tenantId, memorySpace, {
          campaign_id: input.campaign_id, event_type: "experiment_created", summary: `Eksperiment opprettet: ${input.name}`,
          actor_person_id: input.actor_person_id ?? null, metadata: { experiment_id }
        });
      }
      return experiment;
    });
  }

  async getExperiment(tenantId: string, memorySpace: MemorySpace, experimentId: string): Promise<Experiment | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM marketing_experiments WHERE tenant_id = $1 AND experiment_id = $2`, [tenantId, experimentId]);
      return (rows[0] as Experiment) ?? null;
    });
  }

  async listExperiments(tenantId: string, memorySpace: MemorySpace, status: ExperimentStatus | "all" = "all"): Promise<Experiment[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM marketing_experiments WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])
          : await client.query(`SELECT * FROM marketing_experiments WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC`, [tenantId, status]);
      return rows as Experiment[];
    });
  }

  /** Deterministisk lifecycle-overgang. `result_summary` er et strukturert, menneske-/deterministisk-registrert felt - ALDRI en AI-generert kausal påstand. */
  async setExperimentStatus(
    tenantId: string,
    memorySpace: MemorySpace,
    experimentId: string,
    status: ExperimentStatus,
    resultSummary?: string,
    actorPersonId?: string
  ): Promise<Experiment | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: currentRows } = await client.query(
        `SELECT * FROM marketing_experiments WHERE tenant_id = $1 AND experiment_id = $2 FOR UPDATE`,
        [tenantId, experimentId]
      );
      const current = currentRows[0] as Experiment | undefined;
      if (!current) return null;
      assertValidExperimentTransition(current.status, status);
      const startedAtClause = status === "running" && current.started_at === null ? ", started_at = now()" : "";
      const endedAtClause = status === "concluded" || status === "abandoned" ? ", ended_at = now()" : "";
      const { rows } = await client.query(
        `UPDATE marketing_experiments SET status = $1, result_summary = COALESCE($2, result_summary), updated_at = now()${startedAtClause}${endedAtClause}
         WHERE tenant_id = $3 AND experiment_id = $4 RETURNING *`,
        [status, resultSummary ?? null, tenantId, experimentId]
      );
      const updated = rows[0] as Experiment;
      if (updated.campaign_id) {
        await insertEvent(client, tenantId, memorySpace, {
          campaign_id: updated.campaign_id, event_type: "experiment_status_changed",
          summary: `Eksperiment "${updated.name}" status endret: ${current.status} -> ${status}`,
          actor_person_id: actorPersonId ?? null, metadata: { experiment_id: experimentId, from: current.status, to: status }
        });
      }
      return updated;
    });
  }

  async listEvents(tenantId: string, memorySpace: MemorySpace, campaignId: string): Promise<CampaignEvent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM marketing_campaign_events WHERE tenant_id = $1 AND campaign_id = $2 ORDER BY occurred_at ASC`,
        [tenantId, campaignId]
      );
      return rows as CampaignEvent[];
    });
  }

  private async readForUpdate(client: pg.PoolClient, tenantId: string, campaignId: string, lock: boolean): Promise<Campaign | null> {
    const { rows } = await client.query(
      `SELECT * FROM marketing_campaigns WHERE tenant_id = $1 AND campaign_id = $2${lock ? " FOR UPDATE" : ""}`,
      [tenantId, campaignId]
    );
    return (rows[0] as Campaign) ?? null;
  }
}

async function insertCampaign(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: CreateCampaignInput): Promise<Campaign> {
  const campaign_id = `grw-cm-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO marketing_campaigns
       (campaign_id, tenant_id, memory_space_id, channel, name, budget_amount_ore, currency, external_campaign_id, canonical_uri, owner_person_id, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      campaign_id, tenantId, memorySpace, input.channel, input.name, input.budget_amount_ore ?? null,
      input.currency ?? "NOK", input.external_campaign_id ?? null, input.canonical_uri ?? null,
      input.owner_person_id ?? null, input.started_at ?? null
    ]
  );
  return rows[0] as Campaign;
}

interface InsertEventInput {
  campaign_id: string;
  event_type: CampaignEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
}

async function insertEvent(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: InsertEventInput): Promise<CampaignEvent> {
  const event_id = `grw-ev-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO marketing_campaign_events (event_id, tenant_id, memory_space_id, campaign_id, event_type, summary, actor_person_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [event_id, tenantId, memorySpace, input.campaign_id, input.event_type, input.summary, input.actor_person_id, JSON.stringify(input.metadata)]
  );
  return rows[0] as CampaignEvent;
}
