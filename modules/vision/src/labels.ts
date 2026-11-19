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
 * Lagringsregelen for et objektnavn: DB-CHECK `vision_event_observations_object_label_check` (133, mild) og `vision_inventory_items_object_label_check` (135, streng: normalisert form).
 * 1-64 tegn, høyst 4 ord, ingen strukturtegn, kontrolltegn eller usynlige tegn, og minst ett tegn som ikke er siffer/mellomrom/tegnsetting. Alt `normalizeObjectLabel` gir består dette; regelen
 * her er MILDERE (krever ikke små bokstaver - en P0-kilde kan levere «Nøkler») og er et nett under normaliseringen, ikke en erstatning for den. Paritet mot SQL bevises i g3-migrations.test.ts
 * (en sveip over HELE Unicode-rommet mot selve CHECK-en i databasen), og samme regel brukes i inngangsskjemaet (types.ts). Usynlige tegn bygges av kodepunkter (ingen tegnescape i kilden).
 * Det er IKKE et navnefilter (se avsnittet over): regelen sier kun at strengen har formen til et kort objektnavn.
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
