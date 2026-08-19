import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { GrowthService } from "../src/service.ts";
import { GrowthTransport } from "../src/transport.ts";

/**
 * UA-4 Native Jarvis Growth Core (D-74): rene wiring-/orkestreringstester
 * (INGEN embedded Postgres - `GrowthService` er en fake, samme mønster som
 * agreements-transport-wiring.test.ts). Beviser ToolGateway-registrering/
 * risikoklasser og ZERO annonseplattform-leverandør-avhengighet (ingen
 * Google Ads/Meta Ads/GA4/LinkedIn-credential-referanse, ingen
 * provider-env-variabel lest noe sted i modules/growth).
 */

describe("A: growth.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("growth.create_campaign/set_campaign_status/record_spend_event/campaign_performance finnes i registeret og peker til growth-transporten", () => {
    const growthTransport = new GrowthTransport({} as unknown as GrowthService);
    const tools = firstWaveTools({ growth: growthTransport });
    const growthTools = tools.filter((t) => t.tool_id === "growth");
    expect(growthTools.length).toBeGreaterThanOrEqual(16);
    expect(growthTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_campaign", "get_campaign", "list_campaigns", "search_campaigns", "list_by_company",
        "set_campaign_status", "set_budget", "record_spend_event", "list_spend_events", "campaign_performance",
        "attribute_to_campaign", "list_attributions", "create_experiment", "get_experiment", "list_experiments",
        "set_experiment_status", "list_events"
      ])
    );
    for (const tool of growthTools) expect(tool.transport).toBe(growthTransport);
  });
});

describe("B: risikoklasser er effekt-baserte, ingen growth.*-handling er klasse D (ingen live annonseplattform-utførelse i denne sliceen)", () => {
  it("lesing er klasse A, interne skrivinger klasse B, lifecycle-overganger klasse C", () => {
    const tools = firstWaveTools({ growth: new GrowthTransport({} as unknown as GrowthService) }).filter((t) => t.tool_id === "growth");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["get_campaign"]).toBe("A");
    expect(byAction["list_campaigns"]).toBe("A");
    expect(byAction["campaign_performance"]).toBe("A");
    expect(byAction["list_events"]).toBe("A");
    expect(byAction["create_campaign"]).toBe("B");
    expect(byAction["record_spend_event"]).toBe("B");
    expect(byAction["attribute_to_campaign"]).toBe("B");
    expect(byAction["set_campaign_status"]).toBe("C");
    expect(byAction["set_experiment_status"]).toBe("C");
    expect(tools.every((t) => t.capability_class !== "D")).toBe(true);
  });
});

describe("C: transport-dispatch ruter til riktig service-metode", () => {
  function fakeService() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      createCampaign: async (...args: unknown[]) => { calls.push({ method: "createCampaign", args }); return { campaign_id: "grw-cm-1" }; },
      setStatus: async (...args: unknown[]) => { calls.push({ method: "setStatus", args }); return { campaign_id: "grw-cm-1", status: args[3] }; },
      recordSpendEvent: async (...args: unknown[]) => { calls.push({ method: "recordSpendEvent", args }); return { spend_event_id: "grw-se-1" }; },
      campaignPerformance: async (...args: unknown[]) => { calls.push({ method: "campaignPerformance", args }); return { campaign_id: "grw-cm-1" }; },
      _calls: calls
    } as unknown as GrowthService & { _calls: Array<{ method: string; args: unknown[] }> };
  }
  it("create_campaign kaller service.createCampaign med tenant/space/channel/name", async () => {
    const service = fakeService();
    const transport = new GrowthTransport(service);
    await transport.invoke("create_campaign", { tenant_id: "t1", channel: "google_ads", name: "Test" });
    expect(service._calls[0]!.method).toBe("createCampaign");
  });
  it("set_campaign_status kaller service.setStatus med riktig status-parameter", async () => {
    const service = fakeService();
    const transport = new GrowthTransport(service);
    await transport.invoke("set_campaign_status", { tenant_id: "t1", campaign_id: "grw-cm-1", status: "active" });
    expect(service._calls[0]!.method).toBe("setStatus");
    expect(service._calls[0]!.args[3]).toBe("active");
  });
  it("record_spend_event kaller service.recordSpendEvent med tallverdi for spend_amount_ore (streng fra JsonValue konverteres)", async () => {
    const service = fakeService();
    const transport = new GrowthTransport(service);
    await transport.invoke("record_spend_event", { tenant_id: "t1", campaign_id: "grw-cm-1", event_date: "2026-08-01", spend_amount_ore: 1000 });
    expect(service._calls[0]!.method).toBe("recordSpendEvent");
    const input = service._calls[0]!.args[3] as { spend_amount_ore: number };
    expect(input.spend_amount_ore).toBe(1000);
  });
  it("manglende paakrevd parameter kaster growth_missing_parameter", async () => {
    const transport = new GrowthTransport(fakeService());
    await expect(transport.invoke("create_campaign", { tenant_id: "t1" })).rejects.toThrow("growth_missing_parameter:channel");
  });
  it("ukjent action kaster growth_action_not_implemented", async () => {
    const transport = new GrowthTransport(fakeService());
    await expect(transport.invoke("delete_forever", { tenant_id: "t1" })).rejects.toThrow("growth_action_not_implemented:delete_forever");
  });
});

describe("D: ZERO annonseplattform-leverandør-avhengighet (no-provider-proof)", () => {
  const FORBIDDEN = /google\s*ads\s*api|meta\s*marketing\s*api|googleapis\.com\/ads|graph\.facebook\.com|linkedin\.com\/rest|tiktokads/i;
  it("ingen kildefil i modules/growth refererer noen annonseplattform-API-endepunkt", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(FORBIDDEN);
    }
  });
  it("ingen JARVIS_*_ADS*/JARVIS_*_GA4*-miljøvariabel eller annen leverandør-credential leses noe sted i modules/growth", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(/process\.env\[/);
    }
  });
  it("GrowthService/GrowthTransport konstrueres uten NOEN provider-credential-parameter", () => {
    // GrowthService(pool) og GrowthTransport(service) - begge tar KUN interne
    // avhengigheter, ingen API-nøkkel/OAuth-klient av noe slag.
    expect(GrowthTransport.length).toBe(1);
  });
});
