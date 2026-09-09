import type pg from "pg";
import { listAllTenantIds } from "@jarvis/core";
import type { HealthService } from "./service.ts";

/**
 * UA-8 Personal Digital Twin (D-130): periodisk retensjons-håndhevelse for
 * helseobservasjoner - SAMME reboot-durable `DailyScheduler`-mekanisme/
 * mønster som `runLocationRetentionSweepForAllTenants` (@jarvis/location).
 * Bruker `listAllTenantIds` (D-130, 052_tenant_catalog_all.sql) - helsedata
 * er like gjerne knyttet til en persons EGEN tenant som til en
 * bedrifts-tenant. `HealthService.purgeExpiredObservations()` er allerede
 * hardkodet til `health`-spacet internt (se service.ts) - ingen
 * space-iterasjon trengs her, i motsetning til `location`.
 */
export async function runHealthRetentionSweepForAllTenants(
  pool: pg.Pool,
  health: HealthService
): Promise<Record<string, number>> {
  const tenantIds = await listAllTenantIds(pool, 200);
  const purgedByTenant: Record<string, number> = {};
  for (const tenantId of tenantIds) {
    try {
      purgedByTenant[tenantId] = await health.purgeExpiredObservations(tenantId);
    } catch {
      // Én tenant sin purge-feil skal aldri velte hele sveipet for andre tenants.
      purgedByTenant[tenantId] = 0;
    }
  }
  return purgedByTenant;
}
