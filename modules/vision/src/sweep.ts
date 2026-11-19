import type pg from "pg";
import { listAllTenantIds, listTenantMemorySpaces } from "@jarvis/core";
import type { MemorySpace } from "@jarvis/contracts";
import type { VisionService } from "./service.ts";
import type { VisionCaptureService } from "./capture.ts";
import type { VisionEmbeddingService } from "./embeddings.ts";
import type { VisionInventoryService } from "./inventory.ts";
import type { VisionSnapshotService } from "./snapshots.ts";

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

/**
 * WP-G3 (D-465): vedlikeholdssveipet for de nye UA-9-tabellene. `runVisionRetentionSweepForAllTenants` (over) er UENDRET og rydder fortsatt hendelsene; dette sveipet gjør resten og
 * håndhever at BILDEOBJEKTENE faktisk forsvinner:
 *   - FULL kjøring (daglig): slett bilder hvis eget oppbevaringsvindu er passert, rydd mislykkede 'pending'-bilder, slett utløpt inventar, utløp/rydd opptaksforespørsler, fyll manglende
 *     vektorer - og sist reap gravsteinene (sletter selve bildeobjektene og fjerner graven først når lagringen har bekreftet).
 *   - LETT kjøring (hyppig, standard hvert kvarter): kun gravsteiner + pending-bilder + utløp av opptaksforespørsler, slik at et slettet bilde forsvinner fra disken innen minutter, ikke et døgn.
 * Samme per-tenant/per-space-isolasjon som sveipet over: én feil velter aldri resten, men telles og logges (kun koder, aldri innhold).
 */
export interface VisionMaintenanceDeps {
  snapshots?: VisionSnapshotService | undefined;
  inventory?: VisionInventoryService | undefined;
  captures?: VisionCaptureService | undefined;
  embeddings?: VisionEmbeddingService | undefined;
}

export interface VisionMaintenanceSummary {
  spaces: number;
  snapshots_purged: number;
  pending_reaped: number;
  tombstones_deleted: number;
  tombstones_failed: number;
  tombstones_stuck: number;
  inventory_purged: number;
  captures_expired: number;
  captures_deleted: number;
  vectors_backfilled: number;
  failed: VisionRetentionSweepFailure[];
}

export async function runVisionMaintenanceSweepForAllTenants(pool: pg.Pool, deps: VisionMaintenanceDeps, options: { light?: boolean } = {}): Promise<VisionMaintenanceSummary> {
  const summary: VisionMaintenanceSummary = {
    spaces: 0, snapshots_purged: 0, pending_reaped: 0, tombstones_deleted: 0, tombstones_failed: 0, tombstones_stuck: 0,
    inventory_purged: 0, captures_expired: 0, captures_deleted: 0, vectors_backfilled: 0, failed: []
  };
  const tenantIds = await listAllTenantIds(pool, 200);
  for (const tenantId of tenantIds) {
    let spaces: string[];
    try {
      spaces = await listTenantMemorySpaces(pool, tenantId);
    } catch (err) {
      const failure: VisionRetentionSweepFailure = { tenant_id: tenantId, memory_space_id: "*", error: (err as Error).message.slice(0, 200) };
      summary.failed.push(failure);
      console.error(JSON.stringify({ msg: "vision_maintenance_failed", ...failure }));
      continue;
    }
    for (const spaceName of spaces) {
      const space = spaceName as MemorySpace;
      try {
        summary.spaces += 1;
        if (deps.snapshots !== undefined) {
          if (!options.light) summary.snapshots_purged += await deps.snapshots.purgeExpiredSnapshots(tenantId, space);
          summary.pending_reaped += await deps.snapshots.reapPending(tenantId, space);
        }
        if (deps.captures !== undefined) {
          const result = await deps.captures.maintain(tenantId, space);
          summary.captures_expired += result.expired;
          summary.captures_deleted += result.deleted;
        }
        if (!options.light) {
          if (deps.inventory !== undefined) summary.inventory_purged += await deps.inventory.purgeExpired(tenantId, space);
          if (deps.embeddings !== undefined) summary.vectors_backfilled += (await deps.embeddings.backfillMissing(tenantId, space)).embedded;
        }
        // Sist: gravsteinene (inkludert de denne kjøringen nettopp skapte).
        if (deps.snapshots !== undefined) {
          const reaped = await deps.snapshots.reapTombstones(tenantId, space);
          summary.tombstones_deleted += reaped.deleted;
          summary.tombstones_failed += reaped.failed;
          summary.tombstones_stuck += reaped.stuck;
          // Review B-L8: «stuck» (gravsteiner som gjentatte ganger ikke lar seg slette - ofte et volum uten skrivetilgang) er en sveipefeil: den når `assertNoSweepFailures`/loggen i stedet for å ligge stille i en teller.
          if (reaped.stuck > 0) {
            const failure: VisionRetentionSweepFailure = { tenant_id: tenantId, memory_space_id: spaceName, error: `tombstones_stuck:${reaped.stuck}` };
            summary.failed.push(failure);
            console.error(JSON.stringify({ msg: "vision_maintenance_failed", ...failure }));
          }
        }
      } catch (err) {
        const failure: VisionRetentionSweepFailure = { tenant_id: tenantId, memory_space_id: spaceName, error: (err as Error).message.slice(0, 200) };
        summary.failed.push(failure);
        console.error(JSON.stringify({ msg: "vision_maintenance_failed", ...failure }));
      }
    }
  }
  return summary;
}
