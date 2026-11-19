import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VisionCameraService, type VisionCamera } from "../src/cameras.ts";
import { VisionClassifier, type ClassificationOutcome, type VisionDetection } from "../src/classifier.ts";
import { VisionInventoryService, type SightingInput } from "../src/inventory.ts";
import { isInventoryLabel, isStorableObjectLabel } from "../src/labels.ts";
import { VisionIngestPipeline, type CapturedEventSpec, type IngestContext } from "../src/pipeline.ts";
import { VisionService } from "../src/service.ts";
import { detectionsJson, makeJpeg, ScriptedGateway, seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";
import {
  type AnyForm,
  constraintExpression,
  constraintVerdicts,
  describeLabels,
  hex,
  INV_CHECK,
  jsRejectedCodePoints,
  normalizerOutputs,
  OBS_CHECK,
  rejectedCodePoints,
  rejectedIndexes,
  seededRandom,
  SQL_FORMS,
  SQL_WORD_FORMS,
  type SweepForm,
  type WordForm
} from "./support/label-sweep.ts";
import type pg from "pg";

/**
 * WP-G3 (D-465), mini-fiks-runden, review delta D1 (B MEDIUM-D1 + A LOW-D2): etikett-CHECK-ene mot ekte Postgres i klynger med ULIK locale.
 *
 * Regresjonen: den strenge inventar-CHECK-en (135) brukte `[:punct:]`/`[:cntrl:]`. Disse klassene er locale-avhengige - i en glibc-UTF-8-locale (produksjonsbildet) regnes tall-tegn av kategori No
 * (U+09F4 ...) som tegnsetting - så databasen avviste etiketter `normalizeObjectLabel` selv lager (~1500 av ~286 000 kodepunkt), INSERT ga 23514 og HELE hendelsestransaksjonen rullet tilbake.
 * Sandkassens standardklynge har locale `C` (ASCII-bare klasser), så den forrige sveipen så ingenting. Her kjører ALLE sveip i to klynger: `C` og `C.UTF-8` (Unicode-bevisst ctype, samme
 * oppførsel som `en_US.UTF-8` for disse klassene - målt av begge reviewerne).
 *
 * Bevist: (1) alt `normalizeObjectLabel` kan produsere over HELE Unicode-rommet (alene, inni og på begge sider av en bokstav) består BEGGE CHECK-ene i begge locales, (2) JS-reglene og SQL-CHECK-ene
 * avviser NØYAKTIG samme kodepunkter (den milde: databasen er aldri strengere enn JS-skjemaet), (3) settet av avviste kodepunkter er LIK i begge locales i alle fire former (regelen er locale-uavhengig),
 * (4) strukturreglene (lengde, ord, mellomrom/bindestrek) er enige, (5) pipelinen taper aldri basishendelsen på grunn av en etikett som ikke kan bli inventar - og svelger ingen annen feil,
 * (6) ORDTELLINGEN (review delta2 A LOW-E1) er identisk i JS og i den milde CHECK-en: kun ASCII-mellomrom skiller og trimmes, et Unicode-mellomrom er en vanlig tegnverdi. Bevist med tre ekstra sveip over hele
 * Unicode-rommet (kodepunktet ved kanten av en fire-ords etikett, og limt mellom to ord), eksplisitte strenger og en seedet fuzz mot selve CHECK-en - JS skal aldri godta en etikett 133 avviser (23514).
 */
const LOCALES = ["C", "C.UTF-8"] as const;
type Locale = (typeof LOCALES)[number];
const FORMS = Object.keys(SQL_FORMS) as SweepForm[];
const WORD_FORMS = Object.keys(SQL_WORD_FORMS) as WordForm[];
const CHECKS = [INV_CHECK, OBS_CHECK] as const;

const clusters = new Map<Locale, VisionDb>();
let outputs: string[] = [];
const jsRejected = { inventory: {} as Partial<Record<AnyForm, number[]>>, observation: {} as Partial<Record<AnyForm, number[]>> };
const jsRejectedOf = (kind: "inventory" | "observation", form: AnyForm): number[] => jsRejected[kind][form] as number[];

const dbOf = (locale: Locale): VisionDb => clusters.get(locale) as VisionDb;

let available = true;

beforeAll(async () => {
  try {
    for (const locale of LOCALES) clusters.set(locale, await startVisionDb(`g3loc-${locale === "C" ? "c" : "u8"}`, { locale }));
  } catch (err) {
    // Linux (CI, utviklings- og produksjonsbildet) MÅ kunne starte begge klyngene - da feiler filen høyt. Andre plattformer (f.eks. en Windows-vert) har ikke `C.UTF-8`: sveipet hoppes da over med en SYNLIG melding (aldri stille).
    if (process.platform === "linux") throw err;
    available = false;
    console.warn(`g3-label-locale hoppet over på ${process.platform}: klyngene kunne ikke startes med locale C/C.UTF-8 (${String(err).slice(0, 120)})`);
    return;
  }
  outputs = normalizerOutputs();
  for (const form of FORMS) {
    jsRejected.inventory[form] = jsRejectedCodePoints(isInventoryLabel, form);
    jsRejected.observation[form] = jsRejectedCodePoints(isStorableObjectLabel, form);
  }
  for (const form of WORD_FORMS) jsRejected.observation[form] = jsRejectedCodePoints(isStorableObjectLabel, form);
}, 900_000);

afterAll(async () => {
  for (const db of clusters.values()) await db.stop();
}, 180_000);

beforeEach((context) => {
  if (!available) context.skip();
});

const diff = (a: readonly number[], b: readonly number[]): number[] => {
  const set = new Set(b);
  return a.filter((x) => !set.has(x));
};

/** Sveipet kjøres én gang per (locale, CHECK, form) og gjenbrukes mellom testene. */
const swept = new Map<string, number[]>();
async function sqlRejected(locale: Locale, check: string, form: AnyForm): Promise<number[]> {
  const key = `${locale}|${check}|${form}`;
  let rejected = swept.get(key);
  if (rejected === undefined) {
    rejected = await rejectedCodePoints(dbOf(locale).admin, check, form);
    swept.set(key, rejected);
  }
  return rejected;
}

describe("klyngene", () => {
  it("har locale-en testen sier, og KUN den Unicode-bevisste regner tall-tegn av kategori No som tegnsetting (det som gjorde den gamle regelen locale-avhengig)", async () => {
    const norm = (s: string): string => s.toLowerCase().replace("-", "");
    for (const locale of LOCALES) {
      const admin = dbOf(locale).admin;
      expect(norm(String((await admin.query(`SELECT datctype FROM pg_database WHERE datname = current_database()`)).rows[0].datctype))).toBe(norm(locale));
      expect((await admin.query(`SHOW server_encoding`)).rows[0].server_encoding).toBe("UTF8");
    }
    const bengaliCurrencyNumerator = 0x9f4; // kategori No; JS: \p{N}, aldri fjernet av normaliseringen
    const punct = async (locale: Locale): Promise<boolean> => (await dbOf(locale).admin.query(`SELECT (chr($1::int) ~ '[[:punct:]]') AS p`, [bengaliCurrencyNumerator])).rows[0].p as boolean;
    expect(await punct("C")).toBe(false);
    expect(await punct("C.UTF-8")).toBe(true);
  });
});

describe("sveip over HELE Unicode-rommet (alene, inni og på begge sider av en bokstav), i begge locales", () => {
  it("normaliseringen produserer mange etiketter (sveipet er ikke tomt), og ingen av dem bryter JS-reglene", () => {
    expect(outputs.length).toBeGreaterThan(100_000);
    const jsBad = outputs.filter((label) => !isInventoryLabel(label) || !isStorableObjectLabel(label));
    expect(jsBad.length, describeLabels(jsBad)).toBe(0);
  });

  for (const locale of LOCALES) {
    it(`${locale}: HVER etikett normalizeObjectLabel kan lage består BÅDE den milde (133) og den strenge (135) CHECK-en - en etikett databasen avviser rullet tilbake hele hendelsen`, async () => {
      const admin = dbOf(locale).admin;
      for (const check of CHECKS) {
        const bad = (await rejectedIndexes(admin, check, outputs)).map((index) => outputs[index] as string);
        expect(bad.length, `${locale} ${check} avviser etiketter normaliseringen lager: ${describeLabels(bad)}`).toBe(0);
      }
    }, 300_000);

    it(`${locale}: den STRENGE CHECK-en (135) og isInventoryLabel avviser NØYAKTIG de samme kodepunktene i alle fire former`, async () => {
      for (const form of FORMS) {
        const sql = await sqlRejected(locale, INV_CHECK, form);
        const js = jsRejectedOf("inventory", form);
        expect(sql.length, `${form}: sveipet må ha funnet noe`).toBeGreaterThan(4000);
        expect(diff(sql, js).map(hex), `${locale} ${form}: SQL avviser, JS godtar`).toEqual([]);
        expect(diff(js, sql).map(hex), `${locale} ${form}: JS avviser, SQL godtar`).toEqual([]);
      }
    }, 300_000);

    it(`${locale}: den MILDE CHECK-en (133) og isStorableObjectLabel avviser NØYAKTIG de samme kodepunktene (a<tegn>a, <tegn>b, b<tegn>); alene er databasen aldri strengere enn JS-skjemaet`, async () => {
      for (const form of FORMS) {
        const sql = await sqlRejected(locale, OBS_CHECK, form);
        const js = jsRejectedOf("observation", form);
        expect(sql.length, `${form}: sveipet må ha funnet noe`).toBeGreaterThan(4000);
        expect(diff(sql, js).map(hex), `${locale} ${form}: SQL avviser, JS godtar (databasen skal aldri være strengere enn skjemaet)`).toEqual([]);
        const jsOnly = diff(js, sql);
        if (form !== "bare") {
          expect(jsOnly.map(hex), `${locale} ${form}: JS avviser, SQL godtar`).toEqual([]);
        } else {
          // Eneste kjente forskjell: en etikett av KUN ett ikke-ASCII tegnsettings-/symbol-/mellomromstegn (JS er Unicode-bevisst, SQL-bokstavkravet er ASCII-basert og dermed et løsere nett).
          for (const cp of jsOnly) expect(cp > 0x7f && /^[\s\p{P}\p{S}]$/u.test(String.fromCodePoint(cp)), `${locale} uventet forskjell ${hex(cp)}`).toBe(true);
          expect(jsOnly.length).toBeGreaterThan(100);
        }
      }
    }, 300_000);

    it(`${locale}: ORDTELLING (delta2 A-E1): den milde CHECK-en (133) og isStorableObjectLabel avviser NØYAKTIG de samme kodepunktene ved kanten av en fire-ords etikett og limt mellom to ord (kun ASCII-mellomrom skiller/trimmes)`, async () => {
      for (const form of WORD_FORMS) {
        const sql = await sqlRejected(locale, OBS_CHECK, form);
        const js = jsRejectedOf("observation", form);
        // Begge retninger og ingen unntak (alle formene har ASCII-bokstaver, så det ett-veis bokstavgapet kan ikke avgjøre noe): JS godtar ALDRI det 133 avviser (23514), og avviser ikke det 133 godtar.
        expect(diff(js, sql).map(hex), `${locale} ${form}: JS avviser, SQL godtar`).toEqual([]);
        expect(diff(sql, js).map(hex), `${locale} ${form}: SQL avviser, JS godtar (skrivingen ville feilet med 23514)`).toEqual([]);
        expect(sql).toEqual(js);
      }
      // Forankring (sveipet er ikke tomt og har den forventede formen): ved kanten av en fire-ords etikett er ASCII-mellomrom det ENESTE tegnet som holder den på fire ord (det trimmes) - hvert annet kodepunkt, også
      // NBSP/U+2003/U+3000, gir et femte «ord» og avvises. Limt mellom to ord skiller kun ASCII-mellomrom; et Unicode-mellomrom er en vanlig tegnverdi og godtas.
      const everything = (rejected: readonly number[]): number[] => {
        const set = new Set(rejected);
        const accepted: number[] = [];
        for (let cp = 1; cp <= 0x10ffff; cp++) if (!(cp >= 0xd800 && cp <= 0xdfff) && !set.has(cp)) accepted.push(cp);
        return accepted;
      };
      expect(everything(await sqlRejected(locale, OBS_CHECK, "edgeLead"))).toEqual([0x20]);
      expect(everything(await sqlRejected(locale, OBS_CHECK, "edgeTrail"))).toEqual([0x20]);
      const glued = await sqlRejected(locale, OBS_CHECK, "glued");
      expect(glued).toContain(0x20);
      for (const unicodeSpace of [0xa0, 0x1680, 0x2000, 0x2003, 0x2009, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]) expect(glued, `U+${unicodeSpace.toString(16)} er en tegnverdi, ikke et skille`).not.toContain(unicodeSpace);
      for (const forbidden of [0x09, 0x0a, 0x0d, 0x85, 0x200b, 0xfeff]) expect(glued).toContain(forbidden);
    }, 300_000);
  }

  it("settet av avviste kodepunkter er LIK i begge locales for begge CHECK-er i ALLE fire former (regelen er locale-uavhengig: ingen POSIX-klasse avgjør utfallet)", async () => {
    for (const check of CHECKS) {
      for (const form of FORMS) {
        const inC = await sqlRejected("C", check, form);
        const inUtf8 = await sqlRejected("C.UTF-8", check, form);
        expect(diff(inUtf8, inC).map(hex), `${check} ${form}: avvises KUN i C.UTF-8`).toEqual([]);
        expect(diff(inC, inUtf8).map(hex), `${check} ${form}: avvises KUN i C`).toEqual([]);
      }
    }
    for (const form of WORD_FORMS) {
      const inC = await sqlRejected("C", OBS_CHECK, form);
      const inUtf8 = await sqlRejected("C.UTF-8", OBS_CHECK, form);
      expect(diff(inUtf8, inC).map(hex), `${OBS_CHECK} ${form}: avvises KUN i C.UTF-8`).toEqual([]);
      expect(diff(inC, inUtf8).map(hex), `${OBS_CHECK} ${form}: avvises KUN i C`).toEqual([]);
    }
  }, 300_000);

  it("ingen av de to CHECK-ene inneholder locale-avhengige POSIX-klasser (`[:punct:]`, `[:cntrl:]`, `[:digit:]`, `[:space:]`, `[:alpha:]` ...)", async () => {
    for (const locale of LOCALES) {
      for (const check of CHECKS) expect(await constraintExpression(dbOf(locale).admin, check), `${locale}: ${check}`).not.toMatch(/\[:[a-z]+:\]/);
    }
  });
});

describe("strukturreglene (lengde, ordtall, mellomrom/bindestrek) er enige mellom JS og SQL i begge locales", () => {
  const cp = (code: number): string => String.fromCodePoint(code);
  const astralLetter = cp(0x10428); // DESERET SMALL LETTER LONG I: bokstav utenfor BMP (2 UTF-16-enheter, 1 tegn)
  const accepted = [
    "nøkler", "coffee-mug", "a1", "1a", "ladekabel usb c", "en to tre fire", "a-b-c-d", "x".repeat(64), astralLetter.repeat(64), `a${cp(0x9f4)}a`, `${cp(0x9f4)}b`, `${cp(0xaa)}`, "a" + cp(0xb2), "å", "日本語", "a b"
  ];
  const rejected = [
    "", " ", "-", "12", "1 2", "1-2", "---", "x".repeat(65), astralLetter.repeat(65), "en to tre fire fem", "a  b", " a", "a ", "-a", "a-", "a--b", "a- b", "a -b", "a\tb", "a\nb",
    "sekk's", "keys.", "a,b", "(a)", "a_b", "a/b", "<a>", `a${cp(0x2019)}b`, `a${cp(0x2014)}b`, `a${cp(0xa0)}b`, `a${cp(0x3000)}b`,
    `a${cp(0x200b)}b`, `a${cp(0xad)}b`, `a${cp(0xe0041)}b`, "a×b", "a÷b", "a´b", "a·b", "«a»", "¿a"
  ];

  it("de eksplisitte listene har de forventede utfallene i JS (SQL kan ikke bekrefte noe JS og SQL tar feil om samtidig)", () => {
    for (const label of accepted) expect(isInventoryLabel(label), describeLabels([label])).toBe(true);
    for (const label of rejected) expect(isInventoryLabel(label), describeLabels([label])).toBe(false);
  });

  for (const locale of LOCALES) {
    it(`${locale}: SQL-CHECK-en (135) gir samme utfall som isInventoryLabel for alle strengene`, async () => {
      const all = [...accepted, ...rejected];
      const rejectedByDb = new Set((await rejectedIndexes(dbOf(locale).admin, INV_CHECK, all)).map((index) => all[index] as string));
      for (const label of all) expect(!rejectedByDb.has(label), `${locale} SQL for ${describeLabels([label])}`).toBe(isInventoryLabel(label));
    });
  }

  // Den milde regelen (133): lengde, ordtall (ASCII-mellomrom), bokstavkrav og forbudte tegn - uten krav til små bokstaver, tegnsetting eller mellomromsform.
  const nbsp = cp(0xa0);
  const mildAccepted = [
    "Nøkler", "men's watch", "T-shirt.", "sekk (rød)", "  kaffekopp  ", "a1", "a  b", "-a", "x".repeat(64), astralLetter.repeat(64), "en to tre fire", "日本語", `a${cp(0x9f4)}a`, `${cp(0x9f4)}b`, "١٢٣", cp(0xaa),
    // Ordtelling (delta2 A-E1): flere mellomrom på rad, og ledende/etterfølgende ASCII-mellomrom, teller som ETT skille / trimmes (feller en CHECK som deler på ÉTT mellomrom eller ikke trimmer).
    "a  b c d", "a b  c d", "a b c  d", "a   b   c   d", " a b c d", "a b c d ", "  a b c d  ", " a  b c d ",
    // Et Unicode-mellomrom er en vanlig tegnverdi, ikke et skille: fire ord selv om NBSP står limt til et ord.
    `a${nbsp}b c d e`, `${nbsp}a b c d`, `a b c d${nbsp}`, `a${cp(0x2003)}b c d e`, `a${cp(0x3000)}b c d e`, `a b${nbsp}c d`
  ];
  const mildRejected = [
    "", "   ", "12345", "...!?", "1 2", "- -", "x".repeat(65), astralLetter.repeat(65), "en to tre fire fem", "  en to  tre fire fem ", "<a>", "a|b", "x=y", "a\tb", "a\nb",
    `a${cp(0x200b)}b`, `a${cp(0xad)}b`, `a${cp(0xe0041)}b`, `a${cp(0x202e)}b`, `a${cp(0xfeff)}b`, `a${cp(0x85)}b`,
    // Fem ord (også med doble/ledende/etterfølgende mellomrom) avvises.
    "a b c d e", "a  b c d  e", "  a b c d e  ", " a b  c d e",
    // E1: JS sin trim()/\s ga fire ord for et NBSP (eller annet Unicode-mellomrom) skilt fra fire ord med ASCII-mellomrom; databasen ser fem (NBSP-en er et eget «ord»).
    `${nbsp} a b c d`, `a b c d ${nbsp}`, `${cp(0x2003)} a b c d`, `a b c d ${cp(0x3000)}`, `${cp(0x202f)} a b c d`, `a b c d  ${nbsp}`, `${nbsp} ${nbsp} a b c`
  ];
  // Eneste forskjell: en etikett av KUN ikke-ASCII tegnsetting/symboler. JS-skjemaet avviser den (Unicode-bevisst), databasen godtar den (ASCII-basert bokstavkrav, løsere nett - aldri strengere enn skjemaet).
  const mildGap = ["«»", "¿¡", cp(0x2014), "×÷", cp(0xa0), `${cp(0x2003)}`];

  it("de eksplisitte listene for den milde regelen har de forventede utfallene i JS (og gapet er ett-veis)", () => {
    for (const label of mildAccepted) expect(isStorableObjectLabel(label), describeLabels([label])).toBe(true);
    for (const label of mildRejected) expect(isStorableObjectLabel(label), describeLabels([label])).toBe(false);
    for (const label of mildGap) expect(isStorableObjectLabel(label), describeLabels([label])).toBe(false);
  });

  for (const locale of LOCALES) {
    it(`${locale}: SQL-CHECK-en (133) gir samme utfall som isStorableObjectLabel for alle strengene, bortsett fra det ett-veis gapet (databasen godtar ikke-ASCII tegnsetting-bare etiketter)`, async () => {
      const all = [...mildAccepted, ...mildRejected, ...mildGap];
      const rejectedByDb = new Set((await rejectedIndexes(dbOf(locale).admin, OBS_CHECK, all)).map((index) => all[index] as string));
      for (const label of [...mildAccepted, ...mildRejected]) expect(!rejectedByDb.has(label), `${locale} SQL for ${describeLabels([label])}`).toBe(isStorableObjectLabel(label));
      for (const label of mildGap) expect(rejectedByDb.has(label), `${locale} gap ${describeLabels([label])}`).toBe(false);
    });
  }

  // Seedet fuzz (delta2 A-E1): tilfeldige strenger av ASCII- og Unicode-mellomrom, bokstaver, tall og tegnsetting (alle tillatt av tegnklassen). Hver streng har MINST ÉN ASCII-bokstav, så det ett-veis bokstavgapet
  // aldri avgjør utfallet, og ordtellingen (ASCII-mellomrom som eneste skille, trimming av kun ASCII-mellomrom) skal da være IDENTISK i JS og i selve CHECK-en. Samme strenger i begge locales; samme strenger i hver kjøring.
  const FUZZ_COUNT = 30_000;
  const fuzzStrings = ((): string[] => {
    const random = seededRandom(0x6a3e1);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const letters = ["a", "b", "é", astralLetter, "1", "-", ".", cp(0x2019)];
    const unicodeSpaces = [nbsp, cp(0x2003), cp(0x3000), cp(0x202f), cp(0x2028)];
    // Kanten: 0-2 mellomrom, hvert enten ASCII eller Unicode (i alle rekkefølger: «NBSP + ASCII» er nettopp E1-tilfellet).
    const edge = (): string => Array.from({ length: Math.floor(random() * 3) }, () => (random() < 0.6 ? " " : pick(unicodeSpaces))).join("");
    const out: string[] = [];
    for (let i = 0; i < FUZZ_COUNT; i++) {
      let label = edge();
      const words = 2 + Math.floor(random() * 5); // 2..6 ASCII-skilte «ord»
      for (let word = 0; word < words; word++) {
        if (word > 0) label += " ".repeat(1 + Math.floor(random() * 2)); // ett eller to ASCII-mellomrom
        if (word === 0) label += "a"; // minst én ASCII-bokstav i hver streng
        for (let k = 0, length = 1 + Math.floor(random() * 3); k < length; k++) label += random() < 0.15 ? pick(unicodeSpaces) : pick(letters); // et Unicode-mellomrom INNI et ord er ikke et skille
      }
      out.push(label + edge());
    }
    return out;
  })();
  const asciiWords = (label: string): number => label.split(" ").filter((word) => word.length > 0).length;

  it("fuzzen dekker grensen mellom fire og fem ord (ikke tom): minst 1000 strenger med nøyaktig fire og minst 1000 med nøyaktig fem ASCII-ord, og minst 1000 med et Unicode-mellomrom", () => {
    expect(fuzzStrings.filter((label) => asciiWords(label) === 4).length).toBeGreaterThan(1000);
    expect(fuzzStrings.filter((label) => asciiWords(label) === 5).length).toBeGreaterThan(1000);
    expect(fuzzStrings.filter((label) => [...label].some((ch) => ch !== " " && /^\s$/u.test(ch))).length).toBeGreaterThan(1000);
    expect(fuzzStrings.every((label) => label.includes("a"))).toBe(true);
  });

  for (const locale of LOCALES) {
    it(`${locale}: seedet fuzz (${FUZZ_COUNT} strenger) mot selve CHECK-en (133): JS godtar ALDRI det CHECK-en avviser (23514), og avviser ikke det CHECK-en godtar`, async () => {
      const verdicts = await constraintVerdicts(dbOf(locale).admin, OBS_CHECK, fuzzStrings);
      const jsAcceptsDbRejects: string[] = [];
      const jsRejectsDbAccepts: string[] = [];
      fuzzStrings.forEach((label, index) => {
        const js = isStorableObjectLabel(label);
        if (js && !verdicts[index]) jsAcceptsDbRejects.push(label);
        if (!js && verdicts[index]) jsRejectsDbAccepts.push(label);
      });
      expect(jsAcceptsDbRejects.length, `${locale}: JS godtar, CHECK avviser: ${describeLabels(jsAcceptsDbRejects)}`).toBe(0);
      expect(jsRejectsDbAccepts.length, `${locale}: JS avviser, CHECK godtar: ${describeLabels(jsRejectsDbAccepts)}`).toBe(0);
      const accepted = verdicts.filter(Boolean).length;
      expect(accepted, "fuzzen har godtatte strenger").toBeGreaterThan(3000);
      expect(fuzzStrings.length - accepted, "fuzzen har avviste strenger").toBeGreaterThan(3000);
    }, 120_000);
  }
});

/** Lokal modell-dobbel: kun `classify` brukes av pipelinen. Gir de gitte (allerede «normaliserte») deteksjonene uten å gå via normaliseringen. */
function stubClassifier(detections: VisionDetection[]): VisionClassifier {
  const outcome: ClassificationOutcome = { status: "classified", classifier: "stub/vl-test", detections, dropped: 0 };
  return { classify: async (): Promise<ClassificationOutcome> => outcome } as unknown as VisionClassifier;
}

class SpyInventory extends VisionInventoryService {
  calls: SightingInput[] = [];
  failWith: Error | null = null;
  override async recordSightingInTransaction(client: pg.PoolClient, input: SightingInput): Promise<void> {
    this.calls.push(input);
    if (this.failWith !== null) throw this.failWith;
    return super.recordSightingInTransaction(client, input);
  }
}

describe("pipelinen: en etikett som ikke kan bli inventar tar aldri basishendelsen med seg (C.UTF-8-klyngen, der den opprinnelige feilen viste seg)", () => {
  let db: VisionDb;
  let ctx: IngestContext;
  let vision: VisionService;
  let inventory: SpyInventory;
  let camera: VisionCamera;
  let room = "";
  let tenant = "";
  let owner = "";
  const clock = new Date("2026-11-19T12:00:00.000Z");
  let seq = 0;

  beforeAll(async () => {
    if (!available) return; // klyngene finnes ikke på denne plattformen: alle testene i filen hoppes over (se øverst)
    db = dbOf("C.UTF-8");
    const seeded = await seedTenant(db, "g3loc-t1");
    tenant = seeded.tenant;
    owner = seeded.owner;
    vision = new VisionService(db.app);
    inventory = new SpyInventory(db.app, { now: () => clock });
    room = (await vision.createRoom(tenant, "home", { person_id: owner, name: "Stua" })).room_id;
    camera = await new VisionCameraService(db.app).registerCamera(tenant, "home", {
      person_id: owner, label: "Inngang", source_type: "home_assistant", source_ref: "camera.inngang", trigger_entities: ["binary_sensor.motion"], zone_kind: "home", route_policy: "local_only", cooldown_seconds: 30, room_id: room
    });
    ctx = { tenant_id: tenant, memory_space: "home", person_id: owner, task_id: "task-g3-locale", session_id: "sess-g3-locale" };
  }, 120_000);

  const spec = (): CapturedEventSpec => ({
    source_type: "home_assistant", source_event_id: `binary_sensor.motion@loc-${++seq}`, base_event_type: "motion_detected", observed_at: clock.toISOString(), age_ms: 1_000, skipCooldown: true,
    getImage: async () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" })
  });
  const pipelineWith = (classifier: VisionClassifier): VisionIngestPipeline => new VisionIngestPipeline({ pool: db.app, vision, classifier, inventory, enabled: true, storeSnapshots: false, now: () => clock });
  const inventoryLabels = async (): Promise<string[]> => (await inventory.list(tenant, "home", owner, { roomId: room })).map((item) => item.object_label).sort();
  const storedLabels = async (ids: string[]): Promise<Array<string | null>> =>
    ((await db.admin.query(`SELECT object_label FROM vision_event_observations WHERE observation_id = ANY($1) ORDER BY event_type, object_label NULLS FIRST`, [ids])).rows as Array<{ object_label: string | null }>).map((r) => r.object_label);

  it("REGRESJON: etiketten «a<U+09F4>a» (tall-tegn, kategori No) lagres ende-til-ende som hendelse, objekthendelse OG inventar (den gamle CHECK-en avviste den og tapte hele hendelsen)", async () => {
    const label = `a${String.fromCodePoint(0x9f4)}a`;
    const gateway = new ScriptedGateway();
    gateway.text = detectionsJson([{ event_type: "object_detected", object_label: label, confidence: 0.9 }]);
    const out = await pipelineWith(new VisionClassifier({ gateway })).processCaptured(ctx, camera, spec());
    expect(out).toMatchObject({ status: "recorded", classification_status: "classified", detection_count: 1 });
    expect(out.observation_ids).toHaveLength(2);
    expect(out.notes.filter((note) => note.startsWith("inventory_"))).toEqual([]);
    expect(await storedLabels(out.observation_ids)).toEqual([null, label]);
    expect(await inventoryLabels()).toContain(label);
  });

  it("en etikett som er gyldig for hendelsen (mild CHECK) men IKKE har inventarform («sekk's»): basishendelsen og objekthendelsen lagres, INVENTAR hoppes over for den raden - og tjenesten kalles aldri med den", async () => {
    inventory.calls = [];
    const out = await pipelineWith(
      stubClassifier([
        { event_type: "object_detected", object_label: "sekk's", confidence: 0.9 },
        { event_type: "object_detected", object_label: "men's", confidence: 0.85 },
        { event_type: "object_detected", object_label: "kaffekopp", confidence: 0.8 }
      ])
    ).processCaptured(ctx, camera, spec());
    expect(out).toMatchObject({ status: "recorded", detection_count: 3 });
    expect(out.observation_ids).toHaveLength(4);
    expect(out.notes).toContain("inventory_label_invalid");
    expect(out.notes.filter((note) => note === "inventory_label_invalid")).toHaveLength(1); // to avviste etiketter i samme hendelse gir ÉN note
    expect(await storedLabels(out.observation_ids)).toEqual([null, "kaffekopp", "men's", "sekk's"]);
    expect(inventory.calls.map((call) => call.objectLabel)).toEqual(["kaffekopp"]);
    expect(await inventoryLabels()).toContain("kaffekopp");
    expect(await inventoryLabels()).not.toContain("sekk's");
    expect(await inventoryLabels()).not.toContain("men's");
  });

  it("databasen avviser en etikett JS-regelen godtok (CHECK strammet inn / driftet): KUN inventarskrivingen rulles tilbake (savepoint) - hendelsene, og neste objekts inventar, består", async () => {
    inventory.calls = [];
    const original = await constraintExpression(db.admin, INV_CHECK);
    await db.admin.query(`ALTER TABLE vision_inventory_items DROP CONSTRAINT ${INV_CHECK}`);
    // NOT VALID: den strammere regelen gjelder nye rader, og trenger ikke å validere radene tidligere tester la inn.
    await db.admin.query(`ALTER TABLE vision_inventory_items ADD CONSTRAINT ${INV_CHECK} CHECK (object_label <> 'driftet') NOT VALID`);
    try {
      const out = await pipelineWith(
        stubClassifier([
          { event_type: "object_detected", object_label: "driftet", confidence: 0.9 },
          { event_type: "object_detected", object_label: "sekk", confidence: 0.8 }
        ])
      ).processCaptured(ctx, camera, spec());
      expect(out).toMatchObject({ status: "recorded", detection_count: 2 });
      expect(out.observation_ids).toHaveLength(3);
      expect(out.notes).toContain("inventory_label_rejected");
      expect(inventory.calls.map((call) => call.objectLabel).sort()).toEqual(["driftet", "sekk"]);
      expect(await storedLabels(out.observation_ids)).toEqual([null, "driftet", "sekk"]);
      expect(await inventoryLabels()).toContain("sekk");
      expect(await inventoryLabels()).not.toContain("driftet");
    } finally {
      await db.admin.query(`ALTER TABLE vision_inventory_items DROP CONSTRAINT ${INV_CHECK}`);
      await db.admin.query(`ALTER TABLE vision_inventory_items ADD CONSTRAINT ${INV_CHECK} CHECK ${original}`);
    }
    // Gjenopprettet: samme uttrykk (parentesene kan avvike, tolkeren slår sammen nøstede AND), og den strenge regelen gjelder igjen.
    const strip = (expr: string): string => expr.replace(/[()\s]/g, "");
    expect(strip(await constraintExpression(db.admin, INV_CHECK))).toBe(strip(original));
    expect((await rejectedIndexes(db.admin, INV_CHECK, ["sekk's", "driftet", "sekk"])).sort()).toEqual([0]);
  });

  it("savepointet er IKKE et «svelg alt»: enhver annen feil i inventarskrivingen (FK, en annen CHECK) ruller hele hendelsen tilbake som før (`failed`, ingenting lagret)", async () => {
    for (const [code, constraint] of [["23503", "vision_inventory_room_fkey"], ["23514", "vision_inventory_items_confidence_check"], ["23514", undefined]] as const) {
      const s = spec();
      inventory.failWith = Object.assign(new Error("simulert"), { code, ...(constraint !== undefined ? { constraint } : {}) });
      try {
        const out = await pipelineWith(stubClassifier([{ event_type: "object_detected", object_label: "sekk", confidence: 0.9 }])).processCaptured(ctx, camera, s);
        expect(out, `${code} ${constraint}`).toMatchObject({ status: "failed", reason: "pipeline_error", notes: [`db_${code}`] });
      } finally {
        inventory.failWith = null;
      }
      const stored = (await db.admin.query(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_event_id LIKE $1`, [`${s.source_event_id}%`])).rows[0].n as number;
      expect(stored, `ingen delvis skriving etter ${code} ${constraint}`).toBe(0);
    }
  });

  it("uten rom på kameraet, eller uten inventar-tjeneste, skrives det aldri til inventaret (og ingen note)", async () => {
    inventory.calls = [];
    const noRoom = await new VisionCameraService(db.app).registerCamera(tenant, "home", {
      person_id: owner, label: "Garasje", source_type: "home_assistant", source_ref: "camera.garasje", trigger_entities: ["binary_sensor.motion"], zone_kind: "home", route_policy: "local_only", cooldown_seconds: 30
    });
    const detections: VisionDetection[] = [{ event_type: "object_detected", object_label: "sekk's", confidence: 0.9 }];
    const withoutRoom = await pipelineWith(stubClassifier(detections)).processCaptured(ctx, noRoom, spec());
    expect(withoutRoom.status).toBe("recorded");
    const withoutService = await new VisionIngestPipeline({ pool: db.app, vision, classifier: stubClassifier(detections), enabled: true, storeSnapshots: false, now: () => clock }).processCaptured(ctx, camera, spec());
    expect(withoutService.status).toBe("recorded");
    for (const out of [withoutRoom, withoutService]) expect(out.notes.filter((note) => note.startsWith("inventory_"))).toEqual([]);
    expect(inventory.calls).toEqual([]);
  });
});
