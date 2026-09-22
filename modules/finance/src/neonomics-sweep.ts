import type pg from "pg";
import { listBusinessTenantIds } from "@jarvis/core";
import type { BankingService } from "./banking-service.ts";
import type { FinanceService } from "./service.ts";

export interface NeonomicsSweepResult {
  consents_verified: number;
  accounts_synced: number;
  transactions: { inserted: number; transitioned: number; corrections_flagged: number };
  payments: { synced: number; failed: number };
  reconciliation: { matched_by_reference: number; matched_by_amount_date: number; mismatch_flagged: number; ambiguous: number };
  bank_anomalies: { transaction_flags_added: number; flags_cleared: number };
  payment_anomalies: { payment_intent_flags_added: number; flags_cleared: number };
}

const EMPTY_RESULT: NeonomicsSweepResult = {
  consents_verified: 0, accounts_synced: 0,
  transactions: { inserted: 0, transitioned: 0, corrections_flagged: 0 },
  payments: { synced: 0, failed: 0 },
  reconciliation: { matched_by_reference: 0, matched_by_amount_date: 0, mismatch_flagged: 0, ambiguous: 0 },
  bank_anomalies: { transaction_flags_added: 0, flags_cleared: 0 },
  payment_anomalies: { payment_intent_flags_added: 0, flags_cleared: 0 }
};

/**
 * D-111 (UA-6 Slice 5) §17: periodisk open-banking-sveip for ALLE
 * bedrifts-tenants - SAMME reboot-durable `DailyScheduler`-mekanisme og
 * "for-alle-tenants"-mønster som Stripe-/Vipps-/spend-sveipene, ingen ny
 * scheduler-arkitektur. Rekkefølgen er bevisst: samtykke-verifisering ->
 * konto-/transaksjonssynk -> betalingsstatus -> avstemming ->
 * avviksdeteksjon (ferske data FØR reglene evaluerer). Feil på ETT steg/
 * én konto/tenant velter ALDRI resten (per-steg try/catch - f.eks. et
 * utløpt samtykke stopper synk for DEN banken, men avstemming/avvik
 * kjører fortsatt på allerede-innhentede data). Kjøres uten konfigurerte
 * Neonomics-credentials blir provider-stegene no-op (credential_unavailable
 * fanges per steg) mens de RENT LOKALE stegene (avstemming/avvik) fortsatt
 * kjører - passiv integritet er aldri credential-gated.
 */
export async function runNeonomicsSweepForAllTenants(pool: pg.Pool, banking: BankingService, finance: FinanceService): Promise<Record<string, NeonomicsSweepResult>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, NeonomicsSweepResult> = {};
  for (const tenantId of tenantIds) {
    const result: NeonomicsSweepResult = structuredClone(EMPTY_RESULT);
    try {
      const consents = await banking.listConsents(tenantId, "business", 100);
      for (const consent of consents.filter((c) => c.state === "active")) {
        try {
          await banking.verifyConsent(tenantId, "business", consent.consent_id);
          result.consents_verified++;
          const sync = await banking.syncAccounts(tenantId, "business", consent.consent_id);
          result.accounts_synced += sync.discovered + sync.updated;
        } catch (err) {
          // Tapt samtykke/credential for ÉN bank stopper aldri resten - isolasjonen er UENDRET,
          // kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
          console.error(JSON.stringify({
            msg: "neonomics_sweep_consent_verify_failed", tenant_id: tenantId, consent_id: consent.consent_id,
            error: err instanceof Error ? err.message : String(err)
          }));
        }
      }
      const accounts = await banking.listBankAccounts(tenantId, "business");
      for (const account of accounts) {
        try {
          const txResult = await banking.syncTransactions(tenantId, "business", account.bank_account_id);
          result.transactions.inserted += txResult.inserted;
          result.transactions.transitioned += txResult.transitioned;
          result.transactions.corrections_flagged += txResult.corrections_flagged;
        } catch (err) {
          // Én kontos synkfeil isoleres - isolasjonen er UENDRET, kun stillheten var feilen (D-227).
          console.error(JSON.stringify({
            msg: "neonomics_sweep_transaction_sync_failed", tenant_id: tenantId, bank_account_id: account.bank_account_id,
            error: err instanceof Error ? err.message : String(err)
          }));
        }
      }
    } catch (err) {
      // Credential-/listefeil - fortsett til de lokale stegene. Isolasjonen er UENDRET (D-227).
      console.error(JSON.stringify({
        msg: "neonomics_sweep_consent_list_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
    }
    try {
      result.payments = await finance.syncPendingNeonomicsPayments(tenantId, "business");
    } catch (err) {
      // Isolert - isolasjonen er UENDRET, kun stillheten var feilen (D-227).
      console.error(JSON.stringify({
        msg: "neonomics_sweep_payment_sync_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
    }
    try {
      result.reconciliation = await banking.reconcileBankTransactions(tenantId, "business");
      result.bank_anomalies = await banking.runBankAnomalyDetection(tenantId, "business");
      result.payment_anomalies = await finance.runNeonomicsProviderAnomalyDetection(tenantId, "business");
    } catch (err) {
      // Én tenants sveipfeil velter aldri de andre - isolasjonen er UENDRET (D-227).
      console.error(JSON.stringify({
        msg: "neonomics_sweep_reconciliation_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
    }
    results[tenantId] = result;
  }
  return results;
}
