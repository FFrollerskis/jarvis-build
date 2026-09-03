import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { ConversationGraphService } from "./service.ts";
import type { ConversationChannel, ChannelLinkMatchMethod, MergePerformedBy } from "./types.ts";

/**
 * D-49 (samme kjente, delte begrensning som ALLE eksisterende
 * ToolTransport-er - se `business/src/transport.ts` sitt filhode):
 * `invoke()` faar IKKE `IdentityContext` - `tenant_id`/`memory_space` MAA
 * komme via de zod-validerte `parameters`, ALLTID bygget av et TRUSTED
 * kallerlag, ALDRI av modell-output.
 */
export class ConversationGraphTransport implements ToolTransport {
  constructor(private readonly service: ConversationGraphService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

    switch (action) {
      case "resolve_identity": {
        const row = await this.service.resolveIdentityByChannel(
          tenantId, memorySpace,
          requireString(parameters, "channel") as ConversationChannel,
          requireString(parameters, "channel_identifier")
        );
        return { ...(row ? { external_id: row.identity_id } : {}), data: row as unknown as JsonValue };
      }
      case "read_identity": {
        const row = await this.service.readIdentity(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { ...(row ? { external_id: row.identity_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_channel_links": {
        const rows = await this.service.listChannelLinks(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "link_channel_identity": {
        const row = await this.service.linkChannelIdentity(tenantId, memorySpace, {
          channel: requireString(parameters, "channel") as ConversationChannel,
          channel_identifier: requireString(parameters, "channel_identifier"),
          confidence: requireNumber(parameters, "confidence"),
          match_method: requireString(parameters, "match_method") as ChannelLinkMatchMethod,
          ...(parameters["identity_id"] !== undefined ? { identity_id: String(parameters["identity_id"]) } : {}),
          ...(parameters["source_type"] !== undefined ? { source_type: String(parameters["source_type"]) } : {}),
          ...(parameters["source_instance_id"] !== undefined ? { source_instance_id: String(parameters["source_instance_id"]) } : {}),
          ...(parameters["external_id"] !== undefined ? { external_id: String(parameters["external_id"]) } : {}),
          ...(parameters["display_name"] !== undefined ? { display_name: String(parameters["display_name"]) } : {}),
          ...(parameters["linked_business_contact_id"] !== undefined ? { linked_business_contact_id: String(parameters["linked_business_contact_id"]) } : {}),
          ...(parameters["linked_person_id"] !== undefined ? { linked_person_id: String(parameters["linked_person_id"]) } : {}),
          ...(parameters["created_by_person_id"] !== undefined ? { created_by_person_id: String(parameters["created_by_person_id"]) } : {})
        });
        return { external_id: row.link_id, data: row as unknown as JsonValue };
      }
      case "merge_identities": {
        const row = await this.service.mergeIdentities(tenantId, memorySpace, {
          source_identity_id: requireString(parameters, "source_identity_id"),
          target_identity_id: requireString(parameters, "target_identity_id"),
          confidence: requireNumber(parameters, "confidence"),
          reason: requireString(parameters, "reason"),
          performed_by: requireString(parameters, "performed_by") as MergePerformedBy,
          ...(parameters["created_by_person_id"] !== undefined ? { created_by_person_id: String(parameters["created_by_person_id"]) } : {})
        });
        return { external_id: row.merge_id, data: row as unknown as JsonValue };
      }
      case "split_merge": {
        const row = await this.service.splitMerge(tenantId, memorySpace, {
          merge_id: requireString(parameters, "merge_id"),
          performed_by: requireString(parameters, "performed_by") as MergePerformedBy,
          reason: requireString(parameters, "reason"),
          ...(parameters["created_by_person_id"] !== undefined ? { created_by_person_id: String(parameters["created_by_person_id"]) } : {})
        });
        return { external_id: row.merge_id, data: row as unknown as JsonValue };
      }
      case "read_cross_channel_commitments": {
        const rows = await this.service.crossChannelCommitments(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "read_identity_timeline": {
        const rows = await this.service.identityTimeline(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { data: rows as unknown as JsonValue };
      }
      default:
        throw new Error(`conversation_graph_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`conversation_graph_missing_parameter:${key}`);
  }
  return value;
}

function requireNumber(parameters: Record<string, JsonValue>, key: string): number {
  const value = parameters[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`conversation_graph_missing_parameter:${key}`);
  }
  return value;
}
