import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";

/**
 * WP-G4 (D-466) FIKS-RUNDE (A-MEDIUM-4, B-MEDIUM-3): livssyklusen til situasjoner som SIGNALKILDENE skaper (`home:`/`vision:`/`health:`-nøkler; domenene home, vision, health). Tre små, rene SQL-operasjoner (alle tenant+space-scoped
 * under RLS, aldri rør claim-felt, aldri en situasjon som er claimet/utført - den historikken består):
 *
 *  1. `touchSituation`: en observasjon som fortsatt gjelder (`duplicate` i bussen) bumper `updated_at` (høyst hvert 5. minutt) - «sist sett». Auto-ACT krever fersk observasjon (`autoActPending`), så et gammelt forslag UTFØRES aldri.
 *  2. `resolveNormalizedHome`: tilstanden er normal (døra lukket, sensoren tørr, alarmen avarmert, effekten under grensen) -> åpne situasjoner for entiteten løses (ikke lenger «åpen/suggest» i tre døgn).
 *  3. `retireSignalSituations` (daglig, uavhengig av abonnement): åpne, uclaimede signalsituasjoner som ikke er sett på 48 t løses, og signalsituasjoner (løste og åpne) eldre enn kildedataenes oppbevaringstid SLETTES (kaskade til logg,
 *     vurderinger og tilbakemeldinger). Situasjonene er ellers en varig kamera-/helse-tidslinje utenfor G2/G3-retensjonen.
 */
export const SIGNAL_SITUATION_DOMAINS = ["home", "vision", "health"] as const;
export const SIGNAL_SITUATION_KEY_PREFIXES = ["home:", "vision:", "health:"] as const;
export const DEFAULT_RESOLVE_AFTER_HOURS = 48;
export const DEFAULT_SITUATION_RETENTION_DAYS = 30;
/** `touchSituation` skriver høyst så ofte per situasjon (ingen skriveforsterkning per tikk). */
export const TOUCH_MIN_INTERVAL_MINUTES = 5;

const SIGNAL_ORIGIN_SQL = `domain = ANY($3::text[]) AND (${SIGNAL_SITUATION_KEY_PREFIXES.map((p) => `starts_with(detection_key, '${p}')`).join(" OR ")})`;

/** «Sist sett»: bumper `updated_at` på en ÅPEN situasjon, høyst hvert `TOUCH_MIN_INTERVAL_MINUTES`. Returnerer om en rad ble skrevet. */
export async function touchSituation(pool: pg.Pool, tenantId: string, memorySpace: MemorySpace, detectionKey: string): Promise<boolean> {
  return withMemoryTransaction(pool, tenantId, [memorySpace], async (client) => {
    const { rowCount } = await client.query(
      `UPDATE situations SET updated_at = now()
       WHERE tenant_id = $1 AND memory_space_id = $2 AND detection_key = $3 AND status = 'open'
         AND updated_at < now() - make_interval(mins => $4::int)`,
      [tenantId, memorySpace, detectionKey, TOUCH_MIN_INTERVAL_MINUTES]
    );
    return (rowCount ?? 0) > 0;
  });
}

/** Løser åpne `home`-situasjoner for entiteter hvis tilstand nå er normal. `prefixes` = `homeKeyPrefix()` per entitet (`home:<art>:<entitet>@`); tom liste = ingenting. Rører aldri claim-felt. */
export async function resolveNormalizedHome(pool: pg.Pool, tenantId: string, memorySpace: MemorySpace, prefixes: readonly string[]): Promise<number> {
  if (prefixes.length === 0) return 0;
  return withMemoryTransaction(pool, tenantId, [memorySpace], async (client) => {
    const { rowCount } = await client.query(
      `UPDATE situations SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND memory_space_id = $2 AND domain = 'home' AND status = 'open'
         AND EXISTS (SELECT 1 FROM unnest($3::text[]) AS p(prefix) WHERE starts_with(situations.detection_key, p.prefix))`,
      [tenantId, memorySpace, [...prefixes]]
    );
    return rowCount ?? 0;
  });
}

export interface SignalRetentionOptions {
  nowMs?: number;
  /** Åpne, uclaimede signalsituasjoner som ikke er sett så lenge løses. Standard 48 t (1 t - 30 d). */
  resolveAfterHours?: number;
  /** Standard oppbevaring (dager) for signalsituasjoner; klemt til 1-365. */
  retentionDays?: number;
  /** Kildenes EGEN oppbevaring (G3 kamera, G2 helse): en situasjon overlever aldri kildedataene (min av denne og `retentionDays`). `null`/utelatt = ingen egen policy. */
  visionDays?: number | null;
  healthDays?: number | null;
}

const clampDays = (value: number | null | undefined, fallback: number): number =>
  value === null || value === undefined || !Number.isFinite(value) ? fallback : Math.min(365, Math.max(1, Math.floor(value)));

/** Daglig opprydding (se filhode, punkt 3). Returnerer antall løste og slettede situasjoner. Situasjoner som er claimet/utført (act_idempotency_key satt) røres aldri. */
export async function retireSignalSituations(pool: pg.Pool, tenantId: string, memorySpace: MemorySpace, options: SignalRetentionOptions = {}): Promise<{ resolved: number; deleted: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const resolveHours = Math.min(24 * 30, Math.max(1, Math.floor(options.resolveAfterHours ?? DEFAULT_RESOLVE_AFTER_HOURS)));
  const base = clampDays(options.retentionDays, DEFAULT_SITUATION_RETENTION_DAYS);
  const days = { home: base, vision: Math.min(base, clampDays(options.visionDays, base)), health: Math.min(base, clampDays(options.healthDays, base)) };
  const iso = (daysAgo: number): string => new Date(nowMs - daysAgo * 86_400_000).toISOString();
  return withMemoryTransaction(pool, tenantId, [memorySpace], async (client) => {
    // Sletting FØR løsing: en rad som er gammel nok til å slettes skal ikke først «løses» og dermed få en ny levetid.
    const del = await client.query(
      `DELETE FROM situations
       WHERE tenant_id = $1 AND memory_space_id = $2 AND ${SIGNAL_ORIGIN_SQL}
         AND act_idempotency_key IS NULL
         AND updated_at < CASE domain WHEN 'health' THEN $4::timestamptz WHEN 'vision' THEN $5::timestamptz ELSE $6::timestamptz END`,
      [tenantId, memorySpace, [...SIGNAL_SITUATION_DOMAINS], iso(days.health), iso(days.vision), iso(days.home)]
    );
    // Løsing rører IKKE `updated_at`: levetiden regnes fra siste observasjon, ikke fra opprydningen.
    const res = await client.query(
      `UPDATE situations SET status = 'resolved', resolved_at = to_timestamp($4::double precision / 1000.0)
       WHERE tenant_id = $1 AND memory_space_id = $2 AND ${SIGNAL_ORIGIN_SQL}
         AND status = 'open' AND act_idempotency_key IS NULL AND stage IN ('ignore','remember','inform','suggest')
         AND updated_at < $5::timestamptz`,
      [tenantId, memorySpace, [...SIGNAL_SITUATION_DOMAINS], nowMs, new Date(nowMs - resolveHours * 3_600_000).toISOString()]
    );
    return { resolved: res.rowCount ?? 0, deleted: del.rowCount ?? 0 };
  });
}
