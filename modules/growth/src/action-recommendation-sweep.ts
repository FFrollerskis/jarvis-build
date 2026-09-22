import type pg from "pg";
import { listBusinessTenantIds } from "@jarvis/core";
import type { GrowthService } from "./service.ts";

/**
 * D-85: periodisk kjøring av `GrowthService.detectAndRecommendSpendAnomalies()`
 * for ALLE bedrifts-tenants - SAMME `DailyScheduler`-gjenbrukte
 * fan-out-mønster som `runOpenLoopSweepForAllTenants()` (modules/business),
 * bevisst en EGEN, uavhengig scheduler-oppføring (IKKE bolted inn i
 * open-loop-sveipet) fordi denne sveiper et growth-eid resultat
 * (`marketing_campaign_action_recommendations`), ikke `business_open_loops`.
 *
 * Q-27 (D-65): tenant-katalogen leses via den DELTE, RLS-trygge
 * `listBusinessTenantIds()` (@jarvis/core) - ALDRI en rå `pool.query` mot
 * `tenants` direkte.
 */
export interface ActionRecommendationSweepResult {
  detected: number;
  updated: number;
  superseded: number;
}

export async function runActionRecommendationSweepForAllTenants(
  pool: pg.Pool,
  growth: GrowthService
): Promise<Record<string, ActionRecommendationSweepResult>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, ActionRecommendationSweepResult> = {};
  for (const tenantId of tenantIds) {
    try {
      results[tenantId] = await growth.detectAndRecommendSpendAnomalies(tenantId, "business");
    } catch (err) {
      // Én tenant sin sveipfeil skal aldri velte sveipet for andre tenants -
      // isolasjonen er UENDRET, kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
      console.error(JSON.stringify({
        msg: "action_recommendation_sweep_tenant_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      results[tenantId] = { detected: 0, updated: 0, superseded: 0 };
    }
  }
  return results;
}
