import type pg from "pg";
import { listBusinessTenantIds } from "@jarvis/core";
import type { FinanceService } from "./service.ts";
import type { VippsProviderAnomalyDetectionResult } from "./types.ts";

export interface VippsPaymentSyncResult {
  sync: { synced: number; failed: number };
  anomalies: VippsProviderAnomalyDetectionResult;
}

/**
 * D-110 (UA-6 Slice 4) §14: periodisk Vipps-utfallssynk/-avviksdeteksjon
 * for ALLE bedrifts-tenants - SAMME reboot-durable `DailyScheduler`-
 * mekanisme og "for-alle-tenants"-mønster som
 * `runStripePaymentSyncForAllTenants()` - ingen ny scheduler-arkitektur.
 * Tenant-katalogen leses via den DELTE, RLS-trygge `listBusinessTenantIds()`
 * (@jarvis/core, Q-27) - ALDRI en rå spørring direkte mot `tenants`.
 */
export async function runVippsPaymentSyncForAllTenants(pool: pg.Pool, financeService: FinanceService): Promise<Record<string, VippsPaymentSyncResult>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, VippsPaymentSyncResult> = {};
  for (const tenantId of tenantIds) {
    try {
      const sync = await financeService.syncPendingVippsPayments(tenantId, "business");
      const anomalies = await financeService.runVippsProviderAnomalyDetection(tenantId, "business");
      results[tenantId] = { sync, anomalies };
    } catch (err) {
      // Én tenant sin sveip-feil skal aldri velte hele sveipet for andre tenants -
      // isolasjonen er UENDRET, kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
      console.error(JSON.stringify({
        msg: "vipps_sweep_tenant_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      results[tenantId] = { sync: { synced: 0, failed: 0 }, anomalies: { payment_intent_flags_added: 0, capture_flags_added: 0, refund_flags_added: 0, flags_cleared: 0 } };
    }
  }
  return results;
}
