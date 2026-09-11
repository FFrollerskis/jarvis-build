import type pg from "pg";
import { withTenantTransaction } from "../db/pool.ts";

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

export class AllTenantEnumerationError extends Error {
  constructor(cause: unknown) {
    super(`all_tenant_enumeration_failed: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "AllTenantEnumerationError";
  }
}

/**
 * UA-8 (D-130): SAMME mønster/begrunnelse som `listBusinessTenantIds` over
 * (Q-27/D-65 - RLS-blind rå spørring erstattet med en smal SECURITY DEFINER-
 * katalogfunksjon), men UTEN `kind`-filter - trengs av `location`/`health`-
 * retensjons-sveipene, som må nå BÅDE bedrifts- OG person-tenants (personlig
 * lokasjons-/helsedata hører like naturlig hjemme i en persons EGEN tenant).
 * `listBusinessTenantIds` selv er BEVISST uendret og fortsatt kun for
 * eksisterende bedrifts-sveip.
 */
export async function listAllTenantIds(pool: pg.Pool, limit = 200): Promise<string[]> {
  let result;
  try {
    result = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM jarvis_list_all_tenant_ids($1)", [limit]);
  } catch (err) {
    throw new AllTenantEnumerationError(err);
  }
  const tenantIds = result.rows.map((row) => row.tenant_id);
  console.log(JSON.stringify({ msg: "all_tenants_enumerated", count: tenantIds.length }));
  return tenantIds;
}

/**
 * UA-8 (D-130): hvilke memory spaces en gitt tenant faktisk har - trengs for
 * å vite hvilke (tenant, space)-par en space-skopet sveip (f.eks.
 * `location`/`health`-retensjon) skal kjøre for. `memory_spaces` selv har
 * INGEN space-nivå RLS-policy (den ER katalogen space-policyene slår opp i)
 * - kun tenant-RLS - `withTenantTransaction` (ikke `withMemoryTransaction`)
 * er derfor korrekt og tilstrekkelig her, samme som erasure-modulets eget
 * (uavhengige) `tenantSpaces()`-hjelpefunksjon.
 */
export async function listTenantMemorySpaces(pool: pg.Pool, tenantId: string): Promise<string[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{ space: string }>(
      "SELECT DISTINCT space FROM memory_spaces WHERE tenant_id = $1",
      [tenantId]
    );
    return result.rows.map((row) => row.space);
  });
}
