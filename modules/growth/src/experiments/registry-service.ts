import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { pgDateToIsoDate } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { assertValidExperimentTransition } from "../state-machine.ts";
import type { CampaignChannel, Experiment } from "../types.ts";
import { rankCreatives, detectCreativeFatigue, lintCreative, type CreativeInput, type CreativePlatform, type DailyCtr, type FatigueResult, type LintIssue, type RankedCreative } from "./creative-intelligence.ts";
import { METRIC_DIRECTION, METRICS, evaluateExperiment, summarizeEvaluation, type ExperimentEvaluation, type Metric, type VariantTotals } from "./stats.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): eksperimentregister v2 - tjenesten over migrasjon 112/113 (plan, varianter, observasjoner, utfall). Samme RLS-primitiv som resten av vekstdomenet
 * (`withMemoryTransaction`: tenant + memory space settes i transaksjonen; ingen ny sikkerhetsmodell) og samme «klient-scopet, ikke nøstet transaksjon»-disiplin som `GrowthService`.
 *
 * ALT er deterministisk (Q-26): vinneren er en funksjon av tallene (stats.ts), ikke av en modell. Hver skrivende rad bærer proveniens (`source`, `actor_person_id`, `task_id`, `session_id`).
 * Et utfall er append-only; et nytt utfall omgjør et gammelt. Idempotens: planer/observasjoner oppdateres på naturlig nøkkel, utfall på (eksperiment, evalueringsdigest, avgjører).
 */

export type RegistrySource = "owner" | "jarvis_rule" | "import" | "system";
export type VariantKind = "creative" | "keyword" | "bid" | "budget" | "audience" | "landing_page" | "other";
export type VariantStatus = "planned" | "live" | "paused" | "retired";
export type ObservationSourceType = "manual" | "csv_import" | "provider_sync" | "derived_from_campaign";
export type OutcomeVerdict = "winner" | "no_winner" | "inconclusive" | "abandoned";

/** Proveniens på hver skrivende rad (CLAUDE.md regel 4). `source` er hvem som initierte, aldri en fritekst fra et eksternt system. */
export interface Provenance {
  source: RegistrySource;
  actor_person_id?: string;
  task_id?: string;
  session_id?: string;
}

export interface ExperimentPlan {
  plan_id: string; tenant_id: string; memory_space_id: string; experiment_id: string; primary_metric: Metric; metric_direction: string;
  window_start: string; window_end: string; min_impressions_per_variant: string; min_conversions_per_variant: string;
  confidence_level: string; min_effect_pct: string; source: RegistrySource; actor_person_id: string | null; task_id: string | null; session_id: string | null;
  created_at: string; updated_at: string;
}

export interface ExperimentVariant {
  variant_id: string; tenant_id: string; memory_space_id: string; experiment_id: string; variant_key: string; label: string; variant_kind: VariantKind;
  is_control: boolean; status: VariantStatus; campaign_id: string | null; channel: CampaignChannel | null; external_ref: string | null;
  creative: Record<string, unknown> | null; source: RegistrySource; actor_person_id: string | null; task_id: string | null; session_id: string | null;
  created_at: string; updated_at: string;
}

export interface ExperimentObservation {
  observation_id: string; tenant_id: string; memory_space_id: string; experiment_id: string; variant_id: string; observed_on: string;
  impressions: string; clicks: string; conversions: string; spend_ore: string; revenue_ore: string; source_type: ObservationSourceType; source_pointer: string | null;
  source: RegistrySource; actor_person_id: string | null; task_id: string | null; session_id: string | null; created_at: string; updated_at: string;
}

export interface ExperimentOutcome {
  outcome_id: string; tenant_id: string; memory_space_id: string; experiment_id: string; verdict: OutcomeVerdict; winner_variant_id: string | null;
  primary_metric: Metric; effect_pct: string | null; probability_best: string | null; evidence: { evaluation: ExperimentEvaluation; owner_override: boolean };
  evaluation_digest: string; decided_by: "owner" | "rule"; rationale: string | null; source: RegistrySource; actor_person_id: string | null; task_id: string | null; session_id: string | null;
  created_at: string;
}

export interface SetPlanInput {
  primary_metric: Metric;
  window_start: string;
  window_end: string;
  min_impressions_per_variant?: number;
  min_conversions_per_variant?: number;
  confidence_level?: number;
  min_effect_pct?: number;
}

export interface AddVariantInput {
  variant_key: string;
  label: string;
  variant_kind: VariantKind;
  is_control?: boolean;
  status?: VariantStatus;
  campaign_id?: string;
  channel?: CampaignChannel;
  external_ref?: string;
  creative?: Record<string, unknown>;
}

export interface RecordObservationInput {
  observed_on: string;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  spend_ore?: number;
  revenue_ore?: number;
  source_type?: ObservationSourceType;
  source_pointer?: string;
}

export interface RecordOutcomeInput {
  decided_by: "owner" | "rule";
  verdict?: OutcomeVerdict;
  winner_variant_id?: string;
  rationale?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VARIANT_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EXTERNAL_REF = /^[A-Za-z0-9:/_.~=@-]{1,300}$/;
const MAX_CREATIVE_BYTES = 8192;
const MAX_COUNT = 1_000_000_000_000; // 1e12: langt over enhver realistisk daglig/total verdi, langt under 2^53

/** Nøkkel-rekkefølge-uavhengig JSON (stabil digest). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertDate(value: string, field: string): void {
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`experiment_invalid_date:${field}`);
  }
}

function assertCount(value: number | undefined, field: string): number {
  const v = value ?? 0;
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_COUNT) throw new Error(`experiment_invalid_count:${field}`);
  return v;
}

/** `date`-kolonner kommer fra pg som `Date` i LOKAL tid (en `toISOString()` forskyver dagen utenfor UTC) - normaliseres til `YYYY-MM-DD` før de forlater tjenesten (og før de brukes som parameter). */
function planRow(row: ExperimentPlan): ExperimentPlan {
  return { ...row, window_start: pgDateToIsoDate(row.window_start as unknown as Date | string), window_end: pgDateToIsoDate(row.window_end as unknown as Date | string) };
}
function observationRow(row: ExperimentObservation): ExperimentObservation {
  return { ...row, observed_on: pgDateToIsoDate(row.observed_on as unknown as Date | string) };
}

/** Tilordner proveniens-kolonnene (alltid til stede; `source` er påkrevd). */
function prov(p: Provenance): [RegistrySource, string | null, string | null, string | null] {
  return [p.source, p.actor_person_id ?? null, p.task_id ?? null, p.session_id ?? null];
}

/** `marketing_campaign_events.actor_person_id` har en FK mot `people`: kun en ekte person (eieren) kan stå der - en system-/regelaktør gir `null` (proveniensen står uansett på raden selv). */
function eventActor(p: Provenance): string | null {
  return p.source === "owner" ? p.actor_person_id ?? null : null;
}

async function insertCampaignEvent(
  client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, campaignId: string,
  eventType: "experiment_variant_added" | "experiment_outcome_recorded", summary: string, actor: string | null, metadata: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO marketing_campaign_events (event_id, tenant_id, memory_space_id, campaign_id, event_type, summary, actor_person_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [`grw-ev-${randomUUID()}`, tenantId, memorySpace, campaignId, eventType, summary.slice(0, 500), actor, JSON.stringify(metadata)]
  );
}

async function lockExperiment(client: pg.PoolClient, tenantId: string, experimentId: string): Promise<Experiment> {
  const { rows } = await client.query(`SELECT * FROM marketing_experiments WHERE tenant_id = $1 AND experiment_id = $2 FOR UPDATE`, [tenantId, experimentId]);
  const experiment = rows[0] as Experiment | undefined;
  if (!experiment) throw new Error("experiment_not_found");
  return experiment;
}

function assertOpen(experiment: Experiment): void {
  if (experiment.status === "concluded" || experiment.status === "abandoned") throw new Error(`experiment_closed:${experiment.status}`);
}

interface AggregateRow { variant_id: string; impressions: string; clicks: string; conversions: string; spend_ore: string; revenue_ore: string }

export class ExperimentRegistryService {
  constructor(private readonly pool: pg.Pool) {}

  // --------------------------------------------------------------------------------------------- plan

  async setPlan(tenantId: string, memorySpace: MemorySpace, experimentId: string, input: SetPlanInput, p: Provenance): Promise<ExperimentPlan> {
    if (!METRICS.includes(input.primary_metric)) throw new Error("experiment_invalid_metric");
    assertDate(input.window_start, "window_start");
    assertDate(input.window_end, "window_end");
    if (input.window_end < input.window_start) throw new Error("experiment_invalid_window");
    const confidence = input.confidence_level ?? 0.95;
    if (!(confidence >= 0.8 && confidence <= 0.999)) throw new Error("experiment_invalid_confidence_level");
    const minEffect = input.min_effect_pct ?? 5;
    if (!(minEffect >= 0 && minEffect <= 1000)) throw new Error("experiment_invalid_min_effect_pct");
    const minImpressions = assertCount(input.min_impressions_per_variant ?? 1000, "min_impressions_per_variant");
    const minConversions = assertCount(input.min_conversions_per_variant ?? 0, "min_conversions_per_variant");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      assertOpen(await lockExperiment(client, tenantId, experimentId));
      const { rows } = await client.query(
        `INSERT INTO marketing_experiment_plans
           (plan_id, tenant_id, memory_space_id, experiment_id, primary_metric, metric_direction, window_start, window_end,
            min_impressions_per_variant, min_conversions_per_variant, confidence_level, min_effect_pct, source, actor_person_id, task_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (tenant_id, experiment_id) DO UPDATE SET
           primary_metric = EXCLUDED.primary_metric, metric_direction = EXCLUDED.metric_direction, window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
           min_impressions_per_variant = EXCLUDED.min_impressions_per_variant, min_conversions_per_variant = EXCLUDED.min_conversions_per_variant,
           confidence_level = EXCLUDED.confidence_level, min_effect_pct = EXCLUDED.min_effect_pct, updated_at = now(),
           source = EXCLUDED.source, actor_person_id = EXCLUDED.actor_person_id, task_id = EXCLUDED.task_id, session_id = EXCLUDED.session_id
         RETURNING *`,
        [
          `grw-xp-${randomUUID()}`, tenantId, memorySpace, experimentId, input.primary_metric, METRIC_DIRECTION[input.primary_metric], input.window_start, input.window_end,
          minImpressions, minConversions, confidence, minEffect, ...prov(p)
        ]
      );
      return planRow(rows[0] as ExperimentPlan);
    });
  }

  async getPlan(tenantId: string, memorySpace: MemorySpace, experimentId: string): Promise<ExperimentPlan | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => (await this.readPlan(client, tenantId, experimentId)));
  }

  private async readPlan(client: pg.PoolClient, tenantId: string, experimentId: string): Promise<ExperimentPlan | null> {
    const { rows } = await client.query(`SELECT * FROM marketing_experiment_plans WHERE tenant_id = $1 AND experiment_id = $2`, [tenantId, experimentId]);
    return rows[0] ? planRow(rows[0] as ExperimentPlan) : null;
  }

  // --------------------------------------------------------------------------------------------- varianter

  async addVariant(tenantId: string, memorySpace: MemorySpace, experimentId: string, input: AddVariantInput, p: Provenance): Promise<ExperimentVariant> {
    if (!VARIANT_KEY.test(input.variant_key)) throw new Error("experiment_invalid_variant_key");
    if (typeof input.label !== "string" || input.label.length < 1 || input.label.length > 120) throw new Error("experiment_invalid_label");
    if (input.external_ref !== undefined && !EXTERNAL_REF.test(input.external_ref)) throw new Error("experiment_invalid_external_ref");
    if (input.creative !== undefined && JSON.stringify(input.creative).length > MAX_CREATIVE_BYTES) throw new Error("experiment_creative_too_large");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const experiment = await lockExperiment(client, tenantId, experimentId);
      assertOpen(experiment);
      const variantId = `grw-xv-${randomUUID()}`;
      let variant: ExperimentVariant;
      try {
        const { rows } = await client.query(
          `INSERT INTO marketing_experiment_variants
             (variant_id, tenant_id, memory_space_id, experiment_id, variant_key, label, variant_kind, is_control, status, campaign_id, channel, external_ref, creative,
              source, actor_person_id, task_id, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
          [
            variantId, tenantId, memorySpace, experimentId, input.variant_key, input.label, input.variant_kind, input.is_control ?? false, input.status ?? "planned",
            input.campaign_id ?? null, input.channel ?? null, input.external_ref ?? null, input.creative === undefined ? null : JSON.stringify(input.creative), ...prov(p)
          ]
        );
        variant = rows[0] as ExperimentVariant;
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === "23505") throw new Error(e.constraint?.includes("one_control") ? "experiment_control_exists" : "experiment_variant_key_exists");
        if (e.code === "23503" && (e.constraint ?? "").includes("campaign_id")) throw new Error("experiment_campaign_not_found");
        throw err;
      }
      if (variant.campaign_id !== null) {
        await insertCampaignEvent(client, tenantId, memorySpace, variant.campaign_id, "experiment_variant_added", `Eksperimentvariant lagt til: ${variant.variant_key}`, eventActor(p),
          { experiment_id: experimentId, variant_id: variant.variant_id, variant_key: variant.variant_key });
      }
      return variant;
    });
  }

  async setVariantStatus(tenantId: string, memorySpace: MemorySpace, variantId: string, status: VariantStatus): Promise<ExperimentVariant | null> {
    if (!["planned", "live", "paused", "retired"].includes(status)) throw new Error("experiment_invalid_variant_status");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`UPDATE marketing_experiment_variants SET status = $3, updated_at = now() WHERE tenant_id = $1 AND variant_id = $2 RETURNING *`, [tenantId, variantId, status]);
      return (rows[0] as ExperimentVariant | undefined) ?? null;
    });
  }

  async listVariants(tenantId: string, memorySpace: MemorySpace, experimentId: string): Promise<ExperimentVariant[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.readVariants(client, tenantId, experimentId));
  }

  private async readVariants(client: pg.PoolClient, tenantId: string, experimentId: string): Promise<ExperimentVariant[]> {
    const { rows } = await client.query(`SELECT * FROM marketing_experiment_variants WHERE tenant_id = $1 AND experiment_id = $2 ORDER BY variant_key`, [tenantId, experimentId]);
    return rows as ExperimentVariant[];
  }

  // --------------------------------------------------------------------------------------------- observasjoner

  /** Idempotent: samme (variant, dag, kildetype) oppdaterer SAMME rad. */
  async recordObservation(tenantId: string, memorySpace: MemorySpace, variantId: string, input: RecordObservationInput, p: Provenance): Promise<ExperimentObservation> {
    assertDate(input.observed_on, "observed_on");
    const impressions = assertCount(input.impressions, "impressions");
    const clicks = assertCount(input.clicks, "clicks");
    const conversions = assertCount(input.conversions, "conversions");
    const spend = assertCount(input.spend_ore, "spend_ore");
    const revenue = assertCount(input.revenue_ore, "revenue_ore");
    if (input.source_pointer !== undefined && (input.source_pointer.length < 1 || input.source_pointer.length > 300)) throw new Error("experiment_invalid_source_pointer");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: vrows } = await client.query(`SELECT experiment_id FROM marketing_experiment_variants WHERE tenant_id = $1 AND variant_id = $2`, [tenantId, variantId]);
      const variant = vrows[0] as { experiment_id: string } | undefined;
      if (!variant) throw new Error("experiment_variant_not_found");
      assertOpen(await lockExperiment(client, tenantId, variant.experiment_id));
      return this.upsertObservation(client, tenantId, memorySpace, variant.experiment_id, variantId, { ...input, impressions, clicks, conversions, spend_ore: spend, revenue_ore: revenue }, p);
    });
  }

  private async upsertObservation(
    client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, experimentId: string, variantId: string,
    input: Required<Pick<RecordObservationInput, "observed_on" | "impressions" | "clicks" | "conversions" | "spend_ore" | "revenue_ore">> & Pick<RecordObservationInput, "source_type" | "source_pointer">, p: Provenance
  ): Promise<ExperimentObservation> {
    const { rows } = await client.query(
      `INSERT INTO marketing_experiment_observations
         (observation_id, tenant_id, memory_space_id, experiment_id, variant_id, observed_on, impressions, clicks, conversions, spend_ore, revenue_ore, source_type, source_pointer,
          source, actor_person_id, task_id, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (tenant_id, variant_id, observed_on, source_type) DO UPDATE SET
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, conversions = EXCLUDED.conversions, spend_ore = EXCLUDED.spend_ore, revenue_ore = EXCLUDED.revenue_ore,
         source_pointer = EXCLUDED.source_pointer, source = EXCLUDED.source, actor_person_id = EXCLUDED.actor_person_id, task_id = EXCLUDED.task_id, session_id = EXCLUDED.session_id, updated_at = now()
       RETURNING *`,
      [
        `grw-xo-${randomUUID()}`, tenantId, memorySpace, experimentId, variantId, input.observed_on, input.impressions, input.clicks, input.conversions, input.spend_ore, input.revenue_ore,
        input.source_type ?? "manual", input.source_pointer ?? null, ...prov(p)
      ]
    );
    return observationRow(rows[0] as ExperimentObservation);
  }

  async listObservations(tenantId: string, memorySpace: MemorySpace, experimentId: string, limit = 200): Promise<ExperimentObservation[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM marketing_experiment_observations WHERE tenant_id = $1 AND experiment_id = $2 ORDER BY observed_on DESC, variant_id LIMIT $3`,
        [tenantId, experimentId, Math.min(Math.max(limit, 1), 1000)]
      );
      return (rows as ExperimentObservation[]).map(observationRow);
    });
  }

  /**
   * KOBLINGSPUNKT mot det som finnes (spend -> klikk -> lead -> møte -> kunde -> omsetning, kun på KAMPANJENIVÅ): for en variant knyttet til en kampanje utledes observasjoner per dag fra
   * Jarvis' EGNE rader - utgift/klikk/visninger fra `marketing_spend_events` (én kilde per dato, provider_sync > csv_import > manual, kun NOK - samme regel som `campaignPerformance`) og
   * konverteringer/omsetning fra VUNNE muligheter (`business_opportunities.stage = 'won'`) som er tilskrevet kampanjen, per lukkedato (UTC). Ingen nye eksterne kall.
   * Annonsenivå (en enkelt kreativ innen én kampanje) er IKKE tilgjengelig herfra - plattformens annonsenivå-innsikt er ikke synkronisert (`DEFERRED`); bruk `recordObservation` (manuelt/CSV).
   */
  async deriveObservationsFromCampaign(
    tenantId: string, memorySpace: MemorySpace, variantId: string, range: { from: string; to: string }, p: Provenance
  ): Promise<{ days_written: number; days_skipped_foreign_currency: number; observations: ExperimentObservation[] }> {
    assertDate(range.from, "from");
    assertDate(range.to, "to");
    if (range.to < range.from) throw new Error("experiment_invalid_window");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: vrows } = await client.query(`SELECT experiment_id, campaign_id FROM marketing_experiment_variants WHERE tenant_id = $1 AND variant_id = $2`, [tenantId, variantId]);
      const variant = vrows[0] as { experiment_id: string; campaign_id: string | null } | undefined;
      if (!variant) throw new Error("experiment_variant_not_found");
      if (variant.campaign_id === null) throw new Error("experiment_variant_has_no_campaign");
      assertOpen(await lockExperiment(client, tenantId, variant.experiment_id));
      const { rows } = await client.query(
        `WITH spend AS (
           SELECT DISTINCT ON (event_date) event_date AS day, spend_amount_ore, COALESCE(clicks, 0) AS clicks, COALESCE(impressions, 0) AS impressions, upper(currency) AS currency
             FROM marketing_spend_events
            WHERE tenant_id = $1 AND campaign_id = $2 AND event_date BETWEEN $3::date AND $4::date
            ORDER BY event_date, CASE source_type WHEN 'provider_sync' THEN 0 WHEN 'csv_import' THEN 1 ELSE 2 END
         ), won AS (
           SELECT (o.closed_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS conversions, COALESCE(SUM(o.value_ore), 0) AS revenue_ore
             FROM (SELECT DISTINCT entity_id FROM marketing_attributions WHERE tenant_id = $1 AND campaign_id = $2 AND entity_type = 'opportunity') a
             JOIN business_opportunities o ON o.tenant_id = $1 AND o.opportunity_id = a.entity_id AND o.stage = 'won' AND o.closed_at IS NOT NULL
            WHERE (o.closed_at AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date
            GROUP BY 1
         )
         SELECT to_char(COALESCE(s.day, w.day), 'YYYY-MM-DD') AS day, s.currency, COALESCE(s.spend_amount_ore, 0) AS spend_ore, COALESCE(s.clicks, 0) AS clicks,
                COALESCE(s.impressions, 0) AS impressions, COALESCE(w.conversions, 0) AS conversions, COALESCE(w.revenue_ore, 0) AS revenue_ore
           FROM spend s FULL OUTER JOIN won w ON w.day = s.day ORDER BY 1`,
        [tenantId, variant.campaign_id, range.from, range.to]
      );
      const observations: ExperimentObservation[] = [];
      let skipped = 0;
      for (const r of rows as Array<{ day: string; currency: string | null; spend_ore: string; clicks: string; impressions: string; conversions: string; revenue_ore: string }>) {
        // Utenlandsk valuta blandes aldri inn (samme regel som campaignPerformance): dagen hoppes over og telles.
        if (r.currency !== null && r.currency !== "NOK") { skipped++; continue; }
        observations.push(await this.upsertObservation(client, tenantId, memorySpace, variant.experiment_id, variantId, {
          observed_on: r.day, impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions), spend_ore: Number(r.spend_ore), revenue_ore: Number(r.revenue_ore),
          source_type: "derived_from_campaign", source_pointer: `campaign:${variant.campaign_id}`
        }, p));
      }
      return { days_written: observations.length, days_skipped_foreign_currency: skipped, observations };
    });
  }

  // --------------------------------------------------------------------------------------------- evaluering

  /** Summerer observasjoner per variant innenfor planens vindu. Per (variant, dag) teller KUN kilden med høyest tillit (provider_sync > derived_from_campaign > csv_import > manual) - aldri dobbelttelling. */
  private async aggregate(client: pg.PoolClient, tenantId: string, experimentId: string, from: string, to: string): Promise<Map<string, VariantTotals>> {
    const { rows } = await client.query(
      `SELECT variant_id, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(conversions) AS conversions, SUM(spend_ore) AS spend_ore, SUM(revenue_ore) AS revenue_ore
         FROM (
           SELECT DISTINCT ON (variant_id, observed_on) variant_id, observed_on, impressions, clicks, conversions, spend_ore, revenue_ore
             FROM marketing_experiment_observations
            WHERE tenant_id = $1 AND experiment_id = $2 AND observed_on BETWEEN $3::date AND $4::date
            ORDER BY variant_id, observed_on, CASE source_type WHEN 'provider_sync' THEN 0 WHEN 'derived_from_campaign' THEN 1 WHEN 'csv_import' THEN 2 ELSE 3 END
         ) d GROUP BY variant_id`,
      [tenantId, experimentId, from, to]
    );
    const out = new Map<string, VariantTotals>();
    for (const r of rows as AggregateRow[]) {
      out.set(r.variant_id, { impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions), spend_ore: Number(r.spend_ore), revenue_ore: Number(r.revenue_ore) });
    }
    return out;
  }

  private async evaluateWith(client: pg.PoolClient, tenantId: string, experimentId: string): Promise<{ evaluation: ExperimentEvaluation; digest: string; variants: ExperimentVariant[] }> {
    const plan = await this.readPlan(client, tenantId, experimentId);
    if (!plan) throw new Error("experiment_plan_missing");
    const variants = await this.readVariants(client, tenantId, experimentId);
    const totals = await this.aggregate(client, tenantId, experimentId, plan.window_start, plan.window_end);
    const evaluation = evaluateExperiment(
      {
        primary_metric: plan.primary_metric, min_impressions_per_variant: Number(plan.min_impressions_per_variant), min_conversions_per_variant: Number(plan.min_conversions_per_variant),
        confidence_level: Number(plan.confidence_level), min_effect_pct: Number(plan.min_effect_pct)
      },
      variants.map((v) => ({ variant_id: v.variant_id, variant_key: v.variant_key, is_control: v.is_control, totals: totals.get(v.variant_id) ?? { impressions: 0, clicks: 0, conversions: 0, spend_ore: 0, revenue_ore: 0 } }))
    );
    return { evaluation, digest: sha256Hex(canonicalJson(evaluation)), variants };
  }

  /** Ren lesing: evaluerer eksperimentet NÅ (lagrer ingenting). */
  async evaluate(tenantId: string, memorySpace: MemorySpace, experimentId: string): Promise<{ evaluation: ExperimentEvaluation; evaluation_digest: string }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { evaluation, digest } = await this.evaluateWith(client, tenantId, experimentId);
      return { evaluation, evaluation_digest: digest };
    });
  }

  // --------------------------------------------------------------------------------------------- utfall

  /**
   * Registrerer utfallet (append-only, idempotent på (eksperiment, evalueringsdigest, avgjører)). `rule` = utfallet er nøyaktig det deterministiske verdiktet; `owner` = eieren avgjør (kan
   * overstyre; da settes `owner_override`). winner/no_winner avslutter eksperimentet (krever `running`), abandoned forlater det, inconclusive endrer ingen status.
   */
  async recordOutcome(tenantId: string, memorySpace: MemorySpace, experimentId: string, input: RecordOutcomeInput, p: Provenance): Promise<{ outcome: ExperimentOutcome; replayed: boolean; experiment: Experiment }> {
    if (input.decided_by !== "owner" && input.decided_by !== "rule") throw new Error("experiment_invalid_decided_by");
    if (input.rationale !== undefined && (input.rationale.length < 1 || input.rationale.length > 1000)) throw new Error("experiment_invalid_rationale");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const experiment = await lockExperiment(client, tenantId, experimentId);
      assertOpen(experiment);
      const { evaluation, variants } = await this.evaluateWith(client, tenantId, experimentId);
      let verdict: OutcomeVerdict;
      let winnerId: string | null;
      if (input.decided_by === "rule") {
        if (input.verdict !== undefined && input.verdict !== evaluation.verdict) throw new Error("experiment_rule_outcome_must_match_evaluation");
        verdict = evaluation.verdict;
        winnerId = evaluation.winner_variant_id;
      } else {
        if (input.verdict === undefined) throw new Error("experiment_owner_outcome_requires_verdict");
        verdict = input.verdict;
        winnerId = verdict === "winner" ? input.winner_variant_id ?? null : null;
        if (verdict === "winner" && (winnerId === null || !variants.some((v) => v.variant_id === winnerId))) throw new Error("experiment_winner_not_in_experiment");
        if (verdict !== "winner" && input.winner_variant_id !== undefined) throw new Error("experiment_winner_only_with_winner_verdict");
      }
      const override = input.decided_by === "owner" && (verdict !== evaluation.verdict || winnerId !== evaluation.winner_variant_id);
      const digest = sha256Hex(canonicalJson({ evaluation, verdict, winner: winnerId }));
      const winnerEval = evaluation.variants.find((v) => v.variant_id === winnerId);
      const [source, actor, taskId, sessionId] = prov(p);
      const { rows } = await client.query(
        `INSERT INTO marketing_experiment_outcomes
           (outcome_id, tenant_id, memory_space_id, experiment_id, verdict, winner_variant_id, primary_metric, effect_pct, probability_best, evidence, evaluation_digest, decided_by, rationale,
            source, actor_person_id, task_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (tenant_id, experiment_id, evaluation_digest, decided_by) DO NOTHING RETURNING *`,
        [
          `grw-xr-${randomUUID()}`, tenantId, memorySpace, experimentId, verdict, winnerId, evaluation.metric, winnerEval?.vs_control?.improvement_pct ?? null, winnerEval?.probability_best ?? null,
          JSON.stringify({ evaluation, owner_override: override }), digest, input.decided_by, input.rationale ?? null, source, actor, taskId, sessionId
        ]
      );
      if (rows.length === 0) {
        const { rows: existing } = await client.query(
          `SELECT * FROM marketing_experiment_outcomes WHERE tenant_id = $1 AND experiment_id = $2 AND evaluation_digest = $3 AND decided_by = $4`, [tenantId, experimentId, digest, input.decided_by]
        );
        return { outcome: existing[0] as ExperimentOutcome, replayed: true, experiment };
      }
      const outcome = rows[0] as ExperimentOutcome;
      let updated = experiment;
      if (verdict === "winner" || verdict === "no_winner" || verdict === "abandoned") {
        const target = verdict === "abandoned" ? "abandoned" : "concluded";
        assertValidExperimentTransition(experiment.status, target);
        const summary = summarizeEvaluation(evaluation);
        const { rows: upd } = await client.query(
          `UPDATE marketing_experiments SET status = $3, result_summary = $4, ended_at = now(), updated_at = now() WHERE tenant_id = $1 AND experiment_id = $2 RETURNING *`,
          [tenantId, experimentId, target, summary.slice(0, 1000)]
        );
        updated = upd[0] as Experiment;
      }
      if (experiment.campaign_id !== null) {
        await insertCampaignEvent(client, tenantId, memorySpace, experiment.campaign_id, "experiment_outcome_recorded", `Eksperiment "${experiment.name}": utfall ${verdict}`, eventActor(p),
          { experiment_id: experimentId, verdict, decided_by: input.decided_by, outcome_id: outcome.outcome_id });
      }
      return { outcome, replayed: false, experiment: updated };
    });
  }

  async listOutcomes(tenantId: string, memorySpace: MemorySpace, experimentId: string, limit = 20): Promise<ExperimentOutcome[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM marketing_experiment_outcomes WHERE tenant_id = $1 AND experiment_id = $2 ORDER BY created_at DESC LIMIT $3`, [tenantId, experimentId, Math.min(Math.max(limit, 1), 100)]
      );
      return rows as ExperimentOutcome[];
    });
  }

  // --------------------------------------------------------------------------------------------- kreativ-intelligens (rene funksjoner over registerets data)

  async rankVariants(tenantId: string, memorySpace: MemorySpace, experimentId: string, metric?: Exclude<Metric, "roas">): Promise<{ metric: string; ranking: RankedCreative[] }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const plan = await this.readPlan(client, tenantId, experimentId);
      if (!plan) throw new Error("experiment_plan_missing");
      const use = metric ?? (plan.primary_metric === "roas" ? "ctr" : plan.primary_metric);
      const variants = await this.readVariants(client, tenantId, experimentId);
      const totals = await this.aggregate(client, tenantId, experimentId, plan.window_start, plan.window_end);
      const stats = variants.map((v) => { const t = totals.get(v.variant_id) ?? { impressions: 0, clicks: 0, conversions: 0, spend_ore: 0, revenue_ore: 0 }; return { variant_id: v.variant_id, variant_key: v.variant_key, impressions: t.impressions, clicks: t.clicks, conversions: t.conversions, spend_ore: t.spend_ore }; });
      return { metric: use, ranking: rankCreatives(stats, { metric: use }) };
    });
  }

  async creativeFatigue(tenantId: string, memorySpace: MemorySpace, variantId: string): Promise<FatigueResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT to_char(observed_on, 'YYYY-MM-DD') AS date, SUM(impressions) AS impressions, SUM(clicks) AS clicks
           FROM (SELECT DISTINCT ON (observed_on) observed_on, impressions, clicks FROM marketing_experiment_observations WHERE tenant_id = $1 AND variant_id = $2
                  ORDER BY observed_on, CASE source_type WHEN 'provider_sync' THEN 0 WHEN 'derived_from_campaign' THEN 1 WHEN 'csv_import' THEN 2 ELSE 3 END) d GROUP BY observed_on ORDER BY observed_on`,
        [tenantId, variantId]
      );
      const series: DailyCtr[] = (rows as Array<{ date: string; impressions: string; clicks: string }>).map((r) => ({ date: r.date, impressions: Number(r.impressions), clicks: Number(r.clicks) }));
      return detectCreativeFatigue(series);
    });
  }

  async lintVariant(tenantId: string, memorySpace: MemorySpace, variantId: string): Promise<{ platform: CreativePlatform | null; issues: LintIssue[] }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT channel, creative FROM marketing_experiment_variants WHERE tenant_id = $1 AND variant_id = $2`, [tenantId, variantId]);
      const v = rows[0] as { channel: string | null; creative: Record<string, unknown> | null } | undefined;
      if (!v) throw new Error("experiment_variant_not_found");
      const platform: CreativePlatform | null = v.channel === "google_ads" ? "google_ads" : v.channel === "meta_ads" ? "meta_ads" : null;
      if (platform === null) return { platform: null, issues: [{ code: "no_lint_rules_for_channel", severity: "warn", path: "channel" }] };
      if (v.creative === null) return { platform, issues: [{ code: "no_creative_recorded", severity: "warn", path: "creative" }] };
      const c = v.creative;
      const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);
      const input: CreativeInput = {
        headlines: strings(c["headlines"]), descriptions: strings(c["descriptions"]),
        ...(typeof c["primary_text"] === "string" ? { primary_text: c["primary_text"] } : {}), ...(typeof c["final_url"] === "string" ? { final_url: c["final_url"] } : {})
      };
      return { platform, issues: lintCreative(input, platform) };
    });
  }

  /** Samlet rapport (ren lesing) - eksperiment, plan, varianter med totaler, siste utfall og dagens evaluering. */
  async report(tenantId: string, memorySpace: MemorySpace, experimentId: string): Promise<Record<string, unknown>> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: erows } = await client.query(`SELECT * FROM marketing_experiments WHERE tenant_id = $1 AND experiment_id = $2`, [tenantId, experimentId]);
      const experiment = erows[0] as Experiment | undefined;
      if (!experiment) throw new Error("experiment_not_found");
      const plan = await this.readPlan(client, tenantId, experimentId);
      const variants = await this.readVariants(client, tenantId, experimentId);
      const { rows: outcomes } = await client.query(`SELECT outcome_id, verdict, winner_variant_id, decided_by, effect_pct, probability_best, rationale, created_at FROM marketing_experiment_outcomes WHERE tenant_id = $1 AND experiment_id = $2 ORDER BY created_at DESC LIMIT 5`, [tenantId, experimentId]);
      let evaluation: ExperimentEvaluation | null = null;
      let evaluationDigest: string | null = null;
      if (plan) { const e = await this.evaluateWith(client, tenantId, experimentId); evaluation = e.evaluation; evaluationDigest = e.digest; }
      return {
        experiment: { experiment_id: experiment.experiment_id, name: experiment.name, hypothesis: experiment.hypothesis, status: experiment.status, campaign_id: experiment.campaign_id, result_summary: experiment.result_summary },
        plan: plan ? { primary_metric: plan.primary_metric, metric_direction: plan.metric_direction, window_start: plan.window_start, window_end: plan.window_end } : null,
        variants: variants.map((v) => ({ variant_id: v.variant_id, variant_key: v.variant_key, label: v.label, kind: v.variant_kind, is_control: v.is_control, status: v.status, campaign_id: v.campaign_id, channel: v.channel })),
        evaluation, evaluation_digest: evaluationDigest, recent_outcomes: outcomes
      };
    });
  }
}

