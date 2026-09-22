import type pg from "pg";
import { listBusinessTenantIds } from "@jarvis/core";
import type { SpendService } from "./spend-service.ts";
import type { SpendAnomalyDetectionResult, SpendSyncResult } from "./spend-types.ts";

export interface FinanceSpendIntegritySweepResult {
  marketing: SpendSyncResult;
  model_cost: SpendSyncResult;
  reconciliation: { matched: number; advanced_schedules: number };
  anomalies: SpendAnomalyDetectionResult;
}

/**
 * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2) §12:
 * periodisk intern utgifts-synk/matching/deteksjon for ALLE bedrifts-
 * tenants - SAMME reboot-durable `DailyScheduler`-mekanisme og
 * "for-alle-tenants"-mønster som `runOpenLoopSweepForAllTenants()`/
 * `runBusinessEventSyncForAllTenants()` (@jarvis/business) - ingen ny
 * scheduler-arkitektur. Tenant-katalogen leses via den DELTE, RLS-trygge
 * `listBusinessTenantIds()` (@jarvis/core, Q-27) - ALDRI en rå spørring
 * direkte mot `tenants`.
 */
export async function runFinanceSpendIntegritySweepForAllTenants(
  pool: pg.Pool,
  spendService: SpendService
): Promise<Record<string, FinanceSpendIntegritySweepResult>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, FinanceSpendIntegritySweepResult> = {};
  for (const tenantId of tenantIds) {
    try {
      results[tenantId] = await spendService.runFullSweep(tenantId, "business");
    } catch (err) {
      // Én tenant sin sveip-feil skal aldri velte hele sveipet for andre tenants -
      // isolasjonen er UENDRET, kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
      console.error(JSON.stringify({
        msg: "spend_sweep_tenant_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      results[tenantId] = {
        marketing: { scanned: 0, inserted: 0, updated: 0, corrected: 0, correction_conflicts: 0 },
        model_cost: { scanned: 0, inserted: 0, updated: 0, corrected: 0, correction_conflicts: 0 },
        reconciliation: { matched: 0, advanced_schedules: 0 },
        anomalies: { spend_record_flags_added: 0, commitment_flags_added: 0, flags_cleared: 0 }
      };
    }
  }
  return results;
}
