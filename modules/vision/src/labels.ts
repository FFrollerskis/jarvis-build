/**
 * WP-G3 (D-465): normalisering av OBJEKTNAVN fra en lokal visjonsmodell.
 *
 * Modellutdata er UBETRODD (CLAUDE.md regel 7): et objektnavn kommer fra en modell som har sett et kamerabilde, og bildet kan
 * inneholde tekst en angriper har plassert der («ignorer alle tidligere instruksjoner ...»). Navnet er derfor DATA, aldri en
 * instruks, og det slippes ikke videre i den formen modellen leverte det. Normaliseringen er bevisst streng og deterministisk:
 *   - NFKC + fjerning av usynlige tegn (samme kjente omgåelser som `classificationVariants` i model-gateway lukker),
 *   - strukturtegn (tagger, JSON, kode, stier, kommandotegn) FORKASTER hele navnet (aldri «renset» til noe som ser uskyldig ut); øvrig tegnsetting
 *     (punktum, komma, apostrof, parenteser, utropstegn) fjernes, og kun små bokstaver, tall, mellomrom og bindestrek gjenstår,
 *   - maks 64 tegn og maks 4 ord (et objekt er «nøkler», «kaffekopp», «rød sekk» - ikke en setning),
 *   - alt som ikke består blir `null` (forkastet), aldri en delvis rettet streng som ser ut som noe annet enn det modellen sa.
 * HVA DETTE IKKE GJØR (ærlig, review A-M1): normaliseringen er IKKE en navne- eller instruksjonsfilter. Et ÅPENT ordforråd slipper gjennom så lenge det består av
 * bokstaver/tall/mellomrom/bindestrek innenfor lengdegrensene: «tobias sorensen», «bearded-man», «ignore all instructions now» og «drop table users» er gyldige etiketter her.
 * Kun generiske personord (`PERSON_WORDS` i classifier.ts: «man», «woman», «child», «face», «ansikt» ...) og strukturtegn filtreres. Etiketten er derfor UBETRODD DATA: den lagres
 * kun etter en DB-CHECK på lengde/tegnklasse (`isStorableObjectLabel`, speilet i migrasjon 133/135), den tolkes aldri som instruks i Jarvis (ingen kode handler på et objektnavn),
 * og den MÅ rammes inn som `untrusted` hvis den noen gang gis videre til en modell (et senere modellvendt verktøy, jf. N1). Det finnes INGEN garanti for at en etikett ikke er et navn.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|\p{Cf}|\p{Cc}/gu;
const DISALLOWED = /[^\p{L}\p{N} -]/gu;
// Strukturtegn (tagger, JSON, kode, stier, kommandoer): et objektnavn har ingen bruk for dem, og å «rense dem bort» ville gjort en angrepsstreng om til et
// plausibelt navn. En rå streng med slike tegn FORKASTES derfor i sin helhet.
const STRUCTURAL = /[<>{}[\]\\/|;:"`=#@$%^&*~+]/u;

export const MAX_OBJECT_LABEL_CHARS = 64;
export const MAX_OBJECT_LABEL_WORDS = 4;

export function normalizeObjectLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 400) return null;
  // Usynlige tegn FJERNES (ikke erstattet med mellomrom): et skjult tegn midt i et ord skal ikke dele det i to.
  const folded = raw.normalize("NFKC").replace(INVISIBLE, "").toLowerCase();
  if (STRUCTURAL.test(folded)) return null;
  const cleaned = folded.replace(DISALLOWED, " ").replace(/[ -]{2,}/g, " ").replace(/^[ -]+|[ -]+$/g, "").trim();
  if (cleaned.length === 0 || cleaned.length > MAX_OBJECT_LABEL_CHARS) return null;
  const words = cleaned.split(/[ ]+/).filter((w) => w.length > 0);
  if (words.length === 0 || words.length > MAX_OBJECT_LABEL_WORDS) return null;
  // En «etikett» som kun er tall/bindestrek er ikke et objektnavn.
  if (!/\p{L}/u.test(cleaned)) return null;
  return words.join(" ");
}

/**
 * Lagringsregelen for et objektnavn: DB-CHECK `vision_event_observations_object_label_check` (133, mild; denne funksjonen) og `vision_inventory_items_object_label_check` (135, streng: normalisert form; se
 * `isInventoryLabel` under). 1-64 tegn, høyst 4 ord, ingen strukturtegn, kontrolltegn eller usynlige tegn, og minst ett tegn som ikke er siffer/mellomrom/tegnsetting. Alt `normalizeObjectLabel` gir består dette;
 * regelen her er MILDERE (krever ikke små bokstaver - en P0-kilde kan levere «Nøkler») og er et nett under normaliseringen, ikke en erstatning for den. Paritet mot SQL bevises i g3-migrations.test.ts
 * (en sveip over HELE Unicode-rommet mot selve CHECK-en i databasen), og samme regel brukes i inngangsskjemaet (types.ts). Usynlige tegn bygges av kodepunkter (ingen tegnescape i kilden).
 * Det er IKKE et navnefilter (se avsnittet over): regelen sier kun at strengen har formen til et kort objektnavn.
 * Merk (review delta D1): begge CHECK-ene er skrevet UTEN locale-avhengige POSIX-klasser. Den milde CHECK-ens bokstavkrav er «noe annet enn ASCII-sifre, -mellomrom og -tegnsetting» (ikke-ASCII tegn som ikke
 * er forbudt teller som bokstavlike) og ordene telles på ASCII-mellomrom, så databasen er et NETT som aldri er strengere enn normaliseringen; denne JS-regelen er (Unicode-bevisst) STRAMMERE for en etikett av KUN
 * ikke-ASCII tegnsetting/symboler («»), som skjemaet derfor avviser før databasen ser den. Bevist med sveip over alle kodepunkt i to locales (g3-label-locale.test.ts).
 */
// Usynlige/formaterende tegn: soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul-fyllere, Khmer-vokaler, Mongolian-velgere, null-bredde og bidi (200B-200F, 202A-202E),
// ordforbinder/usynlige operatorer (2060-206F), variasjonsvelgere, BOM, halvbredde-fyller, tegn for interlinear annotasjon og Unicode «tag»-tegn (E0000-E0FFF: «ASCII smuggling»).
// MÅ være identisk med tegnklassen i migrasjon 133 (sveipetesten feller enhver forskjell).
const STORED_INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0xe0000, 0xe0fff]
];
const FORBIDDEN_STORED = new RegExp(
  "[<>{}\\[\\]\\\\/|;:\"`=#@$%^&*~+\\p{Cc}" + STORED_INVISIBLE_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("") + "]",
  "u"
);
const HAS_LETTERISH = /[^0-9\s\p{P}\p{S}]/u;

export function isStorableObjectLabel(label: unknown): label is string {
  if (typeof label !== "string") return false;
  const length = [...label].length;
  if (length < 1 || length > MAX_OBJECT_LABEL_CHARS) return false;
  if (FORBIDDEN_STORED.test(label) || !HAS_LETTERISH.test(label)) return false;
  return label.trim().split(/\s+/).length <= MAX_OBJECT_LABEL_WORDS;
}

/**
 * Inventarregelen (STRENG, normalisert form): CHECK `vision_inventory_items_object_label_check` (135). Review delta D1: den gamle regelen brukte POSIX-klassene `[:punct:]`/`[:cntrl:]`, som er LOCALE-AVHENGIGE:
 * i glibc-UTF-8-locales (C.UTF-8, en_US.UTF-8, slik produksjonsbildet er) regnes tall-tegn av kategori No (U+09F4-09F9, U+0B72-0B77, U+0BF0, U+2776-2793 ...) som tegnsetting, så databasen avviste etiketter
 * `normalizeObjectLabel` selv lager (alle \p{L}\p{N}), og HELE hendelsen rullet tilbake. Nå er regelen skrevet med EKSPLISITTE kodepunktområder (ingen POSIX-klasser) og er lik i alle locales.
 * Forbudt: C0/C1-kontrolltegn, ASCII-tegnsetting (alle unntatt bindestrek), Latin-1-tegnsetting/-symboler, usynlige/formaterende tegn (samme som den milde regelen, 133), alle Unicode-mellomrom og hele blokken Generell tegnsetting
 * (U+2000-206F). Øvrig Unicode-tegnsetting har ingen egen klasse (normalizeObjectLabel fjerner den): DB-regelen er et NETT som aldri er strengere enn normaliseringen - ingen etikett `normalizeObjectLabel` gir kan avvises
 * (bevist med sveip over alle kodepunkt i to locales). I tillegg: 1-64 tegn, minst ett tegn som ikke er siffer/mellomrom/bindestrek, ingen ledende/etterfølgende/doble mellomrom eller bindestreker og høyst 4 ord.
 * MÅ være identisk med tegnklassen i migrasjon 135 (sveipetesten feller enhver forskjell). Alle områder er inklusive.
 */
export const INVENTORY_FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0001, 0x001f], // C0-kontrolltegn
  [0x0021, 0x002c], [0x002e, 0x002f], [0x003a, 0x0040], [0x005b, 0x0060], // ASCII-tegnsetting (0x2D = bindestrek er tillatt)
  [0x007b, 0x00a9], // {|}~, DEL, C1-kontrolltegn, NBSP og Latin-1 ¡-©
  [0x00ab, 0x00b1], [0x00b4, 0x00b4], [0x00b6, 0x00b8], [0x00bb, 0x00bb], [0x00bf, 0x00bf], [0x00d7, 0x00d7], [0x00f7, 0x00f7], // Latin-1-tegnsetting/-symboler (ikke ª ² ³ µ ¹ º ¼-¾: bokstaver/tall)
  [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x1680, 0x1680], [0x17b4, 0x17b5], [0x180b, 0x180f], // usynlige tegn, Ogham-mellomrom
  [0x2000, 0x206f], // Generell tegnsetting: mellomrom, null-bredde, bidi, tankestreker, anførselstegn, usynlige operatorer
  [0x3000, 0x3000], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0xe0000, 0xe0fff] // ideografisk mellomrom, fyllere, variasjonsvelgere, BOM, tag-tegn
];

function inRanges(codePoint: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [from, to] of ranges) if (codePoint >= from && codePoint <= to) return true;
  return false;
}

export function isInventoryLabel(label: unknown): label is string {
  if (typeof label !== "string") return false;
  const points = [...label];
  if (points.length < 1 || points.length > MAX_OBJECT_LABEL_CHARS) return false;
  let letterish = false;
  for (const point of points) {
    const codePoint = point.codePointAt(0) as number;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false; // enkeltstående surrogat: ikke gyldig tekst (kan ikke lagres som UTF-8)
    if (inRanges(codePoint, INVENTORY_FORBIDDEN_RANGES)) return false;
    if (!((codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x20 || codePoint === 0x2d)) letterish = true;
  }
  if (!letterish) return false;
  if (/^[ -]|[ -]$|[ -]{2}/.test(label)) return false;
  return label.split(" ").length <= MAX_OBJECT_LABEL_WORDS;
}

/**
 * Teksten som embeddes for en hendelse (kun VALIDERTE felt - aldri rå modelltekst, aldri bildeinnhold). For en objektobservasjon er det KUN det normaliserte objektnavnet:
 * hendelsestype og romnavn ligger i databasen og filtreres der, og et felles prefiks («object detected ...») ville fått ulike objekter til å ligne hverandre (spesielt for
 * hash-embedding, som ikke har semantikk). Uten objektnavn beskrives hendelsestypen. `room_name` aksepteres for kompatibilitet men er ikke med i objektvektoren.
 */
export function describeEventForEmbedding(parts: { event_type: string; object_label?: string | null; room_name?: string | null }): string {
  if (parts.object_label) return parts.object_label;
  return parts.event_type.replace(/_/g, " ");
}

/**
 * Confidence forfaller med halveringstid (inventar og «sist sett»): `conf * 0.5^(alder/halveringstid)`. Ren funksjon, samme formel som
 * SQL-upserten i inventory.ts bruker (låst av en test), slik at det som skrives og det som leses aldri driver fra hverandre.
 */
export function decayedConfidence(confidence: number, lastSeenMs: number, nowMs: number, halfLifeHours: number): number {
  if (!Number.isFinite(confidence) || !Number.isFinite(lastSeenMs) || !Number.isFinite(nowMs) || !(halfLifeHours > 0)) return 0;
  const ageHours = Math.max(0, nowMs - lastSeenMs) / 3_600_000;
  const value = confidence * Math.pow(0.5, ageHours / halfLifeHours);
  return Math.min(1, Math.max(0, value));
}
