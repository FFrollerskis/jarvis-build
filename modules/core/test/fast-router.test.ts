import { describe, expect, it } from "vitest";
import { FAST_ROUTE_MAX_CHARS, FAST_ROUTE_PATTERNS, delegationRequestVariants, fastRoute } from "@jarvis/core";

describe("Fast Router v1 (deterministisk, uten LLM)", () => {
  it("matcher kjente kommandoer", () => {
    expect(fastRoute("status")).toEqual({ kind: "system_status" });
    expect(fastRoute("  Systemstatus ")).toEqual({ kind: "system_status" });
    expect(fastRoute("jobbstatus task-123")).toEqual({ kind: "task_status", task_id: "task-123" });
    expect(fastRoute("opprett jobb: skriv rapport om NAS")).toEqual({
      kind: "create_task",
      goal: "skriv rapport om NAS"
    });
    expect(fastRoute("Opprett jobb rydd garasjen")).toEqual({ kind: "create_task", goal: "rydd garasjen" });
    expect(fastRoute("avbryt jobb task-9")).toEqual({ kind: "cancel_task", task_id: "task-9" });
    expect(fastRoute("hjelp")).toEqual({ kind: "help" });
  });

  it("sender alt annet til intelligent bane", () => {
    expect(fastRoute("hva bør jeg gjøre i dag?")).toBeNull();
    expect(fastRoute("fortell om statusen på livet")).toBeNull();
    expect(fastRoute("")).toBeNull();
  });
});

// EV-1 (D-412): «hva er galt med deg» går til selvdiagnosen (kildebelagt, aldri LLM-gjetting).
describe("fastRoute: self_diagnosis", () => {
  it("gjenkjenner norske og engelske formuleringer", () => {
    for (const text of ["hva er galt med deg", "Hva er galt med deg akkurat nå?", "hva er galt", "hva feiler det på deg", "er du frisk?", "selvdiagnose", "diagnoser deg", "what's wrong with you"]) {
      expect(fastRoute(text), text).toEqual({ kind: "self_diagnosis" });
    }
  });

  it("er presis: vanlige setninger som bare nevner ordene går IKKE hit", () => {
    for (const text of ["hva er galt med bilen min", "hva er galt med denne koden", "er du frisk på å hjelpe meg med skatten", "status"]) {
      expect(fastRoute(text)?.kind, text).not.toBe("self_diagnosis");
    }
  });
});

describe("fastRoute: slo_report (EV-2, D-417)", () => {
  it("gjenkjenner ytelsesspørsmål", () => {
    for (const text of ["hvor bra yter du", "Hvor rask yter du?", "er du treg?", "ytelse", "slo", "tjenestemål", "har noe blitt dårligere", "dataskvalitet"]) {
      expect(fastRoute(text), text).toEqual({ kind: "slo_report" });
    }
  });
  it("er presis: setninger som bare nevner ordene går ikke hit", () => {
    for (const text of ["er du treg til å svare på e-post fra Ola", "ytelse på nettsiden min", "hva er slo"]) {
      expect(fastRoute(text)?.kind, text).not.toBe("slo_report");
    }
  });
});

describe("fastRoute: evolution_report (WP-B, D-452)", () => {
  it("gjenkjenner spørsmål om egen utvikling", () => {
    for (const text of ["hvordan utvikler du deg", "Hvordan utvikler du deg?", "evolusjon", "evolusjonsrapport", "evolusjonsstatus", "evolusjonsporter", "hva kan du forbedre", "hva kan du forbedre hos deg selv?", "hva har du lært", "selvforbedring", "self-improvement"]) {
      expect(fastRoute(text), text).toEqual({ kind: "evolution_report" });
    }
  });
  it("er presis: setninger som bare nevner ordene går ikke hit", () => {
    for (const text of ["evolusjon av arter i boken jeg leser", "hvordan utvikler du deg selv hvis jeg ber om et nytt API", "hva har du lært av e-posten fra Ola", "hva kan du forbedre i koden"]) {
      expect(fastRoute(text)?.kind, text).not.toBe("evolution_report");
    }
  });
});

describe("fastRoute: cost_report og delegate_background (D-424)", () => {
  it("«hva koster du» og varianter gir cost_report", () => {
    for (const text of ["hva koster du", "Hva koster du?", "hva koster det", "hva koster du i måneden", "run-rate", "kostnader", "api-regning", "hvor mye har du kostet", "regningen"]) {
      expect(fastRoute(text), text).toEqual({ kind: "cost_report" });
    }
  });
  it("«… i bakgrunnen» og «bakgrunnsjobb:» gir delegate_background med hele meldingen som prompt", () => {
    const msg = "undersøk i bakgrunnen hva som er status på GitHub-sakene mine, og gi meg en kort rapport";
    expect(fastRoute(msg)).toEqual({ kind: "delegate_background", prompt: msg });
    expect(fastRoute("Bakgrunnsjobb: sammenstill priser fra e-postene mine siste uke")).toEqual({ kind: "delegate_background", prompt: "sammenstill priser fra e-postene mine siste uke" });
    expect(fastRoute("deleger: lag en oppsummering av kalenderen min neste uke")).toMatchObject({ kind: "delegate_background" });
    expect(fastRoute("kan du sjekke e-posten min i bakgrunnen?")).toMatchObject({ kind: "delegate_background" });
  });
  it("er presis: spørsmål OM bakgrunnen, korte og vanlige setninger går ikke hit", () => {
    for (const text of ["hvorfor kjører den i bakgrunnen?", "hva er en bakgrunnsjobb", "er den i bakgrunnen", "i bakgrunnen", "hei", "hva skjer i dag", "hva koster en kaffe i Oslo"]) {
      expect(fastRoute(text)?.kind, text).not.toBe("delegate_background");
      expect(fastRoute(text)?.kind, text).not.toBe("cost_report");
    }
  });
});

// WP-C4: «hva har du hjulpet meg med» går til Value Center (kun tall fra tabellene, aldri LLM-gjetting). Hele meldingen må være spørsmålet (ankret).
describe("fastRoute: value_report (WP-C4)", () => {
  it("gjenkjenner verdi- og bruksspørsmål", () => {
    for (const text of [
      "hva har du hjulpet meg med", "Hva har du hjulpet meg med?", "hva har du hjulpet meg med denne uken", "hva har du gjort for meg hittil", "hva har du levert så langt?",
      "verdi", "Verdi?", "verdirapport", "verdi-rapport", "verdisenter", "value center", "valuecenter", "bruk", "Bruk!", "bruksstatistikk", "bruksmetrikk", "min bruk", "hvor mye bruker jeg deg", "hvor nyttig er du"
    ]) {
      expect(fastRoute(text), text).toEqual({ kind: "value_report" });
    }
  });
  it("er presis: setninger som bare nevner ordene går IKKE hit (de går til den intelligente banen)", () => {
    for (const text of [
      "hva er verdien av huset mitt", "verdi av bilen min", "verdien", "bruk av tid i uka", "bruk Google til å finne en restaurant", "hva er bruk av komma", "min bruk av strøm",
      "hva har du hjulpet Ola med", "hva har du gjort for meg i går kveld på kalenderen", "hvor mye bruker bilen", "hvor nyttig er en sparkesykkel", "value center for Acme AS", "hei"
    ]) {
      expect(fastRoute(text)?.kind, text).not.toBe("value_report");
    }
  });
  it("de eldre intensjonene er uberørt av den nye (kostnad, ytelse, diagnose, hjelp)", () => {
    expect(fastRoute("hva koster du")).toEqual({ kind: "cost_report" });
    expect(fastRoute("hvor mye har jeg brukt")).toEqual({ kind: "cost_report" });
    expect(fastRoute("hvor bra yter du")).toEqual({ kind: "slo_report" });
    expect(fastRoute("hva er galt med deg")).toEqual({ kind: "self_diagnosis" });
    expect(fastRoute("hjelp")).toEqual({ kind: "help" });
    expect(fastRoute("status")).toEqual({ kind: "system_status" });
  });
  it("hurtigbanen leser KUN rapporten: ingen parametre eller fritekst bæres med videre", () => {
    expect(Object.keys(fastRoute("hva har du hjulpet meg med") ?? {})).toEqual(["kind"]);
  });
});

// D-449 (Q-50, gjennomgang nr. 4): hurtigbanen vurderes som om eieren hadde skrevet forespørselen UTEN delegeringsfrasen; ALLE rimelige fjerninger returneres og den strengeste vinner.
describe("delegationRequestVariants (D-449)", () => {
  it("returnerer meldingen slik den står og hver fjerning av frasen/prefikset - uten duplikater og uten tomme varianter", () => {
    expect(delegationRequestVariants("list åpne PR-er i bakgrunnen")).toEqual(["list åpne PR-er i bakgrunnen", "list åpne PR-er"]);
    expect(delegationRequestVariants("Bakgrunnsjobb: sammenstill priser fra e-postene mine")).toEqual(["Bakgrunnsjobb: sammenstill priser fra e-postene mine", "sammenstill priser fra e-postene mine"]);
    expect(delegationRequestVariants("deleger:   sjekk kalenderen min neste uke")).toContain("sjekk kalenderen min neste uke");
    expect(delegationRequestVariants("   ")).toEqual([]);
    expect(delegationRequestVariants("i bakgrunnen")).toEqual(["i bakgrunnen"]);
  });

  it("frasen midt i en setning: variantene bevarer ordene på hver side slik chatten ville sett dem (ingen sammenslåing av «bruk» og «bare»)", () => {
    const variants = delegationRequestVariants("Sjekk e-posten min, og bruk i bakgrunnen bare lokale modeller");
    expect(variants).toContain("Sjekk e-posten min, og bruk bare lokale modeller");
    expect(variants.every((v) => !/\bi bakgrunnen\b/i.test(v) || v === "Sjekk e-posten min, og bruk i bakgrunnen bare lokale modeller")).toBe(true);
  });

  it("linjeskift: én variant beholder linjeskiftet (et mønster med `.*` treffer ikke på tvers av linjer), en annen slår alt mellomrom sammen", () => {
    const variants = delegationRequestVariants("hvor lang tid tar det\ndit i bakgrunnen");
    expect(variants).toContain("hvor lang tid tar det\ndit");
    const mid = delegationRequestVariants("hvor lang tid tar det i bakgrunnen\ndit");
    expect(mid).toContain("hvor lang tid tar det\ndit");
    expect(mid).toContain("hvor lang tid tar det dit");
  });

  it("tegn mellom frasen og resten (komma, punktum, spørsmålstegn, tab, versaler) gir varianter uten frasen; ingen variant er selv en bestilling", () => {
    for (const text of [
      "list åpne PR-er i bakgrunnen.", "list åpne PR-er i bakgrunnen?", "list åpne PR-er\ti bakgrunnen", "list åpne PR-er I BAKGRUNNEN", "I bakgrunnen, list åpne PR-er",
      "Bakgrunnsjobb: list åpne PR-er", "list åpne PR-er i bakgrunnen og i bakgrunnen igjen"
    ]) {
      expect(fastRoute(text)?.kind, text).toBe("delegate_background");
      const variants = delegationRequestVariants(text);
      expect(variants[0], text).toBe(text);
      for (const variant of variants.slice(1)) {
        expect(variant, text).not.toMatch(/\bi bakgrunnen\b/i);
        expect(fastRoute(variant)?.kind, `${text} → ${variant}`).not.toBe("delegate_background");
      }
      expect(variants.length, text).toBeGreaterThan(1);
    }
  });
});

// L4 (gjennomgang av PR #312): «verdi» + 32 000 mellomrom + «x» blokkerte hendelsesløkken i 2,5 s (O(n²) i `\s*[?!.]*\s*$`), også de eldre mønstrene (`kostnad` 1,9 s). Forsvaret gjelder HELE klassen: lengdetak + mellomrom-normalisering ved inngangen.
describe("fastRoute: fiendtlig inndata - tidsbudsjett og uendret atferd for normale meldinger (L4)", () => {
  /** ÉN gyldig kommando per mønster. Testen under krever at HVERT eksporterte mønster treffes av minst én av dem, så et nytt mønster uten fiendtlig dekning feiler her. */
  const STEMS: ReadonlyArray<readonly [string, string]> = [
    ["status", "system_status"], ["hva er galt med deg", "self_diagnosis"], ["hvor bra yter du", "slo_report"], ["hvordan utvikler du deg", "evolution_report"],
    ["hva koster du", "cost_report"], ["hvor mye har du kostet", "cost_report"], ["kostnad", "cost_report"], ["hva har du hjulpet meg med", "value_report"], ["verdi", "value_report"], ["bruk", "value_report"],
    ["jobbstatus task-123", "task_status"], ["opprett jobb: skriv rapport", "create_task"], ["avbryt jobb task-9", "cancel_task"], ["hjelp", "help"], ["skru på lyset", "home_light"],
    ["deleger: sjekk kalenderen min neste uke", "delegate_background"], ["sjekk e-posten min i bakgrunnen", "delegate_background"]
  ];
  const BUDGET_MS = 100;
  const timed = (input: string): number => {
    const started = performance.now();
    fastRoute(input);
    return performance.now() - started;
  };

  it("stammene dekker ALLE hurtigbanemønstrene (et nytt mønster uten dekning feiler her) og gir riktig intensjon", () => {
    expect(FAST_ROUTE_PATTERNS.length).toBeGreaterThanOrEqual(10);
    for (const pattern of FAST_ROUTE_PATTERNS) expect(STEMS.some(([stem]) => pattern.test(stem)), String(pattern)).toBe(true);
    for (const [stem, kind] of STEMS) expect(fastRoute(stem)?.kind, stem).toBe(kind);
  });

  it("alle mønstre × fiendtlige mellomromsløp (32 000 tegn av hvert slag + et tegn som ikke passer) svarer under 100 ms", () => {
    const fillers: ReadonlyArray<readonly [string, string]> = [
      ["mellomrom", " ".repeat(32_000)], ["tabulator", "\t".repeat(32_000)], ["NBSP", "\u00a0".repeat(32_000)], ["linjeskift", "\n".repeat(32_000)],
      ["blandet", " \t\n\u00a0".repeat(8_000)], ["tegnsetting+mellomrom", " ?".repeat(16_000)], ["utropstegn", "!".repeat(32_000)], ["punktum+mellomrom", ". ".repeat(16_000)]
    ];
    const worst: string[] = [];
    outer: for (const [stem] of STEMS) {
      for (const [name, filler] of fillers) {
        for (const input of [`${stem}${filler}x`, `${filler}${stem}${filler}x`, `${stem}${filler}`]) {
          const ms = timed(input);
          if (ms > BUDGET_MS) worst.push(`${stem} + ${name}: ${ms.toFixed(0)} ms`);
          if (worst.length >= 3) break outer; // uten rettelsen tar hvert slikt kall sekunder: stopp tidlig i stedet for å vente i minutter
        }
      }
    }
    expect(worst).toEqual([]);
  });

  it("også innenfor lengdetaket (≈ 1 990 tegn mellomrom) er hvert mønster lineært: under 100 ms", () => {
    const near = " ".repeat(FAST_ROUTE_MAX_CHARS - 40);
    for (const [stem] of STEMS) {
      for (const input of [`${stem}${near}x`, `${stem}${near}\n?`, `${stem} ${" ?".repeat(900)}x`]) expect(timed(input), stem).toBeLessThan(BUDGET_MS);
    }
  });

  it("andre fiendtlige former: lange tegnsetningsløp, lange ord og dypt nøstede parenteser er også raske", () => {
    for (const input of ["verdi" + "?".repeat(30_000) + "x", "a".repeat(100_000), "opprett jobb: " + "a ".repeat(40_000), ("(".repeat(10_000)) + "status", "hvor mye har du kostet " + "ord ".repeat(20_000) + "\nx", "deleger:" + " ".repeat(30_000) + "x"]) {
      expect(timed(input), input.slice(0, 30)).toBeLessThan(BUDGET_MS);
    }
  });

  it("meldinger over 2 000 tegn er aldri hurtigkommandoer (de går til den intelligente banen); nøyaktig 2 000 tegn kan fortsatt være det", () => {
    expect(FAST_ROUTE_MAX_CHARS).toBe(2000);
    expect(fastRoute("status" + " ".repeat(2000))).toBeNull();
    expect(fastRoute("opprett jobb: " + "a".repeat(2000))).toBeNull();
    expect(fastRoute("deleger: " + "undersøk ".repeat(300))).toBeNull();
    expect(fastRoute("status" + " ".repeat(FAST_ROUTE_MAX_CHARS - "status".length))).toEqual({ kind: "system_status" });
    expect(fastRoute(" ".repeat(FAST_ROUTE_MAX_CHARS - 6) + "status")).toEqual({ kind: "system_status" });
    for (const v of [undefined, null, 42, {}] as unknown[]) expect(fastRoute(v as string)).toBeNull();
  });

  it("normale meldinger oppfører seg som før: ankrene, linjeskift-regelen og de eksisterende kommandoene er uendret", () => {
    // flere mellomrom/tabulatorer mellom ordene gjenkjennes nå (kollapset til ett), med samme intensjon
    expect(fastRoute("hva  er   galt\tmed deg")).toEqual({ kind: "self_diagnosis" });
    expect(fastRoute("  hva har du   hjulpet meg med  ?  ")).toEqual({ kind: "value_report" });
    expect(fastRoute("jobbstatus   task-123  ")).toEqual({ kind: "task_status", task_id: "task-123" });
    expect(fastRoute("opprett jobb:  skriv rapport")).toEqual({ kind: "create_task", goal: "skriv rapport" });
    // et linjeskift er fortsatt et linjeskift: `.` krysser det ikke, og en kommando etterfulgt av en ny linje med tekst er ikke en kommando
    expect(fastRoute("opprett jobb: A\nB")).toBeNull();
    expect(fastRoute("hva koster du\nsiste måned")).toBeNull();
    expect(fastRoute("verdi\n\n\nfor huset")).toBeNull();
    expect(fastRoute("status\n")).toEqual({ kind: "system_status" });
    // setninger som bare nevner ordene går fortsatt ikke hit
    for (const text of ["verdi av bilen min", "bruk av tid i uka", "hva er verdien av huset mitt", "status på livet"]) expect(fastRoute(text), text).toBeNull();
  });

  it("delegering leser den OPPRINNELIGE teksten ordrett (D-449): flere mellomrom og linjeskift i prompten bevares", () => {
    const prompt = "undersøk   i bakgrunnen\n\nstatus på GitHub-sakene mine,   og gi meg en kort rapport";
    expect(fastRoute(prompt)).toEqual({ kind: "delegate_background", prompt });
    expect(fastRoute("deleger:   sjekk  kalenderen   min neste uke")).toEqual({ kind: "delegate_background", prompt: "sjekk  kalenderen   min neste uke" });
  });
});
