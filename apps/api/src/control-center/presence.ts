// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)

/**
 * Gjennomgang av PR #316 (M-1 + L-3): lesing av credential-PRESENCE for kontrollsentrene, som TRI-STATE og med kontrollert last.
 *
 * Kilden (`ToolGateway.secretPresence`) gir `true` (finnes), `false` (kilden SVARTE og har den ikke - en måling) eller `null` (kunne ikke spørres - ukjent, aldri «mangler»). Før denne leseren gjorde én Integration-bygging
 * ~87 oppslag mot Infisical, en oppdatering bygget to ganger (~174), og uten token ga hvert oppslag sin egen innlogging (opptil 87 parallelle). Nå:
 *  - CACHE: et definitivt svar (`true`/`false`) gjenbrukes i `PRESENCE_TTL_MS` (30 s) per ref. UKJENT caches aldri (en kilde som er tilbake skal måles på neste bygging), men se utfall under.
 *  - SINGLE-FLIGHT per ref: samtidige spørsmål om samme ref deler ett oppslag.
 *  - SAMTIDIGHET: maks `PRESENCE_CONCURRENCY` (8) oppslag om gangen mot kilden.
 *  - UTFALL: svarer kilden ikke (ukjent og `secretsHealth() === "unavailable"`), spares resten av refene for oppslag i `PRESENCE_OUTAGE_BACKOFF_MS` (10 s) og står som ukjent - ellers ville hver ref vente ut sitt eget
 *    tidsavbrudd (5 s) mot en kilde som er nede, og senteret ville gått ut på tid uten å si noe.
 * Kun mengden av refer (navn) og sannhetsverdier passerer her - aldri secret-verdier.
 */
export const PRESENCE_TTL_MS = 30_000;
export const PRESENCE_CONCURRENCY = 8;
export const PRESENCE_OUTAGE_BACKOFF_MS = 10_000;

export interface PresenceSource {
  /** `true` finnes, `false` kilden svarte og har den ikke, `null` kunne ikke spørres. Skal ikke kaste (en som kaster regnes som ukjent). */
  secretPresence(ref: string): Promise<boolean | null>;
  /** Kildens helse etter siste oppslag. Utelatt = ukjent helse (utfallsvernet slås da aldri på). */
  secretsHealth?(): "healthy" | "unavailable" | "unconfigured";
}

export class PresenceReader {
  private readonly cache = new Map<string, { value: boolean; at: number }>();
  private readonly inflight = new Map<string, Promise<boolean | null>>();
  private downUntil = Number.NEGATIVE_INFINITY;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly source: PresenceSource) {}

  /** Presence for alle refene (unike), med tidspunktet bygget regner med (`nowMs`: registerets klokke, så tester er deterministiske). Kaster aldri. */
  async readAll(refs: readonly string[], nowMs: number): Promise<Map<string, boolean | null>> {
    const unique = [...new Set(refs)];
    const entries = await Promise.all(unique.map(async (ref) => [ref, await this.readOne(ref, nowMs)] as const));
    return new Map(entries);
  }

  private readOne(ref: string, nowMs: number): Promise<boolean | null> {
    const cached = this.cache.get(ref);
    // negativ alder (klokken gikk bakover) regnes ikke som fersk
    if (cached !== undefined && nowMs - cached.at >= 0 && nowMs - cached.at < PRESENCE_TTL_MS) return Promise.resolve(cached.value);
    const pending = this.inflight.get(ref);
    if (pending !== undefined) return pending;
    const attempt: Promise<boolean | null> = this.fetchOne(ref, nowMs);
    this.inflight.set(ref, attempt);
    const clear = (): void => { if (this.inflight.get(ref) === attempt) this.inflight.delete(ref); };
    attempt.then(clear, clear);
    return attempt;
  }

  private async fetchOne(ref: string, nowMs: number): Promise<boolean | null> {
    await this.acquire();
    try {
      // Kilden ble funnet nede mens denne refen sto i kø: ikke bank på den en gang til.
      if (nowMs < this.downUntil) return null;
      let value: boolean | null;
      try {
        value = await this.source.secretPresence(ref);
      } catch {
        value = null;
      }
      // Kun ekte sannhetsverdier er definitive svar. Alt annet (null, en streng fra en feilkoblet kilde, undefined) er ukjent - en verdi passerer aldri herfra.
      if (value !== true && value !== false) {
        if (this.healthOf() === "unavailable") this.downUntil = nowMs + PRESENCE_OUTAGE_BACKOFF_MS;
        return null;
      }
      this.cache.set(ref, { value, at: nowMs });
      return value;
    } finally {
      this.release();
    }
  }

  /** Kildens helse, eller `undefined` når den ikke kan leses (en helse-avlesning som kaster slår aldri utfallsvernet på og velter aldri leseren). */
  private healthOf(): ReturnType<NonNullable<PresenceSource["secretsHealth"]>> | undefined {
    try {
      return this.source.secretsHealth?.();
    } catch {
      return undefined;
    }
  }

  /** Samtidighetsgrense: en ledig plass tas direkte; ellers ventes det, og plassen overleveres uendret når en annen er ferdig (aldri flere enn grensen i gang). */
  private async acquire(): Promise<void> {
    if (this.active < PRESENCE_CONCURRENCY) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => { this.waiting.push(resolve); });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) next();
    else this.active -= 1;
  }
}
