import type pg from "pg";
import { listAllTenantIds, listTenantMemorySpaces } from "@jarvis/core";
import type { MemorySpace } from "@jarvis/contracts";
import type { VisionService } from "./service.ts";

/**
 * UA-9 Vision & Physical World (D-153): periodisk retensjons-håndhevelse
 * for hendelsesobservasjoner - SAMME reboot-durable `DailyScheduler`-
 * mekanisme/mønster som `runLocationRetentionSweepForAllTenants`
 * (@jarvis/location). Bruker `listAllTenantIds` (D-130,
 * 052_tenant_catalog_all.sql) - kamera-/hendelsesdata er like gjerne
 * knyttet til en persons EGEN tenant som til en bedrifts-tenant.
 * `VisionService` er MULTI-SPACE (D-153, i motsetning til `@jarvis/health`
 * sitt enkelt-låste `'health'`-space) - må derfor iterere hver av tenantens
 * faktiske memory spaces separat (`listTenantMemorySpaces`), SAMME grunn
 * som `runLocationRetentionSweepForAllTenants`.
 */
export interface VisionRetentionSweepFailure {
  tenant_id: string;
  /** `"*"` når selve space-oppslaget for tenanten feilet (ikke ett enkelt space). */
  memory_space_id: string;
  error: string;
}

export interface VisionRetentionSweepSummary {
  /** Antall (tenant, memory_space)-kombinasjoner der purge FULLFØRTE uten feil (uavhengig av antall rader faktisk slettet). */
  succeeded: number;
  failed: VisionRetentionSweepFailure[];
}

/**
 * Én tenant/space sin purge-feil skal ALDRI velte resten av sveipet (samme
 * per-tenant/per-space-isolasjon som location/health) - men skal heller
 * ALDRI forsvinne stille: talt/samlet i det returnerte sammendraget OG
 * strukturert logget umiddelbart (samme presedens D-130's arkitekt-review
 * av PR #79 etablerte for AKKURAT denne feilklassen).
 */
export async function runVisionRetentionSweepForAllTenants(pool: pg.Pool, vision: VisionService): Promise<VisionRetentionSweepSummary> {
  const tenantIds = await listAllTenantIds(pool, 200);
  let succeeded = 0;
  const failed: VisionRetentionSweepFailure[] = [];

  for (const tenantId of tenantIds) {
    let spaces: string[];
    try {
      spaces = await listTenantMemorySpaces(pool, tenantId);
    } catch (err) {
      const failure: VisionRetentionSweepFailure = {
        tenant_id: tenantId,
        memory_space_id: "*",
        error: (err as Error).message.slice(0, 200)
      };
      failed.push(failure);
      console.error(JSON.stringify({ msg: "vision_retention_purge_failed", ...failure }));
      continue;
    }

    for (const space of spaces) {
      try {
        await vision.purgeExpiredObservations(tenantId, space as MemorySpace);
        succeeded += 1;
      } catch (err) {
        const failure: VisionRetentionSweepFailure = {
          tenant_id: tenantId,
          memory_space_id: space,
          error: (err as Error).message.slice(0, 200)
        };
        failed.push(failure);
        console.error(JSON.stringify({ msg: "vision_retention_purge_failed", ...failure }));
      }
    }
  }

  return { succeeded, failed };
}
