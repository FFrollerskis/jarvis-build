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

/** Biometri-/ansiktsgjenkjenningsord (hele delord - «surface» og «facebook» er IKKE treff). */
const isBiometricWord = (w: string): boolean => /^(faces?|facial|faceprints?|faceid|ansikt\w*|biometri\w*|voiceprints?|gait)$/.test(w);
/** Ekstra for visjonsmodulen: gjenkjenning/identifisering av personer. («fingerprint» er hash-fingeravtrykk i flere moduler og er bevisst IKKE med.) */
const isRecognitionWord = (w: string): boolean => /^(recogni[sz](e|es|ed|ing|ition)|identify|identifies|identified|identifying|identification)$/.test(w);

function scanIdentifiers(source: string, extra: (w: string) => boolean = () => false): string[] {
  const code = strip(source, false);
  const hits = new Set<string>();
  for (const id of code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (subwords(id).some((w) => isBiometricWord(w) || extra(w))) hits.add(id);
  return [...hits];
}

function scanLiterals(source: string): string[] {
  const code = strip(source, true);
  const literals = code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
  return literals.filter((literal) => subwords(literal).some(isBiometricWord));
}

/** SQL: kommentarer fjernes; ALLE ord (også streng-verdier i CHECK) delord-skannes. `scope` begrenser til setninger som nevner visjons-/vektortabeller. */
function scanSql(sql: string, scope: "all" | "vision"): string[] {
  const clean = sql.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
  const hits = new Set<string>();
  for (const statement of clean.split(";")) {
    if (scope === "vision" && !/vision_|memory_vectors/i.test(statement)) continue;
    for (const word of subwords(statement)) if (isBiometricWord(word)) hits.add(word);
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
  const scanNetwork = (source: string): string[] => {
    const code = strip(source, false);
    const imports = strip(source, true);
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
    expect(disallowedImports('import OpenAI from "openai"; import { x } from "@jarvis/provider-adapters"; import a from "@anthropic-ai/sdk"; import b from "./ok.ts"; import c from "zod"; import d from "node:crypto";').sort()).toEqual(["@anthropic-ai/sdk", "@jarvis/provider-adapters", "openai"]);
    expect(disallowedImports('const m = await import("undici"); const r = require("axios");').sort()).toEqual(["axios", "undici"]);
  });
});
