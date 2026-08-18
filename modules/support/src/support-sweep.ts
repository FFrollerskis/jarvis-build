import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { listBusinessTenantIds } from "@jarvis/core";
import type { GmailIngressStats, SupportEmailService } from "./email-ingress.ts";

/**
 * UA-3 Native Support Core (D-66) §24 i byggeordren: periodisk Gmail-innboks-
 * reconciliation - SAMME reboot-durable `DailyScheduler`-mekanisme som
 * `business-open-loop-sweep`/`business-events-sync` (ingen ny kø). Bounded
 * (LIMIT 200 tenants), idempotent (gjenbruker `ingestFromGmail()`s egen
 * thread-/melding-idempotens), tenant-scoped. Én tenant sin feil velter
 * ALDRI resten.
 *
 * Q-27 (D-65): tenant-katalogen leses via den DELTE, RLS-trygge
 * `listBusinessTenantIds()` (@jarvis/core) - ALDRI en rå `pool.query` direkte
 * mot `tenants` (som var strukturelt RLS-blind). Dette er den SAMME
 * kanoniske katalogfunksjonen som `runOpenLoopSweepForAllTenants`/
 * `runBusinessEventSyncForAllTenants`/`runScoringSweepForAllTenants` bruker -
 * ingen ny/duplisert katalogmekanisme (§23 i byggeordren).
 */
export async function runSupportInboxSyncForAllTenants(
  pool: pg.Pool,
  emailService: SupportEmailService
): Promise<Record<string, GmailIngressStats>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, GmailIngressStats> = {};
  for (const tenantId of tenantIds) {
    const identity: IdentityContext = {
      person_id: "system", tenant_id: tenantId, memory_space_id: "business",
      session_id: `support-inbox-sync-${tenantId}`, device_id: "jarvis-core",
      channel: "api", auth_strength: "active"
    };
    try {
      results[tenantId] = await emailService.ingestFromGmail(tenantId, "business", identity);
    } catch (err) {
      results[tenantId] = {
        scanned: 0, ingested: 0, ignored_not_support: 0, unmatched: 0, ambiguous: 0,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120)
      };
    }
  }
  return results;
}
