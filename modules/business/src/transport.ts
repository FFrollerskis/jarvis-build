import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { BusinessService } from "./service.ts";

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
  constructor(private readonly service: BusinessService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

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
        const row = await this.service.createLead(tenantId, memorySpace, {
          title: requireString(parameters, "title"),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as never } : {}),
          ...(parameters["source"] !== undefined ? { source: String(parameters["source"]) } : {}),
          ...(parameters["source_type"] !== undefined ? { source_type: String(parameters["source_type"]) } : {}),
          ...(parameters["source_instance_id"] !== undefined ? { source_instance_id: String(parameters["source_instance_id"]) } : {}),
          ...(parameters["external_id"] !== undefined ? { external_id: String(parameters["external_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
        });
        return { external_id: row.lead_id, data: row as unknown as JsonValue };
      }
      case "update_lead_status": {
        const row = await this.service.updateLeadStatus(
          tenantId, memorySpace, requireString(parameters, "lead_id"), requireString(parameters, "status") as never
        );
        return { ...(row ? { external_id: row.lead_id } : {}), data: row as unknown as JsonValue };
      }
      case "create_opportunity": {
        const row = await this.service.createOpportunity(tenantId, memorySpace, {
          title: requireString(parameters, "title"),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["lead_id"] !== undefined ? { lead_id: String(parameters["lead_id"]) } : {}),
          ...(parameters["stage"] !== undefined ? { stage: parameters["stage"] as never } : {}),
          ...(parameters["value_ore"] !== undefined ? { value_ore: Number(parameters["value_ore"]) } : {}),
          ...(parameters["currency"] !== undefined ? { currency: String(parameters["currency"]) } : {}),
          ...(parameters["expected_close_date"] !== undefined ? { expected_close_date: String(parameters["expected_close_date"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
        });
        return { external_id: row.opportunity_id, data: row as unknown as JsonValue };
      }
      case "update_opportunity_stage": {
        const row = await this.service.updateOpportunityStage(
          tenantId, memorySpace, requireString(parameters, "opportunity_id"), requireString(parameters, "stage") as never
        );
        return { ...(row ? { external_id: row.opportunity_id } : {}), data: row as unknown as JsonValue };
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
      default:
        throw new Error(`business_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`business_missing_parameter:${key}`);
  }
  return value;
}
