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
  CampaignActionRecommendation,
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
  RecommendationStatus,
  RecommendationType,
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

  /**
   * D-83: leser en kampanje via `(channel, external_campaign_id)` i stedet
   * for Jarvis sin egen `campaign_id` - den nøkkelen en ekstern
   * leverandør-synk (f.eks. `GoogleAdsTransport`) faktisk kjenner. Ren
   * lesing - INGEN mutasjon.
   */
  async findCampaignByExternalId(
    tenantId: string,
    memorySpace: MemorySpace,
    channel: CampaignChannel,
    externalCampaignId: string
  ): Promise<Campaign | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM marketing_campaigns WHERE tenant_id = $1 AND channel = $2 AND external_campaign_id = $3`,
        [tenantId, channel, externalCampaignId]
      );
      return (rows[0] as Campaign) ?? null;
    });
  }

  /**
   * D-83 (UA-4 Google Ads-slice): idempotent upsert av en kampanje sporet
   * FRA en ekstern leverandør (`ON CONFLICT (tenant_id, channel,
   * external_campaign_id)` - SAMME unike indeks `027_growth.sql` allerede
   * definerte for akkurat dette formålet). BEVISST forskjellig fra
   * `setStatus()`: et leverandør-rapportert statusfelt er et EKSTERNT FAKTUM
   * (EXTERNAL_CANONICAL, D-64) - IKKE en Jarvis-initiert
   * lifecycle-handling - og skal derfor ALDRI tvinges gjennom
   * `assertValidCampaignTransition()` sin interne, Jarvis-initierte
   * tilstandsmaskin (en leverandør kan rapportere en overgang - f.eks.
   * PAUSED direkte fra en kampanje Jarvis fortsatt tror er 'draft' - som den
   * interne FSM-en aldri ville tillatt som en EGEN handling, men som er en
   * fullstendig gyldig SANNHET om ekstern tilstand). `status` mappes av
   * kalleren FØR denne metoden (se `mapGoogleAdsCampaignStatus()` i
   * `google-ads-transport.ts`) - denne metoden selv gjør INGEN
   * leverandør-spesifikk tolkning. Logger `campaign_created` KUN ved faktisk
   * ny rad, `status_changed` KUN ved en FAKTISK statusendring (aldri en
   * hendelse ved uendret synk - unngår tidslinje-spam ved daglig re-synk).
   */
  async upsertCampaignFromProvider(
    tenantId: string,
    memorySpace: MemorySpace,
    input: {
      channel: CampaignChannel;
      external_campaign_id: string;
      name: string;
      status?: CampaignStatus;
      currency?: string;
      actor_person_id?: string;
    }
  ): Promise<Campaign> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: existingRows } = await client.query(
        `SELECT * FROM marketing_campaigns WHERE tenant_id = $1 AND channel = $2 AND external_campaign_id = $3 FOR UPDATE`,
        [tenantId, input.channel, input.external_campaign_id]
      );
      const existing = existingRows[0] as Campaign | undefined;
      const nextStatus = input.status ?? existing?.status ?? "draft";
      // `started_at`/`ended_at` beregnes med SQL `now()` (aldri JS-klokken -
      // unngår klokke-skew, samme presedens som resten av filen) og settes
      // KUN én gang (COALESCE beholder en eksisterende verdi UENDRET) - både
      // ved FØRSTE INSERT (INGEN eksisterende rad, `ON CONFLICT`-grenen
      // kjører ALDRI da) OG ved en SENERE overgang på en allerede
      // eksisterende rad (`ON CONFLICT DO UPDATE`-grenen).
      const { rows } = await client.query(
        `INSERT INTO marketing_campaigns (campaign_id, tenant_id, memory_space_id, channel, name, status, currency, external_campaign_id, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 CASE WHEN $6 = 'active' THEN now() ELSE NULL END,
                 CASE WHEN $6 = 'ended' THEN now() ELSE NULL END)
         ON CONFLICT (tenant_id, channel, external_campaign_id) DO UPDATE SET
           name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now(),
           started_at = COALESCE(marketing_campaigns.started_at, CASE WHEN EXCLUDED.status = 'active' THEN now() ELSE NULL END),
           ended_at = COALESCE(marketing_campaigns.ended_at, CASE WHEN EXCLUDED.status = 'ended' THEN now() ELSE NULL END)
         RETURNING *`,
        [`grw-cm-${randomUUID()}`, tenantId, memorySpace, input.channel, input.name, nextStatus, input.currency ?? "NOK", input.external_campaign_id]
      );
      const campaign = rows[0] as Campaign;
      if (!existing) {
        await insertEvent(client, tenantId, memorySpace, {
          campaign_id: campaign.campaign_id, event_type: "campaign_created",
          summary: `Kampanje synkronisert fra leverandør: ${input.name} (${input.channel})`,
          actor_person_id: input.actor_person_id ?? null,
          metadata: { source: "provider_sync", channel: input.channel, external_campaign_id: input.external_campaign_id }
        });
      } else if (existing.status !== nextStatus) {
        await insertEvent(client, tenantId, memorySpace, {
          campaign_id: campaign.campaign_id, event_type: "status_changed",
          summary: `Status synkronisert fra leverandør: ${existing.status} -> ${nextStatus}`,
          actor_person_id: input.actor_person_id ?? null,
          metadata: { source: "provider_sync", channel: input.channel, from: existing.status, to: nextStatus }
        });
      }
      return campaign;
    });
  }

  /**
   * D-85: anomaly -> recommended-action control-plane-fundament. Kalt av
   * `detectAndRecommendSpendAnomalies()` (denne filen) med den SAMME
   * `detection_key`-formen `OpenLoopService.detectSpendAnomalies()`
   * (modules/business) bruker for sin egen open-loop - idempotent, EN
   * aktiv anbefaling per kampanje+regel samtidig (SAMME "gjenåpning ved
   * samme vilkår"-mønster som `upsertOpenLoop()`). `source` er ALLTID
   * `'deterministic_rule'` (databasens CHECK-constraint håndhever dette) -
   * ZERO AI-inferens, ZERO ModelGateway-kall (Q-26-grensen). BESLUTNINGS-
   * lag ALENE: oppretter/oppdaterer KUN Jarvis sin egen interne
   * anbefaling-rad, rører ALDRI noe utenfor egen database - ekte
   * provider-utførelse (pause/reduser budsjett HOS Google Ads) krever en
   * separat, fremtidig kapabilitet (provider-mutate + UA-6 Finance
   * Integrity Gateway), INGEN av delene bygget her.
   */
  async upsertActionRecommendation(
    tenantId: string,
    memorySpace: MemorySpace,
    input: {
      campaign_id: string;
      open_loop_id: string | null;
      recommendation_type: RecommendationType;
      rationale: string;
      evidence: Record<string, unknown>;
      detection_key: string;
    }
  ): Promise<CampaignActionRecommendation> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { recommendation } = await upsertActionRecommendationRow(client, tenantId, memorySpace, input);
      return recommendation;
    });
  }

  async listActionRecommendations(
    tenantId: string,
    memorySpace: MemorySpace,
    filter: { campaign_id?: string; status?: RecommendationStatus | "all" } = {}
  ): Promise<CampaignActionRecommendation[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: Array<string> = [tenantId];
      if (filter.campaign_id) {
        params.push(filter.campaign_id);
        conditions.push(`campaign_id = $${params.length}`);
      }
      if (filter.status && filter.status !== "all") {
        params.push(filter.status);
        conditions.push(`status = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM marketing_campaign_action_recommendations WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
        params
      );
      return rows as CampaignActionRecommendation[];
    });
  }

  /**
   * Eier-disposisjon: markerer en anbefaling som 'accepted'/'dismissed'.
   * Utfører INGENTING mot en ekte annonseplattform - dette er REN,
   * Jarvis-intern sporing av at eieren har sett/tatt stilling til
   * anbefalingen (`accepted` betyr IKKE "Jarvis endret budsjettet hos
   * Google" - se toppkommentaren over `upsertActionRecommendation()`).
   * Kaster ved forsøk på å løse en anbefaling som IKKE er `proposed`
   * (fail-closed - en allerede løst/supersedert anbefaling skal ALDRI
   * kunne overskrives stille).
   */
  async resolveActionRecommendation(
    tenantId: string,
    memorySpace: MemorySpace,
    recommendationId: string,
    status: "accepted" | "dismissed",
    actorPersonId?: string
  ): Promise<CampaignActionRecommendation | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: currentRows } = await client.query(
        `SELECT * FROM marketing_campaign_action_recommendations WHERE tenant_id = $1 AND recommendation_id = $2 FOR UPDATE`,
        [tenantId, recommendationId]
      );
      const current = currentRows[0] as CampaignActionRecommendation | undefined;
      if (!current) return null;
      if (current.status !== "proposed") throw new Error(`recommendation_not_proposed:${current.status}`);
      const { rows } = await client.query(
        `UPDATE marketing_campaign_action_recommendations
         SET status = $3, resolved_at = now(), resolved_by_person_id = $4, updated_at = now()
         WHERE tenant_id = $1 AND recommendation_id = $2 RETURNING *`,
        [tenantId, recommendationId, status, actorPersonId ?? null]
      );
      const recommendation = rows[0] as CampaignActionRecommendation;
      await insertEvent(client, tenantId, memorySpace, {
        campaign_id: recommendation.campaign_id, event_type: "action_recommendation_resolved",
        summary: `Anbefaling ${status === "accepted" ? "godkjent" : "avvist"}: ${recommendation.recommendation_type}`,
        actor_person_id: actorPersonId ?? null,
        metadata: { recommendation_type: recommendation.recommendation_type, status }
      });
      return recommendation;
    });
  }

  /**
   * D-85: supersedes fortsatt `proposed`/`accepted` anbefalinger for en GITT
   * regel (`detectionKeyPrefix`, f.eks. `marketing_spend_anomaly:`) hvis
   * vilkår ikke lenger detekteres - kalt av `detectAndRecommendSpendAnomalies()`
   * SAMMEN med dens egen deteksjon, SAMME prinsipp som
   * `OpenLoopService` sin egen `autoResolveStale()`. Prefiks-scopet SAMME
   * prinsipp som `autoResolveStale()` sin `loop_type`-scoping - hindrer at
   * en FREMTIDIG, ANNEN anbefalingsregel utilsiktet blir supersedert av
   * denne regelens sveip. `dismissed`/`superseded` fra FØR røres ALDRI
   * (allerede en avsluttet tilstand).
   */
  async supersedeStaleActionRecommendations(
    tenantId: string,
    memorySpace: MemorySpace,
    detectionKeyPrefix: string,
    currentDetectionKeys: string[]
  ): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) =>
      supersedeStaleRecommendationRows(client, tenantId, detectionKeyPrefix, currentDetectionKeys)
    );
  }

  /**
   * D-85 kjerne-vertikal: uavhengig, growth-egen deteksjon av SAMME
   * kampanje-utgiftsavvik som `OpenLoopService.detectSpendAnomalies()`
   * (modules/business) allerede overvåker - BEVISST duplisert SQL (IKKE en
   * delt hjelpefunksjon) fordi `modules/business` ALDRI kan avhenge av
   * `modules/growth` (`modules/growth` avhenger allerede av
   * `modules/business` - en motsatt avhengighet ville vært sirkulær) OG
   * fordi OpenLoopService sitt eget arkitektoniske prinsipp er at den
   * ALDRI skriver utenfor sin egen `business_open_loops`-tabell (denne
   * metoden skriver til `marketing_campaign_action_recommendations`, som
   * growth EIER). De to reglene deler KUN `detection_key`-strengformen
   * (`marketing_spend_anomaly:${campaign_id}`) som en løs, dokumentert
   * kontrakt - IKKE et delt kodested. `deviationFactor`/`minBaselineOre`
   * default-verdiene er BEVISST identiske med OpenLoopService sine egne
   * (samme avviks-definisjon for BEGGE reglene) - endres den ene, MÅ den
   * andre endres tilsvarende (dokumentert her og der).
   *
   * Kobler til SØSTER-open-loopen (les-ONLY spørring mot
   * `business_open_loops`, SAMME "growth leser business sine tabeller
   * direkte"-mønster som `campaignPerformance()` sin lesing av
   * `business_opportunities`) via SAMME `detection_key` - `open_loop_id`
   * er `null` hvis open-loopen (ennå) ikke finnes (f.eks. sveip-rekkefølge),
   * ALDRI en feil.
   */
  async detectAndRecommendSpendAnomalies(
    tenantId: string,
    memorySpace: MemorySpace,
    deviationFactor = 1.5,
    minBaselineOre = 100
  ): Promise<{ detected: number; updated: number; superseded: number }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `WITH ranked AS (
           SELECT campaign_id, event_date, spend_amount_ore,
                  AVG(spend_amount_ore) OVER (
                    PARTITION BY campaign_id ORDER BY event_date
                    ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING
                  ) AS trailing_avg_ore,
                  ROW_NUMBER() OVER (PARTITION BY campaign_id ORDER BY event_date DESC) AS rn
           FROM marketing_spend_events WHERE tenant_id = $1
         )
         SELECT r.campaign_id, r.event_date, r.spend_amount_ore, r.trailing_avg_ore, c.name
         FROM ranked r
         JOIN marketing_campaigns c ON c.tenant_id = $1 AND c.campaign_id = r.campaign_id
         WHERE r.rn = 1 AND c.status = 'active'
           AND r.trailing_avg_ore IS NOT NULL AND r.trailing_avg_ore >= $2
           AND (r.spend_amount_ore > r.trailing_avg_ore * $3 OR r.spend_amount_ore < r.trailing_avg_ore / $3)`,
        [tenantId, minBaselineOre, deviationFactor]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      const detectionKeyPrefix = "marketing_spend_anomaly:";
      for (const row of rows as Array<{ campaign_id: string; event_date: string; spend_amount_ore: string; trailing_avg_ore: string; name: string }>) {
        const detectionKey = `${detectionKeyPrefix}${row.campaign_id}`;
        currentKeys.push(detectionKey);
        const over = Number(row.spend_amount_ore) > Number(row.trailing_avg_ore);
        const { rows: loopRows } = await client.query(
          `SELECT open_loop_id FROM business_open_loops WHERE tenant_id = $1 AND detection_key = $2`,
          [tenantId, detectionKey]
        );
        const openLoopId = (loopRows[0] as { open_loop_id: string } | undefined)?.open_loop_id ?? null;
        const { wasCreated } = await upsertActionRecommendationRow(client, tenantId, memorySpace, {
          campaign_id: row.campaign_id, open_loop_id: openLoopId,
          recommendation_type: over ? "reduce_budget" : "investigate",
          rationale: over
            ? `Kampanje "${row.name}" sin utgift for ${row.event_date} (${row.spend_amount_ore} øre) er vesentlig over det glidende 7-dagers-snittet (${Math.round(Number(row.trailing_avg_ore))} øre) - vurder å redusere budsjett eller undersøke årsak`
            : `Kampanje "${row.name}" sin utgift for ${row.event_date} (${row.spend_amount_ore} øre) er vesentlig under det glidende 7-dagers-snittet (${Math.round(Number(row.trailing_avg_ore))} øre) - undersøk om leveransen er hindret`,
          evidence: {
            event_date: row.event_date, spend_amount_ore: row.spend_amount_ore, trailing_avg_ore: row.trailing_avg_ore, deviation_factor: deviationFactor
          },
          detection_key: detectionKey
        });
        if (wasCreated) detected++; else updated++;
      }
      const superseded = await supersedeStaleRecommendationRows(client, tenantId, detectionKeyPrefix, currentKeys);
      return { detected, updated, superseded };
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

interface UpsertActionRecommendationInput {
  campaign_id: string;
  open_loop_id: string | null;
  recommendation_type: RecommendationType;
  rationale: string;
  evidence: Record<string, unknown>;
  detection_key: string;
}

/**
 * Klient-scopet, IKKE-transaksjonell hjelpefunksjon (samme mønster som
 * `insertEvent()` over) - tar et allerede-åpent `client` direkte i stedet
 * for å åpne sin egen `withMemoryTransaction`. Dette lar BÅDE den
 * offentlige `upsertActionRecommendation()`-metoden OG
 * `detectAndRecommendSpendAnomalies()` dele SAMME transaksjon/tilkobling i
 * stedet for å neste to uavhengige `withMemoryTransaction`-kall (som ville
 * gitt to separate, ikke-atomiske transaksjoner på separate pool-
 * tilkoblinger - deadlock-/pool-uttømmings-risiko).
 */
async function upsertActionRecommendationRow(
  client: pg.PoolClient,
  tenantId: string,
  memorySpace: MemorySpace,
  input: UpsertActionRecommendationInput
): Promise<{ recommendation: CampaignActionRecommendation; wasCreated: boolean }> {
  const { rows: existingRows } = await client.query(
    `SELECT * FROM marketing_campaign_action_recommendations WHERE tenant_id = $1 AND detection_key = $2 FOR UPDATE`,
    [tenantId, input.detection_key]
  );
  const existing = existingRows[0] as CampaignActionRecommendation | undefined;
  const { rows } = await client.query(
    `INSERT INTO marketing_campaign_action_recommendations
       (recommendation_id, tenant_id, memory_space_id, campaign_id, open_loop_id, recommendation_type, rationale, evidence, detection_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, detection_key) DO UPDATE SET
       rationale = EXCLUDED.rationale, evidence = EXCLUDED.evidence, open_loop_id = EXCLUDED.open_loop_id, updated_at = now(),
       status = CASE WHEN marketing_campaign_action_recommendations.status IN ('dismissed', 'superseded') THEN 'proposed' ELSE marketing_campaign_action_recommendations.status END,
       resolved_at = CASE WHEN marketing_campaign_action_recommendations.status IN ('dismissed', 'superseded') THEN NULL ELSE marketing_campaign_action_recommendations.resolved_at END,
       resolved_by_person_id = CASE WHEN marketing_campaign_action_recommendations.status IN ('dismissed', 'superseded') THEN NULL ELSE marketing_campaign_action_recommendations.resolved_by_person_id END
     RETURNING *`,
    [
      `grw-rec-${randomUUID()}`, tenantId, memorySpace, input.campaign_id, input.open_loop_id,
      input.recommendation_type, input.rationale, JSON.stringify(input.evidence), input.detection_key
    ]
  );
  const recommendation = rows[0] as CampaignActionRecommendation;
  if (!existing) {
    await insertEvent(client, tenantId, memorySpace, {
      campaign_id: input.campaign_id, event_type: "action_recommendation_created",
      summary: `Anbefaling generert: ${input.recommendation_type} - ${input.rationale}`,
      actor_person_id: null,
      metadata: { recommendation_type: input.recommendation_type, source: "deterministic_rule", detection_key: input.detection_key }
    });
  }
  return { recommendation, wasCreated: !existing };
}

/** Klient-scopet motstykke til `upsertActionRecommendationRow()` over - samme begrunnelse. */
async function supersedeStaleRecommendationRows(
  client: pg.PoolClient,
  tenantId: string,
  detectionKeyPrefix: string,
  currentDetectionKeys: string[]
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE marketing_campaign_action_recommendations
     SET status = 'superseded', resolved_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND status IN ('proposed', 'accepted') AND detection_key LIKE $2 AND NOT (detection_key = ANY($3))`,
    [tenantId, `${detectionKeyPrefix}%`, currentDetectionKeys]
  );
  return rowCount ?? 0;
}
