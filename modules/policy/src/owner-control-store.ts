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
