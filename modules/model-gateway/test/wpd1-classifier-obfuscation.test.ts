import { describe, expect, it } from "vitest";
import { classificationVariants, classifyContentSensitivity } from "../src/content-sensitivity.ts";

/**
 * WP-D1, gjennomgang av PR #325 (funn 1): stikkordsklassifiseringen skal ikke omgås av usynlige tegn, bredformatbokstaver eller bokstaver spredt med mellomrom. Alle kodepunkter bygges med `\u`-escapes/`String.fromCodePoint`
 * (ingen usynlige tegn i selve kildekoden). Mønsterbasert klassifisering er ikke en garanti - testene låser de KJENTE omgåelsene.
 */
const sensitivity = (text: string): string => classifyContentSensitivity({ texts: [text] }).sensitivity;
const tag = (code: number): string => String.fromCodePoint(code);

describe("omgåelser av helseordet «diabetes» klassifiseres som helse (SECRET_RESTRICTED)", () => {
  const cases: Array<[string, string]> = [
    ["myk bindestrek", "diabe­tes"],
    ["nullbredde-mellomrom", "dia​betes"],
    ["nullbredde-sammenføyer", "dia‍betes"],
    ["toveisformatering", "dia‮betes"],
    ["ordsammenføyer (U+2060)", "dia⁠betes"],
    ["variasjonsvelger", "dia️betes"],
    ["kombinerende grafem-skjøt", "dia͏betes"],
    ["Hangul-fyller", "diaㅤbetes"],
    ["arabisk bokstavmerke", "dia؜betes"],
    ["tagg-tegn (U+E0061)", `dia${tag(0xe0061)}betes`],
    ["tagg-avslutter (U+E007F)", `dia${tag(0xe007f)}betes`],
    ["bredformatbokstaver", "ｄｉａｂｅｔｅｓ"],
    ["spredt med mellomrom", "d i a b e t e s"],
    ["spredt med punktum", "d.i.a.b.e.t.e.s"],
    ["spredt med understrek", "d_i_a_b_e_t_e_s"],
    ["spredt med bindestrek", "d-i-a-b-e-t-e-s"],
    ["spredt med stjerne", "d*i*a*b*e*t*e*s"],
    ["spredt OG med usynlig tegn", "d i a​ b e t e s"]
  ];
  it.each(cases)("%s", (_name, word) => {
    expect(sensitivity(`Pasienten har ${word} type 2 og går til kontroll`)).toBe("SECRET_RESTRICTED");
  });

  it("kontroll: det uskjulte ordet er helse, og en vanlig setning uten helseord er IKKE hevet", () => {
    expect(sensitivity("Pasienten har diabetes type 2")).toBe("SECRET_RESTRICTED");
    expect(sensitivity("Møtet er flyttet til torsdag klokken ti i det store rommet")).toBe("PUBLIC_OR_LOW_SENSITIVITY");
  });
});

describe("andre kjente omgåelser og ord", () => {
  it("«cancer» (engelsk/svensk/fransk, samme ord) er helse", () => {
    expect(sensitivity("The patient was diagnosed with cancer last year")).toBe("SECRET_RESTRICTED");
  });

  it("omgåelser av økonomiord og hemmeligheter: spredt kontonummer-ord og bredformat", () => {
    expect(sensitivity("Mitt k o n t o n u m m e r er oppgitt i brevet")).toBe("SECRET_RESTRICTED");
    expect(sensitivity("ｓａｌｄｏ på kontoen")).toBe("SECRET_RESTRICTED");
  });
});

describe("falske positiver: normalisering skal ikke gjøre vanlig tekst sensitiv", () => {
  it.each([
    ["korte bokstavrekker (under 4) slås ikke sammen", "Rapporten viser a b c og tabellen"],
    ["en lang rekke enkeltbokstaver som ikke danner et stikkord", "Rekkefølgen er x y z w v u t s r q"],
    ["akronymer med punktum", "Vi flyttet til U.S.A. i fjor og bor nær N.Y.C. nå"],
    ["emoji med variasjonsvelger", "Møtet er bekreftet ✅️ og alle kommer"],
    ["norske tegn", "Blåbærsyltetøy på brødskiven til frokost på Ålesund"]
  ])("%s", (_name, text) => {
    expect(sensitivity(text)).toBe("PUBLIC_OR_LOW_SENSITIVITY");
  });
});

describe("classificationVariants", () => {
  it("ren tekst gir kun originalen; skjult tekst gir originalen, den normaliserte og den sammenslåtte", () => {
    expect(classificationVariants("hei verden")).toEqual(["hei verden"]);
    const variants = classificationVariants("d i a b e t e s­");
    expect(variants[0]).toBe("d i a b e t e s­");
    expect(variants).toContain("d i a b e t e s");
    expect(variants).toContain("diabetes");
  });

  it("er rask på store tekster uten treff (ingen katastrofal tilbakesporing)", () => {
    const big = `${"a ".repeat(40_000)}${"x".repeat(200_000)}`;
    const started = Date.now();
    classificationVariants(big);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
