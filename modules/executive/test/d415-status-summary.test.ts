import { describe, expect, it } from "vitest";
import { summarizeCapabilityStatusNo, summarizeConnectorStatusNo } from "../src/status-summary.ts";

describe("D-415 summary_no", () => {
  it("kapabilitetsstatus: modell, tilkoblet, mangler, helseproblemer - ingen hemmeligheter", () => {
    const t = summarizeCapabilityStatusNo({
      chat_accessible_tools: [
        { tool_id: "github", actions: ["a", "b"], capability_classes: ["A"], configured: true },
        { tool_id: "slack", actions: ["a"], capability_classes: ["A"], configured: false }
      ],
      connector_health: [{ tool_id: "github", state: "down", at: "2026-10-06T00:00:00Z" }],
      serving_model: { provider: "gemma_local", model: "llama3.1:8b" }
    });
    expect(t).toContain("llama3.1:8b");
    expect(t).toContain("github (2)");
    expect(t).toContain("Mangler oppsett: slack");
    expect(t).toContain("github nede");
  });
  it("D-437: forbeholdet fra en prosess med snevret miljø står i summary_no (det modellen faktisk videreformidler), og mangler ellers", () => {
    const base = { chat_accessible_tools: [{ tool_id: "slack", actions: ["a"], capability_classes: ["A"], configured: false }], connector_health: [], serving_model: null };
    expect(summarizeCapabilityStatusNo({ ...base, evaluation_caveat: "snevret miljø i worker" })).toContain("Forbehold: snevret miljø i worker");
    expect(summarizeCapabilityStatusNo(base)).not.toContain("Forbehold");
  });
  it("ukjent modell sies som ukjent", () => {
    expect(summarizeCapabilityStatusNo({ chat_accessible_tools: [], connector_health: [], serving_model: null })).toContain("ukjent");
  });
  it("koblingsstatus", () => {
    const t = summarizeConnectorStatusNo([
      { id: "g", display_name: "GitHub", configured: true, health: { state: "healthy" } },
      { id: "s", display_name: "Slack", configured: false, health: null }
    ]);
    expect(t).toContain("1 av 2");
    expect(t).toContain("GitHub (ok)");
    expect(t).toContain("Ikke satt opp: Slack");
  });
});
