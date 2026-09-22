import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { FinanceService } from "./service.ts";
import type { CreateStripeRefundInput, StripeRefundReason } from "./types.ts";

/**
 * D-109 (UA-6 Slice 3): `finance_stripe.*`-namespace for de handlingene som
 * er GENUINT Stripe-spesifikke (refusjon, eksplisitt provider-oppfrisking,
 * hendelses-inspeksjon) - `submit_payment_intent`/`get_payment_intent`/osv.
 * forblir i DET EKSISTERENDE `finance.*`-namespacet (FinanceTransport,
 * provider-dispatchet internt av `FinanceService`, IKKE duplisert her -
 * byggeordrens §14 "no direct bypass", ALDRI to konkurrerende handlinger
 * for samme konsept).
 */
export class StripeFinanceTransport implements ToolTransport {
  constructor(private readonly service: FinanceService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    const actorPersonId = parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;

    switch (action) {
      case "request_refund": {
        const input: CreateStripeRefundInput = {
          idempotency_key: requireString(parameters, "idempotency_key"),
          payment_intent_id: requireString(parameters, "payment_intent_id"),
          amount_ore: requireNumber(parameters, "amount_ore"),
          ...(parameters["reason"] !== undefined ? { reason: String(parameters["reason"]) as StripeRefundReason } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(actorPersonId !== undefined ? { actor_person_id: actorPersonId } : {})
        };
        const row = await this.service.createStripeRefund(tenantId, memorySpace, input);
        return { external_id: row.refund_id, data: row as unknown as JsonValue };
      }
      case "submit_refund": {
        const row = await this.service.submitStripeRefund(tenantId, memorySpace, requireString(parameters, "refund_id"), actorPersonId);
        return { external_id: row.refund_id, data: row as unknown as JsonValue };
      }
      case "get_refund": {
        const row = await this.service.getStripeRefund(tenantId, memorySpace, requireString(parameters, "refund_id"));
        return { ...(row ? { external_id: row.refund_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_refunds": {
        const rows = await this.service.listStripeRefunds(
          tenantId, memorySpace,
          parameters["payment_intent_id"] !== undefined ? String(parameters["payment_intent_id"]) : undefined,
          parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined
        );
        return { data: rows as unknown as JsonValue };
      }
      case "refresh_payment_state": {
        const row = await this.service.refreshStripePaymentState(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), actorPersonId);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "get_webhook_event": {
        const row = await this.service.getWebhookEvent(tenantId, requireString(parameters, "stripe_event_id"));
        return { data: row as unknown as JsonValue };
      }
      case "run_provider_anomaly_detection": {
        const result = await this.service.runProviderAnomalyDetection(tenantId, memorySpace);
        return { data: result as unknown as JsonValue };
      }
      // D-242: connector-helsesjekk-probe - ren providerside-lesing (`GET
      // /v1/balance`), INGEN memory-skriving, ingen `payment_intent_id`.
      case "get_balance": {
        const balance = await this.service.getStripeBalance(tenantId);
        return { data: balance as unknown as JsonValue };
      }
      default:
        throw new Error(`finance_stripe_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`finance_stripe_missing_parameter:${key}`);
  }
  return value;
}

function requireNumber(parameters: Record<string, JsonValue>, key: string): number {
  const value = parameters[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`finance_stripe_missing_parameter:${key}`);
  }
  return value;
}
