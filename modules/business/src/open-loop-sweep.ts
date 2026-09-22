import type pg from "pg";
import { listBusinessTenantIds } from "@jarvis/core";
import type { OpenLoopService } from "./open-loop-service.ts";
import type { SweepResult } from "./open-loop-types.ts";

/**
 * UA-3 next slice (D-53) §19/§20: periodisk reevaluering av tidsbaserte
 * open-loop-vilkaar (forfalt oppfoelging, stagnert opportunity). Gjenbruker
 * EKSISTERENDE `DailyScheduler` (samme reboot-durable, tenant-uavhengige
 * claim-mekanisme som den personlige daglige briefen) - ingen ny koe.
 * Denne funksjonen er selve "deliver"-callbacken scheduleren kaller: den
 * itererer alle bedrifts-tenants og kjoerer en full sweep for hver, bounded
 * (LIMIT 200 tenants), tenant-scoped, trygg aa kjoere flere ganger (sweep
 * selv er idempotent - se OpenLoopService.runSweep()).
 *
 * Q-27 (2026-08-18, D-65): tenant-katalogen leses via den DELTE, RLS-trygge
 * `listBusinessTenantIds()` (@jarvis/core) - ALDRI en rå `pool.query`
 * direkte mot `tenants` (som var strukturelt RLS-blind, se D-65).
 */
export async function runOpenLoopSweepForAllTenants(
  pool: pg.Pool,
  openLoops: OpenLoopService
): Promise<Record<string, SweepResult>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, SweepResult> = {};
  for (const tenantId of tenantIds) {
    try {
      results[tenantId] = await openLoops.runSweep(tenantId, "business");
    } catch (err) {
      // Én tenant sin sweep-feil skal aldri velte hele sveipet for andre tenants -
      // isolasjonen er UENDRET, kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
      console.error(JSON.stringify({
        msg: "open_loop_sweep_tenant_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      results[tenantId] = { detected: 0, updated: 0, auto_resolved: 0 };
    }
  }
  return results;
}
