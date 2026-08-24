import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { FinanceService, FikenCredentialsProvider } from "./service.ts";
import type { CreatePaymentIntentInput, PaymentIntentState } from "./types.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway (D-107): provider-nøytralt
 * `finance.*`-namespace. Samme arkitektur-begrensning som
 * `GrowthTransport`/`AgreementsTransport`: `tenant_id`/`memory_space` MÅ
 * komme via de zod-validerte `parameters`, bygget av TRUSTED kallerlag.
 * `submit_payment_intent` er den ENESTE handlingen som faktisk rører en
 * ekstern leverandør (klasse C) - `enable_kill_switch`/
 * `disable_kill_switch` er klasse D (eier-sovereign, D-41: INGEN kunstig
 * godkjenningssperre for eier, men DETERMINISTISK håndhevet i
 * `FinanceService`, ikke bare her).
 */
export class FinanceTransport implements ToolTransport {
  constructor(
    private readonly service: FinanceService,
    private readonly credentialsProvider: FikenCredentialsProvider
  ) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    const actorPersonId = parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;

    switch (action) {
      case "create_payment_intent": {
        const input: CreatePaymentIntentInput = {
          idempotency_key: requireString(parameters, "idempotency_key"),
          purpose: requireString(parameters, "purpose"),
          amount_ore: Number(requireString(parameters, "amount_ore")),
          vendor_name: requireString(parameters, "vendor_name"),
          account_code: requireString(parameters, "account_code"),
          ...(parameters["currency"] !== undefined ? { currency: String(parameters["currency"]) } : {}),
          ...(parameters["vendor_provider_ref"] !== undefined ? { vendor_provider_ref: String(parameters["vendor_provider_ref"]) } : {}),
          ...(parameters["counter_account_code"] !== undefined ? { counter_account_code: String(parameters["counter_account_code"]) } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {}),
          ...(actorPersonId !== undefined ? { actor_person_id: actorPersonId } : {})
        };
        const row = await this.service.createPaymentIntent(tenantId, memorySpace, input);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "get_payment_intent": {
        const row = await this.service.getPaymentIntent(tenantId, memorySpace, requireString(parameters, "payment_intent_id"));
        return { ...(row ? { external_id: row.payment_intent_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_payment_intents": {
        const rows = await this.service.listPaymentIntents(tenantId, memorySpace, {
          ...(parameters["state"] !== undefined ? { state: parameters["state"] as PaymentIntentState } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "submit_payment_intent": {
        const row = await this.service.submitPaymentIntent(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), this.credentialsProvider, actorPersonId);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "settle_payment_intent": {
        const row = await this.service.settlePaymentIntent(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), actorPersonId);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "cancel_payment_intent": {
        const row = await this.service.cancelPaymentIntent(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), actorPersonId);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "reconcile_payment_intent": {
        const matched = String(parameters["matched"]) === "true";
        const note = parameters["note"] !== undefined ? String(parameters["note"]) : undefined;
        const row = await this.service.reconcilePaymentIntent(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), matched, actorPersonId, note);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "enable_kill_switch": {
        const row = await this.service.enableKillSwitch(tenantId, requireString(parameters, "actor_person_id"), requireString(parameters, "reason"));
        return { data: row as unknown as JsonValue };
      }
      case "disable_kill_switch": {
        const row = await this.service.disableKillSwitch(tenantId, requireString(parameters, "actor_person_id"));
        return { data: row as unknown as JsonValue };
      }
      case "get_kill_switch": {
        const row = await this.service.getKillSwitch(tenantId);
        return { data: row as unknown as JsonValue };
      }
      default:
        throw new Error(`finance_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`finance_missing_parameter:${key}`);
  }
  return value;
}
