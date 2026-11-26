import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import { adoptCallSignal, type ToolTransport } from "@jarvis/tool-gateway";
import type { BankingService } from "./banking-service.ts";
import type { FinanceService } from "./service.ts";
import type { BankConsentScope, BankReconciliationState } from "./banking-types.ts";

/**
 * D-111 (UA-6 Slice 5): `finance_neonomics.*`-namespace for open-banking-
 * handlingene. PIS-innsendingen (`submit_payment_intent`) forblir i DET
 * EKSISTERENDE `finance.*`-namespacet (provider-dispatchet internt av
 * FinanceService - byggeordrens «no direct raw provider bypass», aldri to
 * konkurrerende handlinger for samme konsept). INGEN rå Neonomics-proxy-
 * handling eksponeres.
 */
export class NeonomicsFinanceTransport implements ToolTransport {
  constructor(
    private readonly banking: BankingService,
    private readonly finance: FinanceService
  ) {}

  /**
   * WP-FIN2 (D-486, K2): gatewayen gir kallsignalet BÅDE som 5. parameter og som ambient kontekst (`invokeWithCallSignal`); `adoptCallSignal` gjør argumentet til det ambiente kallsignalet også for en
   * kaller som bare gir argumentet (tester/skript), slik at finanstransportene (`financeFetch`) alltid ser samme avbrudd.
   */
  async invoke(action: string, parameters: Record<string, JsonValue>, _credential?: string, _context?: unknown, signal?: AbortSignal): Promise<{ external_id?: string; data?: JsonValue }> {
    return adoptCallSignal(signal, () => this.dispatch(action, parameters));
  }

  private async dispatch(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    const actorPersonId = parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;

    switch (action) {
      case "list_banks": {
        const banks = await this.banking.listBanks(tenantId);
        return { data: banks as unknown as JsonValue };
      }
      case "create_consent": {
        const row = await this.banking.createConsent(tenantId, memorySpace, {
          bank_id: requireString(parameters, "bank_id"),
          ...(parameters["bank_name"] !== undefined ? { bank_name: String(parameters["bank_name"]) } : {}),
          ...(parameters["requested_scope"] !== undefined ? { requested_scope: String(parameters["requested_scope"]) as BankConsentScope } : {}),
          ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
        });
        return { external_id: row.consent_id, data: row as unknown as JsonValue };
      }
      case "get_consent_authorization_url": {
        const result = await this.banking.getConsentAuthorizationUrl(tenantId, memorySpace, requireString(parameters, "consent_id"), requireString(parameters, "redirect_base_url"));
        return { data: result as unknown as JsonValue };
      }
      case "complete_consent_callback": {
        const row = await this.banking.completeConsentCallback(tenantId, memorySpace, requireString(parameters, "consent_id"), requireString(parameters, "callback_state"));
        return { external_id: row.consent_id, data: row as unknown as JsonValue };
      }
      case "get_consent": {
        const row = await this.banking.getConsent(tenantId, memorySpace, requireString(parameters, "consent_id"));
        return { ...(row ? { external_id: row.consent_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_consents": {
        const rows = await this.banking.listConsents(tenantId, memorySpace, parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined);
        return { data: rows as unknown as JsonValue };
      }
      case "verify_consent": {
        const row = await this.banking.verifyConsent(tenantId, memorySpace, requireString(parameters, "consent_id"));
        return { external_id: row.consent_id, data: row as unknown as JsonValue };
      }
      case "revoke_consent": {
        const row = await this.banking.markConsentState(tenantId, memorySpace, requireString(parameters, "consent_id"), "revoked");
        return { external_id: row.consent_id, data: row as unknown as JsonValue };
      }
      case "sync_accounts": {
        const result = await this.banking.syncAccounts(tenantId, memorySpace, requireString(parameters, "consent_id"));
        return { data: result as unknown as JsonValue };
      }
      case "list_bank_accounts": {
        const rows = await this.banking.listBankAccounts(tenantId, memorySpace, parameters["include_inactive"] === true, parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined);
        return { data: rows as unknown as JsonValue };
      }
      case "sync_balances": {
        const result = await this.banking.syncBalances(tenantId, memorySpace, requireString(parameters, "bank_account_id"));
        return { data: result as unknown as JsonValue };
      }
      case "list_balances": {
        const rows = await this.banking.listBalances(tenantId, memorySpace, requireString(parameters, "bank_account_id"), parameters["limit"] !== undefined ? Number(parameters["limit"]) : undefined);
        return { data: rows as unknown as JsonValue };
      }
      case "sync_transactions": {
        const result = await this.banking.syncTransactions(tenantId, memorySpace, requireString(parameters, "bank_account_id"), {
          ...(parameters["max_pages"] !== undefined ? { maxPages: Number(parameters["max_pages"]) } : {})
        });
        return { data: result as unknown as JsonValue };
      }
      case "list_bank_transactions": {
        const rows = await this.banking.listBankTransactions(tenantId, memorySpace, {
          ...(parameters["bank_account_id"] !== undefined ? { bank_account_id: String(parameters["bank_account_id"]) } : {}),
          ...(parameters["reconciliation_state"] !== undefined ? { reconciliation_state: String(parameters["reconciliation_state"]) as BankReconciliationState } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "reconcile_bank_transactions": {
        const result = await this.banking.reconcileBankTransactions(tenantId, memorySpace);
        return { data: result as unknown as JsonValue };
      }
      case "run_bank_anomaly_detection": {
        const result = await this.banking.runBankAnomalyDetection(tenantId, memorySpace);
        return { data: result as unknown as JsonValue };
      }
      case "refresh_payment_state": {
        const row = await this.finance.refreshNeonomicsPaymentState(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), actorPersonId);
        return { external_id: row.payment_intent_id, data: row as unknown as JsonValue };
      }
      case "get_payment_authorization_url": {
        const result = await this.finance.getNeonomicsPaymentAuthorizationUrl(tenantId, memorySpace, requireString(parameters, "payment_intent_id"), requireString(parameters, "redirect_url"));
        return { data: result as unknown as JsonValue };
      }
      case "run_provider_anomaly_detection": {
        const result = await this.finance.runNeonomicsProviderAnomalyDetection(tenantId, memorySpace);
        return { data: result as unknown as JsonValue };
      }
      default:
        throw new Error(`finance_neonomics_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`finance_neonomics_missing_parameter:${key}`);
  }
  return value;
}
