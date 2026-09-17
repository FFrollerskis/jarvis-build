import type pg from "pg";
import { withDomainAdvisoryLocks } from "./advisory-lock.ts";

/**
 * UA-10 Proactive Situation Engine: domene-scoped pause - masterplanens eget
 * akseptansekriterium "Owner can pause a domain or entire Situation Engine
 * instantly". SAMME mønster som `KillSwitch` (modules/policy/src/kill-switch.ts,
 * SECURITY_MODEL §8): in-memory, deterministisk, INGEN LLM involvert, INGEN
 * databaserundtur på selve sjekken - "instantly" betyr nettopp dette.
 * `KillSwitch` selv er GLOBAL-KUN (uansett capability-klasse) og BEVISST
 * UENDRET her - denne klassen legger til et FINERE, domene-navngitt lag
 * OVENPÅ, brukt UTELUKKENDE av `SituationEngine.actOn()` FØR et
 * `ToolGateway.execute()`-kall i det hele tatt vurderes (se der for hvordan
 * de to kombineres).
 *
 * Domenenavn er BEVISST fri tekst (samme "ingen forhåndsregistrert liste"-
 * fleksibilitet som `situations.domain`-kolonnen, 056_situations.sql) - et
 * nytt domene (en fremtidig infra-/hjem-/helse-detektor) kan pause seg selv
 * uten noen kode-endring her. `"*"` er en reservert sentinel som betyr
 * "hele Situation Engine" (masterplanens "or entire Situation Engine").
 *
 * Arkitekt-review-runde 1 (PR #85) Funn 6: den RENE in-memory-varianten
 * over (`pause`/`unpause`/`pauseAll`/`unpauseAll`/`isPaused`/`pauseReason`)
 * er PROSESS-LOKAL og OMSTART-FLYKTIG - SAMME allerede-aksepterte "fase
 * 1-skjelett"-begrensning som `KillSwitch`/`OwnerControls` (authority.ts)
 * har i DAG, IKKE en ny UA-10-spesifikk brist (uendret her: den synkrone
 * kjernen forblir den EKTE, uunngåelige "instantly"-fail-closed-sjekken
 * `actOn()` gjør uten noen DB-rundtur). `*Durable()`-metodene UNDER og
 * `restore()` legger til en VARIG (Postgres, `situation_domain_pauses`,
 * 056_situations.sql) skrive-gjennom + oppstarts-gjenopprettings-mekanisme
 * - en prosess-OMSTART GLEMMER IKKE lenger en aktiv pause (fail-CLOSED)
 * NÅR et `pool` er gitt ved konstruksjon og `restore()` kalles FØR
 * registeret tas i bruk. Dette dekker IKKE ekte SANNTIDS tvers-av-prosess-
 * konsistens (flere SAMTIDIG kjørende worker-prosesser ser hverandres
 * pause først ved NESTE `restore()`, ikke live) - eksplisitt flagget her,
 * ikke stilltiende utelatt; presis samme, fortsatt-uløste grense som
 * `KillSwitch`/`OwnerControls` selv har i dag (en fremtidig delt fix for
 * alle tre er naturlig, IKKE en isolert engangsløsning kun for denne
 * klassen). INGEN tenant-scoping/RLS på `situation_domain_pauses` med
 * vilje - en pause er en EIER-/SOVEREIGN-handling, samme globale
 * (ikke tenant-partisjonerte) omfang som `KillSwitch` selv alltid har hatt.
 *
 * Arkitekt-review-runde 2 (PR #85) Funn 5: runde 1 sin durable-variant løste
 * OMSTART-overlevelse, men IKKE (a) autorisasjon av selve MUTASJONEN
 * (`pauseDurable()`/`unpauseDurable()` skrev tidligere et UBEKREFTET
 * `actorPersonId` uten noen sjekk i det hele tatt) eller (b) at
 * `SituationEngine.actOn()` fortsatt KUN konsulterte den synkrone,
 * prosess-lokale `isPaused()`-cachen for selve sikkerhets-gaten (stille
 * u-initialisert hvis `restore()` aldri kalles eller feiler = fail-OPEN).
 * (b) er rettet i `SituationEngine.actOn()` selv: den EKTE, AUTORITATIVE
 * gaten er nå et TRANSAKSJONELT, direkte spørring mot
 * `situation_domain_pauses` RETT FØR selve claimen (se service.ts) - denne
 * klassens synkrone `isPaused()` er nå KUN en billig, valgfri "fail
 * fast"-optimalisering, ALDRI den eneste sjekken. (a) er rettet her:
 * `*Durable()`-mutasjoner krever nå et `authority` konfigurert ved
 * konstruksjon PLUSS en `actorPersonId` som FAKTISK matcher NÅR et `pool`
 * er gitt (den rene in-memory-varianten uten `pool`, brukt av eksisterende
 * enhetstester, er UENDRET og krever ingen autorisasjon - persistens er
 * det som gjør en mutasjon reelt sikkerhetsrelevant på tvers av prosesser).
 * `situation_domain_pauses` sin brede `GRANT ... TO jarvis_app` er BEVISST
 * UENDRET - samme repo-brede mønster som `tool_executions`/`audit_events`/
 * ENHVER annen tabell i dette repoet: autorisasjon håndheves i
 * APPLIKASJONSKODEN (her, `assertAuthorized()` - samme mønster som
 * `PolicyGateway.authorize()` for alt annet), ALDRI via smale per-tabell
 * DB-grants - en egen, separat DB-rolle KUN for denne ene tabellen ville
 * vært et NYTT, inkonsistent arkitekturmønster resten av repoet ikke bruker
 * noe sted, ikke en lukking av et unikt gap for akkurat denne tabellen.
 */
export const ALL_DOMAINS = "*";

/** Sovereign eier-autoritet for `*Durable()`-mutasjoner (Funn 5) - SAMME minimale form som `PolicyGateway` sin egen `authority: { owner_person_id, owner_tenants }`, men uten tenant-scoping (en pause er global, se filhode). */
export interface DomainPauseAuthority {
  owner_person_id: string;
}

/** Kastet av en `*Durable()`-mutasjon (Funn 5) NÅR et `pool` er gitt, men `actorPersonId` mangler, ikke matcher det konfigurerte `authority`, eller `authority` selv ikke er konfigurert - fail-CLOSED, INGEN skriving skjer. */
export class DomainPauseUnauthorizedError extends Error {
  constructor(public readonly actorPersonId: string | undefined) {
    super(`domain_pause_unauthorized:${actorPersonId ?? "none"}`);
    this.name = "DomainPauseUnauthorizedError";
  }
}

export class DomainPauseRegistry {
  private readonly paused = new Map<string, string>();

  constructor(
    private readonly pool?: pg.Pool,
    private readonly authority?: DomainPauseAuthority
  ) {}

  /** Fail-CLOSED: krever et konfigurert `authority` OG en matchende `actorPersonId` NÅR persistens er aktiv (`pool` gitt) - se filhode Funn 5. Ren in-memory-bruk (ingen `pool`) er UENDRET, ingen autorisasjon her. */
  private assertAuthorized(actorPersonId: string | undefined): void {
    if (!this.pool) return;
    if (!actorPersonId || !this.authority || actorPersonId !== this.authority.owner_person_id) {
      throw new DomainPauseUnauthorizedError(actorPersonId);
    }
  }

  pause(domain: string, reason: string): void {
    this.paused.set(domain, reason);
  }

  unpause(domain: string): void {
    this.paused.delete(domain);
  }

  /** Alt-domene-pause (`ALL_DOMAINS`) vinner ALLTID over en enkelt-domene-tilstand - se `isPaused()`. */
  pauseAll(reason: string): void {
    this.pause(ALL_DOMAINS, reason);
  }

  unpauseAll(): void {
    this.unpause(ALL_DOMAINS);
  }

  /** `true` hvis ENTEN hele motoren ER pauset ELLER akkurat DETTE domenet er pauset. */
  isPaused(domain: string): boolean {
    return this.paused.has(ALL_DOMAINS) || this.paused.has(domain);
  }

  /** Den mest presise grunnen for HVORFOR `domain` er pauset akkurat nå (alt-domene-grunnen foretrekkes hvis begge er satt - den er den bredere, mer relevante forklaringen). */
  pauseReason(domain: string): string | undefined {
    return this.paused.get(ALL_DOMAINS) ?? this.paused.get(domain);
  }

  /** Kun for observability/tester - IKKE en autoritativ policy-kilde i seg selv. */
  pausedDomains(): string[] {
    return [...this.paused.keys()];
  }

  // ---------------------------------------------------------------------
  // Durable-variant (Funn 6, se filhode) - skrive-gjennom til
  // `situation_domain_pauses` NÅR et `pool` ble gitt ved konstruksjon,
  // ellers ren in-memory (identisk med metodene over).
  // ---------------------------------------------------------------------

  /**
   * Funn 1 (arkitekt-review runde 3, PR #85): skriver INNENFOR SAMME
   * advisory-lås som `SituationEngine.actOn()` holder for HELE sin kritiske
   * seksjon (se advisory-lock.ts sitt filhode) - en `pauseDurable()` for
   * domenet en `actOn()` FAKTISK er i flukt for MÅ derfor vente til DEN
   * er helt ferdig (uansett utfall), og et NYTT `actOn()`-forsøk startet
   * ETTER at denne skrivingen har committet SER pausen GARANTERT.
   */
  async pauseDurable(domain: string, reason: string, actorPersonId?: string): Promise<void> {
    this.assertAuthorized(actorPersonId);
    if (this.pool) {
      const pool = this.pool;
      await withDomainAdvisoryLocks(pool, [domain], () =>
        pool.query(
          `INSERT INTO situation_domain_pauses (domain, reason, paused_by, paused_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (domain) DO UPDATE SET reason = EXCLUDED.reason, paused_by = EXCLUDED.paused_by, paused_at = now()`,
          [domain, reason, actorPersonId ?? null]
        )
      );
    }
    this.pause(domain, reason);
  }

  /** Samme advisory-lås-disiplin som `pauseDurable()` (Funn 1, runde 3) - se der. */
  async unpauseDurable(domain: string, actorPersonId?: string): Promise<void> {
    this.assertAuthorized(actorPersonId);
    if (this.pool) {
      const pool = this.pool;
      await withDomainAdvisoryLocks(pool, [domain], () => pool.query(`DELETE FROM situation_domain_pauses WHERE domain = $1`, [domain]));
    }
    this.unpause(domain);
  }

  async pauseAllDurable(reason: string, actorPersonId?: string): Promise<void> {
    return this.pauseDurable(ALL_DOMAINS, reason, actorPersonId);
  }

  async unpauseAllDurable(actorPersonId?: string): Promise<void> {
    return this.unpauseDurable(ALL_DOMAINS, actorPersonId);
  }

  /**
   * Fail-CLOSED oppstartsgjenoppretting (Funn 6): MÅ kalles FØR registeret
   * tas i bruk av en NY prosess/instans når et `pool` er gitt til
   * konstruktøren - ellers ville en omstart stille GLEMT en aktiv pause
   * (fail-OPEN). Et `undefined` pool gjør dette en ren no-op (samme
   * "in-memory only, ingen persistens forventet"-oppførsel som før Funn 6).
   */
  async restore(): Promise<void> {
    if (!this.pool) return;
    const { rows } = await this.pool.query<{ domain: string; reason: string }>(`SELECT domain, reason FROM situation_domain_pauses`);
    this.paused.clear();
    for (const row of rows) {
      this.paused.set(row.domain, row.reason);
    }
  }
}
