import type pg from "pg";
import type { SweepFailureCollector } from "@jarvis/contracts";
import { listBusinessTenantIds, redactForLog } from "@jarvis/core";
import type { FinanceReconciliationService, ReconciliationReport } from "./reconciliation.ts";

/**
 * WP-F1 (D-462, UA-6 akseptanse): planlagt avstemmingssveip for ALLE bedrifts-tenants - SAMME reboot-durable `DailyScheduler`-mekanisme og «for-alle-tenants»-mønster
 * som `runStripePaymentSyncForAllTenants()`/`runNeonomicsSweepForAllTenants()` (ingen ny scheduler-arkitektur). Kjøres ETTER leverandørsynkene (Stripe/Vipps/Neonomics
 * kl. 3, utgifter kl. 4) og FØR open-loop-sveipet (kl. 6), slik at ferske utfall er avstemt og `RECONCILE_*`-flaggene er satt når avviksflaten leser dem.
 *
 * DORMANT uten credentials: den lokale delen krever ingen; Fiken-delen hoppes over synlig (`checks.fiken`). En tenant uten betalinger gir en tom, rask kjøring.
 * Observasjon og varsel - ALDRI en korreksjon eller en pengehandling.
 */
export async function runFinanceReconciliationForAllTenants(
  pool: pg.Pool, service: FinanceReconciliationService, failures?: SweepFailureCollector
): Promise<Record<string, Pick<ReconciliationReport, "run_id" | "checks" | "findings_open" | "findings_new" | "findings_reopened" | "findings_resolved" | "notified">>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, Pick<ReconciliationReport, "run_id" | "checks" | "findings_open" | "findings_new" | "findings_reopened" | "findings_resolved" | "notified">> = {};
  for (const tenantId of tenantIds) {
    try {
      const report = await service.reconcileFinance(tenantId, "business", "sweep");
      // En Fiken-lesing som feilet er IKKE en fullført dag for den delen av avstemmingen (D-442): meld den til sveip-oppsamleren, men la resten stå.
      const fiken = report.checks["fiken"];
      if (typeof fiken === "string" && fiken.startsWith("failed:")) failures?.record(tenantId, `Fiken-avstemming feilet (${fiken})`, "fiken");
      results[tenantId] = {
        run_id: report.run_id, checks: report.checks, findings_open: report.findings_open, findings_new: report.findings_new,
        findings_reopened: report.findings_reopened, findings_resolved: report.findings_resolved, notified: report.notified
      };
    } catch (err) {
      // Én tenant sin feil skal aldri velte sveipet for andre tenants - isolasjonen er uendret, kun stillheten var feilen (D-227).
      console.error(JSON.stringify({
        msg: "finance_reconcile_sweep_tenant_failed", tenant_id: tenantId, error: redactForLog(err instanceof Error ? err.message : String(err), 200)
      }));
      failures?.record(tenantId, err);
    }
  }
  return results;
}
