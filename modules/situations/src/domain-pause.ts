/**
 * UA-10 Proactive Situation Engine: domene-scoped pause - masterplanens eget
 * akseptansekriterium "Owner can pause a domain or entire Situation Engine
 * instantly". SAMME mønster som `KillSwitch` (modules/policy/src/kill-switch.ts,
 * SECURITY_MODEL §8): in-memory, deterministisk, INGEN LLM involvert, INGEN
 * databaserundtur - "instantly" betyr nettopp dette. `KillSwitch` selv er
 * GLOBAL-KUN (uansett capability-klasse) og BEVISST UENDRET her - denne
 * klassen legger til et FINERE, domene-navngitt lag OVENPÅ, brukt
 * UTELUKKENDE av `SituationEngine.actOn()` FØR et `ToolGateway.execute()`-
 * kall i det hele tatt vurderes (se der for hvordan de to kombineres).
 *
 * Domenenavn er BEVISST fri tekst (samme "ingen forhåndsregistrert liste"-
 * fleksibilitet som `situations.domain`-kolonnen, 056_situations.sql) - et
 * nytt domene (en fremtidig infra-/hjem-/helse-detektor) kan pause seg selv
 * uten noen kode-endring her. `"*"` er en reservert sentinel som betyr
 * "hele Situation Engine" (masterplanens "or entire Situation Engine").
 */
export const ALL_DOMAINS = "*";

export class DomainPauseRegistry {
  private readonly paused = new Map<string, string>();

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
}
