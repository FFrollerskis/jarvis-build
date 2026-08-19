import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { GrowthService } from "./service.ts";
import type { AttributionEntityType, AttributionModel, CampaignChannel, CampaignStatus, ExperimentStatus } from "./types.ts";

/**
 * UA-4 Native Jarvis Growth Core (D-74): provider-nøytralt `growth.*`-
 * namespace. Samme arkitektur-begrensning som `AgreementsTransport`/
 * `SupportTransport`: `tenant_id`/`memory_space` MÅ komme via de
 * zod-validerte `parameters`, bygget av TRUSTED kallerlag. Ingen nøstet
 * klasse D-handling i denne sliceen (ingen live annonseplattform-
 * budsjett-/budhandling bygget her) - `ToolInvocationContext` (SECURITY
 * FIX #2/D-68) trengs derfor IKKE av denne transporten.
 */
export class GrowthTransport implements ToolTransport {
  constructor(private readonly service: GrowthService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

    switch (action) {
      case "create_campaign": {
        const row = await this.service.createCampaign(tenantId, memorySpace, {
          channel: requireString(parameters, "channel") as CampaignChannel,
          name: requireString(parameters, "name"),
          ...(parameters["budget_amount_ore"] !== undefined ? { budget_amount_ore: Number(parameters["budget_amount_ore"]) } : {}),
          ...(parameters["currency"] !== undefined ? { currency: String(parameters["currency"]) } : {}),
          ...(parameters["external_campaign_id"] !== undefined ? { external_campaign_id: String(parameters["external_campaign_id"]) } : {}),
          ...(parameters["canonical_uri"] !== undefined ? { canonical_uri: String(parameters["canonical_uri"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["started_at"] !== undefined ? { started_at: String(parameters["started_at"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.campaign_id, data: row as unknown as JsonValue };
      }
      case "get_campaign": {
        const row = await this.service.getCampaign(tenantId, memorySpace, requireString(parameters, "campaign_id"));
        return { ...(row ? { external_id: row.campaign_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_campaigns": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "active") as CampaignStatus | "all";
        const rows = await this.service.listCampaigns(tenantId, memorySpace, status);
        return { data: rows as unknown as JsonValue };
      }
      case "search_campaigns": {
        const rows = await this.service.searchCampaigns(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as CampaignStatus } : {}),
          ...(parameters["channel"] !== undefined ? { channel: parameters["channel"] as CampaignChannel } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["name_contains"] !== undefined ? { name_contains: String(parameters["name_contains"]) } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "list_by_company": {
        const rows = await this.service.listByCompany(tenantId, memorySpace, requireString(parameters, "company_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "set_campaign_status": {
        const row = await this.service.setStatus(
          tenantId, memorySpace, requireString(parameters, "campaign_id"), requireString(parameters, "status") as CampaignStatus, actorId(parameters)
        );
        return { ...(row ? { external_id: row.campaign_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_budget": {
        const value = parameters["budget_amount_ore"] !== undefined ? Number(parameters["budget_amount_ore"]) : null;
        const row = await this.service.setBudget(tenantId, memorySpace, requireString(parameters, "campaign_id"), value, actorId(parameters));
        return { ...(row ? { external_id: row.campaign_id } : {}), data: row as unknown as JsonValue };
      }
      case "record_spend_event": {
        const row = await this.service.recordSpendEvent(tenantId, memorySpace, requireString(parameters, "campaign_id"), {
          event_date: requireString(parameters, "event_date"),
          spend_amount_ore: Number(requireNumberish(parameters, "spend_amount_ore")),
          ...(parameters["currency"] !== undefined ? { currency: String(parameters["currency"]) } : {}),
          ...(parameters["clicks"] !== undefined ? { clicks: Number(parameters["clicks"]) } : {}),
          ...(parameters["impressions"] !== undefined ? { impressions: Number(parameters["impressions"]) } : {}),
          ...(parameters["source_type"] !== undefined ? { source_type: parameters["source_type"] as "manual" | "csv_import" | "provider_sync" } : {}),
          ...(parameters["source_pointer"] !== undefined ? { source_pointer: String(parameters["source_pointer"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.spend_event_id, data: row as unknown as JsonValue };
      }
      case "list_spend_events": {
        const rows = await this.service.listSpendEvents(tenantId, memorySpace, requireString(parameters, "campaign_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "campaign_performance": {
        const row = await this.service.campaignPerformance(tenantId, memorySpace, requireString(parameters, "campaign_id"));
        return { data: row as unknown as JsonValue };
      }
      case "attribute_to_campaign": {
        const row = await this.service.attributeToCampaign(tenantId, memorySpace, requireString(parameters, "campaign_id"), {
          entity_type: requireString(parameters, "entity_type") as AttributionEntityType,
          entity_id: requireString(parameters, "entity_id"),
          ...(parameters["attribution_model"] !== undefined ? { attribution_model: parameters["attribution_model"] as AttributionModel } : {}),
          ...(parameters["source_pointer"] !== undefined ? { source_pointer: String(parameters["source_pointer"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.attribution_id, data: row as unknown as JsonValue };
      }
      case "list_attributions": {
        const rows = await this.service.listAttributions(tenantId, memorySpace, requireString(parameters, "campaign_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "create_experiment": {
        const row = await this.service.createExperiment(tenantId, memorySpace, {
          name: requireString(parameters, "name"),
          ...(parameters["hypothesis"] !== undefined ? { hypothesis: String(parameters["hypothesis"]) } : {}),
          ...(parameters["campaign_id"] !== undefined ? { campaign_id: String(parameters["campaign_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.experiment_id, data: row as unknown as JsonValue };
      }
      case "get_experiment": {
        const row = await this.service.getExperiment(tenantId, memorySpace, requireString(parameters, "experiment_id"));
        return { ...(row ? { external_id: row.experiment_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_experiments": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "all") as ExperimentStatus | "all";
        const rows = await this.service.listExperiments(tenantId, memorySpace, status);
        return { data: rows as unknown as JsonValue };
      }
      case "set_experiment_status": {
        const row = await this.service.setExperimentStatus(
          tenantId, memorySpace, requireString(parameters, "experiment_id"), requireString(parameters, "status") as ExperimentStatus,
          parameters["result_summary"] !== undefined ? String(parameters["result_summary"]) : undefined, actorId(parameters)
        );
        return { ...(row ? { external_id: row.experiment_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_events": {
        const rows = await this.service.listEvents(tenantId, memorySpace, requireString(parameters, "campaign_id"));
        return { data: rows as unknown as JsonValue };
      }
      default:
        throw new Error(`growth_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`growth_missing_parameter:${key}`);
  }
  return value;
}

function requireNumberish(parameters: Record<string, JsonValue>, key: string): number {
  const value = parameters[key];
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`growth_missing_parameter:${key}`);
  }
  return Number(value);
}

function actorId(parameters: Record<string, JsonValue>): string | undefined {
  return parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;
}
