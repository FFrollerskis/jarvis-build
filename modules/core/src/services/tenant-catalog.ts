import type pg from "pg";

/**
 * Q-27 (2026-08-18, D-65): ETT kanonisk, RLS-trygt mønster for å telle opp
 * bedrifts-tenants for scheduler-fan-out - erstatter tre uavhengige, rå
 * `pool.query("SELECT tenant_id FROM tenants WHERE kind='business'...")`
 * som ALLE var strukturelt RLS-blinde (se `023_business_tenant_catalog.sql`
 * for rotårsak/fiks). Kaller den smale `SECURITY DEFINER`-katalogfunksjonen
 * - ALDRI en direkte spørring mot `tenants`. Ingen ny permission-modell:
 * `jarvis_runtime` forblir NOSUPERUSER/NOBYPASSRLS (Q-21) uendret.
 */
export class BusinessTenantEnumerationError extends Error {
  constructor(cause: unknown) {
    super(`business_tenant_enumeration_failed: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "BusinessTenantEnumerationError";
  }
}

/**
 * Returnerer `tenant_id` for alle bedrifts-tenants (`kind='business'`),
 * bounded (default/maks 200, se migrasjonen for øvre grense). Kaster en
 * typet `BusinessTenantEnumerationError` ved faktisk spørrings-/tillatelse-
 * feil - ALDRI stille tolket som "0 tenants" (§14: en gyldig tom mengde og
 * en feil er to forskjellige ting). Logger KUN et antall, aldri tenant-IDer,
 * til vanlig prosess-logg (§15 - unngå unødvendig tenant-identifiserende
 * utskrift i produksjonslogger).
 */
export async function listBusinessTenantIds(pool: pg.Pool, limit = 200): Promise<string[]> {
  let result;
  try {
    result = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM jarvis_list_business_tenant_ids($1)",
      [limit]
    );
  } catch (err) {
    throw new BusinessTenantEnumerationError(err);
  }
  const tenantIds = result.rows.map((row) => row.tenant_id);
  console.log(JSON.stringify({ msg: "business_tenants_enumerated", count: tenantIds.length }));
  return tenantIds;
}
