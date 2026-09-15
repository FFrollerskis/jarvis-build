import type pg from "pg";

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
 */
export const ALL_DOMAINS = "*";

export class DomainPauseRegistry {
  private readonly paused = new Map<string, string>();

  constructor(private readonly pool?: pg.Pool) {}

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

  async pauseDurable(domain: string, reason: string, actorPersonId?: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO situation_domain_pauses (domain, reason, paused_by, paused_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (domain) DO UPDATE SET reason = EXCLUDED.reason, paused_by = EXCLUDED.paused_by, paused_at = now()`,
        [domain, reason, actorPersonId ?? null]
      );
    }
    this.pause(domain, reason);
  }

  async unpauseDurable(domain: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(`DELETE FROM situation_domain_pauses WHERE domain = $1`, [domain]);
    }
    this.unpause(domain);
  }

  async pauseAllDurable(reason: string, actorPersonId?: string): Promise<void> {
    return this.pauseDurable(ALL_DOMAINS, reason, actorPersonId);
  }

  async unpauseAllDurable(): Promise<void> {
    return this.unpauseDurable(ALL_DOMAINS);
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
