import type pg from "pg";
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
 */
export async function runScoringSweepForAllTenants(
  pool: pg.Pool,
  scoring: ScoringService
): Promise<Record<string, { leads: number; opportunities: number }>> {
  const { rows } = await pool.query(
    `SELECT tenant_id FROM tenants WHERE kind = 'business' ORDER BY tenant_id LIMIT 200`
  );
  const results: Record<string, { leads: number; opportunities: number }> = {};
  for (const row of rows as Array<{ tenant_id: string }>) {
    try {
      results[row.tenant_id] = await scoring.recalculateTenant(row.tenant_id, "business");
    } catch {
      // Én tenant sin rekalkulering skal aldri velte hele sveipet for andre tenants.
      results[row.tenant_id] = { leads: 0, opportunities: 0 };
    }
  }
  return results;
}
