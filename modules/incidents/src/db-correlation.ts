import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";

/**
 * D-105 Part F: ekte DB-tilstand-korrelasjon - erstatter det D-104-audit
 * fant var KUN en `source_type`-tag uten egen logikk. Bruker DEN
 * EKSISTERENDE `schema_migrations`-tabellen (migrator.ts, uendret) - INGEN
 * ny leverandør, INGEN forretningsdata lest (kun migrasjonsmetadata +
 * tilkoblings-helse). Deterministisk (INGEN LLM): "er DB-tilstand relevant
 * for denne hendelsen" avgjøres av om nyeste migrasjon ble anvendt INNENFOR
 * hendelsens tidsvindu, ALDRI en gjetning.
 */
export interface DbStateEvidence {
  connectivity: "ok" | "unreachable";
  /**
   * WP-K (D-471, JARVIS-068): HVA `connectivity` faktisk beviser. `api_own_pool` = kun at API-prosessens EGEN databasepool nådde databasen akkurat nå - ikke at databasen er frisk for andre klienter,
   * ikke replikering/disk/ytelse, og ikke at worker-prosessen når den. Feltet finnes slik at «ok» aldri leses som «databasen er frisk».
   */
  connectivity_scope: "api_own_pool";
  connectivity_checked_at: string;
  latest_migration: { name: string; applied_at: string } | null;
  /** Sant KUN når nyeste migrasjon ble anvendt <= `windowEndIso` OG >= `windowStartIso` - EKSPLISITT, aldri en heuristikk. */
  migration_in_window: boolean;
  relevant: "true" | "false" | "unknown";
}

export async function correlateDbState(
  pool: pg.Pool,
  tenantId: string,
  windowStartIso: string,
  windowEndIso: string
): Promise<DbStateEvidence> {
  const checkedAt = new Date().toISOString();
  let connectivity: DbStateEvidence["connectivity"] = "unreachable";
  let latest_migration: DbStateEvidence["latest_migration"] = null;
  try {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query("SELECT 1");
      connectivity = "ok";
      // `schema_migrations` er tenant-nøytral (systemskjema, ingen RLS) -
      // trygt å lese under en tenant-scoped transaksjon (ingen skriving).
      const { rows } = await client.query<{ name: string; applied_at: string }>(
        `SELECT name, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1`
      );
      if (rows[0]) {
        latest_migration = { name: rows[0].name, applied_at: new Date(rows[0].applied_at).toISOString() };
      }
    });
  } catch {
    // Tilkoblingsfeil/manglende tabell -> `connectivity` forblir "unreachable",
    // ALDRI en fabrikkert "ok". `relevant` beregnes under som "unknown".
  }

  if (connectivity === "unreachable") {
    return { connectivity, connectivity_scope: "api_own_pool", connectivity_checked_at: checkedAt, latest_migration: null, migration_in_window: false, relevant: "unknown" };
  }

  const migration_in_window = Boolean(
    latest_migration &&
      (latest_migration as { applied_at: string }).applied_at >= windowStartIso &&
      (latest_migration as { applied_at: string }).applied_at <= windowEndIso
  );
  return {
    connectivity,
    connectivity_scope: "api_own_pool",
    connectivity_checked_at: checkedAt,
    latest_migration,
    migration_in_window,
    relevant: migration_in_window ? "true" : "false"
  };
}
