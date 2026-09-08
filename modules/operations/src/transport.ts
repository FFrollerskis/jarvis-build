import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { OperationsService } from "./service.ts";
import type { OperationsTaskPriority, OperationsTaskStatus, RunbookCategory, VendorCategory, VendorStatus } from "./types.ts";

/**
 * UA-3 Native Jarvis Operations Core (D-129): provider-nøytralt
 * `operations.*`-namespace. Samme arkitektur-begrensning som
 * `ProductTransport`/`AgreementsTransport`: `tenant_id`/`memory_space` MÅ
 * komme via de zod-validerte `parameters`, bygget av TRUSTED kallerlag.
 * Ingen nøstet klasse D-handling i denne sliceen (ingen utgående
 * kommunikasjon bygget her) - `ToolInvocationContext` (SECURITY FIX #2/
 * D-68) trengs derfor IKKE av denne transporten.
 */
export class OperationsTransport implements ToolTransport {
  constructor(private readonly service: OperationsService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

    switch (action) {
      case "create_vendor": {
        const row = await this.service.createVendor(tenantId, memorySpace, {
          name: requireString(parameters, "name"),
          ...(parameters["category"] !== undefined ? { category: parameters["category"] as VendorCategory } : {}),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["escalation_contact_person_id"] !== undefined ? { escalation_contact_person_id: String(parameters["escalation_contact_person_id"]) } : {}),
          ...(parameters["notes"] !== undefined ? { notes: String(parameters["notes"]) } : {})
        });
        return { external_id: row.vendor_id, data: row as unknown as JsonValue };
      }
      case "get_vendor": {
        const row = await this.service.getVendor(tenantId, memorySpace, requireString(parameters, "vendor_id"));
        return { ...(row ? { external_id: row.vendor_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_vendors": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "active") as VendorStatus | "all";
        const rows = await this.service.listVendors(tenantId, memorySpace, status);
        return { data: rows as unknown as JsonValue };
      }
      case "set_vendor_status": {
        const row = await this.service.setVendorStatus(tenantId, memorySpace, requireString(parameters, "vendor_id"), requireString(parameters, "status") as VendorStatus);
        return { ...(row ? { external_id: row.vendor_id } : {}), data: row as unknown as JsonValue };
      }
      case "create_runbook": {
        const row = await this.service.createRunbook(tenantId, memorySpace, {
          title: requireString(parameters, "title"),
          content: requireString(parameters, "content"),
          ...(parameters["category"] !== undefined ? { category: parameters["category"] as RunbookCategory } : {}),
          ...(parameters["vendor_id"] !== undefined ? { vendor_id: String(parameters["vendor_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
        });
        return { external_id: row.runbook_id, data: row as unknown as JsonValue };
      }
      case "get_runbook": {
        const row = await this.service.getRunbook(tenantId, memorySpace, requireString(parameters, "runbook_id"));
        return { ...(row ? { external_id: row.runbook_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_runbooks": {
        const activeOnly = parameters["active_only"] !== undefined ? Boolean(parameters["active_only"]) : true;
        const rows = await this.service.listRunbooks(tenantId, memorySpace, activeOnly);
        return { data: rows as unknown as JsonValue };
      }
      case "update_runbook_content": {
        const row = await this.service.updateRunbookContent(tenantId, memorySpace, requireString(parameters, "runbook_id"), requireString(parameters, "content"));
        return { ...(row ? { external_id: row.runbook_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_runbook_active": {
        const row = await this.service.setRunbookActive(tenantId, memorySpace, requireString(parameters, "runbook_id"), Boolean(parameters["is_active"]));
        return { ...(row ? { external_id: row.runbook_id } : {}), data: row as unknown as JsonValue };
      }
      case "create_task": {
        const row = await this.service.createTask(tenantId, memorySpace, {
          title: requireString(parameters, "title"),
          ...(parameters["description"] !== undefined ? { description: String(parameters["description"]) } : {}),
          ...(parameters["priority"] !== undefined ? { priority: parameters["priority"] as OperationsTaskPriority } : {}),
          ...(parameters["vendor_id"] !== undefined ? { vendor_id: String(parameters["vendor_id"]) } : {}),
          ...(parameters["runbook_id"] !== undefined ? { runbook_id: String(parameters["runbook_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["due_at"] !== undefined ? { due_at: String(parameters["due_at"]) } : {}),
          ...(parameters["canonical_uri"] !== undefined ? { canonical_uri: String(parameters["canonical_uri"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.task_id, data: row as unknown as JsonValue };
      }
      case "get_task": {
        const row = await this.service.getTask(tenantId, memorySpace, requireString(parameters, "task_id"));
        return { ...(row ? { external_id: row.task_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_tasks": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "open") as OperationsTaskStatus | "all";
        const rows = await this.service.listTasks(tenantId, memorySpace, status);
        return { data: rows as unknown as JsonValue };
      }
      case "search_tasks": {
        const rows = await this.service.searchTasks(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as OperationsTaskStatus } : {}),
          ...(parameters["priority"] !== undefined ? { priority: parameters["priority"] as OperationsTaskPriority } : {}),
          ...(parameters["vendor_id"] !== undefined ? { vendor_id: String(parameters["vendor_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["title_contains"] !== undefined ? { title_contains: String(parameters["title_contains"]) } : {}),
          ...(parameters["task_number"] !== undefined ? { task_number: Number(parameters["task_number"]) } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "list_by_vendor": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "all") as OperationsTaskStatus | "all";
        const rows = await this.service.listByVendor(tenantId, memorySpace, requireString(parameters, "vendor_id"), status);
        return { data: rows as unknown as JsonValue };
      }
      case "set_status": {
        const row = await this.service.setStatus(
          tenantId, memorySpace, requireString(parameters, "task_id"), requireString(parameters, "status") as OperationsTaskStatus, actorId(parameters)
        );
        return { ...(row ? { external_id: row.task_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_priority": {
        const row = await this.service.setPriority(
          tenantId, memorySpace, requireString(parameters, "task_id"), requireString(parameters, "priority") as OperationsTaskPriority, actorId(parameters)
        );
        return { ...(row ? { external_id: row.task_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_owner": {
        const owner = parameters["owner_person_id"] !== undefined ? String(parameters["owner_person_id"]) : null;
        const row = await this.service.setOwner(tenantId, memorySpace, requireString(parameters, "task_id"), owner, actorId(parameters));
        return { ...(row ? { external_id: row.task_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_due_at": {
        const dueAt = parameters["due_at"] !== undefined ? String(parameters["due_at"]) : null;
        const row = await this.service.setDueAt(tenantId, memorySpace, requireString(parameters, "task_id"), dueAt, actorId(parameters));
        return { ...(row ? { external_id: row.task_id } : {}), data: row as unknown as JsonValue };
      }
      case "link_vendor": {
        const vendorId = parameters["vendor_id"] !== undefined ? String(parameters["vendor_id"]) : null;
        const row = await this.service.linkVendor(tenantId, memorySpace, requireString(parameters, "task_id"), vendorId, actorId(parameters));
        return { ...(row ? { external_id: row.task_id } : {}), data: row as unknown as JsonValue };
      }
      case "link_runbook": {
        const runbookId = parameters["runbook_id"] !== undefined ? String(parameters["runbook_id"]) : null;
        const row = await this.service.linkRunbook(tenantId, memorySpace, requireString(parameters, "task_id"), runbookId, actorId(parameters));
        return { ...(row ? { external_id: row.task_id } : {}), data: row as unknown as JsonValue };
      }
      case "escalate_task": {
        const escalatedTo = parameters["escalated_to_person_id"] !== undefined ? String(parameters["escalated_to_person_id"]) : undefined;
        const row = await this.service.escalateTask(tenantId, memorySpace, requireString(parameters, "task_id"), escalatedTo, actorId(parameters));
        return { ...(row ? { external_id: row.task_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_task_events": {
        const rows = await this.service.listTaskEvents(tenantId, memorySpace, requireString(parameters, "task_id"));
        return { data: rows as unknown as JsonValue };
      }
      default:
        throw new Error(`operations_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`operations_missing_parameter:${key}`);
  }
  return value;
}

function actorId(parameters: Record<string, JsonValue>): string | undefined {
  return parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;
}
