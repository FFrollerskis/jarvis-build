import { scanForSecrets } from "./secret-scan.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M4): ÉN renser for tekst som en MODELL har skrevet og som vises til eieren (AI-rådets forventede effekt og risikosammendrag - i bekreftelseskortet og i chat-svaret), og for
 * parameterverdier som vises på samme sted. Før dette fjernet rensingen bare ASCII-kontrolltegn: U+202E (bidi-overstyring), U+2066-2069 (isolater), U+200B (nullbredde), tag-tegn, markdown
 * (`[trykk her](https://evil…)`, `![x](http://evil/p.png)`) og rå HTML (`<img onerror=…>`) kom rett gjennom og ble vist i en tekst eieren leser rett før han godkjenner en handling.
 *
 * To nivåer, begge rene funksjoner uten I/O:
 *  - `sanitizeDisplayText`: STRENG, for modellens egen prosa. Resultatet er ren tekst: NFKC-normalisert (fullbredde-/ligatur-/kompatibilitetstegn faller til vanlig form), alle usynlige tegn og kontrolltegn borte (`\p{C}`: Cc, Cf inkl.
 *    bidi/nullbredde/tag-tegn, Cs, Co, Cn; linje-/avsnittsskilletegn og alle mellomrom blir ett vanlig mellomrom), lenker (`skjema://…`, `www.…`) fjernet, markdown-/HTML-tegn (`[]()<>` ` * _ # ! | \`) og HTML-entiteter
 *    nøytralisert, lange rekker av kombinerende tegn (zalgo) kappet til to, hemmeligheter redigert bort, og kappet på KODEPUNKTGRENSE (aldri midt i et surrogatpar, som Postgres jsonb ville avvist).
 *  - `sanitizeParameterValue`: for en parameterverdi som er DEL AV selve handlingen (mottaker, mål, tittel). Beholder verdien lesbar (lenker, `_`, `#`) og fjerner bare det som kan bli en lenke, et bilde eller et HTML-element
 *    (`[]()<>` og backtick). Skjulte tegn skal aldri nå hit - porten avviser slike parametere (`containsHiddenCharacters`) i stedet for å vise dem «renset», for da ville eieren godkjenne noe annet enn det som utføres.
 *
 * Begge er IDEMPOTENTE (rådet renser teksten, og porten renser den en gang til - de må gi samme tekst): trinnene gjentas til teksten er stabil, og hemmelighetsskanningen kjører på den ferdig rensede teksten (å fjerne et
 * tegn kan lage en ny hemmelighetslignende sekvens av resten). Låst av `modules/core/test/wpd4-display-text.test.ts` (inkl. fuzz).
 */

/** Hvor mye av en (ubetrodd, potensielt enorm) streng som i det hele tatt leses: `max × faktor`. Holder normalisering og regex-arbeid begrenset uansett hva modellen leverer. */
const INPUT_FACTOR = 8;
const MAX_ROUNDS = 6;

const SPACE_LIKE = /[\p{Zs}\p{Zl}\p{Zp}\t\n\r\v\f\u0085]+/gu;
const INVISIBLE_OR_CONTROL = /\p{C}/gu;
// Uten \b: «7http://…» og «xwww.…» skal ikke slippe gjennom fordi tegnet foran er et ordtegn.
const LINK_LIKE = /[a-z][a-z0-9+.-]{1,20}:\/\/\S*|www\.\S+/gi;
const STRICT_MARKUP = /[[\]()<>`*_#!|\\]/g;
const LINK_MARKUP = /[[\]()<>`]/g;
const ENTITY_START = /&(?=#?\w{1,12};)/g;
const ENTITY_TEST = /&(?=#?\w{1,12};)/;
const MARK_RUN = /(\p{M}{2})\p{M}+/gu;
const LEADING_MARK = /(^|\s)\p{M}+/gu;

/**
 * Fjerner `&` som innleder en HTML-entitet (`&lt;`, `&#60;`, `&#x3c;`). Å fjerne en kan lage en NY entitet av resten (`&ab&cd;` → `&abcd;`), så det gjentas til ingen er igjen (hver runde forkorter teksten). Et vanlig
 * «&» («Smith & Wesson», «R&D») er ikke innledningen til en entitet og røres ikke.
 */
function neutralizeEntities(text: string): string {
  let out = text;
  for (let i = 0; i < 32 && ENTITY_TEST.test(out); i++) out = out.replace(ENTITY_START, "");
  return ENTITY_TEST.test(out) ? out.replace(/&/g, "") : out;
}

/** Kappet på KODEPUNKTER (ikke UTF-16-enheter), med `…` som siste tegn. Aldri en halv surrogat. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * Mellomrom først (TAB/LF/CR/NEL/U+2028/U+2029 blir ett mellomrom), deretter ALT usynlig bort. NFKC gjentas til teksten er stabil: å fjerne et usynlig tegn (f.eks. et tag-tegn mellom «m» og en aksent) kan gjøre at resten
 * først NÅ lar seg komponere.
 */
function visibleOnly(input: string, normalize: boolean): string {
  let text = input;
  for (let i = 0; i < 4; i++) {
    const before = text;
    if (normalize) text = text.normalize("NFKC");
    text = text.replace(SPACE_LIKE, " ").replace(INVISIBLE_OR_CONTROL, "");
    if (text === before) break;
  }
  return text;
}

/**
 * Skanningen kjører FØR markup fjernes (mønstrene trenger `_` i `ghp_…` og `-` i `sk-…`), på tekst uten usynlige tegn (nullbredde inni en nøkkel skjuler den ikke). Redigeringsmerket `[REDACTED:type]` har selv markup-tegn
 * og et nøkkelord (`token`, `secret`) som skanneren ville reagert på i neste runde - det byttes derfor til det nøytrale ordet «REDACTED» før videre rensing, ellers konvergerer ikke renseren.
 */
const redact = (text: string): string => scanForSecrets(text).text.replace(/\[REDACTED:[^\]]*\]/g, "REDACTED");

function strictRound(input: string): string {
  const stripped = redact(visibleOnly(input, true)).replace(LINK_LIKE, "lenke-fjernet").replace(STRICT_MARKUP, " ");
  return neutralizeEntities(stripped).replace(MARK_RUN, "$1").replace(LEADING_MARK, "$1").replace(/\s+/g, " ").trim();
}

function parameterRound(input: string): string {
  return neutralizeEntities(redact(visibleOnly(input, false)).replace(LINK_MARKUP, " ")).replace(/\s+/g, " ").trim();
}

function toFixpoint(raw: string, max: number, round: (text: string) => string): string {
  let text = raw.length > max * INPUT_FACTOR ? raw.slice(0, max * INPUT_FACTOR) : raw;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const next = round(text);
    if (next === text) break;
    text = next;
  }
  // Kappingen kan lage ny kontekst ved snittflaten («password: REDACTE…»), og NFKC gjør `…` til «...»: rens den kappede teksten på nytt til kapp + rens er stabile (ellers ville rådets og portens rensing gitt ulik tekst).
  let out = cut(text, max);
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const next = cut(round(out), max);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Modellens egen tekst som vises til eieren: ren tekst på maks `max` tegn. Ikke-strenger gir tom streng. */
export function sanitizeDisplayText(raw: unknown, max: number): string {
  if (typeof raw !== "string" || !(max > 0)) return "";
  return toFixpoint(raw, max, strictRound);
}

/** En parameterverdi som er del av selve handlingen: lesbar, men kan aldri bli en lenke, et bilde eller et HTML-element i en visning. */
export function sanitizeParameterValue(raw: unknown, max: number): string {
  if (typeof raw !== "string" || !(max > 0)) return "";
  return toFixpoint(raw, max, parameterRound);
}

// eslint-disable-next-line no-control-regex -- kontroll- og formattegn er nettopp det som skal oppdages
const HIDDEN = /[\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/**
 * Inneholder verdien (rekursivt, nøkler OG strenger) usynlige/styrende tegn: bidi-overstyring/-isolater, nullbredde, tag-tegn, andre format-tegn, private-bruk, løse surrogater eller kontrolltegn (TAB/LF/CR er tillatt i
 * lengre tekster)? Slike tegn har ingen plass i en parameter et råd foreslår, og de gjør at det eieren leser ikke er det som utføres. Begrenset dybde/antall noder - for stor eller for dyp struktur regnes som «ja» (fail-closed).
 */
export function containsHiddenCharacters(value: unknown): boolean {
  const state = { nodes: 0 };
  const walk = (v: unknown, depth: number): boolean => {
    state.nodes += 1;
    if (state.nodes > 2000 || depth > 12) return true;
    if (typeof v === "string") return HIDDEN.test(v);
    if (Array.isArray(v)) return v.some((item) => walk(item, depth + 1));
    if (typeof v === "object" && v !== null) return Object.keys(v).some((k) => HIDDEN.test(k) || walk((v as Record<string, unknown>)[k], depth + 1));
    return false;
  };
  return walk(value, 0);
}
