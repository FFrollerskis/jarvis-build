import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { SpendService } from "./spend-service.ts";
import type { CommitmentCadence, CreateProcurementItemInput, CreateRecurringCommitmentInput } from "./spend-types.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): eget
 * `finance_spend.*`-namespace (SEPARAT fra `finance.*`/`FinanceTransport`
 * som eier Payment/Spend Intent-domenet - ingen av handlingene her rører
 * NOEN ekstern leverandør, se `spend-service.ts`-toppkommentar). SAMME
 * `credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN"`-sentinel-mønster som
 * andre rene interne handlinger (D-49) - ALLE handlinger er klasse A/B,
 * INGEN klasse C/D (ingen provider-kall i det hele tatt i dette namespacet).
 */
export class SpendTransport implements ToolTransport {
  constructor(private readonly service: SpendService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

    switch (action) {
      case "create_recurring_commitment": {
        const input: CreateRecurringCommitmentInput = {
          vendor_name: requireString(parameters, "vendor_name"),
          description: requireString(parameters, "description"),
          cadence: requireString(parameters, "cadence") as CommitmentCadence,
          expected_amount_ore: requireNumber(parameters, "expected_amount_ore"),
          start_date: requireString(parameters, "start_date"),
          ...(parameters["cadence_interval_days"] !== undefined ? { cadence_interval_days: Number(parameters["cadence_interval_days"]) } : {}),
          ...(parameters["expected_billing_day_of_month"] !== undefined ? { expected_billing_day_of_month: Number(parameters["expected_billing_day_of_month"]) } : {}),
          ...(parameters["currency"] !== undefined ? { currency: String(parameters["currency"]) } : {}),
          ...(parameters["amount_tolerance_ore"] !== undefined ? { amount_tolerance_ore: Number(parameters["amount_tolerance_ore"]) } : {}),
          ...(parameters["source_mapping"] !== undefined ? { source_mapping: parameters["source_mapping"] as Record<string, unknown> } : {}),
          ...(parameters["payment_intent_id"] !== undefined ? { payment_intent_id: String(parameters["payment_intent_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(parameters["end_date"] !== undefined ? { end_date: String(parameters["end_date"]) } : {})
        };
        const row = await this.service.createCommitment(tenantId, memorySpace, input);
        return { external_id: row.commitment_id, data: row as unknown as JsonValue };
      }
      case "get_recurring_commitment": {
        const row = await this.service.getCommitment(tenantId, memorySpace, requireString(parameters, "commitment_id"));
        return { ...(row ? { external_id: row.commitment_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_recurring_commitments": {
        const rows = await this.service.listCommitments(tenantId, memorySpace, parameters["state"] as never);
        return { data: rows as unknown as JsonValue };
      }
      case "update_recurring_commitment": {
        const row = await this.service.updateCommitment(tenantId, memorySpace, requireString(parameters, "commitment_id"), {
          ...(parameters["description"] !== undefined ? { description: String(parameters["description"]) } : {}),
          ...(parameters["expected_amount_ore"] !== undefined ? { expected_amount_ore: Number(parameters["expected_amount_ore"]) } : {}),
          ...(parameters["amount_tolerance_ore"] !== undefined ? { amount_tolerance_ore: Number(parameters["amount_tolerance_ore"]) } : {}),
          ...(parameters["source_mapping"] !== undefined ? { source_mapping: parameters["source_mapping"] as Record<string, unknown> } : {})
        });
        return { external_id: row.commitment_id, data: row as unknown as JsonValue };
      }
      case "pause_recurring_commitment": {
        const row = await this.service.pauseCommitment(tenantId, memorySpace, requireString(parameters, "commitment_id"));
        return { external_id: row.commitment_id, data: row as unknown as JsonValue };
      }
      case "resume_recurring_commitment": {
        const row = await this.service.resumeCommitment(tenantId, memorySpace, requireString(parameters, "commitment_id"));
        return { external_id: row.commitment_id, data: row as unknown as JsonValue };
      }
      case "cancel_recurring_commitment": {
        const row = await this.service.cancelCommitment(tenantId, memorySpace, requireString(parameters, "commitment_id"));
        return { external_id: row.commitment_id, data: row as unknown as JsonValue };
      }
      case "create_procurement_item": {
        const input: CreateProcurementItemInput = {
          vendor_name: requireString(parameters, "vendor_name"),
          description: requireString(parameters, "description"),
          expected_amount_ore: requireNumber(parameters, "expected_amount_ore"),
          expected_date: requireString(parameters, "expected_date"),
          ...(parameters["currency"] !== undefined ? { currency: String(parameters["currency"]) } : {}),
          ...(parameters["expected_window_days"] !== undefined ? { expected_window_days: Number(parameters["expected_window_days"]) } : {}),
          ...(parameters["payment_intent_id"] !== undefined ? { payment_intent_id: String(parameters["payment_intent_id"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
        };
        const row = await this.service.createProcurementItem(tenantId, memorySpace, input);
        return { external_id: row.procurement_item_id, data: row as unknown as JsonValue };
      }
      case "get_procurement_item": {
        const row = await this.service.getProcurementItem(tenantId, memorySpace, requireString(parameters, "procurement_item_id"));
        return { ...(row ? { external_id: row.procurement_item_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_procurement_items": {
        const rows = await this.service.listProcurementItems(tenantId, memorySpace, parameters["status"] as never);
        return { data: rows as unknown as JsonValue };
      }
      case "update_procurement_item": {
        const row = await this.service.updateProcurementItem(tenantId, memorySpace, requireString(parameters, "procurement_item_id"), {
          ...(parameters["expected_amount_ore"] !== undefined ? { expected_amount_ore: Number(parameters["expected_amount_ore"]) } : {}),
          ...(parameters["expected_date"] !== undefined ? { expected_date: String(parameters["expected_date"]) } : {}),
          ...(parameters["expected_window_days"] !== undefined ? { expected_window_days: Number(parameters["expected_window_days"]) } : {})
        });
        return { external_id: row.procurement_item_id, data: row as unknown as JsonValue };
      }
      case "cancel_procurement_item": {
        const row = await this.service.cancelProcurementItem(tenantId, memorySpace, requireString(parameters, "procurement_item_id"));
        return { external_id: row.procurement_item_id, data: row as unknown as JsonValue };
      }
      case "list_spend_records": {
        const rows = await this.service.listSpendRecords(tenantId, memorySpace, {
          ...(parameters["source_family"] !== undefined ? { source_family: parameters["source_family"] as never } : {}),
          ...(parameters["campaign_id"] !== undefined ? { campaign_id: String(parameters["campaign_id"]) } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "get_spend_record": {
        const row = await this.service.getSpendRecord(tenantId, memorySpace, requireString(parameters, "spend_record_id"));
        return { ...(row ? { external_id: row.spend_record_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_unresolved_spend_anomalies": {
        const data = await this.service.listUnresolvedSpendAnomalies(tenantId, memorySpace);
        return { data: data as unknown as JsonValue };
      }
      case "sync_internal_spend": {
        const marketing = await this.service.syncMarketingSpend(tenantId, memorySpace);
        const modelCost = await this.service.syncModelCost(tenantId, memorySpace);
        return { data: { marketing, model_cost: modelCost } as unknown as JsonValue };
      }
      case "run_spend_reconciliation": {
        const data = await this.service.matchAndReconcile(tenantId, memorySpace);
        return { data: data as unknown as JsonValue };
      }
      case "run_spend_anomaly_detection": {
        const data = await this.service.runAnomalyDetection(tenantId, memorySpace);
        return { data: data as unknown as JsonValue };
      }
      default:
        throw new Error(`finance_spend_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`finance_spend_missing_parameter:${key}`);
  return value;
}

function requireNumber(parameters: Record<string, JsonValue>, key: string): number {
  const value = parameters[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`finance_spend_missing_parameter:${key}`);
  return value;
}
