import type pg from "pg";

/**
 * K1 (Sovereign graduation, D-164): delt, ren SQL-hjelper mot
 * `owner_control_state` (058_owner_control_authority.sql) - brukt av BÅDE
 * `KillSwitch` (kind="kill_switch") OG `OwnerControls`
 * (kind="connector_freeze"/"credential_revocation"). SAMME "presens = aktiv"-
 * moenster som `situation_domain_pauses`: en rad betyr AKTIV, ingen rad
 * betyr INAKTIV - `deleteControlState()` ER "deaktiver".
 *
 * INGEN advisory-laas her (i motsetning til `situation_domain_pauses`):
 * denne tilstanden koordinerer ikke med en samtidig, langvarig kritisk
 * seksjon (situations sin `actOn()`-claim) - en enkelt parameterisert
 * UPSERT/DELETE er atomisk nok for "siste skriving vinner"-semantikken en
 * pause-/frys-/tilbakekallsbryter faktisk trenger.
 */
export interface OwnerControlStateRow {
  control_kind: string;
  control_target: string;
  reason: string;
  actor_person_id: string | null;
  changed_at: string;
}

export async function readControlState(pool: pg.Pool, kind: string, target: string): Promise<OwnerControlStateRow | null> {
  const { rows } = await pool.query<OwnerControlStateRow>(
    `SELECT control_kind, control_target, reason, actor_person_id, changed_at::text
     FROM owner_control_state WHERE control_kind = $1 AND control_target = $2`,
    [kind, target]
  );
  return rows[0] ?? null;
}

export async function listControlState(pool: pg.Pool, kind: string): Promise<OwnerControlStateRow[]> {
  const { rows } = await pool.query<OwnerControlStateRow>(
    `SELECT control_kind, control_target, reason, actor_person_id, changed_at::text
     FROM owner_control_state WHERE control_kind = $1 ORDER BY control_target`,
    [kind]
  );
  return rows;
}

export async function writeControlState(
  pool: pg.Pool,
  kind: string,
  target: string,
  reason: string,
  actorPersonId: string | undefined
): Promise<void> {
  await pool.query(
    `INSERT INTO owner_control_state (control_kind, control_target, reason, actor_person_id, changed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (control_kind, control_target)
     DO UPDATE SET reason = EXCLUDED.reason, actor_person_id = EXCLUDED.actor_person_id, changed_at = now()`,
    [kind, target, reason, actorPersonId ?? null]
  );
}

export async function deleteControlState(pool: pg.Pool, kind: string, target: string): Promise<void> {
  await pool.query(`DELETE FROM owner_control_state WHERE control_kind = $1 AND control_target = $2`, [kind, target]);
}

/** Sovereign eier-autoritet for `*Durable()`-mutasjoner - SAMME minimale form/disiplin som `DomainPauseAuthority` (situations/domain-pause.ts). */
export interface OwnerControlAuthority {
  owner_person_id: string;
}

export class OwnerControlUnauthorizedError extends Error {
  constructor(public readonly actorPersonId: string | undefined) {
    super(`owner_control_unauthorized:${actorPersonId ?? "none"}`);
    this.name = "OwnerControlUnauthorizedError";
  }
}

/** Fail-CLOSED: krever et konfigurert `authority` OG en matchende `actorPersonId` NAAR persistens er aktiv (`pool` gitt) - se `DomainPauseRegistry.assertAuthorized()` for identisk presedens/begrunnelse. */
export function assertOwnerControlAuthorized(
  pool: pg.Pool | undefined,
  authority: OwnerControlAuthority | undefined,
  actorPersonId: string | undefined
): void {
  if (!pool) return;
  if (!actorPersonId || !authority || actorPersonId !== authority.owner_person_id) {
    throw new OwnerControlUnauthorizedError(actorPersonId);
  }
}

/**
 * D-166 (arkitekt-review PR #93, funn B1): den MINIMALE, EKSPLISITTE
 * handlingsmengden på `owner_controls` selv som forblir tilgjengelig
 * gjennom den KANONISKE ToolGateway-/PolicyGateway-stien når ETT, ELLER
 * BEGGE SAMTIDIG, av (a) global kill switch aktiv, (b) den delte interne
 * `credential_ref`-en (samme ref `owner_controls`/`situations`/`executive`
 * selv bruker) er tilbakekalt. IKKE en blanket-unntak for HELE
 * `owner_controls`-verktøyet (D-164 sin opprinnelige, for brede
 * `isRevokedDurable`-fiks var nettopp DET - rettet her) - kun disse tre,
 * navngitte handlingene:
 *
 * - `get_control_state`: eieren må ALLTID kunne SE hvorfor systemet er
 *   stanset/tilbakekalt, spesielt akkurat NÅR det er det (uendret fra D-164).
 * - `deactivate_kill_switch`: uten unntak et énveis-lås for kill switchen selv
 *   (uendret fra D-164).
 * - `restore_credential`: NY i D-166. `restore_credential` bruker SAMME
 *   delte `credential_ref` som resten av `owner_controls` - uten unntak
 *   ville en tilbakekalling av DEN delte refen (feil, forveksling, eller
 *   kompromittert eier-identitet) blokkert `restore_credential` MED SIN
 *   EGEN sjekk, et énveis-lås identisk i form til kill-switch-scenariet,
 *   men uten noe unntak.
 *
 * BEGGE gatene (kill-switch-aktiv-sjekken i `PolicyGateway.authorize()`,
 * OG den tilbakekalt-credential-sjekken i `ToolGateway.execute()`) MÅ bruke
 * DENNE SAMME mengden - ikke to uavhengige, potensielt driftende lister -
 * for at BEGGE gjenopprettingsrekkefølger (`restore_credential` FØR
 * `deactivate_kill_switch`, ELLER omvendt) skal være deterministisk mulige
 * når BEGGE tilstandene er aktive samtidig. Handlinger UTENFOR denne
 * mengden (`activate_kill_switch`, `freeze_connector`/`unfreeze_connector`,
 * `revoke_credential`) er ALDRI unntatt fra NOEN av de to gatene - kun
 * frys-sjekken (`isFrozenDurable`) har sitt EGET, videre, allerede
 * eksisterende og godkjente unntak for HELE `owner_controls`-verktøyet
 * (uendret av D-166 - det gjaldt en annen, langt smalere selv-mål-risiko
 * enn den delte credential_ref-en, se D-166 i DECISIONS_AND_ASSUMPTIONS.md).
 */
export const OWNER_CONTROLS_SELF_RECOVERY_ACTIONS: ReadonlySet<string> = new Set([
  "get_control_state",
  "deactivate_kill_switch",
  "restore_credential"
]);
