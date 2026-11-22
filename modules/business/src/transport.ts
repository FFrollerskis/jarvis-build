import type pg from "pg";
import { correlationFields, type IdentityContext, type JsonValue, type MemorySpace } from "@jarvis/contracts";
import { DailyBrief } from "@jarvis/tool-gateway";
import type { BriefSource, ToolGateway, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { BusinessService } from "./service.ts";
import { BusinessPipelineError, BusinessPipelineService, type PipelineContext } from "./pipeline-service.ts";
import { ChurnService } from "./churn-service.ts";
import { ProductUsageService } from "./product-usage-service.ts";
import { businessOpenLoopsSource, generateWeeklyBrief, renderWeeklyBrief } from "./business-brief.ts";
import type { OpenLoopService } from "./open-loop-service.ts";
import { BusinessEventSyncService } from "./business-event-sync.ts";
import type { ScoringService } from "./scoring-service.ts";
import type { ScoreEntityType } from "./scoring-types.ts";

/**
 * D-49: `ToolTransport.invoke(action, parameters, credential)` gir - som for
 * ALLE eksisterende transporter (Gmail/Calendar/Github/Drive) - IKKE
 * `IdentityContext` til transporten. `tenant_id`/`memory_space` MÅ derfor
 * komme via de zod-validerte `parameters` - som ALLTID bygges av TRUSTED
 * kallerlag (MeshToolExecutor-mapping/API-handler), ALDRI av modell-output.
 * Samme presedens som `mesh-bridge.ts` sin `parameters: (modelArgs) => ...`-
 * bygging for calendar/email/github (modellen bestemmer aldri gateway-
 * parametre for sensitive felter). Dette er en KJENT, delt arkitektur-
 * begrensning i `ToolTransport`, ikke noe nytt Business OS introduserer -
 * en generisk utvidelse av `ToolTransport` til å motta identity er BEVISST
 * utelatt fra dette sliceet (for stor endring for smallest-coherent-unit).
 */
export class BusinessTransport implements ToolTransport {
  private eventSync?: BusinessEventSyncService;
  private pipeline?: BusinessPipelineService;
  private churn?: ChurnService;
  private usage?: ProductUsageService;

  constructor(
    private readonly service: BusinessService,
    private readonly openLoops?: OpenLoopService,
    private readonly pool?: pg.Pool,
    private readonly gateway?: ToolGateway,
    private readonly scoring?: ScoringService,
    /**
     * D-90 (UA-4 NESTE SLICE): valgfrie EKSTRA `BriefSource`-er for Business
     * OS-dagsbriefen, injisert fra app-laget (`apps/api/src/main.ts`) - IKKE
     * konstruert her. `@jarvis/business` importerer BEVISST ALDRI
     * `@jarvis/growth` (som allerede avhenger av `@jarvis/business` -
     * en motsatt avhengighet ville vært sirkulær); i stedet bygger
     * app-laget f.eks. `marketingMemoryBriefSource(growthService)` og
     * sender den inn her som en ren `@jarvis/tool-gateway`-kontrakt denne
     * transporten allerede kjenner. Tom liste som default - EKSAKT samme
     * brief-oppførsel som FØR denne sliceen når ingen ekstra kilder gis.
     */
    private readonly extraBriefSources: BriefSource[] = []
  ) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential?: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    // WP-D2: pipeline-skrivingene (lead/opportunity) har forsvar i dybden utover gatewayens scope-sjekk - identitetens tenant MÅ være tenanten det skrives i.
    const pipelineCtx = (): PipelineContext => {
      if (context?.identity && context.identity.tenant_id !== tenantId) throw new Error("business_pipeline:scope_mismatch");
      return {
        actor_person_id: context?.identity?.person_id ?? null,
        idempotency_key: typeof parameters["idempotency_key"] === "string" ? (parameters["idempotency_key"] as string) : null
      };
    };

    switch (action) {
      case "create_company": {
        const row = await this.service.createCompany(tenantId, memorySpace, {
          name: requireString(parameters, "name"),
          ...(parameters["domain"] !== undefined ? { domain: String(parameters["domain"]) } : {}),
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as never } : {}),
          ...(parameters["source"] !== undefined ? { source: String(parameters["source"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
        });
        return { external_id: row.company_id, data: row as unknown as JsonValue };
      }
      case "create_contact": {
        const row = await this.service.createContact(tenantId, memorySpace, {
          name: requireString(parameters, "name"),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["email"] !== undefined ? { email: String(parameters["email"]) } : {}),
          ...(parameters["phone"] !== undefined ? { phone: String(parameters["phone"]) } : {}),
          ...(parameters["title"] !== undefined ? { title: String(parameters["title"]) } : {}),
          ...(parameters["source"] !== undefined ? { source: String(parameters["source"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
        });
        return { external_id: row.contact_id, data: row as unknown as JsonValue };
      }
      case "create_lead": {
        const res = await this.requirePipeline().createLead(tenantId, memorySpace, {
          title: parameters["title"], company_id: parameters["company_id"], contact_id: parameters["contact_id"], status: parameters["status"],
          source: parameters["source"], source_type: parameters["source_type"], source_instance_id: parameters["source_instance_id"],
          external_id: parameters["external_id"], owner_person_id: parameters["owner_person_id"]
        }, pipelineCtx());
        const row = res.entity as unknown as { lead_id: string };
        return { external_id: row.lead_id, data: row as unknown as JsonValue };
      }
      case "update_lead_status": {
        try {
          const res = await this.requirePipeline().setLeadStatus(tenantId, memorySpace, requireString(parameters, "lead_id"), parameters["status"], pipelineCtx());
          const row = res.entity as unknown as { lead_id: string };
          return { external_id: row.lead_id, data: row as unknown as JsonValue };
        } catch (err) {
          if (err instanceof BusinessPipelineError && err.code === "not_found") return { data: null };
          throw err;
        }
      }
      case "create_opportunity": {
        const res = await this.requirePipeline().createOpportunity(tenantId, memorySpace, {
          title: parameters["title"], company_id: parameters["company_id"], contact_id: parameters["contact_id"], lead_id: parameters["lead_id"],
          stage: parameters["stage"], value_ore: parameters["value_ore"], currency: parameters["currency"], expected_close_date: parameters["expected_close_date"],
          owner_person_id: parameters["owner_person_id"]
        }, pipelineCtx());
        const row = res.entity as unknown as { opportunity_id: string };
        return { external_id: row.opportunity_id, data: row as unknown as JsonValue };
      }
      case "update_opportunity_stage": {
        try {
          const res = await this.requirePipeline().moveOpportunityStage(
            tenantId, memorySpace, requireString(parameters, "opportunity_id"), parameters["stage"], parameters["value_ore"], pipelineCtx()
          );
          const row = res.entity as unknown as { opportunity_id: string };
          return { external_id: row.opportunity_id, data: row as unknown as JsonValue };
        } catch (err) {
          if (err instanceof BusinessPipelineError && err.code === "not_found") return { data: null };
          throw err;
        }
      }
      // WP-D2 (JARVIS-049): nye pipeline-handlinger. Alle skriver via BusinessPipelineService (kun business-tenant, før/etter-logg, valgfri idempotency_key).
      case "update_lead": {
        const res = await this.requirePipeline().updateLead(tenantId, memorySpace, requireString(parameters, "lead_id"), pickPatch(parameters, LEAD_PATCH_KEYS), pipelineCtx());
        return pipelineData(res, requireString(parameters, "lead_id"));
      }
      case "update_opportunity": {
        const res = await this.requirePipeline().updateOpportunity(tenantId, memorySpace, requireString(parameters, "opportunity_id"), pickPatch(parameters, OPPORTUNITY_PATCH_KEYS), pipelineCtx());
        return pipelineData(res, requireString(parameters, "opportunity_id"));
      }
      case "set_next_action": {
        const res = await this.requirePipeline().setNextAction(
          tenantId, memorySpace, requireString(parameters, "entity_type") as never, requireString(parameters, "entity_id"),
          { next_action: parameters["next_action"] === undefined ? null : parameters["next_action"], next_action_due_at: parameters["next_action_due_at"] }, pipelineCtx()
        );
        return pipelineData(res, requireString(parameters, "entity_id"));
      }
      case "close_lead": {
        const res = await this.requirePipeline().closeLead(tenantId, memorySpace, requireString(parameters, "lead_id"), { outcome: parameters["outcome"], reason: parameters["reason"] }, pipelineCtx());
        return pipelineData(res, requireString(parameters, "lead_id"));
      }
      case "close_opportunity": {
        const res = await this.requirePipeline().closeOpportunity(
          tenantId, memorySpace, requireString(parameters, "opportunity_id"),
          { outcome: parameters["outcome"], reason: parameters["reason"], final_value_ore: parameters["final_value_ore"] }, pipelineCtx()
        );
        return pipelineData(res, requireString(parameters, "opportunity_id"));
      }
      case "delete_lead": {
        const res = await this.requirePipeline().deleteLead(tenantId, memorySpace, requireString(parameters, "lead_id"), pipelineCtx());
        return { external_id: res.entity_id, data: res as unknown as JsonValue };
      }
      case "delete_opportunity": {
        const res = await this.requirePipeline().deleteOpportunity(tenantId, memorySpace, requireString(parameters, "opportunity_id"), pipelineCtx());
        return { external_id: res.entity_id, data: res as unknown as JsonValue };
      }
      // Gatewayens klasse C-evidens (`preflight_action`): saneret før/etter-snapshot (ingen fritekst) - se BusinessPipelineService.inspect().
      case "inspect_lead": {
        const snap = await this.requirePipeline().inspect(tenantId, memorySpace, "lead", requireString(parameters, "lead_id"));
        return { data: snap as JsonValue };
      }
      case "inspect_opportunity": {
        const snap = await this.requirePipeline().inspect(tenantId, memorySpace, "opportunity", requireString(parameters, "opportunity_id"));
        return { data: snap as JsonValue };
      }
      case "record_activity": {
        const row = await this.service.recordActivity(tenantId, memorySpace, {
          activity_type: requireString(parameters, "activity_type") as never,
          summary: requireString(parameters, "summary"),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["opportunity_id"] !== undefined ? { opportunity_id: String(parameters["opportunity_id"]) } : {}),
          ...(parameters["lead_id"] !== undefined ? { lead_id: String(parameters["lead_id"]) } : {}),
          ...(parameters["source_type"] !== undefined ? { source_type: String(parameters["source_type"]) } : {}),
          ...(parameters["source_instance_id"] !== undefined ? { source_instance_id: String(parameters["source_instance_id"]) } : {}),
          ...(parameters["external_id"] !== undefined ? { external_id: String(parameters["external_id"]) } : {}),
          ...(parameters["canonical_uri"] !== undefined ? { canonical_uri: String(parameters["canonical_uri"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["occurred_at"] !== undefined ? { occurred_at: String(parameters["occurred_at"]) } : {})
        });
        return { external_id: row.activity_id, data: row as unknown as JsonValue };
      }
      case "find_companies": {
        const rows = await this.service.findCompanies(tenantId, memorySpace, requireString(parameters, "query"), parameters["limit"] !== undefined ? Number(parameters["limit"]) : 10);
        return { data: rows as unknown as JsonValue };
      }
      case "find_contacts": {
        const rows = await this.service.findContacts(tenantId, memorySpace, requireString(parameters, "query"), parameters["limit"] !== undefined ? Number(parameters["limit"]) : 10);
        return { data: rows as unknown as JsonValue };
      }
      case "get_customer_overview": {
        const overview = await this.service.customerOverview(tenantId, memorySpace, requireString(parameters, "company_id"));
        return { data: overview as unknown as JsonValue };
      }
      case "read_company_timeline": {
        const rows = await this.service.companyTimeline(tenantId, memorySpace, requireString(parameters, "company_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "create_followup": {
        const row = await this.service.createFollowup(tenantId, memorySpace, {
          title: requireString(parameters, "title"),
          due_at: requireString(parameters, "due_at"),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["opportunity_id"] !== undefined ? { opportunity_id: String(parameters["opportunity_id"]) } : {}),
          ...(parameters["lead_id"] !== undefined ? { lead_id: String(parameters["lead_id"]) } : {}),
          ...(parameters["activity_id"] !== undefined ? { activity_id: String(parameters["activity_id"]) } : {}),
          ...(parameters["reason"] !== undefined ? { reason: String(parameters["reason"]) } : {}),
          ...(parameters["next_action"] !== undefined ? { next_action: String(parameters["next_action"]) } : {}),
          ...(parameters["priority"] !== undefined ? { priority: parameters["priority"] as never } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["idempotency_key"] !== undefined ? { idempotency_key: String(parameters["idempotency_key"]) } : {})
        });
        return { external_id: row.followup_id, data: row as unknown as JsonValue };
      }
      case "complete_followup": {
        const row = await this.service.completeFollowup(tenantId, memorySpace, requireString(parameters, "followup_id"));
        return { ...(row ? { external_id: row.followup_id } : {}), data: row as unknown as JsonValue };
      }
      case "cancel_followup": {
        const row = await this.service.cancelFollowup(tenantId, memorySpace, requireString(parameters, "followup_id"));
        return { ...(row ? { external_id: row.followup_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_overdue_followups": {
        const rows = await this.service.overdueFollowups(
          tenantId, memorySpace, parameters["as_of"] !== undefined ? String(parameters["as_of"]) : undefined
        );
        return { data: rows as unknown as JsonValue };
      }
      case "read_metrics": {
        const metrics = await this.service.metrics(tenantId, memorySpace);
        return { data: metrics as unknown as JsonValue };
      }
      case "list_open_loops": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "open") as "open" | "resolved" | "all";
        const rows = await this.requireOpenLoops().listOpenLoops(tenantId, memorySpace, status);
        return { data: rows as unknown as JsonValue };
      }
      case "read_open_loop": {
        const row = await this.requireOpenLoops().readOpenLoop(tenantId, memorySpace, requireString(parameters, "open_loop_id"));
        return { ...(row ? { external_id: row.open_loop_id } : {}), data: row as unknown as JsonValue };
      }
      case "get_attention_queue": {
        const rows = await this.requireOpenLoops().attentionQueue(tenantId, memorySpace);
        return { data: rows as unknown as JsonValue };
      }
      case "get_business_brief": {
        const period = (parameters["period"] !== undefined ? String(parameters["period"]) : "daily") as "daily" | "weekly";
        if (period === "weekly") {
          const brief = await generateWeeklyBrief(this.requirePool(), tenantId, memorySpace);
          return { data: { ...brief, rendered: renderWeeklyBrief(brief) } as unknown as JsonValue };
        }
        const identity: IdentityContext = {
          person_id: "system", tenant_id: tenantId, memory_space_id: memorySpace,
          session_id: `business-brief-${tenantId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
        };
        const dailyBrief = new DailyBrief(
          [businessOpenLoopsSource(this.requireOpenLoops()), ...this.extraBriefSources],
          this.pool
        );
        const brief = await dailyBrief.generate(identity);
        return { data: { ...brief, rendered: DailyBrief.render(brief) } as unknown as JsonValue };
      }
      case "resolve_open_loop": {
        // WP-D2 (JARVIS-045): valgfritt utfall (acted/dismissed) = kalibreringsgrunnlag; tjenesten avviser alt annet FØR noe skrives.
        const outcome = parameters["outcome"] === undefined ? undefined : String(parameters["outcome"]);
        const row = await this.requireOpenLoops().resolveOpenLoop(
          tenantId, memorySpace, requireString(parameters, "open_loop_id"), requireString(parameters, "resolution_reason"), outcome as "acted" | "dismissed" | undefined
        );
        return { ...(row ? { external_id: row.open_loop_id } : {}), data: row as unknown as JsonValue };
      }
      // WP-D2 (UA-3 «churn/product usage», JARVIS-045): lesing av churn-oversikt og kalibreringsrapport, og eierens kobling konto -> selskap (klasse B, bak bekreftelse).
      case "get_churn_overview": {
        const minLevel = parameters["min_level"] === undefined ? "medium" : String(parameters["min_level"]);
        if (minLevel !== "medium" && minLevel !== "high") throw new Error("business_churn:min_level_invalid");
        const limit = parameters["limit"] !== undefined ? Number(parameters["limit"]) : 20;
        const overview = await this.requireChurn().overview(tenantId, memorySpace, { minLevel, limit });
        return { data: overview as unknown as JsonValue };
      }
      case "get_calibration_report": {
        const sinceDays = parameters["since_days"] !== undefined ? Number(parameters["since_days"]) : undefined;
        const report = await this.requireOpenLoops().calibrationReport(tenantId, memorySpace, sinceDays !== undefined ? { sinceDays } : {});
        return { data: report as unknown as JsonValue };
      }
      case "link_product_account": {
        // Forsvar i dybden utover gatewayens scope-sjekk: identitetens tenant MÅ være tenanten det skrives i.
        if (context?.identity && context.identity.tenant_id !== tenantId) throw new Error("business_usage:scope_mismatch");
        const r = await this.requireUsage().linkAccount(tenantId, memorySpace, parameters["account_ref"], parameters["company_id"], context?.identity?.person_id ?? null);
        return { data: { changed: r.changed, company_id: r.company_id, previous_company_id: r.previous_company_id } as unknown as JsonValue };
      }
      case "defer_open_loop": {
        const row = await this.requireOpenLoops().deferOpenLoop(
          tenantId, memorySpace, requireString(parameters, "open_loop_id"), requireString(parameters, "due_at")
        );
        return { ...(row ? { external_id: row.open_loop_id } : {}), data: row as unknown as JsonValue };
      }
      case "assign_open_loop": {
        const row = await this.requireOpenLoops().assignOpenLoop(
          tenantId, memorySpace, requireString(parameters, "open_loop_id"), requireString(parameters, "owner_person_id")
        );
        return { ...(row ? { external_id: row.open_loop_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_open_loop_next_action": {
        const row = await this.requireOpenLoops().setNextAction(
          tenantId, memorySpace, requireString(parameters, "open_loop_id"), requireString(parameters, "next_action")
        );
        return { ...(row ? { external_id: row.open_loop_id } : {}), data: row as unknown as JsonValue };
      }
      case "sync_business_events": {
        const identity: IdentityContext = {
          person_id: "system", tenant_id: tenantId, memory_space_id: memorySpace,
          session_id: `business-events-sync-${tenantId}`, device_id: "jarvis-core",
          channel: "api", auth_strength: "active"
        };
        // WP-K (JARVIS-054): det nøstede `system`-kallet arver korrelasjons-ID-ene fra det YTRE kallet (hvis det hadde noen), slik at radene kan knyttes til jobben/oppgaven som ba om synken.
        const result = await this.requireEventSync().syncTenant(tenantId, memorySpace, identity, correlationFields({ task_id: context?.task_id, trace_id: context?.trace_id }));
        return { data: result as unknown as JsonValue };
      }
      case "get_lead_score": {
        const row = await this.requireScoring().explainScore(tenantId, memorySpace, "lead", requireString(parameters, "lead_id"));
        return { ...(row ? { external_id: row.score_id } : {}), data: row as unknown as JsonValue };
      }
      case "get_opportunity_score": {
        const row = await this.requireScoring().explainScore(tenantId, memorySpace, "opportunity", requireString(parameters, "opportunity_id"));
        return { ...(row ? { external_id: row.score_id } : {}), data: row as unknown as JsonValue };
      }
      case "explain_score": {
        const entityType = requireString(parameters, "entity_type") as ScoreEntityType;
        const row = await this.requireScoring().explainScore(tenantId, memorySpace, entityType, requireString(parameters, "entity_id"));
        return { ...(row ? { external_id: row.score_id } : {}), data: row as unknown as JsonValue };
      }
      case "rank_leads": {
        const limit = parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined;
        const rows = await this.requireScoring().rankLeads(tenantId, memorySpace, limit);
        return { data: rows as unknown as JsonValue };
      }
      case "rank_opportunities": {
        const limit = parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined;
        const rows = await this.requireScoring().rankOpportunities(tenantId, memorySpace, limit);
        return { data: rows as unknown as JsonValue };
      }
      case "recalculate_score": {
        const entityType = requireString(parameters, "entity_type") as ScoreEntityType;
        const entityId = requireString(parameters, "entity_id");
        const row = entityType === "lead"
          ? await this.requireScoring().recalculateLeadScore(tenantId, memorySpace, entityId)
          : await this.requireScoring().recalculateOpportunityScore(tenantId, memorySpace, entityId);
        return { ...(row ? { external_id: row.score_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_manual_override": {
        const entityType = requireString(parameters, "entity_type") as ScoreEntityType;
        const entityId = requireString(parameters, "entity_id");
        const row = await this.requireScoring().setManualOverride(tenantId, memorySpace, entityType, entityId, {
          override_score: requireNumber(parameters, "override_score"),
          reason: requireString(parameters, "reason"),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { ...(row ? { external_id: row.score_id } : {}), data: row as unknown as JsonValue };
      }
      case "clear_manual_override": {
        const entityType = requireString(parameters, "entity_type") as ScoreEntityType;
        const entityId = requireString(parameters, "entity_id");
        const row = await this.requireScoring().clearManualOverride(tenantId, memorySpace, entityType, entityId);
        return { ...(row ? { external_id: row.score_id } : {}), data: row as unknown as JsonValue };
      }
      default:
        throw new Error(`business_action_not_implemented:${action}`);
    }
  }

  private requireChurn(): ChurnService {
    this.churn ??= new ChurnService(this.requirePool());
    return this.churn;
  }

  private requireUsage(): ProductUsageService {
    this.usage ??= new ProductUsageService(this.requirePool());
    return this.usage;
  }

  private requirePipeline(): BusinessPipelineService {
    this.pipeline ??= new BusinessPipelineService(this.requirePool());
    return this.pipeline;
  }

  private requireOpenLoops(): OpenLoopService {
    if (!this.openLoops) throw new Error("business_open_loops_not_configured");
    return this.openLoops;
  }

  private requirePool(): pg.Pool {
    if (!this.pool) throw new Error("business_pool_not_configured");
    return this.pool;
  }

  private requireEventSync(): BusinessEventSyncService {
    if (!this.gateway) throw new Error("business_event_sync_gateway_not_configured");
    this.eventSync ??= new BusinessEventSyncService(this.gateway, this.service, this.requireOpenLoops());
    return this.eventSync;
  }

  private requireScoring(): ScoringService {
    if (!this.scoring) throw new Error("business_scoring_not_configured");
    return this.scoring;
  }
}

/** Feltene (parameternavn) som `update_lead`/`update_opportunity` kan endre - alt annet i parametrene (id-er, nøkkel, scope) er aldri en del av patchen. */
const LEAD_PATCH_KEYS = ["title", "company_id", "contact_id", "source", "assign_to_person_id"] as const;
const OPPORTUNITY_PATCH_KEYS = ["title", "company_id", "contact_id", "lead_id", "value_ore", "currency", "expected_close_date", "assign_to_person_id"] as const;

function pickPatch(parameters: Record<string, JsonValue>, keys: readonly string[]): Record<string, JsonValue> {
  const patch: Record<string, JsonValue> = {};
  for (const key of keys) if (parameters[key] !== undefined) patch[key] = parameters[key] as JsonValue;
  return patch;
}

function pipelineData(res: { entity: unknown; changed: boolean; replayed: boolean; change_id: string | null; changed_fields: string[] }, entityId: string): { external_id: string; data: JsonValue } {
  return {
    external_id: entityId,
    data: { changed: res.changed, replayed: res.replayed, change_id: res.change_id, changed_fields: res.changed_fields, entity: res.entity } as unknown as JsonValue
  };
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`business_missing_parameter:${key}`);
  }
  return value;
}

function requireNumber(parameters: Record<string, JsonValue>, key: string): number {
  const value = parameters[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`business_missing_parameter:${key}`);
  }
  return value;
}
