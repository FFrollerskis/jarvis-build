import type pg from "pg";
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
 */
export async function runOpenLoopSweepForAllTenants(
  pool: pg.Pool,
  openLoops: OpenLoopService
): Promise<Record<string, SweepResult>> {
  const { rows } = await pool.query(
    `SELECT tenant_id FROM tenants WHERE kind = 'business' ORDER BY tenant_id LIMIT 200`
  );
  const results: Record<string, SweepResult> = {};
  for (const row of rows as Array<{ tenant_id: string }>) {
    try {
      results[row.tenant_id] = await openLoops.runSweep(row.tenant_id, "business");
    } catch {
      // Én tenant sin sweep-feil skal aldri velte hele sveipet for andre tenants.
      results[row.tenant_id] = { detected: 0, updated: 0, auto_resolved: 0 };
    }
  }
  return results;
}
