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
 *     vurderinger og tilbakemeldinger). Situasjonene er ellers en varig kamera-/helse-tidslinje utenfor G2/G3-retensjonen. Eneste unntak fra slettingen: en situasjon som en av eierens beslutninger refererer
 *     (`decision_log.related_situation_id`) består til beslutningen er borte (den løses likevel som vanlig).
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

/**
 * Det EFFEKTIVE vinduet (dager) en signalsituasjon i et kilde-domene med egen oppbevaring (kamera/vision, helse) overlever: `min(grunnvindu, kildens egen oppbevaring)`, begge klemt til 1-365; uten kildepolicy (`null`/utelatt) gjelder
 * grunnvinduet selv. ÉN definisjon: sveipet (`retireSignalSituations`) bruker den, og eierens vision-rute (WP-G3b fiks-runde 1, F1) regner en forkorting av kameravinduet mot DEN - grunnvinduet er `JARVIS_SITUATION_LOG_RETENTION_DAYS`
 * (7-365, standard 30), ikke rutens standard (30), så en forlengelse mot standarden kan likevel forkorte det sveipet bruker.
 */
export function signalSituationWindowDays(baseDays: number | undefined, sourceDays: number | null | undefined): number {
  const base = clampDays(baseDays, DEFAULT_SITUATION_RETENTION_DAYS);
  return Math.min(base, clampDays(sourceDays, base));
}

/**
 * Én eller begge oppryddingsstegene feilet. Begge forsøkes ALLTID (se `retireSignalSituations`); feilen kastes først etter det, med hvilke steg som feilet og hva som likevel lyktes. Meldingen er en kort kode uten innhold
 * (`signal_retention_failed:delete`, `...:resolve`, `...:delete.resolve`); den underliggende databasefeilen ligger i `cause`.
 */
export class SignalRetentionFailedError extends Error {
  readonly steps: ReadonlyArray<"delete" | "resolve">;
  readonly resolved: number;
  readonly deleted: number;
  constructor(steps: ReadonlyArray<"delete" | "resolve">, done: { resolved: number; deleted: number }, cause: unknown) {
    super(`signal_retention_failed:${steps.join(".")}`, { cause });
    this.name = "SignalRetentionFailedError";
    this.steps = steps;
    this.resolved = done.resolved;
    this.deleted = done.deleted;
  }
}

/**
 * Daglig opprydding (se filhode, punkt 3). Returnerer antall løste og slettede situasjoner. Situasjoner som er claimet/utført (act_idempotency_key satt) røres aldri.
 *
 * D-MEDIUM-1 (delta-review B): en situasjon som en av eierens beslutninger refererer (`decision_log.related_situation_id`, FK uten kaskade, 059) SLETTES ikke: beslutningen er eierens historikk og FK-en ville ellers rullet tilbake hele DELETE-en
 * (23503) og dermed stoppet både slettingen og løsingen for hele rommet, daglig og stille. Den refererte situasjonen løses som vanlig (48 t), og slettes først når beslutningen er borte (eller via erasure). Sletting og løsing går i HVER SIN
 * transaksjon, så en uforutsett feil i det ene aldri hindrer det andre; begge forsøkes alltid, og feilen kastes (`SignalRetentionFailedError`) etter det.
 */
export async function retireSignalSituations(pool: pg.Pool, tenantId: string, memorySpace: MemorySpace, options: SignalRetentionOptions = {}): Promise<{ resolved: number; deleted: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const resolveHours = Math.min(24 * 30, Math.max(1, Math.floor(options.resolveAfterHours ?? DEFAULT_RESOLVE_AFTER_HOURS)));
  const base = clampDays(options.retentionDays, DEFAULT_SITUATION_RETENTION_DAYS);
  const days = { home: base, vision: signalSituationWindowDays(options.retentionDays, options.visionDays), health: signalSituationWindowDays(options.retentionDays, options.healthDays) };
  const iso = (daysAgo: number): string => new Date(nowMs - daysAgo * 86_400_000).toISOString();
  const done = { resolved: 0, deleted: 0 };
  const failed: Array<"delete" | "resolve"> = [];
  let firstCause: unknown;
  // Sletting FØR løsing: en rad som er gammel nok til å slettes skal ikke først «løses» og dermed få en ny levetid.
  try {
    done.deleted = await withMemoryTransaction(pool, tenantId, [memorySpace], async (client) => {
      const del = await client.query(
        `DELETE FROM situations
         WHERE tenant_id = $1 AND memory_space_id = $2 AND ${SIGNAL_ORIGIN_SQL}
           AND act_idempotency_key IS NULL
           AND updated_at < CASE domain WHEN 'health' THEN $4::timestamptz WHEN 'vision' THEN $5::timestamptz ELSE $6::timestamptz END
           AND NOT EXISTS (
             SELECT 1 FROM decision_log d
             WHERE d.tenant_id = situations.tenant_id AND d.memory_space_id = situations.memory_space_id AND d.related_situation_id = situations.situation_id
           )`,
        [tenantId, memorySpace, [...SIGNAL_SITUATION_DOMAINS], iso(days.health), iso(days.vision), iso(days.home)]
      );
      return del.rowCount ?? 0;
    });
  } catch (err) {
    failed.push("delete");
    firstCause = err;
  }
  // Løsing rører IKKE `updated_at`: levetiden regnes fra siste observasjon, ikke fra opprydningen.
  try {
    done.resolved = await withMemoryTransaction(pool, tenantId, [memorySpace], async (client) => {
      const res = await client.query(
        `UPDATE situations SET status = 'resolved', resolved_at = to_timestamp($4::double precision / 1000.0)
         WHERE tenant_id = $1 AND memory_space_id = $2 AND ${SIGNAL_ORIGIN_SQL}
           AND status = 'open' AND act_idempotency_key IS NULL AND stage IN ('ignore','remember','inform','suggest')
           AND updated_at < $5::timestamptz`,
        [tenantId, memorySpace, [...SIGNAL_SITUATION_DOMAINS], nowMs, new Date(nowMs - resolveHours * 3_600_000).toISOString()]
      );
      return res.rowCount ?? 0;
    });
  } catch (err) {
    failed.push("resolve");
    firstCause ??= err;
  }
  if (failed.length > 0) throw new SignalRetentionFailedError(failed, done, firstCause);
  return done;
}
