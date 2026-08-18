import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { AgreementsService } from "./service.ts";
import type { ContractStatus, ObligationStatus } from "./types.ts";

/**
 * UA-3 Native Jarvis Contracts Core (D-71): provider-nøytralt `contract.*`-
 * namespace. Samme arkitektur-begrensning som `SupportTransport`/
 * `BusinessTransport`: `tenant_id`/`memory_space` MÅ komme via de
 * zod-validerte `parameters`, bygget av TRUSTED kallerlag. Ingen nøstet
 * klasse D-handling i denne sliceen (ingen e-sign/utgående kommunikasjon
 * bygget her) - `ToolInvocationContext` (SECURITY FIX #2/D-68) trengs derfor
 * IKKE av denne transporten, i motsetning til `SupportTransport.reply`.
 */
export class AgreementsTransport implements ToolTransport {
  constructor(private readonly service: AgreementsService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

    switch (action) {
      case "create_contract": {
        const row = await this.service.createContract(tenantId, memorySpace, {
          title: requireString(parameters, "title"),
          ...(parameters["contract_type"] !== undefined ? { contract_type: String(parameters["contract_type"]) } : {}),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["effective_date"] !== undefined ? { effective_date: String(parameters["effective_date"]) } : {}),
          ...(parameters["start_date"] !== undefined ? { start_date: String(parameters["start_date"]) } : {}),
          ...(parameters["end_date"] !== undefined ? { end_date: String(parameters["end_date"]) } : {}),
          ...(parameters["termination_deadline"] !== undefined ? { termination_deadline: String(parameters["termination_deadline"]) } : {}),
          ...(parameters["renewal_date"] !== undefined ? { renewal_date: String(parameters["renewal_date"]) } : {}),
          ...(parameters["auto_renew"] !== undefined ? { auto_renew: Boolean(parameters["auto_renew"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["canonical_uri"] !== undefined ? { canonical_uri: String(parameters["canonical_uri"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.contract_id, data: row as unknown as JsonValue };
      }
      case "get_contract": {
        const row = await this.service.getContract(tenantId, memorySpace, requireString(parameters, "contract_id"));
        return { ...(row ? { external_id: row.contract_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_contracts": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "active") as ContractStatus | "all";
        const rows = await this.service.listContracts(tenantId, memorySpace, status);
        return { data: rows as unknown as JsonValue };
      }
      case "search_contracts": {
        const rows = await this.service.searchContracts(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as ContractStatus } : {}),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["title_contains"] !== undefined ? { title_contains: String(parameters["title_contains"]) } : {}),
          ...(parameters["contract_number"] !== undefined ? { contract_number: Number(parameters["contract_number"]) } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "list_by_company": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "all") as ContractStatus | "all";
        const rows = await this.service.listByCompany(tenantId, memorySpace, requireString(parameters, "company_id"), status);
        return { data: rows as unknown as JsonValue };
      }
      case "upcoming_renewals": {
        const rows = await this.service.upcomingRenewals(tenantId, memorySpace, numberOr(parameters, "within_days", 30));
        return { data: rows as unknown as JsonValue };
      }
      case "upcoming_termination_deadlines": {
        const rows = await this.service.upcomingTerminationDeadlines(tenantId, memorySpace, numberOr(parameters, "within_days", 30));
        return { data: rows as unknown as JsonValue };
      }
      case "cancellable_now": {
        const rows = await this.service.cancellableNow(tenantId, memorySpace);
        return { data: rows as unknown as JsonValue };
      }
      case "due_obligations": {
        const rows = await this.service.dueObligations(tenantId, memorySpace, parameters["within_days"] !== undefined ? Number(parameters["within_days"]) : undefined);
        return { data: rows as unknown as JsonValue };
      }
      case "overdue_obligations": {
        const rows = await this.service.overdueObligations(tenantId, memorySpace);
        return { data: rows as unknown as JsonValue };
      }
      case "set_status": {
        const row = await this.service.setStatus(
          tenantId, memorySpace, requireString(parameters, "contract_id"), requireString(parameters, "status") as ContractStatus, actorId(parameters)
        );
        return { ...(row ? { external_id: row.contract_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_owner": {
        const owner = parameters["owner_person_id"] !== undefined ? String(parameters["owner_person_id"]) : null;
        const row = await this.service.setOwner(tenantId, memorySpace, requireString(parameters, "contract_id"), owner, actorId(parameters));
        return { ...(row ? { external_id: row.contract_id } : {}), data: row as unknown as JsonValue };
      }
      case "link_counterparty": {
        const companyId = parameters["company_id"] !== undefined ? String(parameters["company_id"]) : null;
        const contactId = parameters["contact_id"] !== undefined ? String(parameters["contact_id"]) : null;
        const row = await this.service.linkCounterparty(tenantId, memorySpace, requireString(parameters, "contract_id"), companyId, contactId, actorId(parameters));
        return { ...(row ? { external_id: row.contract_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_renewal_date": {
        const value = parameters["renewal_date"] !== undefined ? String(parameters["renewal_date"]) : null;
        const row = await this.service.setRenewalDate(tenantId, memorySpace, requireString(parameters, "contract_id"), value, actorId(parameters));
        return { ...(row ? { external_id: row.contract_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_termination_deadline": {
        const value = parameters["termination_deadline"] !== undefined ? String(parameters["termination_deadline"]) : null;
        const row = await this.service.setTerminationDeadline(tenantId, memorySpace, requireString(parameters, "contract_id"), value, actorId(parameters));
        return { ...(row ? { external_id: row.contract_id } : {}), data: row as unknown as JsonValue };
      }
      case "add_version": {
        const row = await this.service.addVersion(tenantId, memorySpace, requireString(parameters, "contract_id"), {
          summary: requireString(parameters, "summary"),
          ...(parameters["source_type"] !== undefined ? { source_type: String(parameters["source_type"]) } : {}),
          ...(parameters["source_instance_id"] !== undefined ? { source_instance_id: String(parameters["source_instance_id"]) } : {}),
          ...(parameters["source_message_id"] !== undefined ? { source_message_id: String(parameters["source_message_id"]) } : {}),
          ...(parameters["canonical_uri"] !== undefined ? { canonical_uri: String(parameters["canonical_uri"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { created_by_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.version_id, data: row as unknown as JsonValue };
      }
      case "list_versions": {
        const rows = await this.service.listVersions(tenantId, memorySpace, requireString(parameters, "contract_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "get_current_version": {
        const row = await this.service.getCurrentVersion(tenantId, memorySpace, requireString(parameters, "contract_id"));
        return { ...(row ? { external_id: row.version_id } : {}), data: row as unknown as JsonValue };
      }
      case "add_obligation": {
        const row = await this.service.addObligation(tenantId, memorySpace, requireString(parameters, "contract_id"), {
          description: requireString(parameters, "description"),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["due_at"] !== undefined ? { due_at: String(parameters["due_at"]) } : {}),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: row.obligation_id, data: row as unknown as JsonValue };
      }
      case "list_obligations": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "all") as ObligationStatus | "all";
        const rows = await this.service.listObligations(tenantId, memorySpace, requireString(parameters, "contract_id"), status);
        return { data: rows as unknown as JsonValue };
      }
      case "complete_obligation": {
        const row = await this.service.completeObligation(tenantId, memorySpace, requireString(parameters, "obligation_id"), actorId(parameters));
        return { ...(row ? { external_id: row.obligation_id } : {}), data: row as unknown as JsonValue };
      }
      case "waive_obligation": {
        const row = await this.service.waiveObligation(tenantId, memorySpace, requireString(parameters, "obligation_id"), actorId(parameters));
        return { ...(row ? { external_id: row.obligation_id } : {}), data: row as unknown as JsonValue };
      }
      case "reopen_obligation": {
        const row = await this.service.reopenObligation(tenantId, memorySpace, requireString(parameters, "obligation_id"), actorId(parameters));
        return { ...(row ? { external_id: row.obligation_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_events": {
        const rows = await this.service.listEvents(tenantId, memorySpace, requireString(parameters, "contract_id"));
        return { data: rows as unknown as JsonValue };
      }
      default:
        throw new Error(`contract_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`contract_missing_parameter:${key}`);
  }
  return value;
}

function actorId(parameters: Record<string, JsonValue>): string | undefined {
  return parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;
}

function numberOr(parameters: Record<string, JsonValue>, key: string, fallback: number): number {
  return parameters[key] !== undefined ? Number(parameters[key]) : fallback;
}
