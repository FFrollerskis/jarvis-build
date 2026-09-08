import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { ProductService } from "./service.ts";
import type { ProductItemPriority, ProductItemStatus } from "./types.ts";

/**
 * UA-3 Native Jarvis Product Core (D-128): provider-nøytralt `product.*`-
 * namespace. Samme arkitektur-begrensning som `AgreementsTransport`/
 * `SupportTransport`: `tenant_id`/`memory_space` MÅ komme via de
 * zod-validerte `parameters`, bygget av TRUSTED kallerlag. Ingen nøstet
 * klasse D-handling i denne sliceen (ingen utgående kommunikasjon bygget
 * her) - `ToolInvocationContext` (SECURITY FIX #2/D-68) trengs derfor IKKE
 * av denne transporten, i motsetning til `SupportTransport.reply`.
 */
export class ProductTransport implements ToolTransport {
  constructor(private readonly service: ProductService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

    switch (action) {
      case "create_item": {
        const row = await this.service.createItem(tenantId, memorySpace, {
          title: requireString(parameters, "title"),
          ...(parameters["description"] !== undefined ? { description: String(parameters["description"]) } : {}),
          ...(parameters["item_type"] !== undefined ? { item_type: parameters["item_type"] as CreateItemType } : {}),
          ...(parameters["priority"] !== undefined ? { priority: parameters["priority"] as ProductItemPriority } : {}),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["canonical_uri"] !== undefined ? { canonical_uri: String(parameters["canonical_uri"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.item_id, data: row as unknown as JsonValue };
      }
      case "get_item": {
        const row = await this.service.getItem(tenantId, memorySpace, requireString(parameters, "item_id"));
        return { ...(row ? { external_id: row.item_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_items": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "new") as ProductItemStatus | "all";
        const rows = await this.service.listItems(tenantId, memorySpace, status);
        return { data: rows as unknown as JsonValue };
      }
      case "search_items": {
        const rows = await this.service.searchItems(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as ProductItemStatus } : {}),
          ...(parameters["priority"] !== undefined ? { priority: parameters["priority"] as ProductItemPriority } : {}),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["title_contains"] !== undefined ? { title_contains: String(parameters["title_contains"]) } : {}),
          ...(parameters["item_number"] !== undefined ? { item_number: Number(parameters["item_number"]) } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "list_by_company": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "all") as ProductItemStatus | "all";
        const rows = await this.service.listByCompany(tenantId, memorySpace, requireString(parameters, "company_id"), status);
        return { data: rows as unknown as JsonValue };
      }
      case "set_status": {
        const row = await this.service.setStatus(
          tenantId, memorySpace, requireString(parameters, "item_id"), requireString(parameters, "status") as ProductItemStatus, actorId(parameters)
        );
        return { ...(row ? { external_id: row.item_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_priority": {
        const row = await this.service.setPriority(
          tenantId, memorySpace, requireString(parameters, "item_id"), requireString(parameters, "priority") as ProductItemPriority, actorId(parameters)
        );
        return { ...(row ? { external_id: row.item_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_owner": {
        const owner = parameters["owner_person_id"] !== undefined ? String(parameters["owner_person_id"]) : null;
        const row = await this.service.setOwner(tenantId, memorySpace, requireString(parameters, "item_id"), owner, actorId(parameters));
        return { ...(row ? { external_id: row.item_id } : {}), data: row as unknown as JsonValue };
      }
      case "link_reporter": {
        const companyId = parameters["company_id"] !== undefined ? String(parameters["company_id"]) : null;
        const contactId = parameters["contact_id"] !== undefined ? String(parameters["contact_id"]) : null;
        const row = await this.service.linkReporter(tenantId, memorySpace, requireString(parameters, "item_id"), companyId, contactId, actorId(parameters));
        return { ...(row ? { external_id: row.item_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_events": {
        const rows = await this.service.listEvents(tenantId, memorySpace, requireString(parameters, "item_id"));
        return { data: rows as unknown as JsonValue };
      }
      default:
        throw new Error(`product_action_not_implemented:${action}`);
    }
  }
}

type CreateItemType = "feature_request" | "bug_report" | "usage_feedback" | "improvement";

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`product_missing_parameter:${key}`);
  }
  return value;
}

function actorId(parameters: Record<string, JsonValue>): string | undefined {
  return parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;
}
