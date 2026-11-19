import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VISION_SYSTEM_PROMPT, parseModelClassification } from "../src/classifier.ts";
import { HomeAssistantVisionSource } from "../src/ha-source.ts";
import { inspectImage, sniffMediaType } from "../src/image.ts";
import { VisionEventTypeSchema } from "../src/types.ts";

/**
 * WP-G3 (D-465), P3f: BYGGEVAKTER (ikke atferdstester av en funksjon, men låser som feller bygget hvis noen senere går utenfor UA-9-rammen):
 *
 *   1. `no_biometric`: masterplan v4.0 UA-9 / personvern-tabellen («no biometric identity in this plan»; biometrisk ansiktsidentifikasjon er utenfor planen med mindre separat besluttet og lovlig).
 *      Ingen kolonne/tabell/CHECK-verdi/identifikator/modelloppgave for ansiktsgjenkjenning eller biometrisk identitet.
 *   2. Ingen kontinuerlig RÅ VIDEO: kun hendelses-øyeblikksbilder (ett stillbilde per hendelse). Ingen strøm-/opptaks-/video-kode, ingen videoformater, ingen persistent kanal.
 *   3. Visjonsmodulen har ingen egen nettverksvei og ingen leverandør-SDK: HTTP går kun via den INNSATTE `fetch` (adapter-grensen, CLAUDE.md regel 3), modellkall via ModelGateway-porten.
 *
 * Hver vakt har en NON-VAKUITETSTEST: skanneren kjøres mot syntetiske brudd og MÅ felle dem - en vakt som aldri feller noe er verdiløs.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const VISION_SRC = join(ROOT, "modules/vision/src");

/* ----------------------------- skannere (rene funksjoner) ----------------------------- */

const REGEX_PRECEDING_WORDS = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "else", "do", "yield", "await"]);

/** Kan en `/` her begynne en regex-literal (og ikke være en divisjon)? Heuristikk etter forrige signifikante token. */
function regexAllowedAfter(out: string): boolean {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j] as string)) j -= 1;
  if (j < 0) return true;
  const last = out[j] as string;
  if (/[A-Za-z_$]/.test(last)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k] as string)) k -= 1;
    return REGEX_PRECEDING_WORDS.has(out.slice(k + 1, j + 1));
  }
  return "(,=:[!&|?{};+-*%<>~^".includes(last);
}

/**
 * Fjerner kommentarer og regex-literaler (en regex med en anførselstegn-/backtick-tegn ville ellers forvirre streng-tilstandsmaskinen). `keepStrings=false` blanker i tillegg
 * innholdet i streng-/mal-literaler (da er bare KODE igjen). Ikke en full JS-tokenizer, men nøyaktig nok for kildefilene i dette repoet (verifisert av non-vakuitetstestene under).
 */
function strip(src: string, keepStrings: boolean): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "/" && regexAllowedAfter(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const ch = src[j] as string;
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (inClass) inClass = ch !== "]";
        else if (ch === "[") inClass = true;
        else if (ch === "/") break;
        j += 1;
      }
      if (src[j] === "/") {
        out += "/re/";
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i] as string)) i += 1; // flagg
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          if (keepStrings) out += src[i];
          i += 1;
        }
        if (keepStrings || src[i] === "\n") out += src[i];
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** camelCase/snake_case/kebab/punktum -> små delord. */
function subwords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9æøå]+/)
    .filter((w) => w.length > 0);
}

/**
 * Biometri-/ansiktsgjenkjenningsord (hele delord - «surface» og «facebook» er IKKE treff). Review A-L4: også de sammensatte ordene `subwords()` ikke deler (facematch, facerec*, facedetect*, faceembed*, ...)
 * og person-gjenidentifisering (reid*). Disse vaktene er NAIVE BRUDD-VAKTER (de felles rene, utilsiktede innføringer med de vanlige navnene), ikke en garanti: en forsettlig omgåelse med et helt annet navn fanges ikke.
 */
const isBiometricWord = (w: string): boolean => /^(faces?|facial|faceprints?|faceid|face(match|rec|recog|detect|embed|template|ident|cluster)\w*|ansikt\w*|biometri\w*|voiceprints?|gait|reid\w*)$/.test(w);
/**
 * Ekstra for visjonsmodulen: gjenkjenning/identifisering av personer. («fingerprint» er hash-fingeravtrykk i flere moduler og er bevisst IKKE med.) Review A-L4: også norsk
 * (gjenkjenn*, identifiser*) - modellen/prompten/teksten kan være norsk.
 */
const isRecognitionWord = (w: string): boolean => /^(recogni[sz](e|es|ed|ing|ition)|identify|identifies|identified|identifying|identification|gjenkjenn\w*|identifiser\w*)$/.test(w);
const PERSON_NOUNS: ReadonlySet<string> = new Set(["person", "people", "human"]);
const IDENTITY_NOUNS: ReadonlySet<string> = new Set(["name", "names", "identity", "identities", "embedding", "embeddings", "template", "templates", "match", "matches", "signature", "descriptor", "descriptors", "vector"]);
/**
 * Review A-L4 (kun visjonsomfanget): en identifikator/kolonne som PARER en person med et identitetsord (`person_name`, `personEmbedding`, `PersonTemplate`, `person_match`) eller skriver person-gjenidentifisering
 * (`re_id`, `reIdentify`). `person_id`/`person_present` er IKKE treff (id/present er ikke identitetsord).
 */
function isPersonIdentityIdentifier(id: string): boolean {
  const words = subwords(id);
  if (words.some((w) => PERSON_NOUNS.has(w)) && words.some((w) => IDENTITY_NOUNS.has(w))) return true;
  for (let i = 0; i + 1 < words.length; i += 1) if (words[i] === "re" && /^(id|identif\w*)$/.test(words[i + 1] as string)) return true;
  return false;
}

function scanIdentifiers(source: string, extra: (w: string) => boolean = () => false): string[] {
  const code = strip(source, false);
  const hits = new Set<string>();
  for (const id of code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (subwords(id).some((w) => isBiometricWord(w) || extra(w))) hits.add(id);
  return [...hits];
}

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function scanLiterals(source: string): string[] {
  const code = strip(source, true);
  const literals = code.match(STRING_LITERAL) ?? [];
  return literals.filter((literal) => subwords(literal).some(isBiometricWord));
}

/** Review A-L4: identifikatorer som parer en person med et identitetsord (`person_name`, `PersonEmbedding`) eller skriver re-identifisering (`reId`). Brukes kun i visjonsomfanget. */
function scanPersonIdentityIdentifiers(source: string): string[] {
  const hits = new Set<string>();
  for (const id of strip(source, false).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (isPersonIdentityIdentifier(id)) hits.add(id);
  return [...hits];
}

/**
 * Review A-L4: streng-literaler som nevner biometri/gjenkjenning/identifisering (engelsk eller norsk) eller ber modellen navngi/beskrive/identifisere en person («Identify the person by name»).
 * Brukes kun i visjonsomfanget; de granskede forbudslistene står i allowlisten under.
 */
function scanRecognitionLiterals(source: string): string[] {
  const literals = strip(source, true).match(STRING_LITERAL) ?? [];
  return literals.filter((literal) => subwords(literal).some((w) => isBiometricWord(w) || isRecognitionWord(w)) || /\b(name|describe|identify)\s+(the|this|each|any|a)\s+(person|people|man|woman|face)/i.test(literal));
}

const cleanSql = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

/** SQL: kommentarer fjernes; ALLE ord (også streng-verdier i CHECK) delord-skannes. `scope` begrenser til setninger som nevner visjons-/vektortabeller. */
function scanSql(sql: string, scope: "all" | "vision"): string[] {
  const hits = new Set<string>();
  for (const statement of cleanSql(sql).split(";")) {
    if (scope === "vision" && !/vision_|memory_vectors/i.test(statement)) continue;
    for (const word of subwords(statement)) if (isBiometricWord(word)) hits.add(word);
  }
  return [...hits];
}

/** Review A-L4: i setninger som berører vision-tabeller (vision_ + navn) og memory_vectors: gjenkjennings-/identifiseringsord og identifikatorer som parer en person med et identitetsord (kolonnen `person_name`). */
function scanSqlIdentity(sql: string): string[] {
  const hits = new Set<string>();
  for (const statement of cleanSql(sql).split(";")) {
    if (!/vision_|memory_vectors/i.test(statement)) continue;
    for (const word of subwords(statement)) if (isRecognitionWord(word)) hits.add(word);
    for (const id of statement.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (isPersonIdentityIdentifier(id)) hits.add(id);
  }
  return [...hits];
}

function* walk(dir: string, accept: (file: string) => boolean): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full, accept);
    else if (accept(full)) yield full;
  }
}

/** Alle ikke-test kildefiler under `<område>/*\/src`. */
function productionSources(): string[] {
  const files: string[] = [];
  for (const area of ["modules", "packages", "apps"]) {
    const base = join(ROOT, area);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, "src");
      if (existsSync(src) && statSync(src).isDirectory()) files.push(...walk(src, (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)));
    }
  }
  return files;
}

const visionSources = (): string[] => [...walk(VISION_SRC, (f) => f.endsWith(".ts")), ...(existsSync(join(ROOT, "apps/api/src")) ? [...walk(join(ROOT, "apps/api/src"), (f) => /\/vision[a-z-]*\.ts$/.test(f))] : [])];
/** Review A-L4: ALLE produksjonsfiler som nevner «camera» (kode eller literaler) - også utenfor visjonsmodulen (en senere HA-/kameraverktøy-fil i tool-gateway ville havnet her). */
const cameraScopedSources = (): string[] => productionSources().filter((file) => /camera/i.test(strip(readFileSync(file, "utf8"), true)));
const rel = (file: string): string => relative(ROOT, file);
const migrations = (): Array<{ name: string; sql: string }> =>
  readdirSync(join(ROOT, "modules/core/src/db/migrations")).filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(join(ROOT, "modules/core/src/db/migrations", name), "utf8") }));

/* ----------------------------------- 1. no_biometric ----------------------------------- */

describe("no_biometric: ingen kolonne/tabell/modelloppgave for ansiktsgjenkjenning eller biometrisk identitet", () => {
  // Kjente, GRANSKEDE treff i streng-literaler: forbuds-/avvisningslister (ordene finnes der for å FORBY dem).
  const LITERAL_ALLOWLIST: Readonly<Record<string, string>> = {
    "modules/vision/src/classifier.ts": "systemprompten FORBYR å identifisere/gjenkjenne personer og lister «faces»; PERSON_WORDS er listen over ord som FJERNES fra modellens etiketter",
    "modules/business/src/scoring-rules.ts": "liste over SENSITIVE nøkkelord («biometric») som business-scoring ikke skal bruke"
  };

  it("repo-bred: ingen identifikator (funksjon/variabel/type/felt) i produksjonskode har et biometri-/ansiktsdelord", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      const hits = scanIdentifiers(readFileSync(file, "utf8"));
      if (hits.length > 0) offenders.push(`${rel(file)}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("visjonsmodulen: i tillegg ingen gjenkjennings-/identifiseringsidentifikator (recognise*/identify*)", () => {
    const offenders: string[] = [];
    for (const file of visionSources()) {
      const hits = scanIdentifiers(readFileSync(file, "utf8"), isRecognitionWord);
      if (hits.length > 0) offenders.push(`${rel(file)}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("streng-literaler: kun de to granskede forbudslistene nevner ordene, og allowlisten er ikke foreldet", () => {
    const flagged = new Set<string>();
    for (const file of productionSources()) if (scanLiterals(readFileSync(file, "utf8")).length > 0) flagged.add(rel(file));
    expect([...flagged].sort()).toEqual(Object.keys(LITERAL_ALLOWLIST).sort());
  });

  it("alle migrasjoner: ingen tabell/kolonne/CHECK-verdi med biometri-/ansiktsord; og ingen i det hele tatt i setninger som berører vision_*/memory_vectors", () => {
    const offenders: string[] = [];
    for (const migration of migrations()) {
      const all = scanSql(migration.sql, "all");
      if (all.length > 0) offenders.push(`${migration.name}: ${all.join(", ")}`);
      expect(scanSql(migration.sql, "vision")).toEqual([]);
    }
    expect(offenders).toEqual([]);
  });

  it("visjonsomfanget (review A-L4): ingen identifikator som parer en person med et identitetsord (person_name, personEmbedding, reId ...) og ingen streng-literal om gjenkjenning/identifisering utenfor den granskede forbudslisten", () => {
    const LITERALS_OK: Readonly<Record<string, string>> = { "modules/vision/src/classifier.ts": "systemprompten FORBYR å identifisere/gjenkjenne personer (frosset av pinnen under); PERSON_WORDS er forbudslisten" };
    const identifierOffenders: string[] = [];
    const literalFlagged = new Set<string>();
    for (const file of visionSources()) {
      const source = readFileSync(file, "utf8");
      const ids = scanPersonIdentityIdentifiers(source);
      if (ids.length > 0) identifierOffenders.push(`${rel(file)}: ${ids.join(", ")}`);
      if (scanRecognitionLiterals(source).length > 0) literalFlagged.add(rel(file));
    }
    expect(identifierOffenders).toEqual([]);
    expect([...literalFlagged].sort()).toEqual(Object.keys(LITERALS_OK).sort());
  });

  it("migrasjoner (review A-L4): ingen setning om vision_*/memory_vectors har person+identitetsord (kolonnen person_name) eller gjenkjennings-/identifiseringsord", () => {
    const offenders: string[] = [];
    for (const migration of migrations()) {
      const hits = scanSqlIdentity(migration.sql);
      if (hits.length > 0) offenders.push(`${migration.name}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("systemprompten er FROSSET (review A-L4): enhver endring - også en liten «Identify the person ...»-linje - feller denne pinnen og krever en bevisst oppdatering av den og av DPIA-en", () => {
    expect(createHash("sha256").update(VISION_SYSTEM_PROMPT).digest("hex")).toBe("9ba927473947dd0ecca89599f5737c85451ad440af81be456719d9c1b2dd584f");
  });

  it("den lukkede hendelsesmengden har ingen biometrisk/identitetstype", () => {
    expect([...VisionEventTypeSchema.options].sort()).toEqual(["doorbell_event", "motion_detected", "object_detected", "opening_detected", "person_present", "security_alert"]);
    for (const type of VisionEventTypeSchema.options) expect(subwords(type).some((w) => isBiometricWord(w) || isRecognitionWord(w))).toBe(false);
  });

  it("modellutdata for ansikt/identitet avvises deterministisk: ukjent type, ukjente nøkler, person med etikett, personbeskrivende etiketter", () => {
    const parse = (detections: unknown[]): ReturnType<typeof parseModelClassification> => parseModelClassification(JSON.stringify({ detections }));
    const outcomes = [
      parse([{ event_type: "face_recognized", confidence: 0.99 }]),
      parse([{ event_type: "person_identified", object_label: "Ola Nordmann", confidence: 0.99 }]),
      parse([{ event_type: "person_present", confidence: 0.9, identity: "Ola" }]),
      parse([{ event_type: "person_present", confidence: 0.9, face_embedding: [0.1, 0.2] }]),
      parse([{ event_type: "object_detected", object_label: "face", confidence: 0.9 }]),
      parse([{ event_type: "object_detected", object_label: "ansikt", confidence: 0.9 }]),
      parse([{ event_type: "object_detected", object_label: "woman", confidence: 0.9 }]),
      parse([{ event_type: "person_present", object_label: "Ola", confidence: 0.9 }])
    ];
    for (const outcome of outcomes) {
      // Enten hele svaret avvises (ukjent nøkkel/type), eller det gir ingen deteksjon (forbudt etikett droppes) - aldri en deteksjon som bærer identitet.
      if (outcome.ok) expect(outcome.detections).toEqual([]);
      else expect(outcome.reason).toBeTruthy();
    }
    const person = parse([{ event_type: "person_present", confidence: 0.9 }]);
    expect(person).toMatchObject({ ok: true, detections: [{ event_type: "person_present", object_label: null }] });
  });

  it("systemprompten FORBYR eksplisitt å identifisere, navngi, beskrive, sammenligne eller gjenkjenne personer (og ansikter)", () => {
    expect(VISION_SYSTEM_PROMPT).toContain("NEVER identify, name, describe, compare or recognise any person");
    expect(VISION_SYSTEM_PROMPT).toMatch(/faces/);
    expect(VISION_SYSTEM_PROMPT).toContain("For person_present give NO object_label");
  });

  it("NON-VAKUITET: skannerne feller syntetiske brudd (identifikatorer, literaler og SQL), og ikke uskyldige ord", () => {
    expect(scanIdentifiers("export function recognizeFace(img: Uint8Array) { const faceEmbedding = []; return faceEmbedding; }")).toEqual(["recognizeFace", "faceEmbedding"]);
    expect(scanIdentifiers("type FaceMatch = { face_id: string }; const biometricTemplate = 1; const ansiktsgjenkjenning = 2;").sort()).toEqual(["FaceMatch", "ansiktsgjenkjenning", "biometricTemplate", "face_id"]);
    expect(scanIdentifiers("function identifyPerson() {} const recognisedUser = 1;", isRecognitionWord).sort()).toEqual(["identifyPerson", "recognisedUser"]);
    expect(scanIdentifiers("const surface = 1; const facebookUrl = 2; const interfaceName = 3; const faceted = 4; // face recognition i en kommentar")).toEqual([]);
    expect(scanIdentifiers('const t = "face recognition i en streng";')).toEqual([]); // identifikator-skanneren ser bare kode; strenger tas av literal-skanneren
    expect(scanLiterals('const task = "face_recognition";').length).toBe(1);
    expect(scanLiterals('const t = "surface"; const u = "graph.facebook.com"; // "face"')).toEqual([]);
    // Regex-literaler med anførselstegn/backtick forvirrer ikke skanneren (en divisjon er heller ikke en regex): koden etter dem leses riktig.
    expect(scanLiterals('const re = /[`"\']/g; const t = "face";')).toEqual(['"face"']);
    expect(scanLiterals('const half = total / count; const t = "face"; const u = x / 2; const v = "ok";')).toEqual(['"face"']);
    expect(scanLiterals('return /["`]face["`]/.test(x) ? "ok" : "ansikt";')).toEqual(['"ansikt"']);
    expect(scanSql("CREATE TABLE vision_faces (face_id text);", "vision")).toEqual(["faces", "face"]);
    expect(scanSql("ALTER TABLE vision_event_observations ADD COLUMN face_embedding vector(512);", "vision")).toEqual(["face"]);
    expect(scanSql("ALTER TABLE vision_event_observations ADD CONSTRAINT c CHECK (event_type IN ('face_recognized'));", "vision")).toEqual(["face"]);
    expect(scanSql("ALTER TABLE memory_vectors ADD CONSTRAINT c CHECK (ref_kind IN ('item','face_template'));", "vision")).toEqual(["face"]);
    expect(scanSql("CREATE TABLE people_biometrics (id int);", "all")).toEqual(["biometrics"]);
    expect(scanSql("-- face recognition forbudt\nCREATE TABLE vision_x (surface text); /* biometric */", "all")).toEqual([]);
    expect(scanSql("CREATE TABLE unrelated (face int);", "vision")).toEqual([]); // utenfor vision-scope fanges av «all»
    expect(scanSql("CREATE TABLE unrelated (face int);", "all")).toEqual(["face"]);
  });

  it("NON-VAKUITET (review A-L4): de utvidede skannerne feller de omgåelsene reviewer A fant (facematch, person_name, «Identify the person by name», norske ord) - og ikke uskyldige navn", () => {
    expect(scanIdentifiers("const facematch = 1; function facerecognition() {} const reidentify = 2; const faceembedding = 3;").sort()).toEqual(["faceembedding", "facematch", "facerecognition", "reidentify"]);
    expect(scanIdentifiers("const resident = 1; const reliable = 2; const reid = 3; const faceted = 4; const facetime = 5;")).toEqual(["reid"]);
    expect(scanPersonIdentityIdentifiers("const person_name = 1; type PersonEmbedding = {}; const reId = 2; function reIdentify() {} const personMatch = 3;").sort()).toEqual(["PersonEmbedding", "personMatch", "person_name", "reId", "reIdentify"]);
    expect(scanPersonIdentityIdentifiers("const person_id = 1; const person_present = 2; type PersonTenants = {}; const PERSON_WORDS = []; const object_label = 3; const already = 4; const reading = 5;")).toEqual([]);
    expect(scanRecognitionLiterals('const p = "Identify the person by name and describe them";')).toHaveLength(1);
    expect(scanRecognitionLiterals('const m = "Jeg kan ikke gjenkjenne personer";')).toHaveLength(1);
    expect(scanRecognitionLiterals('const u = "identifiser personen";')).toHaveLength(1);
    expect(scanRecognitionLiterals('const t = "Please describe the face in the image";')).toHaveLength(1);
    expect(scanRecognitionLiterals('const ok = "object_detected"; const k = "keys"; const j = `${a}/api/camera_proxy/${b}`;')).toEqual([]);
    expect(scanSqlIdentity("ALTER TABLE vision_event_observations ADD COLUMN person_name text;")).toEqual(["person_name"]);
    expect(scanSqlIdentity("CREATE TABLE vision_x (identification text, recognised boolean);").sort()).toEqual(["identification", "recognised"]);
    expect(scanSqlIdentity("CREATE TABLE unrelated (person_name text);")).toEqual([]);
    expect(scanSqlIdentity("-- person_name er forbudt\nCREATE TABLE vision_x (person_id text);")).toEqual([]);
  });
});

/* ------------------------------- 2. ingen kontinuerlig rå video ------------------------------- */

describe("ingen kontinuerlig rå video: kun hendelses-øyeblikksbilder", () => {
  // Kode MED streng-literaler (URL-er/stier står i strenger). Kommentarer (som forklarer hva som IKKE brukes) er strippet.
  const VIDEO_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
    ["camera_proxy_stream (MJPEG-strøm)", /camera_proxy_stream/i],
    ["/api/stream /api/hls (strøm-endepunkt)", /\/api\/(stream|hls)\b/i],
    ["HLS/DASH-spilleliste", /\.(m3u8|mpd)\b/i],
    ["rtsp/rtmp/srt-URL", /\b(rtsps?|rtmps?|srt):\/\//i],
    ["MJPEG / multipart-strøm", /mjpeg|multipart\/x-mixed-replace/i],
    ["nettleser-opptak (MediaRecorder/getUserMedia)", /MediaRecorder|getUserMedia/],
    ["ffmpeg", /ffmpeg/i],
    ["WebRTC", /webrtc|RTCPeerConnection/i],
    ["HA-kamera opptak/strøm-tjenester (skriver filer/åpner strøm)", /camera[./](record|play_stream|stream_source)|play_stream/i],
    ["videomedietype", /\bvideo\//i],
    ["persistent kanal (WebSocket/EventSource) - HA-push er DEFERRED og krever en bevisst oppdatering av denne vakten og DPIA-en", /new\s+WebSocket|\bEventSource\b/]
  ];
  const scanVideo = (source: string): string[] => VIDEO_TOKENS.filter(([, pattern]) => pattern.test(strip(source, true))).map(([label]) => label);

  it("ingen strøm-/opptaks-/video-/persistent-kanal-kode i visjonsmodulen (eller visjons-API-filer)", () => {
    const offenders: string[] = [];
    for (const file of visionSources()) {
      const hits = scanVideo(readFileSync(file, "utf8"));
      if (hits.length > 0) offenders.push(`${rel(file)}: ${hits.join("; ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("repo-bredt (review A-L4): ingen produksjonsfil som nevner «camera» - uansett modul - har strøm-/opptaks-/video-kode, og HA-bildehentingen (camera_proxy) finnes kun i ha-source.ts", () => {
    const scoped = cameraScopedSources();
    expect(scoped.map(rel)).toEqual(expect.arrayContaining(["apps/api/src/server.ts", "modules/erasure/src/plan.ts", "modules/vision/src/pipeline.ts", "modules/vision/src/ha-source.ts"]));
    const offenders: string[] = [];
    const proxyUsers: string[] = [];
    for (const file of scoped) {
      const source = readFileSync(file, "utf8");
      const hits = scanVideo(source);
      if (hits.length > 0) offenders.push(`${rel(file)}: ${hits.join("; ")}`);
      if (/camera_proxy/.test(strip(source, true))) proxyUsers.push(rel(file));
    }
    expect(offenders).toEqual([]);
    expect(proxyUsers).toEqual(["modules/vision/src/ha-source.ts"]);
  });

  it("kildeadapteren HA har kun lese-/bildehentingsmetoder (ingen subscribe/stream/record/styring)", () => {
    expect(Object.getOwnPropertyNames(HomeAssistantVisionSource.prototype).sort()).toEqual(["constructor", "fetchSnapshot", "get", "mapState", "pollEvents", "readState", "root"]);
  });

  const header = (...bytes: number[]): Uint8Array => Uint8Array.from([...bytes, ...new Array<number>(64).fill(0)]);
  const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
  const VIDEO_AND_OTHER: Array<[string, Uint8Array]> = [
    ["MP4/MOV (ftyp)", header(0, 0, 0, 0x18, ...ascii("ftypisom"))],
    ["HEIC-bilde (ikke i den tillatte stillbildemengden)", header(0, 0, 0, 0x18, ...ascii("ftypheic"))],
    ["WebM/Matroska", header(0x1a, 0x45, 0xdf, 0xa3)],
    ["AVI (RIFF....AVI )", header(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("AVI "))],
    ["Ogg", header(...ascii("OggS"))],
    ["GIF (animert)", header(...ascii("GIF89a"))],
    ["FLV", header(...ascii("FLV"), 1)],
    ["MPEG-TS", header(0x47, 0x40, 0x00, 0x10)],
    ["MPEG-PS", header(0x00, 0x00, 0x01, 0xba)],
    ["ASF/WMV", header(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11)],
    ["SVG (kan inneholde skript)", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')],
    ["HTML", new TextEncoder().encode("<!doctype html><html></html>")]
  ];

  it.each(VIDEO_AND_OTHER)("%s avvises av bildekontrollen (bytene avgjør, ikke deklarert type)", (_label, bytes) => {
    expect(sniffMediaType(bytes)).toBeNull();
    expect(() => inspectImage(bytes)).toThrow(/unsupported_format/);
    expect(() => inspectImage(bytes, { declaredType: "image/jpeg" })).toThrow(/unsupported_format/); // løgn om type hjelper ikke
  });

  it("de tre tillatte stillbildeformatene (jpeg/png/webp) godtas - og ingen annen media type finnes", () => {
    expect(inspectImage(header(0xff, 0xd8, 0xff, 0xe0)).media_type).toBe("image/jpeg");
    expect(inspectImage(header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).media_type).toBe("image/png");
    expect(inspectImage(header(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"))).media_type).toBe("image/webp");
  });

  it("databasen tillater kun stillbilder og én liten rad per hendelse: media_type = 3 bildeformater, byte_length <= 20 MiB, route_policy har ingen strøm-/sky-verdi", () => {
    const sql = readFileSync(join(ROOT, "modules/core/src/db/migrations/134_vision_snapshots.sql"), "utf8");
    expect(/media_type\s+text NOT NULL CHECK \(media_type IN \('image\/jpeg','image\/png','image\/webp'\)\)/.test(sql)).toBe(true);
    expect(/byte_length\s+integer NOT NULL CHECK \(byte_length BETWEEN 1 AND 20971520\)/.test(sql)).toBe(true);
    const cameras = readFileSync(join(ROOT, "modules/core/src/db/migrations/133_vision_cameras.sql"), "utf8");
    expect(/route_policy\s+text NOT NULL CHECK \(route_policy IN \('discard','local_only','store_snapshot'\)\)/.test(cameras)).toBe(true);
  });

  it("NON-VAKUITET: vakten feller syntetiske brudd, ikke kommentarer", () => {
    expect(scanVideo('const url = `${base}/api/camera_proxy_stream/${entity}`;')).toEqual(["camera_proxy_stream (MJPEG-strøm)"]);
    expect(scanVideo('await fetch("rtsp://kamera.lokal/stream1");')).toEqual(["rtsp/rtmp/srt-URL"]);
    expect(scanVideo('spawn("ffmpeg", ["-i", url]); const t = "video/mp4";').sort()).toEqual(["ffmpeg", "videomedietype"]);
    expect(scanVideo('const ws = new WebSocket("ws://ha.lokal/api/websocket");')).toHaveLength(1);
    expect(scanVideo('await ha.callService("camera.record", { filename: "/x.mp4" });')).toEqual(["HA-kamera opptak/strøm-tjenester (skriver filer/åpner strøm)"]);
    expect(scanVideo("// camera_proxy_stream og ffmpeg brukes IKKE\n/* rtsp://x */ const ok = 1;")).toEqual([]);
  });
});

/* ------------------------- 3. ingen egen nettverksvei / leverandør-SDK ------------------------- */

describe("visjonsmodulen har ingen egen nettverksvei og ingen leverandør-SDK (adaptergrensen)", () => {
  // Kode UTEN streng-literaler (kun faktiske kall/importer). `import ... from "x"` leses separat fra rå kilde.
  const NETWORK_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
    ["bar fetch(...)", /(?<![.\w$])fetch\s*\(/],
    ["globalThis/window/self.fetch", /\b(globalThis|window|self)\s*\.\s*fetch\b/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["node:http/https/net/dgram/tls/dns/child_process", /\bfrom\s+["']node:(https?|net|dgram|tls|dns|child_process|worker_threads|cluster)["']/]
  ];
  const importsOf = (source: string): string[] => [...strip(source, true).matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
  const ALLOWED_BARE = new Set(["node:crypto", "node:fs", "node:fs/promises", "node:path", "pg", "zod", "@jarvis/contracts", "@jarvis/core", "@jarvis/memory"]);
  /**
   * Rene TYPE-importer (`import type ... from "node:http"`, kun typer, ingen kjøretidskode) og rene IP-parsere (`import { isIP } from "node:net"`, ingen sokkel) er ufarlige og ikke et nettverksvei; alt annet fra de
   * rå modulene er det.
   */
  const withoutBenignNodeImports = (imports: string): string =>
    imports
      .replace(/\bimport\s+type\b[^;]*?\bfrom\s+["']node:[^"']+["']/g, "")
      .replace(/\bimport\s*\{\s*(?:isIP|isIPv4|isIPv6)(?:\s*,\s*(?:isIP|isIPv4|isIPv6))*\s*\}\s*from\s+["']node:net["']/g, "");
  const scanNetwork = (source: string): string[] => {
    const code = strip(source, false);
    const imports = withoutBenignNodeImports(strip(source, true));
    return NETWORK_TOKENS.filter(([label, pattern]) => pattern.test(label.startsWith("node:") ? imports : code)).map(([label]) => label);
  };
  const disallowedImports = (source: string): string[] => importsOf(source).filter((spec) => !spec.startsWith(".") && !ALLOWED_BARE.has(spec));

  it("ingen bar fetch/XMLHttpRequest/rå nettverks-/prosessmodul i visjonskoden - HTTP går KUN via den innsatte fetch (`this.options.fetch`)", () => {
    const offenders: string[] = [];
    for (const file of visionSources()) {
      const hits = scanNetwork(readFileSync(file, "utf8"));
      if (hits.length > 0) offenders.push(`${rel(file)}: ${hits.join("; ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("repo-bredt (review A-L4): produksjonsfiler som nevner «camera» har ingen bar fetch/globalThis.fetch/XMLHttpRequest (kamerakode henter kun via en innsatt, vaktet fetch)", () => {
    const offenders: string[] = [];
    for (const file of cameraScopedSources()) {
      // Rå node-moduler (node:http m.fl.) er ikke med her: api-serveren (server.ts) nevner «camera» via visjonsrutene og SERVERER over node:http - det er ingen utgående kamerabane.
      const hits = scanNetwork(readFileSync(file, "utf8")).filter((label) => !label.startsWith("node:"));
      if (hits.length > 0) offenders.push(`${rel(file)}: ${hits.join("; ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("kun tillatte importer (relative, node:crypto/fs/path, pg, zod, @jarvis/contracts|core|memory) - aldri leverandør-SDK eller @jarvis/provider-adapters (modellkall går via ModelGateway-porten)", () => {
    const offenders: string[] = [];
    for (const file of walk(VISION_SRC, (f) => f.endsWith(".ts"))) {
      const bad = disallowedImports(readFileSync(file, "utf8"));
      if (bad.length > 0) offenders.push(`${rel(file)}: ${bad.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("package.json har ingen leverandør-/nettverksavhengighet utover kjernepakkene", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "modules/vision/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@jarvis/contracts", "@jarvis/core", "@jarvis/memory", "pg", "zod"]);
  });

  it("NON-VAKUITET: skanneren feller syntetiske brudd, men ikke den innsatte fetch eller kommentarer", () => {
    expect(scanNetwork('const r = await fetch("http://x");')).toEqual(["bar fetch(...)"]);
    expect(scanNetwork("const r = await globalThis.fetch(url);")).toEqual(["globalThis/window/self.fetch"]);
    expect(scanNetwork("const x = new XMLHttpRequest();")).toEqual(["XMLHttpRequest"]);
    expect(scanNetwork('import { request } from "node:https";')).toEqual(["node:http/https/net/dgram/tls/dns/child_process"]);
    expect(scanNetwork('import { spawn } from "node:child_process";')).toHaveLength(1);
    expect(scanNetwork("const r = await this.options.fetch(url, init); // fetch( i en kommentar")).toEqual([]);
    // ufarlige node-importer: ren typeimport og ren IP-parser slipper gjennom; enhver ekte nettverks-/sokkelbruk av samme moduler gjør det ikke
    expect(scanNetwork('import type { IncomingMessage } from "node:http";')).toEqual([]);
    expect(scanNetwork('import { isIP } from "node:net";')).toEqual([]);
    expect(scanNetwork('import { isIP, isIPv6 } from "node:net";')).toEqual([]);
    expect(scanNetwork('import { createConnection } from "node:net";')).toHaveLength(1);
    expect(scanNetwork('import { isIP, connect } from "node:net";')).toHaveLength(1);
    expect(scanNetwork('import http from "node:http";')).toHaveLength(1);
    expect(scanNetwork('import * as net from "node:net";')).toHaveLength(1);
    expect(scanNetwork('import type { Socket } from "node:net"; import { request } from "node:http";')).toHaveLength(1);
    expect(disallowedImports('import OpenAI from "openai"; import { x } from "@jarvis/provider-adapters"; import a from "@anthropic-ai/sdk"; import b from "./ok.ts"; import c from "zod"; import d from "node:crypto";').sort()).toEqual(["@anthropic-ai/sdk", "@jarvis/provider-adapters", "openai"]);
    expect(disallowedImports('const m = await import("undici"); const r = require("axios");').sort()).toEqual(["axios", "undici"]);
  });
});

/* ------------------- 4. kamerabilder når ingen skyadapter (review A-L2) ------------------- */

describe("hver adapterfil med bildemapping har assertNoRestrictedMedia (review A-L2: lag 3 er ikke bare to filer)", () => {
  const ADAPTER_SRC = join(ROOT, "packages/provider-adapters/src");
  /** Uttrykk som BYGGER eller LESER en bildedel mot en leverandør. Ren tekstskanning av koden (kommentarer fjernet, streng-literaler beholdt). */
  const IMAGE_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
    ["type: \"image\" (bildedel i en forespørsel)", /\btype\s*:\s*["']image["']/],
    ["type === \"image\" (leser en bildedel)", /\btype\s*[=!]==?\s*["']image["']/],
    ["inlineData / inline_data (Gemini-bilde)", /\binline_?[dD]ata\b/],
    ["image_url (OpenAI-format)", /\bimage_url\b/],
    ["input_image (OpenAI Responses-format)", /\binput_image\b/],
    ["mimeType (bildedel)", /\bmimeType\b/],
    ["base64 data-URL", /;base64,/]
  ];
  /** Bildemapping er tillatt UTEN assertNoRestrictedMedia kun her: typefila (definerer ContentPart og selve låsen) og den LOKALE adapteren (begrensede bilder er lov kun til lokal modell, og kun med `vision: true`). */
  const ALLOWLIST: Readonly<Record<string, string>> = {
    "packages/provider-adapters/src/types.ts": "definerer ContentPart-typen, hasRestrictedMedia og selve assertNoRestrictedMedia",
    "packages/provider-adapters/src/local-llm.ts": "LOKAL adapter: sender image_url med data-URL kun til et lokalt endepunkt, og kun når `vision: true` (se vakten under)"
  };
  const adapterFiles = (): string[] => readdirSync(ADAPTER_SRC).filter((f) => f.endsWith(".ts")).map((f) => join(ADAPTER_SRC, f));
  const scanImageMapping = (source: string): { tokens: string[]; guarded: boolean } => ({
    tokens: IMAGE_TOKENS.filter(([, pattern]) => pattern.test(strip(source, true))).map(([label]) => label),
    guarded: /\bassertNoRestrictedMedia\s*\(/.test(strip(source, false))
  });

  it("enhver adapterfil som mapper bilder (type: \"image\", inlineData, image_url ...) kaller assertNoRestrictedMedia - ellers kunne en ny skyadapter sende et kamerabilde", () => {
    const offenders: string[] = [];
    const guarded: string[] = [];
    for (const file of adapterFiles()) {
      const { tokens, guarded: ok } = scanImageMapping(readFileSync(file, "utf8"));
      if (tokens.length === 0 || ALLOWLIST[rel(file)] !== undefined) continue;
      if (ok) guarded.push(rel(file));
      else offenders.push(`${rel(file)}: ${tokens.join("; ")}`);
    }
    expect(offenders).toEqual([]);
    // non-vakuitet mot det ekte repoet: de to skyadapterne med ekte bildestøtte er funnet og vokter - en ny bildeadapter må dukke opp her bevisst
    expect(guarded.sort()).toEqual(["packages/provider-adapters/src/anthropic.ts", "packages/provider-adapters/src/gemma.ts"]);
  });

  it("allowlisten er ikke foreldet: begge filene finnes og har fortsatt bildemapping - og kun den lokale adapteren konstrueres med `vision: true`, kun under navnet local_vision og kun i vision-runtime.ts", () => {
    for (const path of Object.keys(ALLOWLIST)) expect(scanImageMapping(readFileSync(join(ROOT, path), "utf8")).tokens.length, path).toBeGreaterThan(0);
    const constructors = productionSources().filter((file) => /\bvision\s*:\s*true\b/.test(strip(readFileSync(file, "utf8"), false)));
    expect(constructors.map(rel)).toEqual(["apps/api/src/vision-runtime.ts"]);
    expect(strip(readFileSync(join(ROOT, "apps/api/src/vision-runtime.ts"), "utf8"), true)).toMatch(/"local_vision", undefined, \{ vision: true \}/);
  });

  it("NON-VAKUITET: skanneren feller en syntetisk skyadapter med bildemapping uten låsen, godtar en som har den, og ser ikke kommentarer", () => {
    const naive = 'const part = { type: "image", source: { data } }; const g = { inlineData: { mimeType, data } }; const o = { type: "image_url", image_url: { url: `data:${t};base64,${d}` } };';
    expect(scanImageMapping(naive)).toMatchObject({ guarded: false });
    expect(scanImageMapping(naive).tokens).toHaveLength(5);
    expect(scanImageMapping('assertNoRestrictedMedia(this.name, request); const part = { type: "image" };')).toEqual({ tokens: ["type: \"image\" (bildedel i en forespørsel)"], guarded: true });
    expect(scanImageMapping("// assertNoRestrictedMedia(x) er ikke et kall, og { type: \"image\", image_url } står i en kommentar\nconst ok = 1;")).toEqual({ tokens: [], guarded: false });
    expect(scanImageMapping('const x = { type: "text", text }; const y = parts.filter((p) => p.type === "text");').tokens).toEqual([]);
  });
});
