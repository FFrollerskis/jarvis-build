import type pg from "pg";
import { listAllTenantIds } from "@jarvis/core";
import type { HealthService } from "./service.ts";

/**
 * Strukturert oppsummering av ett sveip - RETTET etter arkitekt-review av
 * PR #79 (D-130): den opprinnelige versjonen av denne funksjonen svelget
 * ALLE per-tenant purge-feil stille (tom `catch {}`, feilen ble aldri
 * logget og ALDRI skilt fra "0 rader å purge") - en tenant med en reell,
 * vedvarende purge-feil (f.eks. en DB-tilkoblingsfeil, en fremtidig
 * skjemadrift) ville sett IDENTISK ut som en tenant uten noe å slette, i
 * evighet, uten at noen noensinne fikk vite det. `succeeded`/`failed` gjør
 * feilen OBSERVERBAR (logget strukturert under, i tillegg til returnert her
 * for kalleren) - per-tenant-ISOLASJONEN er UENDRET: én tenants feil velter
 * fortsatt ALDRI sveipet for de andre.
 */
export interface HealthRetentionSweepResult {
  /** Antall tenants der purge fullførte OK (uavhengig av om noen rader faktisk ble slettet). */
  succeeded: number;
  /** Faktisk slettet antall rader per tenant - KUN for tenants i `succeeded`. */
  purgedByTenant: Record<string, number>;
  /** Tenants der purge feilet - se strukturert `console.error`-logglinje for hver, samtidig som sveipet fortsetter. */
  failed: Array<{ tenant_id: string; error: string }>;
}

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
): Promise<HealthRetentionSweepResult> {
  const tenantIds = await listAllTenantIds(pool, 200);
  const result: HealthRetentionSweepResult = { succeeded: 0, purgedByTenant: {}, failed: [] };
  for (const tenantId of tenantIds) {
    try {
      result.purgedByTenant[tenantId] = await health.purgeExpiredObservations(tenantId);
      result.succeeded += 1;
    } catch (err) {
      // Én tenant sin purge-feil skal aldri velte hele sveipet for andre tenants
      // - men den skal heller ALDRI forsvinne stille (se JSDoc over).
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      console.error(JSON.stringify({ msg: "health_retention_purge_failed", tenant_id: tenantId, error: message }));
      result.failed.push({ tenant_id: tenantId, error: message });
    }
  }
  return result;
}
