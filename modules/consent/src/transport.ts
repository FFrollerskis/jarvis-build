import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { ConsentEnforcementService } from "./enforcement-service.ts";
import type { ConsentService } from "./service.ts";
import type { ConsentDecisionState, ConsentEnforcementMode, ConsentLegalBasis, ConsentPurpose } from "./types.ts";

/**
 * D-91 (UA-4 NESTE SLICE): provider-nøytralt `consent.*`-namespace.
 * Samme arkitektur-begrensning som `AgreementsTransport`/`GrowthTransport`:
 * `tenant_id`/`memory_space` MÅ komme via de zod-validerte `parameters`,
 * bygget av TRUSTED kallerlag. Ingen klasse C/D-handling her - INGEN av
 * disse handlingene utfører en ekstern/uigjenkallelig operasjon.
 * `ToolInvocationContext` trengs derfor IKKE.
 */
export class ConsentTransport implements ToolTransport {
  constructor(private readonly service: ConsentService, private readonly enforcement?: ConsentEnforcementService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

    switch (action) {
      case "record_decision": {
        const row = await this.service.recordConsentDecision(tenantId, memorySpace, {
          contact_id: requireString(parameters, "contact_id"),
          purpose: requireString(parameters, "purpose") as ConsentPurpose,
          state: requireString(parameters, "state") as ConsentDecisionState,
          legal_basis: requireString(parameters, "legal_basis") as ConsentLegalBasis,
          evidence: (parameters["evidence"] as Record<string, unknown> | undefined) ?? {},
          policy_version: requireString(parameters, "policy_version"),
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {}),
          ...(parameters["expires_at"] !== undefined ? { expires_at: String(parameters["expires_at"]) } : {})
        });
        return { external_id: row.decision_id, data: row as unknown as JsonValue };
      }
      case "get_current_state": {
        const row = await this.service.getCurrentConsentState(
          tenantId, memorySpace, requireString(parameters, "contact_id"), requireString(parameters, "purpose") as ConsentPurpose
        );
        return { ...(row ? { external_id: row.decision_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_decisions": {
        const rows = await this.service.listConsentDecisions(tenantId, memorySpace, {
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["purpose"] !== undefined ? { purpose: String(parameters["purpose"]) as ConsentPurpose } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "evaluate_processing_decision": {
        const result = await this.service.evaluateProcessingDecision(
          tenantId, memorySpace, requireString(parameters, "contact_id"), requireString(parameters, "purpose") as ConsentPurpose
        );
        return { data: result as unknown as JsonValue };
      }
      case "get_enforcement_policy": {
        const policy = await this.requireEnforcement().getEnforcementPolicy(tenantId, memorySpace, requireString(parameters, "purpose") as ConsentPurpose);
        return { ...(policy ? { external_id: `${policy.tenant_id}:${policy.memory_space_id}:${policy.purpose}` } : {}), data: policy as unknown as JsonValue };
      }
      case "set_enforcement_policy": {
        const policy = await this.requireEnforcement().setEnforcementMode(tenantId, memorySpace, {
          purpose: requireString(parameters, "purpose") as ConsentPurpose,
          mode: requireString(parameters, "mode") as ConsentEnforcementMode,
          ...(parameters["actor_person_id"] !== undefined ? { actor_person_id: String(parameters["actor_person_id"]) } : {})
        });
        return { external_id: `${policy.tenant_id}:${policy.memory_space_id}:${policy.purpose}`, data: policy as unknown as JsonValue };
      }
      default:
        throw new Error(`consent_action_not_implemented:${action}`);
    }
  }

  private requireEnforcement(): ConsentEnforcementService {
    if (!this.enforcement) throw new Error("consent_enforcement_not_wired");
    return this.enforcement;
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`consent_missing_parameter:${key}`);
  }
  return value;
}
