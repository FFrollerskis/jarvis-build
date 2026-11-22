import { z } from "zod";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { CampaignChannel } from "../types.ts";
import { METRICS, type Metric } from "./stats.ts";
import type { ExperimentRegistryService, Provenance, VariantKind, VariantStatus } from "./registry-service.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): `growth.*`-handlingene for eksperimentregisteret v2 og kreativ-intelligensen. REGISTRERES KUN med `JARVIS_GROWTH_EXPERIMENTS=on` (AV som standard: uten
 * flagget finnes verktøyene ikke, og verktøylister/utvalg/rate-grenser er identiske med main). Ingen handling står på noen modellflate i denne runden (`DEFERRED`: eksponering via
 * `OPTIONAL_TIER_KEYS` krever en egen beslutning og regenerering av flagg-AV-baselinene) - de nås via eier-ruten og interne kallere.
 *
 * IDENTITET: tenant, memory space og aktør hentes UTELUKKENDE fra den autentiserte `ToolInvocationContext.identity` - aldri fra parametere (skjemaene har ingen slike felt, og
 * `.strict()` avviser dem). Ingen handling gjør noe eksternt kall (D-64: plattformene er kilder Jarvis allerede har hentet fra). Risikoklasser: lesing/ren evaluering = A, registrering
 * (plan/variant/observasjon) = B, `conclude_experiment` (avslutter et eksperiment med et utfall) = C.
 */
export const GROWTH_EXPERIMENT_TOOL_ACTIONS = [
  "set_experiment_plan", "add_experiment_variant", "set_variant_status", "record_experiment_observation", "derive_variant_observations", "conclude_experiment",
  "evaluate_experiment", "get_experiment_report", "rank_experiment_creatives", "get_creative_fatigue", "check_variant_creative"
] as const;
export type GrowthExperimentToolAction = (typeof GROWTH_EXPERIMENT_TOOL_ACTIONS)[number];

const INTERNAL_CREDENTIAL_REF = "JARVIS_BUSINESS_INTERNAL_TOKEN";
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1).max(200);
const count = z.number().int().min(0).max(1_000_000_000_000);
const metric = z.enum(METRICS as unknown as [string, ...string[]]);
const channel = z.enum(["google_ads", "meta_ads", "ga4", "search_console", "google_business_profile", "linkedin", "youtube", "tiktok", "other"]);

type Params = Record<string, JsonValue>;

function req(parameters: Params, key: string): string {
  const v = parameters[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`growth_missing_parameter:${key}`);
  return v;
}
const opt = (parameters: Params, key: string): string | undefined => (typeof parameters[key] === "string" ? (parameters[key] as string) : undefined);
const optNum = (parameters: Params, key: string): number | undefined => (typeof parameters[key] === "number" ? (parameters[key] as number) : undefined);

export class GrowthExperimentTransport implements ToolTransport {
  constructor(private readonly registry: ExperimentRegistryService) {}

  async invoke(action: string, parameters: Params, _credential: string, context?: ToolInvocationContext): Promise<{ external_id?: string; data?: JsonValue }> {
    if (!context) throw new Error("growth_experiment_context_required");
    const identity = context.identity;
    const tenantId = identity.tenant_id;
    const space = identity.memory_space_id as MemorySpace;
    const prov: Provenance = {
      source: "owner", actor_person_id: identity.person_id, ...(context.task_id !== undefined ? { task_id: context.task_id } : {}), session_id: identity.session_id
    };
    const out = (data: unknown, external_id?: string): { external_id?: string; data?: JsonValue } => ({ ...(external_id !== undefined ? { external_id } : {}), data: data as JsonValue });
    switch (action) {
      case "set_experiment_plan": {
        const plan = await this.registry.setPlan(tenantId, space, req(parameters, "experiment_id"), {
          primary_metric: req(parameters, "primary_metric") as Metric, window_start: req(parameters, "window_start"), window_end: req(parameters, "window_end"),
          ...(optNum(parameters, "min_impressions_per_variant") !== undefined ? { min_impressions_per_variant: optNum(parameters, "min_impressions_per_variant")! } : {}),
          ...(optNum(parameters, "min_conversions_per_variant") !== undefined ? { min_conversions_per_variant: optNum(parameters, "min_conversions_per_variant")! } : {}),
          ...(optNum(parameters, "confidence_level") !== undefined ? { confidence_level: optNum(parameters, "confidence_level")! } : {}),
          ...(optNum(parameters, "min_effect_pct") !== undefined ? { min_effect_pct: optNum(parameters, "min_effect_pct")! } : {})
        }, prov);
        return out(plan, plan.plan_id);
      }
      case "add_experiment_variant": {
        const variant = await this.registry.addVariant(tenantId, space, req(parameters, "experiment_id"), {
          variant_key: req(parameters, "variant_key"), label: req(parameters, "label"), variant_kind: req(parameters, "variant_kind") as VariantKind,
          ...(typeof parameters["is_control"] === "boolean" ? { is_control: parameters["is_control"] } : {}),
          ...(opt(parameters, "status") !== undefined ? { status: opt(parameters, "status") as VariantStatus } : {}),
          ...(opt(parameters, "campaign_id") !== undefined ? { campaign_id: opt(parameters, "campaign_id")! } : {}),
          ...(opt(parameters, "channel") !== undefined ? { channel: opt(parameters, "channel") as CampaignChannel } : {}),
          ...(opt(parameters, "external_ref") !== undefined ? { external_ref: opt(parameters, "external_ref")! } : {}),
          ...(typeof parameters["creative"] === "object" && parameters["creative"] !== null && !Array.isArray(parameters["creative"]) ? { creative: parameters["creative"] as Record<string, unknown> } : {})
        }, prov);
        return out(variant, variant.variant_id);
      }
      case "set_variant_status": {
        const variant = await this.registry.setVariantStatus(tenantId, space, req(parameters, "variant_id"), req(parameters, "status") as VariantStatus);
        return out(variant, variant?.variant_id);
      }
      case "record_experiment_observation": {
        const o = await this.registry.recordObservation(tenantId, space, req(parameters, "variant_id"), {
          observed_on: req(parameters, "observed_on"),
          ...(optNum(parameters, "impressions") !== undefined ? { impressions: optNum(parameters, "impressions")! } : {}),
          ...(optNum(parameters, "clicks") !== undefined ? { clicks: optNum(parameters, "clicks")! } : {}),
          ...(optNum(parameters, "conversions") !== undefined ? { conversions: optNum(parameters, "conversions")! } : {}),
          ...(optNum(parameters, "spend_ore") !== undefined ? { spend_ore: optNum(parameters, "spend_ore")! } : {}),
          ...(optNum(parameters, "revenue_ore") !== undefined ? { revenue_ore: optNum(parameters, "revenue_ore")! } : {}),
          ...(opt(parameters, "source_type") === "csv_import" ? { source_type: "csv_import" as const } : {}),
          ...(opt(parameters, "source_pointer") !== undefined ? { source_pointer: opt(parameters, "source_pointer")! } : {})
        }, prov);
        return out(o, o.observation_id);
      }
      case "derive_variant_observations": {
        const result = await this.registry.deriveObservationsFromCampaign(tenantId, space, req(parameters, "variant_id"), { from: req(parameters, "from"), to: req(parameters, "to") }, prov);
        return out({ days_written: result.days_written, days_skipped_foreign_currency: result.days_skipped_foreign_currency });
      }
      case "conclude_experiment": {
        const r = await this.registry.recordOutcome(tenantId, space, req(parameters, "experiment_id"), {
          decided_by: req(parameters, "decided_by") as "owner" | "rule",
          ...(opt(parameters, "verdict") !== undefined ? { verdict: opt(parameters, "verdict") as "winner" | "no_winner" | "inconclusive" | "abandoned" } : {}),
          ...(opt(parameters, "winner_variant_id") !== undefined ? { winner_variant_id: opt(parameters, "winner_variant_id")! } : {}),
          ...(opt(parameters, "rationale") !== undefined ? { rationale: opt(parameters, "rationale")! } : {})
        }, prov);
        return out({ outcome: r.outcome, replayed: r.replayed, experiment_status: r.experiment.status }, r.outcome.outcome_id);
      }
      case "evaluate_experiment": return out(await this.registry.evaluate(tenantId, space, req(parameters, "experiment_id")));
      case "get_experiment_report": return out(await this.registry.report(tenantId, space, req(parameters, "experiment_id")));
      case "rank_experiment_creatives": {
        const m = opt(parameters, "metric");
        return out(await this.registry.rankVariants(tenantId, space, req(parameters, "experiment_id"), m === undefined ? undefined : (m as Exclude<Metric, "roas">)));
      }
      case "get_creative_fatigue": return out(await this.registry.creativeFatigue(tenantId, space, req(parameters, "variant_id")));
      case "check_variant_creative": return out(await this.registry.lintVariant(tenantId, space, req(parameters, "variant_id")));
      default: throw new Error(`growth_experiment_action_not_implemented:${action}`);
    }
  }
}

/**
 * Verktøydefinisjonene. KUN kalt fra `main.ts` når `JARVIS_GROWTH_EXPERIMENTS=on`. `owner_only` (gatewayen nekter alle andre enn den autentiserte eieren når credential-binding er aktiv)
 * fordi registeret bærer eierens vurderinger og beslutninger.
 */
export function growthExperimentToolDefinitions(transport: ToolTransport): ToolDefinition[] {
  const base = { tool_id: "growth", credential_ref: INTERNAL_CREDENTIAL_REF, output_trust: "internal" as const, transport, owner_only: true, idempotent_external: true, timeout_ms: 15_000 };
  const read = (action: GrowthExperimentToolAction, description: string, shape: z.ZodRawShape): ToolDefinition => ({
    ...base, action, description, input_schema: record(shape), capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)", rate_limit_per_minute: 30
  });
  const write = (action: GrowthExperimentToolAction, description: string, shape: z.ZodRawShape, rollback: string, cls: "B" | "C" = "B"): ToolDefinition => ({
    ...base, action, description, input_schema: record(shape), capability_class: cls, scopes: ["growth.write"], reversible: true, rollback_procedure: rollback, rate_limit_per_minute: 30
  });
  return [
    write("set_experiment_plan", "Sett/oppdater eksperimentplanen (metrikk, tidsvindu, terskler) - idempotent per eksperiment", {
      experiment_id: id, primary_metric: metric, window_start: date, window_end: date, min_impressions_per_variant: count.optional(), min_conversions_per_variant: count.optional(),
      confidence_level: z.number().min(0.8).max(0.999).optional(), min_effect_pct: z.number().min(0).max(1000).optional()
    }, "kall på nytt med forrige plan (ingen ekstern effekt)"),
    write("add_experiment_variant", "Legg til en variant (kontroll eller utfordrer) i et eksperiment; peker på plattformressursen, kopierer den aldri", {
      experiment_id: id, variant_key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/), label: z.string().min(1).max(120),
      variant_kind: z.enum(["creative", "keyword", "bid", "budget", "audience", "landing_page", "other"]), is_control: z.boolean().optional(),
      status: z.enum(["planned", "live", "paused", "retired"]).optional(), campaign_id: id.optional(), channel: channel.optional(),
      external_ref: z.string().regex(/^[A-Za-z0-9:/_.~=@-]{1,300}$/).optional(), creative: z.record(z.string(), z.unknown()).optional()
    }, "sett varianten til 'retired' (varianter slettes ikke; ingen ekstern effekt)"),
    write("set_variant_status", "Sett en variants status (planned/live/paused/retired) i registeret - endrer INGENTING hos plattformen", { variant_id: id, status: z.enum(["planned", "live", "paused", "retired"]) }, "sett forrige status"),
    write("record_experiment_observation", "Registrer en dags tall (visninger/klikk/konverteringer/utgift/omsetning) for en variant - idempotent per (variant, dag, kilde)", {
      variant_id: id, observed_on: date, impressions: count.optional(), clicks: count.optional(), conversions: count.optional(), spend_ore: count.optional(), revenue_ore: count.optional(),
      source_type: z.enum(["manual", "csv_import"]).optional(), source_pointer: z.string().min(1).max(300).optional()
    }, "registrer korrigerte tall for samme (variant, dag, kilde)"),
    write("derive_variant_observations", "Utled observasjoner for en kampanje-variant fra Jarvis' egne utgifts-/attribusjonsrader (spend -> klikk -> lead -> kunde -> omsetning, kampanjenivå) - ingen eksterne kall", {
      variant_id: id, from: date, to: date
    }, "kjør på nytt (idempotent per dag) eller registrer manuelle tall"),
    write("conclude_experiment", "Registrer eksperimentets utfall (append-only). decided_by=rule bruker det deterministiske verdiktet; decided_by=owner lar eieren avgjøre (overstyring merkes). winner/no_winner avslutter eksperimentet", {
      experiment_id: id, decided_by: z.enum(["owner", "rule"]), verdict: z.enum(["winner", "no_winner", "inconclusive", "abandoned"]).optional(), winner_variant_id: id.optional(), rationale: z.string().min(1).max(1000).optional()
    }, "registrer et NYTT utfall; sett eksperimentet tilbake til 'draft' via growth.set_experiment_status (avsluttede eksperimenter kan bare gå til draft)", "C"),
    read("evaluate_experiment", "Evaluer eksperimentet deterministisk NÅ (z-test, Bonferroni, praktisk signifikans) - lagrer ingenting", { experiment_id: id }),
    read("get_experiment_report", "Samlet eksperimentrapport: plan, varianter, dagens evaluering og siste utfall", { experiment_id: id }),
    read("rank_experiment_creatives", "Rangér variantene med shrunket rate (empirisk Bayes) - små utvalg trekkes mot gjennomsnittet", { experiment_id: id, metric: z.enum(["ctr", "cvr", "cpc", "cpa"]).optional() }),
    read("get_creative_fatigue", "Sjekk om en varianten viser kreativ slitasje (signifikant CTR-fall siste uke mot uken før)", { variant_id: id }),
    read("check_variant_creative", "Rådgivende lint av variantens annonsetekst mot plattformens kjente grenser (kun feltstier og koder, aldri tekstgjentakelse)", { variant_id: id })
  ];
}
