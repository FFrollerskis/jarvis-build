import type pg from "pg";
import { listAllTenantIds, listTenantMemorySpaces } from "@jarvis/core";
import type { MemorySpace } from "@jarvis/contracts";
import type { LocationService } from "./service.ts";

/**
 * UA-8 Personal Digital Twin (D-130): periodisk retensjons-håndhevelse for
 * lokasjonsobservasjoner - SAMME reboot-durable `DailyScheduler`-mekanisme/
 * mønster som `runOpenLoopSweepForAllTenants` (@jarvis/business). Personlig
 * lokasjonsdata er like gjerne knyttet til en persons EGEN tenant som til en
 * bedrifts-tenant - bruker derfor `listAllTenantIds` (D-130,
 * 052_tenant_catalog_all.sql), IKKE den bevisst bedrifts-snevrede
 * `listBusinessTenantIds` (Q-27/D-65) resten av UA-3-sveipene bruker.
 * `LocationService` er space-skopet (RESTRICTIVE RLS) - må derfor iterere
 * hver av tenantens faktiske memory spaces separat (`listTenantMemorySpaces`),
 * ikke bare kalle tenant-nivå én gang.
 */
export async function runLocationRetentionSweepForAllTenants(
  pool: pg.Pool,
  location: LocationService
): Promise<Record<string, number>> {
  const tenantIds = await listAllTenantIds(pool, 200);
  const purgedByTenant: Record<string, number> = {};
  for (const tenantId of tenantIds) {
    let purged = 0;
    try {
      const spaces = await listTenantMemorySpaces(pool, tenantId);
      for (const space of spaces) {
        try {
          purged += await location.purgeExpiredObservations(tenantId, space as MemorySpace);
        } catch {
          // Én space sin purge-feil skal aldri velte resten av tenantens spaces.
        }
      }
    } catch {
      // Én tenant sin feil (f.eks. space-oppslag) skal aldri velte hele sveipet for andre tenants.
    }
    purgedByTenant[tenantId] = purged;
  }
  return purgedByTenant;
}
