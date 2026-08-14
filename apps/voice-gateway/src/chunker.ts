/**
 * BO-12 §13: trygg setnings-/frasechunking av streamet modelltekst til TTS.
 * Mål: lav opplevd latens (TTS starter på første ferdige setning) uten å
 * sende halvferdige ord til talesyntese. Deterministisk, ingen nettverk.
 */
export interface ChunkerOptions {
  /** Minste antall tegn før en grense gir chunk (unngår "Ok." alene → hakkete tale). */
  minChars?: number;
  /** Maks tegn før vi chunker på siste ordgrense selv uten setningsslutt. */
  maxChars?: number;
}

const BOUNDARY = /[.!?:;\n]/;

export class SentenceChunker {
  private buffer = "";
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(
    private readonly emit: (chunk: string) => void,
    options: ChunkerOptions = {}
  ) {
    // 16 gir tidlig første chunk også for korte norske setninger ("Du har tre
    // møter i dag." = 23 tegn) - viktig for opplevd latens (§13).
    this.minChars = options.minChars ?? 16;
    this.maxChars = options.maxChars ?? 320;
  }

  push(delta: string): void {
    this.buffer += delta;
    for (;;) {
      const cut = this.findCut();
      if (cut === -1) {
        return;
      }
      const chunk = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (chunk.length > 0) {
        this.emit(chunk);
      }
    }
  }

  /** Slutt på generering: alt gjenværende sendes (aldri mistet tekst). */
  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length > 0) {
      this.emit(rest);
    }
  }

  /** Barge-in: gjenværende buffer forkastes - gammel tekst skal aldri leses opp (§16). */
  discard(): void {
    this.buffer = "";
  }

  private findCut(): number {
    // Setningsgrense etter minChars: kutt ETTER tegnet (inkluder punktum i chunken).
    for (let i = this.minChars; i < this.buffer.length; i++) {
      const ch = this.buffer[i] as string;
      if (BOUNDARY.test(ch)) {
        // Ikke kutt midt i tall som "18.30" eller forkortelser fulgt av tegn uten mellomrom:
        const next = this.buffer[i + 1];
        if (ch === "." && next !== undefined && /\d/.test(next)) {
          continue;
        }
        return i + 1;
      }
    }
    // Overlang buffer uten grense: kutt på siste ordgrense (aldri midt i et ord).
    if (this.buffer.length >= this.maxChars) {
      const lastSpace = this.buffer.lastIndexOf(" ", this.maxChars);
      if (lastSpace > 0) {
        return lastSpace + 1;
      }
    }
    return -1;
  }
}
