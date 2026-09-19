import type pg from "pg";

/**
 * D-167 (host-harness-korreksjon, PR #93): hjelpere for å lese `audit_events`
 * for `owner_controls.*`-handlinger AVGRENSET TIL ÉN spesifikk kjøring - IKKE
 * "de N siste radene", som er ikke-deterministisk så snart en kjøring gjør
 * FLERE enn N matchende handlinger (nøyaktig hva som skjedde med
 * `k1-owner-control-authority-live.ts` sin gamle `ORDER BY audit_id DESC
 * LIMIT 10`-spørring etter B1/D-166 la til flere `owner_controls`-kall enn
 * den opprinnelige, håndplukkede grensen tålte - se D-167 for full analyse).
 *
 * Avgrensningen er DOBBEL, ikke enkel - begge deler av det den kallende
 * scriptet allerede EMITTERER inn i `audit_events` for hvert kall:
 * - `session_id` (identisk for ALLE kall gjort med samme `IdentityContext` i
 *   én kjøring av host-scriptet - en eksakt, allerede-eksisterende
 *   kjøre-korrelator, ikke en ny mekanisme).
 * - En vannmerke-grense (`audit_id > watermark`), tatt FØR kjøringens første
 *   mutasjon - garanterer at INGEN rad fra en tidligere kjøring (samme
 *   `session_id` kan i prinsippet gjenbrukes hvis en fremtidig kaller ikke
 *   genererer en fersk UUID) kan telle med.
 *
 * INGEN `LIMIT` her - riktigheten skal ALDRI avhenge av en håndplukket
 * øvre grense. Antall rader som faktisk matcher er uansett lite og kjent
 * (avgrenset av hvor mange `owner_controls`-kall selve scriptet gjør), så en
 * `LIMIT` ville KUN vært en påstått, ikke-verifiserende "optimalisering".
 */
export interface OwnerControlsAuditRow {
  type: string;
  decision: string;
  reason: string | null;
  action: string;
  payload: Record<string, unknown>;
}

/** Tas FØR kjøringens første mutasjon - se filhode. Returneres som `text` (ikke `number`) fordi `audit_id` er `bigint` og en lenge-levende produksjonstabell strukturelt kan overskride `Number.MAX_SAFE_INTEGER`. */
export async function captureAuditWatermark(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ watermark: string }>(
    "SELECT COALESCE(MAX(audit_id), 0)::text AS watermark FROM audit_events"
  );
  return rows[0]!.watermark;
}

export interface RunScopedAuditQuery {
  personId: string;
  sessionId: string;
  /** Fra {@link captureAuditWatermark} - kun rader STRENGT ETTER denne telles. */
  watermark: string;
  actions: readonly string[];
}

/** Se filhode: avgrenset til `tool_id='owner_controls'` + eksakt `person_id`/`session_id` + `audit_id > watermark`. Ingen `LIMIT` - se filhode for hvorfor det aldri er riktighets-bærende her. */
export async function queryRunScopedOwnerControlsAudit(
  pool: pg.Pool,
  { personId, sessionId, watermark, actions }: RunScopedAuditQuery
): Promise<OwnerControlsAuditRow[]> {
  const { rows } = await pool.query<OwnerControlsAuditRow>(
    `SELECT type, decision, reason, action, payload FROM audit_events
     WHERE tool_id = 'owner_controls' AND person_id = $1 AND session_id = $2
       AND audit_id > $3::bigint AND action = ANY($4::text[])
     ORDER BY audit_id ASC`,
    [personId, sessionId, watermark, actions]
  );
  return rows;
}
