import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport, ToolInvocationContext } from "@jarvis/tool-gateway";
import type { CardService, CreateCardInput, UpdateSpendPolicyInput } from "./card-service.ts";
import type { CardType } from "./card-types.ts";

/**
 * UA-6 Slice 6 (D-112): `finance_wallester.*`-namespace for det
 * programmerbare kortdomenet. INGEN rå Wallester-proxy-handling
 * eksponeres (byggeordrens §18) - alle handlinger går gjennom
 * CardService sin kanoniske autoritet (idempotens/kill-switch/
 * tilstandsmaskin/audit).
 */
export class WallesterFinanceTransport implements ToolTransport {
  constructor(private readonly cards: CardService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>, _credential?: string, context?: ToolInvocationContext): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    const actor = context?.identity?.person_id;

    switch (action) {
      case "create_card": {
        const input: CreateCardInput = {
          idempotency_key: requireString(parameters, "idempotency_key"),
          name: requireString(parameters, "name"),
          purpose: requireString(parameters, "purpose"),
          card_type: requireString(parameters, "card_type") as CardType,
          ...(parameters["currency"] !== undefined ? { currency: String(parameters["currency"]) } : {}),
          ...(parameters["cardholder_person_id"] !== undefined ? { cardholder_person_id: String(parameters["cardholder_person_id"]) } : {}),
          ...(parameters["commitment_id"] !== undefined ? { commitment_id: String(parameters["commitment_id"]) } : {}),
          ...(parameters["campaign_id"] !== undefined ? { campaign_id: String(parameters["campaign_id"]) } : {}),
          ...(parameters["vendor_name"] !== undefined ? { vendor_name: String(parameters["vendor_name"]) } : {}),
          ...(parameters["transaction_limit_ore"] !== undefined ? { requested_transaction_limit_ore: Number(parameters["transaction_limit_ore"]) } : {}),
          ...(parameters["daily_limit_ore"] !== undefined ? { requested_daily_limit_ore: Number(parameters["daily_limit_ore"]) } : {}),
          ...(parameters["weekly_limit_ore"] !== undefined ? { requested_weekly_limit_ore: Number(parameters["weekly_limit_ore"]) } : {}),
          ...(parameters["monthly_limit_ore"] !== undefined ? { requested_monthly_limit_ore: Number(parameters["monthly_limit_ore"]) } : {}),
          ...(parameters["atm_enabled"] !== undefined ? { requested_atm_enabled: parameters["atm_enabled"] === true } : {}),
          ...(parameters["online_enabled"] !== undefined ? { requested_online_enabled: parameters["online_enabled"] === true } : {}),
          ...(parameters["contactless_enabled"] !== undefined ? { requested_contactless_enabled: parameters["contactless_enabled"] === true } : {})
        };
        const row = await this.cards.createCard(tenantId, memorySpace, input, actor);
        return { external_id: row.card_id, data: row as unknown as JsonValue };
      }
      case "submit_card": {
        const row = await this.cards.submitCard(tenantId, memorySpace, requireString(parameters, "card_id"), actor);
        return { external_id: row.card_id, data: row as unknown as JsonValue };
      }
      case "get_card": {
        const row = await this.cards.getCard(tenantId, memorySpace, requireString(parameters, "card_id"));
        return { ...(row ? { external_id: row.card_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_cards": {
        const rows = await this.cards.listCards(tenantId, memorySpace, parameters["include_closed"] === true, parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined);
        return { data: rows as unknown as JsonValue };
      }
      case "activate_card": {
        const row = await this.cards.activateCard(tenantId, memorySpace, requireString(parameters, "card_id"), actor);
        return { external_id: row.card_id, data: row as unknown as JsonValue };
      }
      case "freeze_card": {
        const row = await this.cards.freezeCard(tenantId, memorySpace, requireString(parameters, "card_id"), actor);
        return { external_id: row.card_id, data: row as unknown as JsonValue };
      }
      case "unfreeze_card": {
        const row = await this.cards.unfreezeCard(tenantId, memorySpace, requireString(parameters, "card_id"), actor);
        return { external_id: row.card_id, data: row as unknown as JsonValue };
      }
      case "close_card": {
        const row = await this.cards.closeCard(tenantId, memorySpace, requireString(parameters, "card_id"), actor);
        return { external_id: row.card_id, data: row as unknown as JsonValue };
      }
      case "get_spend_policy": {
        const row = await this.cards.getSpendPolicy(tenantId, memorySpace, requireString(parameters, "card_id"));
        return { data: row as unknown as JsonValue };
      }
      case "update_spend_policy": {
        const input: UpdateSpendPolicyInput = {
          ...(parameters["transaction_limit_ore"] !== undefined ? { requested_transaction_limit_ore: parameters["transaction_limit_ore"] === null ? null : Number(parameters["transaction_limit_ore"]) } : {}),
          ...(parameters["daily_limit_ore"] !== undefined ? { requested_daily_limit_ore: parameters["daily_limit_ore"] === null ? null : Number(parameters["daily_limit_ore"]) } : {}),
          ...(parameters["weekly_limit_ore"] !== undefined ? { requested_weekly_limit_ore: parameters["weekly_limit_ore"] === null ? null : Number(parameters["weekly_limit_ore"]) } : {}),
          ...(parameters["monthly_limit_ore"] !== undefined ? { requested_monthly_limit_ore: parameters["monthly_limit_ore"] === null ? null : Number(parameters["monthly_limit_ore"]) } : {}),
          ...(parameters["atm_enabled"] !== undefined ? { requested_atm_enabled: parameters["atm_enabled"] === true } : {}),
          ...(parameters["online_enabled"] !== undefined ? { requested_online_enabled: parameters["online_enabled"] === true } : {}),
          ...(parameters["contactless_enabled"] !== undefined ? { requested_contactless_enabled: parameters["contactless_enabled"] === true } : {})
        };
        const row = await this.cards.updateSpendPolicy(tenantId, memorySpace, requireString(parameters, "card_id"), input, actor);
        return { data: row as unknown as JsonValue };
      }
      case "sync_card_state": {
        const row = await this.cards.syncCardState(tenantId, memorySpace, requireString(parameters, "card_id"));
        return { external_id: row.card_id, data: row as unknown as JsonValue };
      }
      case "sync_authorizations": {
        const result = await this.cards.syncAuthorizations(tenantId, memorySpace, requireString(parameters, "card_id"), {
          ...(parameters["max_pages"] !== undefined ? { maxPages: Number(parameters["max_pages"]) } : {})
        });
        return { data: result as unknown as JsonValue };
      }
      case "sync_transactions": {
        const result = await this.cards.syncTransactions(tenantId, memorySpace, requireString(parameters, "card_id"), {
          ...(parameters["max_pages"] !== undefined ? { maxPages: Number(parameters["max_pages"]) } : {})
        });
        return { data: result as unknown as JsonValue };
      }
      case "list_authorizations": {
        const rows = await this.cards.listAuthorizations(tenantId, memorySpace, {
          ...(parameters["card_id"] !== undefined ? { card_id: String(parameters["card_id"]) } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "list_card_transactions": {
        const rows = await this.cards.listCardTransactions(tenantId, memorySpace, {
          ...(parameters["card_id"] !== undefined ? { card_id: String(parameters["card_id"]) } : {}),
          ...(parameters["reconciliation_state"] !== undefined ? { reconciliation_state: String(parameters["reconciliation_state"]) } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "reconcile_card_transactions": {
        const result = await this.cards.reconcileCardTransactions(tenantId, memorySpace);
        return { data: result as unknown as JsonValue };
      }
      case "run_card_anomaly_detection": {
        const result = await this.cards.runCardAnomalyDetection(tenantId, memorySpace);
        return { data: result as unknown as JsonValue };
      }
      case "get_provider_balance": {
        const result = await this.cards.getProviderBalance(tenantId);
        return { data: result as unknown as JsonValue };
      }
      default:
        throw new Error(`finance_wallester_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`finance_wallester_missing_parameter:${key}`);
  }
  return value;
}
