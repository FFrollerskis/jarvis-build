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
export interface LocationRetentionSweepFailure {
  tenant_id: string;
  /** `"*"` når selve space-oppslaget for tenanten feilet (ikke ett enkelt space). */
  memory_space_id: string;
  error: string;
}

/**
 * MERGE BLOCKER A (arkitekt-review, PR #79): tidligere svelget denne
 * funksjonen ALLE purge-feil stille (kun `catch {}`) - retensjonshåndhevelse
 * kunne dermed feile for alltid uten NOEN synlig signal, mens scheduleren
 * fortsatt så "vellykket" ut. `try`/`catch`-PER-(tenant, space) beholdes
 * BEVISST (én tenant/space sin feil skal fortsatt ALDRI velte resten av
 * sveipet) - men feilen er nå OBSERVERBAR: talt/samlet i det returnerte
 * sammendraget OG strukturert logget umiddelbart (samme
 * `console.error(JSON.stringify({msg: ...}))`-mønster som
 * `voice_core_error` i apps/voice-gateway/src/session.ts), slik at en feilet
 * purge synes i logger selv om ingen (ennå) leser returverdien.
 */
export interface LocationRetentionSweepSummary {
  /** Antall (tenant, memory_space)-kombinasjoner der purge FULLFØRTE uten feil (uavhengig av antall rader faktisk slettet). */
  succeeded: number;
  failed: LocationRetentionSweepFailure[];
}

export async function runLocationRetentionSweepForAllTenants(
  pool: pg.Pool,
  location: LocationService
): Promise<LocationRetentionSweepSummary> {
  const tenantIds = await listAllTenantIds(pool, 200);
  let succeeded = 0;
  const failed: LocationRetentionSweepFailure[] = [];

  for (const tenantId of tenantIds) {
    let spaces: string[];
    try {
      spaces = await listTenantMemorySpaces(pool, tenantId);
    } catch (err) {
      // Én tenant sin feil (f.eks. space-oppslag) skal aldri velte hele
      // sveipet for andre tenants - men den skal heller ALDRI forsvinne stille.
      const failure: LocationRetentionSweepFailure = {
        tenant_id: tenantId,
        memory_space_id: "*",
        error: (err as Error).message.slice(0, 200)
      };
      failed.push(failure);
      console.error(JSON.stringify({ msg: "location_retention_purge_failed", ...failure }));
      continue;
    }

    for (const space of spaces) {
      try {
        await location.purgeExpiredObservations(tenantId, space as MemorySpace);
        succeeded += 1;
      } catch (err) {
        // Én space sin purge-feil skal aldri velte resten av tenantens
        // spaces (isolasjon beholdt) - men skal ALDRI svelges stille lenger.
        const failure: LocationRetentionSweepFailure = {
          tenant_id: tenantId,
          memory_space_id: space,
          error: (err as Error).message.slice(0, 200)
        };
        failed.push(failure);
        console.error(JSON.stringify({ msg: "location_retention_purge_failed", ...failure }));
      }
    }
  }

  return { succeeded, failed };
}
