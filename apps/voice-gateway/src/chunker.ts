/**
 * BO-12 §13: trygg setnings-/frasechunking av streamet modelltekst til TTS.
 * Mål: lav opplevd latens (TTS starter på første ferdige setning) uten å
 * sende halvferdige ord til talesyntese. Deterministisk, ingen nettverk.
 *
 * WP-V2 (K8, JARVIS-098): tekst-kanttilfeller.
 *  - HARD maks chunk-lengde (`hardMaxChars`, standard 4 000 - OpenAI TTS tar 4 096 tegn) også uten mellomrom/grense, kuttet på
 *    kodepunktgrense (aldri midt i et surrogatpar).
 *  - «klokka 14:30» og «18.30» kuttes ikke ved `:`/`.` (da mistet chunken `normalizeForNorwegianSpeech`, som gjør 14:30 -> 14.30), og
 *    «f.eks.», «bl.a.», «kl. 14» osv. kuttes ikke midt i. Et tegn på slutten av bufferen som KAN bli et tall/en forkortelse
 *    («14.» + «30», «f.» + «eks.») holdes til neste token er sett (maks ett token forsinkelse; `flush()` sender alltid alt).
 *  - Skanningen er INKREMENTELL (`scanPos`): hver tegnposisjon vurderes høyst én gang per chunk. Før skannet `findCut` hele bufferen fra
 *    `minChars` ved HVER `push` - kvadratisk tid på tekst uten grenser (200 KB uten punktum/mellomrom stoppet event-loopen).
 */
export interface ChunkerOptions {
  /** Minste antall tegn før en grense gir chunk (unngår "Ok." alene → hakkete tale). */
  minChars?: number;
  /** Maks tegn før vi chunker på siste ordgrense selv uten setningsslutt. */
  maxChars?: number;
  /** Absolutt øvre grense for en chunk (tegn), også uten ordgrense. Standard 4 000 (OpenAI TTS: 4 096). */
  hardMaxChars?: number;
}

export const DEFAULT_HARD_MAX_CHARS = 4_000;

/** Forkortelser (uten siste punktum, små bokstaver) som ALDRI avslutter en setning - et punktum etter dem er ikke en grense. */
const NON_TERMINAL_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "f.eks", "bl.a", "m.fl", "d.v.s", "t.o.m", "f.o.m", "t.d", "ca", "kl", "nr", "tlf", "mill", "mrd", "evt", "jf", "jfr", "pga", "mht",
  "inkl", "ekskl", "ifm", "vha", "hr", "fr", "dr", "prof", "st", "kap", "fig", "tab"
]);

/** Alle FORAN-segmenter av punkterte forkortelser («f» og «bl» i «f.eks»/«bl.a», «d» og «d.v» i «d.v.s»): et punktum etter dem på slutten av bufferen kan fortsette. */
const DOTTED_PREFIXES: ReadonlySet<string> = (() => {
  const prefixes = new Set<string>();
  for (const abbreviation of NON_TERMINAL_ABBREVIATIONS) {
    const parts = abbreviation.split(".");
    for (let n = 1; n < parts.length; n++) {
      prefixes.add(parts.slice(0, n).join("."));
    }
  }
  return prefixes;
})();

/**
 * FIX-8 (F8): månedsnavn (bokmål/nynorsk, små bokstaver). «den 1. mai» er et ORDINALTALL + måned (norsk skriver dagen som «1.»), ikke slutten på en
 * setning - før kuttet chunkeren etter «1.» og TTS leste «den første» som en egen setning med fall i tonen.
 */
const MONTH_NAMES: ReadonlySet<string> = new Set([
  "januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"
]);
/** Alle ikke-tomme forstavelser av månedsnavn («m», «ma», «mar», «mars», «mai»): et ord på slutten av bufferen som kan BLI en måned holdes til det er ferdig. */
const MONTH_PREFIXES: ReadonlySet<string> = (() => {
  const prefixes = new Set<string>();
  for (const month of MONTH_NAMES) {
    for (let n = 1; n <= month.length; n++) {
      prefixes.add(month.slice(0, n));
    }
  }
  return prefixes;
})();
/** Høyst så mange mellomrom mellom «1.» og månedsnavnet (en lengre rekke er aldri en dato - og holder skanningen lineær). */
const MAX_DATE_GAP = 3;

/** Maks antall tegn `looksLikeUrl` ser bakover (ett «ord» uten mellomrom). */
const MAX_URL_SCAN = 120;

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";
const isWhitespace = (ch: string | undefined): boolean => ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
const LETTER = /\p{L}/u;
const isLetter = (ch: string | undefined): boolean => ch !== undefined && LETTER.test(ch);

/** Maks antall tegn `tokenBefore` ser bakover (se metoden). */
const MAX_TOKEN_SCAN = 8;

type Verdict = "cut" | "skip" | "hold";

export class SentenceChunker {
  private buffer = "";
  /** Neste posisjon som ikke er vurdert ennå (inkrementell skanning). Nullstilles når en chunk kuttes. */
  private scanPos = 0;
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly hardMaxChars: number;

  constructor(
    private readonly emit: (chunk: string) => void,
    options: ChunkerOptions = {}
  ) {
    // 16 gir tidlig første chunk også for korte norske setninger ("Du har tre
    // møter i dag." = 23 tegn) - viktig for opplevd latens (§13).
    this.minChars = options.minChars ?? 16;
    this.maxChars = options.maxChars ?? 320;
    // Den harde grensen skal alltid ligge over den myke, ellers kunne den myke aldri slå inn.
    this.hardMaxChars = Math.max(options.hardMaxChars ?? DEFAULT_HARD_MAX_CHARS, this.maxChars + 1, 2);
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
      this.scanPos = 0;
      if (chunk.length > 0) {
        this.emit(chunk);
      }
    }
  }

  /** Slutt på generering: alt gjenværende sendes (aldri mistet tekst). */
  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    this.scanPos = 0;
    if (rest.length > 0) {
      this.emit(rest);
    }
  }

  /** Barge-in: gjenværende buffer forkastes - gammel tekst skal aldri leses opp (§16). */
  discard(): void {
    this.buffer = "";
    this.scanPos = 0;
  }

  private findCut(): number {
    const buffer = this.buffer;
    // Aldri skann forbi den harde grensen: en chunk kan ikke bli lengre enn den, så det som ligger bak vurderes først etter at vi har kuttet.
    const limit = Math.min(buffer.length, this.hardMaxChars);
    for (let i = Math.max(this.scanPos, this.minChars); i < limit; i++) {
      const ch = buffer[i] as string;
      if (ch !== "." && ch !== "!" && ch !== "?" && ch !== ":" && ch !== ";" && ch !== "\n") {
        continue;
      }
      const verdict = this.judge(buffer, i);
      if (verdict === "cut") {
        return i + 1;
      }
      if (verdict === "hold") {
        // Vent på neste token: posisjonen vurderes på nytt når mer tekst har kommet (aldri hoppet over).
        this.scanPos = i;
        return -1;
      }
    }
    this.scanPos = limit;
    // Overlang buffer uten grense: kutt på siste ordgrense (aldri midt i et ord).
    if (buffer.length >= this.maxChars) {
      const lastSpace = buffer.lastIndexOf(" ", this.maxChars);
      if (lastSpace > 0) {
        return lastSpace + 1;
      }
    }
    // WP-V2: ingen grense og ingen ordgrense: hard kutt ved `hardMaxChars`, på kodepunktgrense (aldri mellom et surrogatpar).
    if (buffer.length >= this.hardMaxChars) {
      let cut = this.hardMaxChars;
      const before = buffer.charCodeAt(cut - 1);
      if (before >= 0xd800 && before <= 0xdbff) {
        cut -= 1;
      }
      return cut;
    }
    return -1;
  }

  /** Avgjør om tegnet på `i` (et av `.!?:;\n`) er en chunk-grense. */
  private judge(buffer: string, i: number): Verdict {
    const ch = buffer[i] as string;
    const next = buffer[i + 1];
    const prev = i > 0 ? buffer[i - 1] : undefined;
    if (ch === "\n" || ch === "!" || ch === "?" || ch === ";") {
      return "cut";
    }
    if (ch === ":") {
      // «14:30», «1:2», «https://…»: kolon som ikke følges av mellomrom/linjeskift er aldri en grense.
      if (next === undefined) {
        // Siste tegn i bufferen: kan bli «14:» + «30» eller «https:» + «//…».
        const word = this.tokenBefore(buffer, i);
        return isDigit(prev) || word === "http" || word === "https" || this.looksLikeUrl(buffer, i) ? "hold" : "cut";
      }
      return isWhitespace(next) ? "cut" : "skip";
    }
    // ch === "."
    const token = this.tokenBefore(buffer, i);
    if (NON_TERMINAL_ABBREVIATIONS.has(token)) {
      return "skip"; // «f.eks.», «kl.», «ca.» ... (uansett hva som følger)
    }
    if (next === undefined) {
      // Siste tegn: «14.» + «30» (desimal/klokkeslett), «f.» + «eks.»/«bl.» + «a.» (forkortelse), eller midt i en adresse («https://nrk.» + «no») kan
      // fortsette - hold til neste token. Ellers er det en vanlig setningsslutt som skal ut UMIDDELBART (verktøykall kan følge, og stillhet er
      // verre enn ett token forsinkelse).
      return isDigit(prev) || DOTTED_PREFIXES.has(token) || (token.length === 1 && isLetter(token)) || this.looksLikeUrl(buffer, i) ? "hold" : "cut";
    }
    if (isWhitespace(next)) {
      // FIX-8: «den 1. mai» - et dagstall (1-31) + punktum + månedsnavn er IKKE en setningsslutt. Avgjøres av ordet etter (holdes til det er ferdig).
      if (isDigit(prev)) {
        const date = this.dateOrdinalVerdict(buffer, i);
        if (date !== null) {
          return date;
        }
      }
      return "cut"; // (også etter en adresse: «se https://x.no/side. Neste»)
    }
    if (isDigit(next) || isLetter(next)) {
      return "skip"; // 18.30, 3.5, f.eks, t.d, nrk.no - punktum rett foran tall/bokstav er ikke en setningsslutt
    }
    return "cut";
  }

  /**
   * FIX-8: `buffer[i]` er et punktum rett etter et siffer og foran mellomrom. `"skip"` = «dagstall. måned» (ikke en grense), `"hold"` = ordet etter er ikke
   * ferdig og kan bli et månedsnavn (vent på neste token), `null` = ikke en dato (vanlig setningsslutt). Alt er avgrenset (høyst 2 siffer, 3 mellomrom,
   * et ord som ikke lenger er en månedsforstavelse avgjør straks), så skanningen forblir lineær.
   */
  private dateOrdinalVerdict(buffer: string, i: number): Verdict | null {
    // Dagstallet: 1-2 siffer, og tegnet foran er ikke en bokstav («A1.» er en kode, «2024.» et år - ingen av dem er en dag). Skanner høyst 3 siffer.
    let start = i;
    while (start > 0 && isDigit(buffer[start - 1]) && i - start < 3) {
      start -= 1;
    }
    const digits = i - start;
    const before = start > 0 ? buffer[start - 1] : undefined;
    if (digits < 1 || digits > 2 || isLetter(before)) {
      return null;
    }
    const day = Number(buffer.slice(start, i));
    if (day < 1 || day > 31) {
      return null;
    }
    // Mellomrommet (kun mellomrom/tab - et linjeskift er en setningsslutt) og ordet etter.
    let j = i + 1;
    while (j < buffer.length && (buffer[j] === " " || buffer[j] === "\t") && j - i <= MAX_DATE_GAP) {
      j += 1;
    }
    if (j - i - 1 > MAX_DATE_GAP || (j < buffer.length && isWhitespace(buffer[j]))) {
      return null;
    }
    if (j >= buffer.length) {
      return "hold"; // kun mellomrom hittil: ordet er ikke sett
    }
    let k = j;
    while (k < buffer.length && isLetter(buffer[k])) {
      k += 1;
    }
    const word = buffer.slice(j, k).toLowerCase();
    if (k >= buffer.length) {
      return MONTH_PREFIXES.has(word) ? "hold" : null; // ordet kan fortsette: «ma» -> «mai»/«mars», men «de» (-> «deretter») avgjøres straks
    }
    return MONTH_NAMES.has(word) ? "skip" : null;
  }

  /** Er «ordet» (tegn uten mellomrom) som ender på `i` en adresse (`…://…`, `www.…`) eller en e-postadresse (`…@…`)? Skanner høyst `MAX_URL_SCAN` tegn bakover. */
  private looksLikeUrl(buffer: string, i: number): boolean {
    let start = i;
    while (start > 0 && i - start < MAX_URL_SCAN && !isWhitespace(buffer[start - 1])) {
      start -= 1;
    }
    const word = buffer.slice(start, i);
    return word.includes("://") || word.startsWith("www.") || word.includes("@");
  }

  /**
   * Ordet (bokstaver og punktum, små bokstaver) rett før posisjon `i`, f.eks. «f.eks» foran det siste punktumet i «f.eks.». Skanner
   * høyst `MAX_TOKEN_SCAN` tegn bakover (lengste forkortelse er 5 tegn): et lengre «ord» (a.a.a.a… uten ende) er aldri en forkortelse, og
   * en ubegrenset skanning ville gjort tekst med mange punktum kvadratisk. Et for langt ord gir en streng som ikke kan matche noe.
   */
  private tokenBefore(buffer: string, i: number): string {
    let start = i;
    while (start > 0 && i - start < MAX_TOKEN_SCAN) {
      const c = buffer[start - 1] as string;
      if (c === "." || isLetter(c)) {
        start -= 1;
      } else {
        return buffer.slice(start, i).toLowerCase();
      }
    }
    if (start > 0 && i - start >= MAX_TOKEN_SCAN) {
      const c = buffer[start - 1] as string;
      if (c === "." || isLetter(c)) {
        return `${"?".repeat(MAX_TOKEN_SCAN + 1)}`;
      }
    }
    return buffer.slice(start, i).toLowerCase();
  }
}
