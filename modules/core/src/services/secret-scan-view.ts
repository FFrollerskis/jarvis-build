/**
 * WP-SEC2 (JARVIS-013/069, K1/K2/K6): DETEKSJONSVISNING for hemmelighetsskanneren.
 *
 * `scanForSecrets` leter ikke i den rå teksten, men i en normalisert VISNING av den, og bruker treffene på ORIGINALTEKSTEN via et indekskart. Slik slipper ikke en hemmelighet unna fordi noen har lagt inn
 * usynlige tegn (nullbredde, myk bindestrek, bidi-overstyring, tag-tegn, kontrolltegn, kombinerende merker), skrevet den med fullbredde-/kompatibilitetstegn (`ｇｈｐ＿…`, `ﬁ`) eller byttet en bokstav med en
 * kjent homoglyf (liten, eksplisitt tabell under). Visningen er KUN til deteksjon: teksten som lagres er alltid originalen (med treffene byttet ut), så tekst UTEN funn er BYTE-IDENTISK uendret.
 *
 * Visningen bygges per KODEPUNKT (NFKC per kodepunkt, ikke per streng): da er indekskartet entydig (hvert visningstegn vet hvilket kodepunkt i originalen det kom fra), og kombinerende merker kan fjernes uten å
 * måtte komponeres. Alt er LINEÆRT og BEGRENSET: ingen kvadratisk oppførsel i lengden, og én skanning leser høyst `SCAN_WINDOW_CHARS` tegn om gangen (se `windowStarts`).
 *
 * KLEMT visning (`squeezeView`): visningen med mellomrom/linjeskift fjernet der begge naboene er token-tegn. Brukes kun av de prefiks-forankrede reglene (K2a) - se `secret-scan.ts`.
 *
 * Homoglyf-tabellen er HÅNDVALGT (kyrilliske/greske tegn som ser ut som latinske bokstaver) og IKKE hentet fra Unicode TR39 `confusables.txt` (leverandørdokument, ikke lest i denne økten): `unverified`.
 * Full TR39-dekning er DEFERRED (se docs/runbooks/WPSEC2_SECRET_SCAN.md).
 */

/** Dokumentert maksgrense per vindu (UTF-16-enheter). Større inndata skannes i overlappende vinduer (K6). */
export const SCAN_WINDOW_CHARS = 262_144;
/** Overlapp mellom to vinduer (minst 8 KiB, K6): enhver hemmelighet på høyst så mange tegn ligger helt inne i minst ett vindu. */
export const SCAN_OVERLAP_CHARS = 16_384;

export interface ScanView {
  /** Normalisert tekst som mønstrene kjøres mot. */
  readonly text: string;
  /** Visningsindeks -> indeks i originalen for kodepunktet tegnet kom fra. `null` = identitet (visningen er originalen fra `base`). */
  readonly map: Uint32Array | null;
  readonly base: number;
  readonly source: string;
}

/** Original-indeks (UTF-16) for starten av kodepunktet visningstegn `i` kom fra. */
export function origStart(view: ScanView, i: number): number {
  return view.map === null ? view.base + i : (view.map[i] as number);
}

/** Original-indeks (eksklusiv) for slutten av kodepunktet visningstegn `i` kom fra. */
export function origEnd(view: ScanView, i: number): number {
  const start = origStart(view, i);
  const cp = view.source.codePointAt(start);
  return start + (cp !== undefined && cp > 0xffff ? 2 : 1);
}

// Alt som IKKE er synlig ASCII (+ \n \t \r) må gjennom normalisering. Ren ASCII-tekst er sin egen visning (rask vei).
const NEEDS_VIEW = /[^\x20-\x7e\n\t\r]/;
// Tegn som ikke har noe i en visning å gjøre: format (Cf: nullbredde, bidi, myk bindestrek, tag-tegn), kontroll (Cc), kombinerende merker (Mn/Me: også variantvelgere og CGJ), løse surrogater (Cs), privat bruk (Co),
// «default ignorable» (Hangul-fyllere osv.), brailleblankt og U+FFFC (objekt-erstatningstegn, kategori So: usynlig plassholder som ellers bryter et token).
const DROPPED = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Mn}\p{Me}\p{Cs}\p{Co}\u2800\uFFFC]/u;

/** Håndvalgte homoglyfer (kyrillisk/gresk/latinsk utvidelse -> ASCII). `unverified`: ikke fra TR39. */
const HOMOGLYPHS: ReadonlyMap<number, string> = new Map<number, string>([
  // kyrillisk, små
  [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"], [0x0445, "x"], [0x0443, "y"], [0x0456, "i"], [0x0458, "j"], [0x0455, "s"], [0x0501, "d"], [0x04bb, "h"], [0x043a, "k"], [0x051b, "q"], [0x051d, "w"],
  // kyrillisk, store
  [0x0410, "A"], [0x0412, "B"], [0x0415, "E"], [0x041a, "K"], [0x041c, "M"], [0x041d, "H"], [0x041e, "O"], [0x0420, "P"], [0x0421, "C"], [0x0422, "T"], [0x0425, "X"], [0x0406, "I"], [0x0408, "J"], [0x0405, "S"],
  // gresk
  [0x03bf, "o"], [0x03bd, "v"], [0x03c1, "p"], [0x0391, "A"], [0x0392, "B"], [0x0395, "E"], [0x0396, "Z"], [0x0397, "H"], [0x0399, "I"], [0x039a, "K"], [0x039c, "M"], [0x039d, "N"], [0x039f, "O"], [0x03a1, "P"], [0x03a4, "T"],
  [0x03a5, "Y"], [0x03a7, "X"],
  // latinsk utvidelse
  [0x0261, "g"], [0x0131, "i"]
]);

/** Tankestreker/minus som NFKC ikke gjør om til «-» (men som ser slik ut og brukes i `sk-…`/`github_pat`-lignende prefikser). */
const isDashLike = (cp: number): boolean => (cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212 || cp === 0x2043 || cp === 0xfe58;

const foldCache = new Map<number, string>();
const FOLD_CACHE_MAX = 8192;

/** Visningsform av ett kodepunkt >= 0x80 (tom streng = utelates). */
function foldCodePoint(cp: number): string {
  const cached = foldCache.get(cp);
  if (cached !== undefined) return cached;
  let out: string;
  if (cp === 0x85) out = "\n"; // NEL er linjeskift (er Cc, men er blanke)
  else {
    const ch = String.fromCodePoint(cp);
    if (DROPPED.test(ch)) out = "";
    else {
      out = "";
      for (const piece of ch.normalize("NFKC")) {
        const pcp = piece.codePointAt(0) as number;
        if (pcp < 0x80) out += piece;
        else if (DROPPED.test(piece)) continue;
        else if (isDashLike(pcp)) out += "-";
        else out += HOMOGLYPHS.get(pcp) ?? piece;
      }
    }
  }
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
  foldCache.set(cp, out);
  return out;
}

/** Bygger visningen av `source[start, end)`. Ren ASCII gir identitet (ingen kart, ingen kopi utover substringen). */
export function buildView(source: string, start: number, end: number): ScanView {
  const slice = source.slice(start, end);
  if (!NEEDS_VIEW.test(slice)) return { text: slice, map: null, base: start, source };
  let units = new Uint16Array(slice.length + 16);
  let map = new Uint32Array(slice.length + 16);
  let n = 0;
  const push = (unit: number, orig: number): void => {
    if (n === units.length) {
      const grownUnits = new Uint16Array(units.length * 2);
      grownUnits.set(units);
      units = grownUnits;
      const grownMap = new Uint32Array(map.length * 2);
      grownMap.set(map);
      map = grownMap;
    }
    units[n] = unit;
    map[n] = orig;
    n += 1;
  };
  for (let i = 0; i < slice.length; ) {
    const c = slice.charCodeAt(i);
    if (c < 0x80) {
      if (c >= 0x20 && c !== 0x7f) push(c, start + i);
      else if (c === 0x09 || c === 0x0a || c === 0x0d) push(c, start + i);
      else if (c === 0x0b || c === 0x0c) push(0x20, start + i); // \v og \f er blanke
      i += 1;
      continue;
    }
    const cp = slice.codePointAt(i) as number;
    const folded = foldCodePoint(cp);
    for (let k = 0; k < folded.length; k += 1) push(folded.charCodeAt(k), start + i);
    i += cp > 0xffff ? 2 : 1;
  }
  return { text: unitsToString(units, n), map: map.subarray(0, n), base: start, source };
}

function unitsToString(units: Uint16Array, n: number): string {
  const CHUNK = 8192;
  if (n <= CHUNK) return String.fromCharCode.apply(null, units.subarray(0, n) as unknown as number[]);
  const parts: string[] = [];
  for (let i = 0; i < n; i += CHUNK) parts.push(String.fromCharCode.apply(null, units.subarray(i, Math.min(n, i + CHUNK)) as unknown as number[]));
  return parts.join("");
}

/** Token-tegn: det en hemmelighets kropp og prefiks består av (inkl. base64 og punktum i JWT). Mellomrom mellom to slike tegn er det «klemt» visning fjerner. */
export function isTokenChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d || c === 0x2e || c === 0x2b || c === 0x2f || c === 0x3d;
}

/** Ordtegn slik `\b` ser det (ASCII). */
export function isWordChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

const isDigitCode = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isSpaceCode = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

export interface Squeezed {
  /** Visningen uten blanke mellom to token-tegn. */
  readonly text: string;
  /** Klemt indeks -> indeks i visningen. */
  readonly map: Uint32Array;
  /** 1 = en fjernet blank-rekke ligger rett FØR dette tegnet (mellom det og forrige tegn). */
  readonly gap: Uint8Array;
}

// Rask forhåndssjekk: finnes det i det hele tatt en blank-rekke mellom to token-tegn? (ellers er klemt visning lik visningen og hoppes over)
const HAS_SQUEEZABLE = /[A-Za-z0-9_\-.+/=][ \t\r\n\v\f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+[A-Za-z0-9_\-.+/=]/;

/** Klemt visning av en visning, eller `null` når det ikke finnes noe å klemme. LINEÆR. */
export function squeezeView(view: ScanView): Squeezed | null {
  const text = view.text;
  if (!HAS_SQUEEZABLE.test(text)) return null;
  const n = text.length;
  const units = new Uint16Array(n);
  const map = new Uint32Array(n);
  const gap = new Uint8Array(n);
  let m = 0;
  let pendingGap = 0;
  for (let i = 0; i < n; ) {
    const c = text.charCodeAt(i);
    if (isSpaceCode(c)) {
      let j = i + 1;
      while (j < n && isSpaceCode(text.charCodeAt(j))) j += 1;
      // «<siffer>:» (Telegram-token) regnes også som token-slutt, så en bryting rett etter kolonet slås sammen (fiks-runde 1, A-L5).
      const prevIsToken = m > 0 && (isTokenChar(units[m - 1] as number) || (units[m - 1] === 0x3a && m > 1 && isDigitCode(units[m - 2] as number)));
      const nextIsToken = j < n && isTokenChar(text.charCodeAt(j));
      if (prevIsToken && nextIsToken) {
        pendingGap = 1;
      } else {
        for (let k = i; k < j; k += 1) {
          units[m] = text.charCodeAt(k);
          map[m] = k;
          gap[m] = 0;
          m += 1;
        }
        pendingGap = 0;
      }
      i = j;
      continue;
    }
    units[m] = c;
    map[m] = i;
    gap[m] = pendingGap;
    pendingGap = 0;
    m += 1;
    i += 1;
  }
  return { text: unitsToString(units, m), map: map.subarray(0, m), gap: gap.subarray(0, m) };
}

/**
 * Startindekser for vinduene over en tekst av lengde `length`. Ett vindu hvis teksten går i ett; ellers `SCAN_WINDOW_CHARS` brede vinduer der hvert nytt vindu starter `SCAN_OVERLAP_CHARS` før forrige vindus slutt. Starten flyttes
 * (bakover, aldri forover, så overlappet bare blir større) til en ordgrense og aldri midt i et surrogatpar - da får ikke et `\b` i vindusstarten et falskt treff midt i et ord. Siste vindu når alltid enden av teksten.
 */
export function windowStarts(source: string, length: number): number[] {
  const starts = [0];
  let end = Math.min(length, SCAN_WINDOW_CHARS);
  while (end < length) {
    let start = end - SCAN_OVERLAP_CHARS;
    for (let back = 0; back < 64 && start > 0; back += 1) {
      const prev = source.charCodeAt(start - 1);
      const cur = source.charCodeAt(start);
      const insidePair = prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff;
      if (!insidePair && !isWordChar(prev)) break;
      start -= 1;
    }
    starts.push(start);
    end = Math.min(length, start + SCAN_WINDOW_CHARS);
  }
  return starts;
}
