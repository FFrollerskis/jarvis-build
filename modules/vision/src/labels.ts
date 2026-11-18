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
 * Dette er IKKE en garanti mot at en kort tekst fortsatt kan lese som en instruks for en LLM; garantien er at navnet aldri tolkes som
 * instruks i Jarvis (verktøyutdata merkes `untrusted`, og ingen kode handler på et objektnavn).
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
 * Teksten som embeddes for en hendelse (kun VALIDERTE felt: hendelsestype, normalisert objektnavn, eierens egne romnavn). Aldri
 * rå modelltekst, aldri bildeinnhold. Romnavnet er eierens eget (eier-definert i vision_rooms) og normaliseres på samme måte.
 */
export function describeEventForEmbedding(parts: { event_type: string; object_label?: string | null; room_name?: string | null }): string {
  const room = parts.room_name === undefined || parts.room_name === null ? null : normalizeObjectLabel(parts.room_name);
  const segments = [parts.event_type.replace(/_/g, " ")];
  if (parts.object_label) segments.push(parts.object_label);
  if (room) segments.push(`i ${room}`);
  return segments.join(" ");
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
