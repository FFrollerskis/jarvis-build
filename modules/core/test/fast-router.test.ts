import { describe, expect, it } from "vitest";
import { fastRoute } from "@jarvis/core";

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

