import type pg from "pg";
import type { SweepFailureCollector } from "@jarvis/contracts";
import { listBusinessTenantIds } from "@jarvis/core";
import type { FinanceService } from "./service.ts";
import type { StripeProviderAnomalyDetectionResult } from "./types.ts";

export interface StripePaymentSyncResult {
  sync: { synced: number; failed: number };
  anomalies: StripeProviderAnomalyDetectionResult;
}

/**
 * D-109 (UA-6 Slice 3) §15: periodisk Stripe-utfallssynk/-avviksdeteksjon
 * for ALLE bedrifts-tenants - SAMME reboot-durable `DailyScheduler`-
 * mekanisme og "for-alle-tenants"-mønster som
 * `runFinanceSpendIntegritySweepForAllTenants()`/
 * `runOpenLoopSweepForAllTenants()` - ingen ny scheduler-arkitektur.
 * Tenant-katalogen leses via den DELTE, RLS-trygge `listBusinessTenantIds()`
 * (@jarvis/core, Q-27) - ALDRI en rå spørring direkte mot `tenants`.
 * Kjøres FØR `finance-spend-integrity-sweep` (kl. 03, mot kl. 04) slik at
 * ferske Stripe-utfall er tilgjengelige når resten av finans-sveipet
 * kjører samme morgen.
 */
export async function runStripePaymentSyncForAllTenants(pool: pg.Pool, financeService: FinanceService, failures?: SweepFailureCollector): Promise<Record<string, StripePaymentSyncResult>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, StripePaymentSyncResult> = {};
  for (const tenantId of tenantIds) {
    try {
      const sync = await financeService.syncPendingStripePayments(tenantId, "business");
      // D-442: tjenesten fanger per-betalings-feil og returnerer kun et tall - en leverandørnedetid ({synced:0, failed:n}) skal ikke bokføres som en fullført dag.
      if (sync.failed > 0) failures?.record(tenantId, `${sync.failed} betaling(er) kunne ikke synkes`, "payments");
      const anomalies = await financeService.runProviderAnomalyDetection(tenantId, "business");
      results[tenantId] = { sync, anomalies };
    } catch (err) {
      // Én tenant sin sveip-feil skal aldri velte hele sveipet for andre tenants -
      // isolasjonen er UENDRET, kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
      console.error(JSON.stringify({
        msg: "stripe_sweep_tenant_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      failures?.record(tenantId, err);
      results[tenantId] = { sync: { synced: 0, failed: 0 }, anomalies: { payment_intent_flags_added: 0, refund_flags_added: 0, flags_cleared: 0 } };
    }
  }
  return results;
}
