/**
 * WP-C4: felles tekstvask for ALT i Value Center som kan stamme fra en kilde utenfor koden (årsaker fra målekilder, oppfølgingstitler til push). Ingenting her tolker tekst som instruks - den gjør bare tekst
 * til én trygg, synlig linje: kontroll-, retnings- og usynlige formateringstegn (inkl. «tag»-tegn som brukes til å smugle skjult tekst) fjernes, mellomrom slås sammen, lengden begrenses i tegn (ikke bytes).
 */
function isInvisibleOrControl(cp: number): boolean {
  return (
    cp < 0x20 || // C0-kontroll (inkl. tab, linjeskift)
    (cp >= 0x7f && cp <= 0x9f) || // DEL + C1-kontroll
    (cp >= 0x200b && cp <= 0x200f) || // nullbredde + LTR/RTL-merker
    (cp >= 0x2028 && cp <= 0x202e) || // linje-/avsnittsskille + retnings-embedding/override
    (cp >= 0x2060 && cp <= 0x206f) || // word joiner, usynlige operatorer, retnings-isolater
    cp === 0xfeff || // BOM / nullbredde mellomrom
    (cp >= 0xfff9 && cp <= 0xfffb) || // interlinear-annotasjon
    (cp >= 0xe0000 && cp <= 0xe007f) || // tag-tegn (usynlig tekst)
    (cp >= 0xe0100 && cp <= 0xe01ef) // variasjonsvelgere (supplement)
  );
}

/** Erstatter kontroll-/usynlige tegn med mellomrom (tegnene kan ikke lenger skjule eller bryte opp tekst). */
export function stripInvisible(text: string): string {
  let out = "";
  for (const ch of text) out += isInvisibleOrControl(ch.codePointAt(0) ?? 0) ? " " : ch;
  return out;
}

/** Avkorter til høyst `max` tegn (kodepunkter), uten å dele et surrogatpar. */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Én linje, uten usynlige tegn, avkortet. Ikke-streng gir tom streng. */
export function flattenText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return truncateChars(stripInvisible(raw).replace(/\s+/g, " ").trim(), max);
}

/**
 * L1 (gjennomgang av PR #312): oppslag i en ordbok med en nøkkel som kan stamme fra en kilde utenfor koden (en løkketype fra databasen, en id fra en rapport). `table[key]` slår også opp i prototypekjeden:
 * `constructor`/`toString`/`__proto__` gir en FUNKSJON (som havnet i meldingen som «function Object() …» eller ga NaN i en sortering). Kun egne felt gjelder; alt annet er `undefined`.
 */
export function ownValue<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Ekstern årsak -> trygg, kort norsk linje. Tom/ugyldig gir «ukjent årsak» (aldri en tom forklaring). */
export function cleanReason(raw: unknown, max = 160): string {
  const flat = flattenText(raw, max);
  return flat.length === 0 ? "ukjent årsak" : flat;
}
