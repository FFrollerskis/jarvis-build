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

