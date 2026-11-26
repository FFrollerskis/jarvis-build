import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInventoryLabel, isStorableObjectLabel, normalizeObjectLabel } from "../src/labels.ts";
import { VisionObservationValidationError, VisionService } from "../src/service.ts";
import { VisionObservationInputSchema } from "../src/types.ts";
import { seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";
import { OBS_CHECK, hex, jsRejectedCodePoints, rejectedCodePoints } from "./support/label-sweep.ts";

/**
 * WP-G3b (D-485), K3 = JARVIS-114 (k): etikett-avviket mellom JS-skjemaet og databasens milde CHECK (133) er `ACCEPTED/PINNED` - IKKE lukket med en ny migrasjon. Denne filen er den permanente nålen.
 *
 * Avviket (ett-veis, ufarlig): en etikett av KUN ikke-ASCII mellomrom/tegnsetting/symboler («»), ¿¡, tankestrek, ×÷, NBSP ...) avvises av JS (`isStorableObjectLabel`, Unicode-bevisst `\p{P}\p{S}`) men godtas av databasen
 * (bokstavkravet i SQL er ASCII-basert: «noe annet enn ASCII-sifre, -mellomrom og -tegnsetting»). Databasen er et NETT under skjemaet og er aldri strengere enn det.
 *
 * Hvorfor IKKE stramme CHECK-en (valg (i) i stedet for (ii)): å matche JS-regelen i SQL krever en eksplisitt kodepunkttabell for hele Unicode-kategoriene P og S (POSIX-klassene er locale-avhengige, og det var nettopp det som
 * ga review-funnet D1). En slik tabell er bundet til én Unicode-versjon og kan ikke bevises i produksjonens locale (`en_US.UTF-8` er NOT VERIFIED, JARVIS-114 l): en senere forskjell ville gjøre databasen STRENGERE enn skjemaet
 * i enkelte kodepunkt - den FARLIGE retningen (et navn JS godtar, men databasen avviser med 23514 og ruller tilbake hele hendelsen). Dagens løsere nett kan ikke gi den feilen. Gapet kan ikke nås fra noen skrivevei i appen (alle går
 * gjennom skjemaet først), så en stramming ville gitt en ny, ubevisbar risiko mot en utilsiktet effekt: ingen.
 *
 * Nålen holder tre ting fast: (1) gapet er NØYAKTIG det som er beskrevet (begge inklusjoner, Unicode-versjons-uavhengig fordi begge sider regnes av samme Node), (2) ingen skrivevei i appen kan produsere en slik etikett,
 * og (3) databasen godtar den faktisk (så ingen tror at CHECK-en fanger den). Endrer noen JS-regelen, CHECK-en eller Unicode-dataene på en måte som flytter gapet, feiler denne filen - og punktet må vurderes på nytt.
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let vision: VisionService;
let sql: number[] = [];
let js: number[] = [];
let gap: number[] = [];

const cp = (code: number): string => String.fromCodePoint(code);
/** Kodepunktene over ASCII (ingen surrogater) som er mellomrom, tegnsetting eller symbol i JS sin forstand. */
const NON_ASCII_SPACE_PUNCT_SYMBOL = /^[\s\p{P}\p{S}]$/u;

beforeAll(async () => {
  db = await startVisionDb("g3bgap");
  T = await seedTenant(db, "g3bgap-t");
  vision = new VisionService(db.app);
  sql = await rejectedCodePoints(db.admin, OBS_CHECK, "bare");
  js = jsRejectedCodePoints(isStorableObjectLabel, "bare");
  const sqlSet = new Set(sql);
  gap = js.filter((code) => !sqlSet.has(code));
}, 240_000);

afterAll(async () => {
  await db?.stop();
}, 120_000);

describe("JARVIS-114 (k): gapet er ett-veis og har NØYAKTIG denne formen", () => {
  it("databasen er aldri strengere enn skjemaet: ingen alene-stående kodepunkt som databasen avviser og JS godtar", () => {
    const jsSet = new Set(js);
    expect(sql.filter((code) => !jsSet.has(code)).map(hex)).toEqual([]);
    expect(sql.length).toBeGreaterThan(4000); // sveipet er ikke tomt
  });

  it("gapet = nøyaktig de IKKE-ASCII mellomrom-/tegnsettings-/symbolkodepunktene databasen ikke forbyr (begge inklusjoner; ingen ASCII-tegn i gapet)", () => {
    const sqlSet = new Set(sql);
    const expected: number[] = [];
    for (let code = 0x80; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (sqlSet.has(code)) continue; // forbudt også i databasen (kontroll-, usynlige og strukturtegn): JS og SQL er enige
      if (NON_ASCII_SPACE_PUNCT_SYMBOL.test(cp(code))) expected.push(code);
    }
    expect(gap.map(hex)).toEqual(expected.map(hex));
    expect(gap.every((code) => code > 0x7f)).toBe(true);
    expect(gap.length).toBeGreaterThan(1000); // et reelt gap (i dag ca. 9 500 kodepunkt; avhenger av Node/ICU sin Unicode-versjon, derfor ingen eksakt grense)
  });

  it("de kjente eksemplene ligger i gapet: «»¿¡ tankestrek × ÷ NBSP U+2003 U+3000 U+20AC (euro) U+00A9 (©)", () => {
    for (const code of [0xab, 0xbb, 0xbf, 0xa1, 0x2014, 0xd7, 0xf7, 0xa0, 0x2003, 0x3000, 0x20ac, 0xa9]) expect(gap, hex(code)).toContain(code);
    for (const label of ["«»", "¿¡", cp(0x2014), "×÷", cp(0xa0), cp(0x2003), cp(0x20ac)]) expect(isStorableObjectLabel(label), label).toBe(false);
  });

  it("ASCII-tegn er ALDRI i gapet (JS og databasen er enige om hver ASCII-etikett av ett tegn), og bokstaver/tall i alle skrift ligger utenfor det", () => {
    const gapSet = new Set(gap);
    for (let code = 1; code < 0x80; code += 1) expect(gapSet.has(code), hex(code)).toBe(false);
    for (const ch of ["a", "Å", "ø", "日", "ж", "١", cp(0x10428)]) expect(isStorableObjectLabel(ch), ch).toBe(true);
    for (const ch of ["a", "Å", "ø", "日", "ж", "١", cp(0x10428)]) expect(gapSet.has(ch.codePointAt(0) as number), ch).toBe(false);
  });
});

describe("JARVIS-114 (k): ingen skrivevei i appen kan produsere en etikett fra gapet", () => {
  const sample = (): string[] => [...new Set([...gap.filter((_, index) => index % 37 === 0), 0xab, 0xbb, 0x2014, 0xa0, 0x3000].map(cp))];

  it("HVER gap-etikett avvises av `isStorableObjectLabel` og av inngangsskjemaet (object_label_invalid): skjemaet er porten FØR databasen, og inventaret (135) nås kun via en LAGRET hendelse", () => {
    expect(gap.length).toBeGreaterThan(0);
    expect(gap.map(cp).filter((label) => isStorableObjectLabel(label))).toEqual([]);
    for (const label of sample()) {
      const parsed = VisionObservationInputSchema.safeParse({ event_type: "object_detected", object_label: label, source_event_id: "e", observed_at: "2026-11-26T10:00:00.000Z", source_type: "t", source_instance_id: "i" });
      expect(parsed.success, hex(label.codePointAt(0) as number)).toBe(false);
    }
    // Merk: den STRENGE inventarregelen (`isInventoryLabel`, 135) har ingen egen klasse for Unicode-tegnsetting og godtar mange av disse tegnene BÅDE i JS og i databasen (paritet bevist i g3-label-locale.test.ts) - det er uten
    // betydning her fordi en inventarskriving kun skjer etter at hendelsen med samme etikett er lagret (pipeline.ts), og den lagres aldri uten å bestå den milde regelen.
  });

  it("selve tjenesten avviser en gap-etikett med en lesbar feil FØR databasen (aldri et rått 23514, aldri en skrevet rad)", async () => {
    const before = Number(((await db.admin.query(`SELECT count(*) AS n FROM vision_event_observations WHERE tenant_id = $1`, [T.tenant])).rows[0] as { n: string }).n);
    for (const label of ["«»", "¿¡", cp(0x2014), cp(0xa0)]) {
      const err = await vision.ingestObservation(T.tenant, "home", T.owner, { event_type: "object_detected", object_label: label, source_event_id: `gap-${label.codePointAt(0)}`, observed_at: "2026-11-26T10:00:00.000Z", source_type: "test", source_instance_id: "g3b" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VisionObservationValidationError);
      expect(err).toMatchObject({ field: "object_label" });
    }
    expect(Number(((await db.admin.query(`SELECT count(*) AS n FROM vision_event_observations WHERE tenant_id = $1`, [T.tenant])).rows[0] as { n: string }).n)).toBe(before);
  });

  it("modellens normalisering (den eneste veien en kamerabilde-etikett tar) gir ALDRI en gap-etikett: hver gap-streng blir null eller en etikett som består begge reglene", () => {
    for (const code of gap) {
      for (const wrap of [(ch: string) => ch, (ch: string) => `a${ch}a`, (ch: string) => `${ch}b`]) {
        const out = normalizeObjectLabel(wrap(cp(code)));
        if (out !== null) {
          expect(isStorableObjectLabel(out) && isInventoryLabel(out), hex(code)).toBe(true);
          expect(out.length, hex(code)).toBeGreaterThan(0);
        }
      }
    }
    for (const label of ["«»", "¿¡", cp(0x2014), cp(0xa0), "×÷"]) expect(normalizeObjectLabel(label), label).toBeNull();
  });
});

describe("JARVIS-114 (k): databasen godtar gap-etiketten (nålen: CHECK-en er det løsere nettet, ikke en port)", () => {
  it("en direkte INSERT av «»-etiketten som admin lykkes i databasen (rulles tilbake) - og en etikett med en forbudt tegnklasse avvises (23514), så nettet er ikke tomt", async () => {
    const client = await db.admin.connect();
    try {
      await client.query("BEGIN");
      const insert = (label: string, id: string): Promise<unknown> => client.query(
        `INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, event_type, object_label, source_type, source_instance_id, source_event_id, payload_fingerprint, observed_at)
         VALUES ($1, $2, 'home', $3, 'object_detected', $4, 'test', 'g3b', $1, 'fp', now())`, [id, T.tenant, T.owner, label]
      );
      await expect(insert("«»", "vis-ob-gap-1")).resolves.toBeDefined();
      await expect(insert(cp(0x2014), "vis-ob-gap-2")).resolves.toBeDefined();
      await client.query("SAVEPOINT s");
      await expect(insert("<script>", "vis-ob-gap-3")).rejects.toMatchObject({ code: "23514" }); // strukturtegn: forbudt også i databasen
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expect(insert("a".repeat(65), "vis-ob-gap-4")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(Number(((await db.admin.query(`SELECT count(*) AS n FROM vision_event_observations WHERE observation_id LIKE 'vis-ob-gap-%'`)).rows[0] as { n: string }).n)).toBe(0);
  });
});

describe("JARVIS-114 (k): status og begrunnelse står i koden, og ingen migrasjon etter 137 har rørt etikett-CHECK-ene", () => {
  it("labels.ts merker punktet ACCEPTED/PINNED (JARVIS-114 k, D-485), forklarer hvorfor det ikke er strammet, og peker hit", () => {
    const labels = readFileSync(fileURLToPath(new URL("../src/labels.ts", import.meta.url)), "utf8");
    expect(labels).toContain("ACCEPTED/PINNED");
    expect(labels).toContain("JARVIS-114 (k)");
    expect(labels).toContain("g3b-label-gap-pin.test.ts");
    expect(labels).toContain("STRENGERE enn skjemaet");
  });

  it("ingen migrasjon med nummer over 137 nevner de to etikett-CHECK-ene (valg (i): ingenting er strammet; en senere stramming MÅ gjøre denne filen rød og vurderes på nytt)", () => {
    const dir = fileURLToPath(new URL("../../core/src/db/migrations/", import.meta.url));
    const later = readdirSync(dir).filter((file) => /^\d+_/.test(file) && Number.parseInt(file, 10) > 137);
    expect(later.length).toBeGreaterThan(0); // 139, 140 ... finnes: skanningen er ikke tom
    for (const file of later) {
      const text = readFileSync(`${dir}${file}`, "utf8");
      expect(text, file).not.toMatch(/vision_event_observations_object_label_check|vision_inventory_items_object_label_check/);
      expect(text, file).not.toMatch(/ALTER TABLE\s+vision_(event_observations|inventory_items)[\s\S]*object_label/i);
    }
    for (const file of ["133_vision_cameras.sql", "135_vision_embeddings_inventory.sql"]) expect(readFileSync(`${dir}${file}`, "utf8")).toContain("object_label");
  });
});
