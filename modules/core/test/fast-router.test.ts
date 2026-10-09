import { describe, expect, it } from "vitest";
import { delegationRequestVariants, fastRoute } from "@jarvis/core";

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
