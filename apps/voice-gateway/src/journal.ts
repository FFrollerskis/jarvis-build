import type { MemorySpaceAuthority } from "@jarvis/contracts";

/**
 * Utterance-journal: gjør turer idempotente ved failover/gjenopptak (masterplan v2.1 §14: «failover uten doble verktøyhandlinger»).
 *
 * WP-V2 (K5, JARVIS-079): journalen er nå
 *  - PROSESS-DELT (opprettes én gang - `main.ts`/`createVoiceGateway` - og deles av alle sesjoner; den var før per sesjon, så et
 *    `replay_final` på en ny tilkobling var usynlig for den forrige og ga et NYTT Core-kall),
 *  - nøklet på (autoritet, tenant, enhet, utterance_id) - en ubevist klient kan aldri forgifte nøkkelrommet til en bevist enhet,
 *  - ATOMISK: `claim()` skjer FØR Core-kallet, så to samtidige `replay_final` for samme id gir ÉTT Core-kall,
 *  - BEGRENSET: LRU-kapasitet + TTL (aldri ubegrenset vekst fra en klient som sender unike id-er).
 *
 * GRENSE (PARTIAL, dokumentert): journalen ligger i prosessminnet og overlever ikke en omstart, og deles ikke mellom to
 * gateway-prosesser. Varig deling krever en Core-rute og migrasjon (egen WP). Delvis dekning i mellomtiden: ToolGateway-ledgerens
 * idempotensnøkkel (`toolCallIdempotencyKey`, 10 minutters tidsvindu) i modules/model-gateway.
 */
export type ClaimResult = "claimed" | "in_flight" | "completed";

export interface JournalOptions {
  /** Maks antall nøkler (LRU). Standard 10 000 (ca. 1 MB). */
  maxEntries?: number;
  /** Hvor lenge en FULLFØRT utterance huskes (ms). Standard 1 time - mye lenger enn et failover-gjenopptak og ToolGateway-vinduet (10 min). */
  completedTtlMs?: number;
  /** Hvor lenge en PÅGÅENDE claim holdes (ms) før den regnes som død. Standard 10 min - over turfristen (120 s) med god margin. */
  claimedTtlMs?: number;
  now?: () => number;
}

interface Entry {
  state: "claimed" | "completed";
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_COMPLETED_TTL_MS = 60 * 60_000;
const DEFAULT_CLAIMED_TTL_MS = 10 * 60_000;
const PRUNE_INTERVAL_MS = 1_000;

export class UtteranceJournal {
  /** Map bevarer innsettingsrekkefølge = LRU-rekkefølge (eldste først); treff flyttes bakerst. */
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly completedTtlMs: number;
  private readonly claimedTtlMs: number;
  private readonly now: () => number;
  private lastPruneAt = Number.NEGATIVE_INFINITY;
  /** Antall nøkler som ble kastet pga. kapasitet (observerbart: en kastet nøkkel kan i prinsippet re-utføres). */
  evictedForCapacity = 0;

  constructor(options: JournalOptions = {}) {
    this.maxEntries = options.maxEntries !== undefined && options.maxEntries > 0 ? Math.floor(options.maxEntries) : DEFAULT_MAX_ENTRIES;
    this.completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
    this.claimedTtlMs = options.claimedTtlMs ?? DEFAULT_CLAIMED_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Atomisk (synkron, ingen `await` mellom sjekk og skriving): `claimed` = kalleren eier nå utførelsen og MÅ kalle `complete` eller
   * `release`; `in_flight`/`completed` = en annen tur eier/har utført den - kalleren skal IKKE kalle Core.
   */
  claim(key: string): ClaimResult {
    const t = this.now();
    this.prune(t);
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.expiresAt > t) {
      // LRU: et treff holder nøkkelen ferskere i kapasitetsrekkefølgen (utløpstiden er uendret).
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.state === "claimed" ? "in_flight" : "completed";
    }
    this.entries.delete(key);
    this.entries.set(key, { state: "claimed", expiresAt: t + this.claimedTtlMs });
    this.enforceCapacity();
    return "claimed";
  }

  /** Turen er utført (også avbrutt/feilet etter at forespørselen kan ha nådd Core): gjenopptak avvises videre. */
  complete(key: string): void {
    const t = this.now();
    this.entries.delete(key);
    this.entries.set(key, { state: "completed", expiresAt: t + this.completedTtlMs });
    this.enforceCapacity();
  }

  /** Forespørselen nådde BEVISELIG aldri Core: nøkkelen frigjøres så en senere replay kan kjøres. */
  release(key: string): void {
    const existing = this.entries.get(key);
    if (existing?.state === "claimed") {
      this.entries.delete(key);
    }
  }

  isCompleted(key: string): boolean {
    const existing = this.entries.get(key);
    return existing !== undefined && existing.state === "completed" && existing.expiresAt > this.now();
  }

  /** Bakoverkompatibel: marker som fullført uten forutgående claim. */
  markCompleted(key: string): void {
    this.complete(key);
  }

  private prune(t: number): void {
    if (t - this.lastPruneAt < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneAt = t;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= t) {
        this.entries.delete(key);
      }
    }
  }

  /** Over kapasitet: kast eldste FULLFØRTE nøkkel først (en pågående claim er vernet - den er det vi må ikke miste); finnes ingen, eldste. */
  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      let victim: string | undefined;
      for (const [key, entry] of this.entries) {
        if (entry.state === "completed") {
          victim = key;
          break;
        }
      }
      if (victim === undefined) {
        victim = this.entries.keys().next().value as string | undefined;
      }
      if (victim === undefined) {
        return;
      }
      this.entries.delete(victim);
      this.evictedForCapacity += 1;
    }
  }
}

/**
 * Journalnøkkel: (tillitsnivå, tenant, enhet, utterance_id), kodet entydig (JSON-array - ingen skilletegn som kan kollidere).
 * Tillitsnivået er med så en ubevist (`CLIENT_ASSERTED`) klient, som kan PÅSTÅ hvilken tenant/enhet den vil, aldri kan
 * forhåndsclaime id-ene til en bevist enhet.
 */
export function journalKey(
  authority: MemorySpaceAuthority,
  tenantId: string,
  deviceId: string,
  utteranceId: string
): string {
  return JSON.stringify([authority, tenantId, deviceId, utteranceId]);
}
