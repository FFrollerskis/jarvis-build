import type pg from "pg";
import {
  assertOwnerControlAuthorized,
  deleteControlState,
  readControlState,
  writeControlState,
  type OwnerControlAuthority
} from "./owner-control-store.ts";

const KIND = "kill_switch";
const TARGET = "GLOBAL";

/**
 * Kill switch (SECURITY_MODEL §8) - fase 1-skjelett.
 * Når aktiv skal ALLE autorisasjoner nektes, uansett capability-klasse.
 * Deterministisk tilstand; ingen LLM involvert.
 *
 * K1 (Sovereign graduation, D-164): de RENE synkrone metodene under er
 * BEVISST UENDRET (samme "ingen databaserundtur"-instantly-egenskap som
 * `DomainPauseRegistry` sine ikke-durable metoder har for situations) -
 * eksisterende enhetstester som konstruerer `new KillSwitch()` uten `pool`
 * fortsetter å virke identisk. `*Durable()`-metodene UNDER legger til et
 * VARIG (Postgres, `owner_control_state`, 058_owner_control_authority.sql),
 * DELT (api-/worker-prosess ser SAMME rad LIVE, ikke bare ved neste
 * `restore()`) skrive-/lese-lag NÅR et `pool` er gitt ved konstruksjon -
 * `PolicyGateway.authorize()` kaller `isActiveDurable()` (ALDRI den rene
 * synkrone `isActive()`) i produksjon, se der. Uten `pool` er
 * `isActiveDurable()` en ren speiling av den synkrone in-memory-tilstanden
 * (identisk oppførsel som før denne sliceen for tester uten database).
 */
export class KillSwitch {
  private active = false;
  private reason: string | undefined;

  constructor(
    private readonly pool?: pg.Pool,
    private readonly authority?: OwnerControlAuthority
  ) {}

  activate(reason: string): void {
    this.active = true;
    this.reason = reason;
  }

  deactivate(): void {
    this.active = false;
    this.reason = undefined;
  }

  isActive(): boolean {
    return this.active;
  }

  activeReason(): string | undefined {
    return this.reason;
  }

  /**
   * Den AUTORITATIVE, LIVE sjekken - kaller PolicyGateway.authorize() bruker
   * ALLTID denne (aldri den synkrone `isActive()`) fordi den, NÅR et `pool`
   * er gitt, spørrer `owner_control_state` direkte hver gang: den synkrone
   * in-memory-cachen er PER PROSESS og kan derfor divergere mellom api- og
   * worker-prosessen - "instantly" fail-fast-egenskapen situations sin
   * `DomainPauseRegistry` bevisst beholdt for domain-pause gjelder IKKE her,
   * fordi kill switch (i motsetning til domain-pause) er den ENE,
   * ubetingede gaten som sjekkes for HVERT eneste verktøykall, uansett
   * capability-klasse - cross-prosess-konsistens er viktigere enn å spare
   * ett enkelt, billig, indeksert enrads-oppslag per kall.
   */
  async isActiveDurable(): Promise<boolean> {
    if (!this.pool) return this.active;
    const row = await readControlState(this.pool, KIND, TARGET);
    return row !== null;
  }

  /** Samme live-spørring som `isActiveDurable()`, men returnerer hele raden (for `owner_controls.get_control_state`). */
  async currentStateDurable(): Promise<{ reason: string; actor_person_id: string | null; changed_at: string } | null> {
    if (!this.pool) {
      return this.active ? { reason: this.reason ?? "", actor_person_id: null, changed_at: new Date().toISOString() } : null;
    }
    return readControlState(this.pool, KIND, TARGET);
  }

  async activateDurable(reason: string, actorPersonId?: string): Promise<void> {
    assertOwnerControlAuthorized(this.pool, this.authority, actorPersonId);
    if (this.pool) {
      await writeControlState(this.pool, KIND, TARGET, reason, actorPersonId);
    }
    this.activate(reason);
  }

  async deactivateDurable(actorPersonId?: string): Promise<void> {
    assertOwnerControlAuthorized(this.pool, this.authority, actorPersonId);
    if (this.pool) {
      await deleteControlState(this.pool, KIND, TARGET);
    }
    this.deactivate();
  }

  /**
   * Fail-CLOSED oppstartsgjenoppretting - MÅ kalles FØR instansen tas i
   * bruk av en NY prosess når et `pool` er gitt (samme disiplin som
   * `DomainPauseRegistry.restore()`). Speiler DB-tilstanden inn i den
   * synkrone in-memory-cachen (brukt av eksisterende synkrone kallesteder/
   * tester) - den AUTORITATIVE sjekken (`isActiveDurable()`) spør likevel
   * ALLTID DB direkte, denne metoden er kun for observability/den synkrone
   * speilingen, ikke selve sikkerhets-garantien.
   */
  async restore(): Promise<void> {
    if (!this.pool) return;
    const row = await readControlState(this.pool, KIND, TARGET);
    if (row) {
      this.activate(row.reason);
    } else {
      this.deactivate();
    }
  }
}
