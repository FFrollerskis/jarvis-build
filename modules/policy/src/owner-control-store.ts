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
  /** Persistens (typisk `pg.Pool`; D-438: også `InfraModeStore`). `undefined` = ingen varig tilstand å beskytte = ingen sjekk. */
  pool: object | undefined,
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

/**
 * D-176 (arkitekt-review 5251073737, BLOKKER B5): D-174 sin utvidelse av
 * BEGGE gatene til å også godta `tool_id === "executive"` antok FEILAKTIG at
 * `executive`s handlingsnavn er IDENTISKE med `owner_controls` sine for ALLE
 * tre navngitte handlinger. Det holder for de to MUTASJONENE
 * (`deactivate_kill_switch`/`restore_credential` - samme navn på begge
 * tool_id-er), men IKKE for LESING: `executive` sin samlede
 * kontrolloverflate-lesing heter `get_control_surface_status`
 * (`ExecutiveTransport`), ALDRI `get_control_state` (det navnet finnes KUN på
 * `owner_controls`). Konsekvens FØR denne rettelsen: mens global kill switch
 * var aktiv, eller den delte `BUSINESS_INTERNAL_CREDENTIAL_REF` var
 * tilbakekalt, ble `executive.get_control_surface_status` selv AVSLÅTT av
 * akkurat den ytre gaten den skulle la eieren SE FORBI - direkte
 * `owner_controls.get_control_state` forble upåvirket, men B2 sitt "ETT
 * kontrollpanel for BÅDE lesing OG gjenoppretting" var reelt brutt under
 * begge låstilstandene.
 *
 * ANDRE, DYPERE funn under DENNE rettelsen (ikke navngitt i arkitekt-
 * gjennomgangen sitt "fresh code finding", men strukturelt UUNNGÅELIG å
 * fikse for at TASK 3 sine akseptansekriterier - `executive.
 * get_control_surface_status` returnerer et SANNFERDIG, KOMPLETT svar under
 * lås - faktisk kan holde): `ExecutiveService.getControlSurfaceStatus()`
 * komponerer IKKE bare `owner_controls.get_control_state`, men OGSÅ
 * `situations.get_pause_state` OG `finance.get_kill_switch`, via TO
 * YTTERLIGERE nøstede `ToolGateway.execute()`-kall (`Promise.all`, se
 * `ExecutiveService.getControlSurfaceStatus()`). BEGGE disse er REELLE,
 * UAVHENGIGE `authorize()`-kall MED SIN EGEN tool_id ("situations"/
 * "finance") - IKKE dekket av `executive`/`owner_controls`-unntaket over.
 * `finance.get_kill_switch` OG situations sine verktøy bruker DESSUTEN SAMME
 * delte `BUSINESS_INTERNAL_CREDENTIAL_REF` som `owner_controls`/`executive`
 * selv (se `situations/transport.ts` og `tool-gateway/integrations.ts`).
 * Uten et unntak ØGSÅ for DISSE to navngitte, rene lesehandlingene ville
 * `Promise.all()` i `getControlSurfaceStatus()` FORTSATT kastet
 * (`ExecutiveAccessDeniedError` fra DEN nøstede lesingen), og HELE den
 * ytre `executive.get_control_surface_status`-lesingen ville FORTSATT
 * feilet under lås - selv etter at DEN ytre gaten alene var rettet.
 *
 * FIKSEN er en eksplisitt per-(tool_id,action)-mapping (IKKE en antakelse om
 * identiske handlingsnavn - denne feilen BEVISER at det er en utrygg
 * antakelse selv innenfor SAMME komposisjon): bruk `isSelfRecoveryAction()`
 * i BEGGE gatene (`PolicyGateway.authorize()` sin kill-switch-sjekk OG
 * `ToolGateway.execute()` sin tilbakekalt-credential-sjekk) i stedet for å
 * konstruere unionen selv på kallestedet. Unntaket forblir like SMALT som
 * før - KUN disse navngitte handlingene per tool_id, ALDRI en bredere "alle
 * situations-/finance-/executive-lesinger"-regel. `situations.get_pause_state`
 * OG `finance.get_kill_switch` er BEGGE klasse A (universelt lesbare selv
 * NÅR kill switchen er inaktiv, ingen eier-sjekk) - å la dem overleve
 * kill-switch-/tilbakekalt-credential-gaten endrer IKKE hvem som kan lese
 * dem, kun NÅR; ingen mutasjon er unntatt av dette utover de allerede
 * eksisterende tre navngitte gjenopprettingshandlingene.
 */
const EXECUTIVE_SELF_RECOVERY_ACTIONS: ReadonlySet<string> = new Set([
  "get_control_surface_status",
  "deactivate_kill_switch",
  "restore_credential"
]);

/** D-176: `get_control_surface_status` sin nøstede lesing av domene-pausetilstand (UA-10) - se D-176 over. */
const SITUATIONS_SELF_RECOVERY_ACTIONS: ReadonlySet<string> = new Set(["get_pause_state"]);

/** D-176: `get_control_surface_status` sin nøstede lesing av finans-nødbryter-tilstand - se D-176 over. */
const FINANCE_SELF_RECOVERY_ACTIONS: ReadonlySet<string> = new Set(["get_kill_switch"]);

export function isSelfRecoveryAction(toolId: string, action: string): boolean {
  if (toolId === "owner_controls") return OWNER_CONTROLS_SELF_RECOVERY_ACTIONS.has(action);
  if (toolId === "executive") return EXECUTIVE_SELF_RECOVERY_ACTIONS.has(action);
  if (toolId === "situations") return SITUATIONS_SELF_RECOVERY_ACTIONS.has(action);
  if (toolId === "finance") return FINANCE_SELF_RECOVERY_ACTIONS.has(action);
  return false;
}

/**
 * D-438: delt lagring av global infra-modus i `owner_control_state` (kind `infra_mode`, mål `GLOBAL`). «Rad = aktiv (DEGRADED/PAUSED), ingen rad =
 * NORMAL»; `reason` bærer JSON {mode, reason, at}. Ugyldig JSON/ukjent modus tolkes fail-CLOSED som PAUSED (aldri stille NORMAL). NORMAL lagres aldri -
 * `clear()` er den ENE måten å løsne på.
 */
export function createPgInfraModeStore(pool: pg.Pool): import("./infra-execution-gate.ts").InfraModeStore {
  const KIND = "infra_mode";
  const TARGET = "GLOBAL";
  return {
    async read() {
      const row = await readControlState(pool, KIND, TARGET);
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.reason) as { mode?: string; reason?: string; at?: string };
        if (parsed.mode === "PAUSED" || parsed.mode === "DEGRADED") {
          return { mode: parsed.mode, ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}), at: parsed.at ?? row.changed_at };
        }
      } catch {
        // faller til fail-closed under
      }
      return { mode: "PAUSED", reason: "infra_mode_state_unreadable", at: row.changed_at };
    },
    async write(state, actorPersonId) {
      await writeControlState(pool, KIND, TARGET, JSON.stringify({ mode: state.mode, reason: state.reason, at: state.at }), actorPersonId);
    },
    async clear() {
      await deleteControlState(pool, KIND, TARGET);
    }
  };
}
