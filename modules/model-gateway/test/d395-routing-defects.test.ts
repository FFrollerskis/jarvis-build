import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  AiCouncil,
  AiRouter,
  CapabilityRegistry,
  classifyDecisionImportance,
  computeConsensusStatus,
  meshRouterState,
  ProviderHealthTracker,
  type ModelProfile
} from "../src/index.ts";

/**
 * D-395 (JARVIS-078) - rutings-/rådsdefekter: (1) uavgjort avgjøres deterministisk (ikke registreringsrekkefølge), (2) mesh-ruteren rapporterer reell tilstand
 * (ikke en hardkodet «HEALTHY»), (3) CONSENSUS betyr faktisk at alle svarende støtter, (4) norske beløp («500 000 kr», «2 millioner kroner») gjenkjennes,
 * (5) feil i råd-persistens logges (var helt stille).
 */
const base: Omit<ModelProfile, "provider" | "model"> = {
  capabilities: ["text"],
  context_tokens: 32_000,
  locality: "cloud",
  cost_class: 3,
  quality_class: 3,
  latency_class: "medium"
};
const profile = (provider: string): ModelProfile => ({ ...base, provider, model: `${provider}-m` });
const configured = (...names: string[]): Map<string, { configured: boolean; model: string }> => new Map(names.map((n) => [n, { configured: true, model: `${n}-m` }]));

describe("router: deterministisk tie-break", () => {
  it("to identisk skårede providere gir SAMME vinner uansett registreringsrekkefølge (alfabetisk på navn)", () => {
    const profiles = [profile("zeta"), profile("alfa"), profile("mid")];
    const ab = new AiRouter(new CapabilityRegistry(profiles), new ProviderHealthTracker()).plan({}, configured("zeta", "alfa", "mid"));
    const ba = new AiRouter(new CapabilityRegistry([...profiles].reverse()), new ProviderHealthTracker()).plan({}, configured("mid", "alfa", "zeta"));
    expect(ab.candidates[0]?.provider).toBe("alfa");
    expect(ba.candidates[0]?.provider).toBe("alfa");
    expect(ab.candidates.map((c) => c.provider)).toEqual(["alfa", "mid", "zeta"]);
    expect(ba.candidates.map((c) => c.provider)).toEqual(["alfa", "mid", "zeta"]);
  });

  it("en reell poengforskjell avgjør fortsatt (tie-break overstyrer aldri kvalitet)", () => {
    const profiles = [profile("alfa"), { ...profile("zeta"), quality_class: 5 as const }];
    const plan = new AiRouter(new CapabilityRegistry(profiles), new ProviderHealthTracker()).plan({ mode: "QUALITY" }, configured("alfa", "zeta"));
    expect(plan.candidates[0]?.provider).toBe("zeta");
  });
});

describe("meshRouterState: beregnet, ikke en hardkodet streng", () => {
  it("ingen konfigurerte providere = UNAVAILABLE", () => {
    expect(meshRouterState([])).toBe("UNAVAILABLE");
    expect(meshRouterState([{ configured: false, state: "NOT_CONFIGURED" }])).toBe("UNAVAILABLE");
  });
  it("alle UNAVAILABLE = UNAVAILABLE; noen svekket = DEGRADED; ellers HEALTHY", () => {
    expect(meshRouterState([{ configured: true, state: "UNAVAILABLE" }, { configured: true, state: "UNAVAILABLE" }])).toBe("UNAVAILABLE");
    expect(meshRouterState([{ configured: true, state: "LIVE" }, { configured: true, state: "UNAVAILABLE" }])).toBe("DEGRADED");
    expect(meshRouterState([{ configured: true, state: "LIVE" }, { configured: true, state: "RATE_LIMITED" }])).toBe("DEGRADED");
    expect(meshRouterState([{ configured: true, state: "LIVE" }, { configured: true, state: "CONFIGURED" }, { configured: false, state: "NOT_CONFIGURED" }])).toBe("HEALTHY");
  });
});

describe("computeConsensusStatus", () => {
  const full = { members: 5, unavailable: 0, round3: 5 };
  it("CONSENSUS kun når ALLE svarende støtter og rådet er fullt", () => {
    expect(computeConsensusStatus({ ...full, supporting: 5, dissenting: 0 })).toBe("CONSENSUS");
  });
  it("ingen uenighet, men ingen støtte i det hele tatt = IKKE konsensus (tidligere CONSENSUS)", () => {
    expect(computeConsensusStatus({ ...full, supporting: 0, dissenting: 0 })).toBe("DEGRADED_NO_CONSENSUS");
  });
  it("noen nøytrale (ikke støttende, ikke uenige) = MAJORITY, ikke CONSENSUS", () => {
    expect(computeConsensusStatus({ ...full, supporting: 3, dissenting: 0 })).toBe("MAJORITY");
  });
  it("manglende medlemmer = DEGRADED_NO_CONSENSUS", () => {
    expect(computeConsensusStatus({ members: 5, unavailable: 1, round3: 4, supporting: 4, dissenting: 0 })).toBe("DEGRADED_NO_CONSENSUS");
  });
  it("kun ett medlem svarte = ikke konsensus", () => {
    expect(computeConsensusStatus({ members: 1, unavailable: 0, round3: 1, supporting: 1, dissenting: 0 })).toBe("DEGRADED_NO_CONSENSUS");
  });
  it("uenighet: flertall/splittet som før", () => {
    expect(computeConsensusStatus({ ...full, supporting: 3, dissenting: 2 })).toBe("MAJORITY");
    expect(computeConsensusStatus({ ...full, supporting: 2, dissenting: 2 })).toBe("SPLIT");
    expect(computeConsensusStatus({ ...full, supporting: 1, dissenting: 4 })).toBe("SPLIT");
  });
});

describe("decision-importance: norske beløp", () => {
  it.each([
    "Skal vi betale 500 000 kr for dette?",
    "Skal vi betale 500 000 kr for dette?",
    "Vi vurderer å bruke 2 millioner kroner på annonser",
    "budsjett på 1,5 mill kr",
    "kr 3 millioner i investering",
    "3 mrd NOK",
    "Should we pay $2 million?",
    "bruker 500.000 NOK",
    "bruker 120000 kroner"
  ])("%s → høy innvirkning (financial_magnitude)", (text) => {
    const c = classifyDecisionImportance(text);
    expect(c.decision_importance, text).toBe("HIGH_IMPACT_DECISION");
    expect(c.trigger_reasons).toContain("financial_magnitude");
  });

  it.each([
    "Det koster 5 000 kr", // under terskelen
    "Jeg har 2 millioner brukere", // ingen valuta
    "Møtet er klokken 10 000 meter unna", // ingen valuta
    "Hva er 1,5 mill?", // ingen valuta
    "bruker 99 000 kr"
  ])("%s → rutine (ingen falsk positiv)", (text) => {
    expect(classifyDecisionImportance(text).decision_importance, text).not.toBe("HIGH_IMPACT_DECISION");
  });
});

describe("council: persistensfeil logges (var helt stille)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persistEvent kaster aldri, men logger council_event_persist_failed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingPool = { connect: async () => { throw new Error("db_down"); }, query: async () => { throw new Error("db_down"); } } as unknown as pg.Pool;
    const council = new AiCouncil({} as never, failingPool);
    await (council as unknown as { persistEvent: (i: unknown, id: string, t: string, p: Record<string, unknown>) => Promise<void> }).persistEvent(
      { tenant_id: "t" },
      "council-1",
      "council_result",
      { x: 1 }
    );
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("council_event_persist_failed");
    expect(logged).toContain("council-1");
  });

  it("persistArtifact logger council_artifact_persist_failed ved DB-feil", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingPool = { connect: async () => { throw new Error("db_down"); } } as unknown as pg.Pool;
    const council = new AiCouncil({} as never, failingPool);
    await (council as unknown as { persistArtifact: (i: unknown, id: string, r: unknown) => Promise<void> }).persistArtifact({ tenant_id: "t", task_id: "task-1" }, "council-2", {});
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("council_artifact_persist_failed");
  });
});
