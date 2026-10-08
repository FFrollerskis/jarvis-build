import type pg from "pg";
import type { SweepFailureCollector } from "@jarvis/contracts";
import { listBusinessTenantIds } from "@jarvis/core";
import type { ScoringService } from "./scoring-service.ts";

/**
 * UA-3 profiling/scoring slice (D-61) §23: periodisk, idempotent
 * rekalkulering av lead-/opportunity-scorer - gjenbruker EKSISTERENDE
 * `DailyScheduler` (samme reboot-durable mekanisme som open-loop-sveipet/
 * Gmail-Calendar-synken) - ingen ny koe. Denne funksjonen er selve
 * "deliver"-callbacken scheduleren kaller: den itererer alle
 * bedrifts-tenants og rekalkulerer for hver, bounded (LIMIT 200 tenants),
 * tenant-scoped, trygg aa kjoere flere ganger (rekalkulering er idempotent -
 * se ScoringService.recalculateTenant()).
 *
 * Q-27 (2026-08-18, D-65): tenant-katalogen leses via den DELTE, RLS-trygge
 * `listBusinessTenantIds()` (@jarvis/core) - ALDRI en rå `pool.query`
 * direkte mot `tenants` (som var strukturelt RLS-blind, se D-65).
 */
export async function runScoringSweepForAllTenants(
  pool: pg.Pool,
  scoring: ScoringService,
  failures?: SweepFailureCollector
): Promise<Record<string, { leads: number; opportunities: number }>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, { leads: number; opportunities: number }> = {};
  for (const tenantId of tenantIds) {
    try {
      results[tenantId] = await scoring.recalculateTenant(tenantId, "business");
    } catch (err) {
      // Én tenant sin rekalkulering skal aldri velte hele sveipet for andre tenants -
      // isolasjonen er UENDRET, kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
      console.error(JSON.stringify({
        msg: "scoring_sweep_tenant_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      failures?.record(tenantId, err);
      results[tenantId] = { leads: 0, opportunities: 0 };
    }
  }
  return results;
}
