import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { FinanceService } from "./service.ts";
import type { CreateVippsCaptureInput, CreateVippsRefundInput } from "./types.ts";

/**
 * D-110 (UA-6 Slice 4): `finance_vipps.*`-namespace for de handlingene som
 * er GENUINT Vipps-spesifikke (capture, cancel-med-provider-kall, refusjon,
 * eksplisitt provider-oppfrisking, hendelses-inspeksjon) -
 * `create_payment_intent`/`submit_payment_intent`/osv. forblir i DET
 * EKSISTERENDE `finance.*`-namespacet (provider-dispatchet internt av
 * `FinanceService`, SAMME "no direct bypass"-prinsipp som
 * `StripeFinanceTransport`, ALDRI to konkurrerende handlinger for samme
 * konsept).
 */
export class VippsFinanceTransport implements ToolTransport {
  constructor(private readonly service: FinanceService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    const actorPersonId = parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;

    switch (action) {
      case "request_capture": {
        const input: CreateVippsCaptureInput = {
          idempotency_key: requireString(parameters, "idempotency_key"),
          payment_intent_id: requireString(parameters, "payment_intent_id"),
          amount_ore: requireNumber(parameters, "amount_ore"),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(actorPersonId !== undefined ? { actor_person_id: actorPersonId } : {})
        };
        const row = await this.service.createVippsCapture(tenantId, memorySpace, input);
        return { external_id: row.capture_id, data: row as unknown as JsonValue };
      }
      case "submit_capture": {
        const row = await this.service.submitVippsCapture(tenantId, memorySpace, requireString(parameters, "capture_id"), actorPersonId);
        return { external_id: row.capture_id, data: row as unknown as JsonValue };
      }
      case "get_capture": {
        const row = await this.service.getVippsCapture(tenantId, memorySpace, requireString(parameters, "capture_id"));
        return { ...(row ? { external_id: row.capture_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_captures": {
        const rows = await this.service.listVippsCaptures(
          tenantId, memorySpace,
          parameters["payment_intent_id"] !== undefined ? String(parameters["payment_intent_id"]) : undefined,
          parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined
        );
        return { data: rows as unknown as JsonValue };
      }
      case "cancel_payment": {
        const row = await this.service.cancelVippsPayment(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), actorPersonId);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "request_refund": {
        const input: CreateVippsRefundInput = {
          idempotency_key: requireString(parameters, "idempotency_key"),
          payment_intent_id: requireString(parameters, "payment_intent_id"),
          amount_ore: requireNumber(parameters, "amount_ore"),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(actorPersonId !== undefined ? { actor_person_id: actorPersonId } : {})
        };
        const row = await this.service.createVippsRefund(tenantId, memorySpace, input);
        return { external_id: row.refund_id, data: row as unknown as JsonValue };
      }
      case "submit_refund": {
        const row = await this.service.submitVippsRefund(tenantId, memorySpace, requireString(parameters, "refund_id"), actorPersonId);
        return { external_id: row.refund_id, data: row as unknown as JsonValue };
      }
      case "get_refund": {
        const row = await this.service.getVippsRefund(tenantId, memorySpace, requireString(parameters, "refund_id"));
        return { ...(row ? { external_id: row.refund_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_refunds": {
        const rows = await this.service.listVippsRefunds(
          tenantId, memorySpace,
          parameters["payment_intent_id"] !== undefined ? String(parameters["payment_intent_id"]) : undefined,
          parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined
        );
        return { data: rows as unknown as JsonValue };
      }
      case "refresh_payment_state": {
        const row = await this.service.refreshVippsPaymentState(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), actorPersonId);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "get_webhook_event": {
        const row = await this.service.getVippsWebhookEvent(tenantId, requireString(parameters, "dedupe_key"));
        return { data: row as unknown as JsonValue };
      }
      case "run_provider_anomaly_detection": {
        const result = await this.service.runVippsProviderAnomalyDetection(tenantId, memorySpace);
        return { data: result as unknown as JsonValue };
      }
      default:
        throw new Error(`finance_vipps_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`finance_vipps_missing_parameter:${key}`);
  }
  return value;
}

function requireNumber(parameters: Record<string, JsonValue>, key: string): number {
  const value = parameters[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`finance_vipps_missing_parameter:${key}`);
  }
  return value;
}
