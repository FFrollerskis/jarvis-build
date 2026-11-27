import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * WP-EV0 (K2): `Constitution.classify` er bygget av UAVHENGIGE lag, og strengeste lag vinner:
 *   1. ugyldig sti (kan ikke normaliseres trygt) = E3,
 *   2. den gamle hardkodede policyen (`classifySelfModification`: forbidden / zero_review / requires_approval),
 *   3. de hardkodede forbudte mønstrene og de SIGNERTE manifest-reglene (prefix / exact / suffix / basename),
 *   4. E1 kun når policyen sier zero_review OG alle stier er EKSAKT i manifestets E1-allowliste.
 * Policyen (2) overstyres her, så hvert lag bevises UAVHENGIG av de andre. Uten dette ville et lag kunne råtne uten at noen test merket det,
 * fordi et annet lag tilfeldigvis dekker det samme i dag (forsvar i dybden er bare verdt noe når hvert lag er testet alene).
 */
const state = vi.hoisted(() => ({ override: null as null | "forbidden" | "zero_review" | "requires_approval" }));
vi.mock("../src/policy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/policy.ts")>();
  return { ...actual, classifySelfModification: (paths: readonly string[]) => state.override ?? actual.classifySelfModification(paths) };
});

import { buildConstitution, type ConstitutionManifest } from "../src/constitution.ts";

const ROOT = new URL("../../../", import.meta.url);
const committed = (): ConstitutionManifest => JSON.parse(readFileSync(new URL("config/evolution/constitution.v1.json", ROOT), "utf8")) as ConstitutionManifest;
const withRules = (...rules: ConstitutionManifest["protected_paths"]): ConstitutionManifest => {
  const m = committed();
  m.protected_paths = [...m.protected_paths, ...rules];
  return m;
};

afterEach(() => {
  state.override = null;
});

describe("A: lag 1 - en ugyldig sti er E3 uansett hva policyen sier", () => {
  it("A1: med en maksimalt tillatende policy er `..`, absolutt, kolon, kontrolltegn og tom sti fortsatt E3", () => {
    const c = buildConstitution(committed());
    state.override = "requires_approval";
    for (const bad of ["../x.ts", "a/../b.ts", "/etc/passwd", "C:/Windows/x.ts", "a/b\u0000c.ts", "~/x.ts", "docs/~1/x.md", ""]) {
      expect(c.classify([bad]), JSON.stringify(bad)).toBe("E3");
      expect(c.classify(["docs/harmless.md", bad]), `blandet: ${JSON.stringify(bad)}`).toBe("E3");
    }
    state.override = "zero_review";
    expect(c.classify(["../config/charlie-personality.json"])).toBe("E3");
  });

  it("A2: kontroll - med samme policy er en vanlig, ufarlig sti E2 (laget er ikke bare «alt er E3»)", () => {
    const c = buildConstitution(committed());
    state.override = "requires_approval";
    expect(c.classify(["docs/harmless.md"])).toBe("E2");
    expect(c.classify([])).toBe("E3");
  });
});

describe("B: lag 2 - policyen kan alene gjøre en ellers ufarlig endring til E3", () => {
  it("B1: forbidden fra policyen gir E3 selv om hverken manifestet eller mønstrene treffer", () => {
    const c = buildConstitution(committed());
    expect(c.classify(["docs/harmless.md"])).toBe("E2");
    state.override = "forbidden";
    expect(c.classify(["docs/harmless.md"])).toBe("E3");
    expect(c.classify(["config/charlie-personality.json"])).toBe("E3");
  });
});

describe("C: lag 3 - manifest-reglenes semantikk (prefix / exact / suffix / basename), uten hjelp fra policyen", () => {
  const c = buildConstitution(withRules(
    { kind: "prefix", value: "zz-area/inner/" },
    { kind: "exact", value: "zz-area/only.ts" },
    { kind: "suffix", value: ".zzkey" },
    { kind: "basename", value: "zzbase.cfg" }
  ));

  it("C1: prefix er forankret i starten av stien (ikke «inneholder»)", () => {
    expect(c.classify(["zz-area/inner/a.ts"])).toBe("E3");
    expect(c.classify(["zz-area/inner/deep/b.ts"])).toBe("E3");
    expect(c.classify(["x/zz-area/inner/a.ts"]), "midt i stien er ikke en prefiks").toBe("E2");
    expect(c.classify(["zz-area/innerx/a.ts"]), "nabokatalog med lik start").toBe("E2");
    expect(c.classify(["zz-area/other/a.ts"])).toBe("E2");
  });

  it("C2: exact er hele stien og ingenting mer", () => {
    expect(c.classify(["zz-area/only.ts"])).toBe("E3");
    expect(c.classify(["zz-area/only.tsx"])).toBe("E2");
    expect(c.classify(["zz-area/only.ts.bak"])).toBe("E2");
    expect(c.classify(["x/zz-area/only.ts"])).toBe("E2");
  });

  it("C3: suffix er slutten av stien (på et hvilket som helst nivå), ikke hele stien og ikke midten", () => {
    expect(c.classify(["secrets/prod.zzkey"])).toBe("E3");
    expect(c.classify(["a/b/c/d.zzkey"])).toBe("E3");
    expect(c.classify([".zzkey"]), "stien er selve suffikset").toBe("E3");
    expect(c.classify(["secrets/prod.zzkey.bak"]), "suffikset står ikke sist").toBe("E2");
    expect(c.classify(["secrets/prod.zzkeys"])).toBe("E2");
    expect(c.classify(["secrets/zzkey/readme.md"])).toBe("E2");
  });

  it("C4: basename treffer filnavnet på alle nivåer, men aldri et navn som bare ender likt", () => {
    expect(c.classify(["zzbase.cfg"])).toBe("E3");
    expect(c.classify(["a/b/zzbase.cfg"])).toBe("E3");
    expect(c.classify(["a/b/xzzbase.cfg"])).toBe("E2");
    expect(c.classify(["a/b/zzbase.cfg.old"])).toBe("E2");
    expect(c.classify(["a/zzbase.cfg/readme.md"]), "katalogen heter det, filen ikke").toBe("E2");
  });

  it("C5: reglene brettes (store/små bokstaver, ./, backslash) som stiene - en annen skrivemåte slipper ikke unna", () => {
    expect(c.classify(["ZZ-Area\\Inner\\A.ts"])).toBe("E3");
    expect(c.classify(["./zz-area/only.ts"])).toBe("E3");
    expect(c.classify(["Secrets/PROD.ZZKEY"])).toBe("E3");
    expect(c.classify(["a/ZzBase.CFG"])).toBe("E3");
  });

  it("C6: en blandet diff er E3 så snart ÉN sti treffer en regel", () => {
    expect(c.classify(["docs/harmless.md", "secrets/prod.zzkey"])).toBe("E3");
    expect(c.classify(["docs/harmless.md", "docs/other.md"])).toBe("E2");
  });
});

describe("D: lag 4 - E1 krever zero_review fra policyen OG at ALLE stier er eksakt i manifestets allowliste", () => {
  const A = "config/charlie-personality.json";

  it("D1: positiv kontroll - policyen sier zero_review og stien er eksakt i allowlisten: E1", () => {
    const c = buildConstitution(committed());
    state.override = "zero_review";
    expect(c.classify([A])).toBe("E1");
    expect(c.classify([`./${A}`]), "ledende ./ normaliseres likt som i policyen").toBe("E1");
  });

  it("D2: ÉN sti utenfor manifestets allowliste holder ikke (alle må være med, ikke «noen»)", () => {
    const c = buildConstitution(committed());
    state.override = "zero_review";
    expect(c.classify([A, "config/other.json"])).toBe("E2");
    expect(c.classify(["config/other.json", A])).toBe("E2");
    expect(c.classify(["config/other.json"])).toBe("E2");
  });

  it("D3: allowlisten er EKSAKT og skiller store/små bokstaver, selv om beskyttelsesnøkkelen er foldet", () => {
    const c = buildConstitution(committed());
    state.override = "zero_review";
    expect(c.classify(["Config/Charlie-Personality.json"])).toBe("E2");
    expect(c.classify(["config/CHARLIE-PERSONALITY.JSON"])).toBe("E2");
  });

  it("D4: policyen må si zero_review - allowlisten alene er ikke nok (manifestet kan stramme inn, aldri løsne)", () => {
    const c = buildConstitution(committed());
    state.override = "requires_approval";
    expect(c.classify([A])).toBe("E2");
  });

  it("D5: en beskyttet sti i samme diff gjør E1 til E3, også når policyen sier zero_review (strengeste vinner)", () => {
    const c = buildConstitution(withRules({ kind: "exact", value: "config/other.json" }));
    state.override = "zero_review";
    expect(c.classify([A])).toBe("E1");
    expect(c.classify([A, "config/other.json"])).toBe("E3");
  });
});
