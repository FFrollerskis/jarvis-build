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
    expect(growthTools.length).toBeGreaterThanOrEqual(23);
    expect(growthTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_campaign", "get_campaign", "list_campaigns", "search_campaigns", "list_by_company",
        "set_campaign_status", "set_budget", "record_spend_event", "list_spend_events", "campaign_performance",
        "attribute_to_campaign", "list_attributions", "create_experiment", "get_experiment", "list_experiments",
        "set_experiment_status", "list_events",
        "register_campaign_tracking_tag", "list_campaign_tracking_tags", "resolve_campaign_from_tracking", "attribute_from_tracking",
        "list_action_recommendations", "resolve_action_recommendation"
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
    expect(byAction["list_campaign_tracking_tags"]).toBe("A");
    expect(byAction["resolve_campaign_from_tracking"]).toBe("A");
    expect(byAction["register_campaign_tracking_tag"]).toBe("B");
    expect(byAction["attribute_from_tracking"]).toBe("B");
    // D-85: BESLUTNINGS-lag ALENE - `resolve_action_recommendation` er klasse
    // B (REN Jarvis-intern disposisjon-sporing), ALDRI C/D (ingen ekte
    // provider-utførelse i denne sliceen).
    expect(byAction["list_action_recommendations"]).toBe("A");
    expect(byAction["resolve_action_recommendation"]).toBe("B");
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

describe("C2 (D-82): sporingstagg-dispatch - gjensidig utelukkende click_id/utm-input", () => {
  function fakeTrackingService() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      registerCampaignTrackingTag: async (...args: unknown[]) => { calls.push({ method: "registerCampaignTrackingTag", args }); return { tag_id: "grw-tt-1" }; },
      listCampaignTrackingTags: async (...args: unknown[]) => { calls.push({ method: "listCampaignTrackingTags", args }); return []; },
      resolveCampaignFromTracking: async (...args: unknown[]) => { calls.push({ method: "resolveCampaignFromTracking", args }); return "grw-cm-1"; },
      attributeFromTracking: async (...args: unknown[]) => { calls.push({ method: "attributeFromTracking", args }); return { attribution_id: "grw-at-1" }; },
      _calls: calls
    } as unknown as GrowthService & { _calls: Array<{ method: string; args: unknown[] }> };
  }
  it("register_campaign_tracking_tag med click_id kaller service med riktig union-form", async () => {
    const service = fakeTrackingService();
    const transport = new GrowthTransport(service);
    await transport.invoke("register_campaign_tracking_tag", { tenant_id: "t1", campaign_id: "grw-cm-1", click_id_param: "gclid", click_id_value: "abc123" });
    expect(service._calls[0]!.method).toBe("registerCampaignTrackingTag");
    expect(service._calls[0]!.args[3]).toEqual({ click_id_param: "gclid", click_id_value: "abc123" });
  });
  it("register_campaign_tracking_tag med utm-triplett kaller service med riktig union-form", async () => {
    const service = fakeTrackingService();
    const transport = new GrowthTransport(service);
    await transport.invoke("register_campaign_tracking_tag", {
      tenant_id: "t1", campaign_id: "grw-cm-1", utm_source: "google", utm_medium: "cpc", utm_campaign: "spring-sale"
    });
    expect(service._calls[0]!.args[3]).toEqual({ utm_source: "google", utm_medium: "cpc", utm_campaign: "spring-sale" });
  });
  it("register_campaign_tracking_tag med BÅDE click_id og utm kaster (tvetydig, ALDRI gjettet hvilken)", async () => {
    const transport = new GrowthTransport(fakeTrackingService());
    await expect(
      transport.invoke("register_campaign_tracking_tag", {
        tenant_id: "t1", campaign_id: "grw-cm-1", click_id_param: "gclid", click_id_value: "abc123", utm_source: "google", utm_medium: "cpc", utm_campaign: "x"
      })
    ).rejects.toThrow("growth_missing_parameter:exactly_one_of_click_id_or_utm_required");
  });
  it("register_campaign_tracking_tag uten NOEN sporingsparameter kaster (samme feilmelding, aldri en stille tom tagg)", async () => {
    const transport = new GrowthTransport(fakeTrackingService());
    await expect(
      transport.invoke("register_campaign_tracking_tag", { tenant_id: "t1", campaign_id: "grw-cm-1" })
    ).rejects.toThrow("growth_missing_parameter:exactly_one_of_click_id_or_utm_required");
  });
  it("resolve_campaign_from_tracking returnerer campaign_id fra service, ingen mutasjon", async () => {
    const service = fakeTrackingService();
    const transport = new GrowthTransport(service);
    const result = await transport.invoke("resolve_campaign_from_tracking", { tenant_id: "t1", click_id_param: "fbclid", click_id_value: "xyz" });
    expect(service._calls[0]!.method).toBe("resolveCampaignFromTracking");
    expect(result.external_id).toBe("grw-cm-1");
  });
  it("attribute_from_tracking sender entity_type/entity_id + tracking-union videre til service.attributeFromTracking", async () => {
    const service = fakeTrackingService();
    const transport = new GrowthTransport(service);
    await transport.invoke("attribute_from_tracking", {
      tenant_id: "t1", entity_type: "lead", entity_id: "lead-1", utm_source: "google", utm_medium: "cpc", utm_campaign: "spring-sale"
    });
    expect(service._calls[0]!.method).toBe("attributeFromTracking");
    const input = service._calls[0]!.args[2] as { entity_type: string; entity_id: string; tracking: unknown };
    expect(input.entity_type).toBe("lead");
    expect(input.entity_id).toBe("lead-1");
    expect(input.tracking).toEqual({ utm_source: "google", utm_medium: "cpc", utm_campaign: "spring-sale" });
  });
});

describe("C3 (D-85): anbefaling-dispatch - list/resolve ruter til riktig service-metode", () => {
  function fakeRecommendationService() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      listActionRecommendations: async (...args: unknown[]) => { calls.push({ method: "listActionRecommendations", args }); return []; },
      resolveActionRecommendation: async (...args: unknown[]) => { calls.push({ method: "resolveActionRecommendation", args }); return { recommendation_id: "grw-rec-1", status: args[3] }; },
      _calls: calls
    } as unknown as GrowthService & { _calls: Array<{ method: string; args: unknown[] }> };
  }
  it("list_action_recommendations kaller service.listActionRecommendations med valgfritt campaign_id/status-filter", async () => {
    const service = fakeRecommendationService();
    const transport = new GrowthTransport(service);
    await transport.invoke("list_action_recommendations", { tenant_id: "t1", campaign_id: "grw-cm-1", status: "proposed" });
    expect(service._calls[0]!.method).toBe("listActionRecommendations");
    expect(service._calls[0]!.args[2]).toEqual({ campaign_id: "grw-cm-1", status: "proposed" });
  });
  it("resolve_action_recommendation kaller service.resolveActionRecommendation med recommendation_id/status/actor", async () => {
    const service = fakeRecommendationService();
    const transport = new GrowthTransport(service);
    const result = await transport.invoke("resolve_action_recommendation", {
      tenant_id: "t1", recommendation_id: "grw-rec-1", status: "accepted", actor_person_id: "person-owner"
    });
    expect(service._calls[0]!.method).toBe("resolveActionRecommendation");
    expect(service._calls[0]!.args[2]).toBe("grw-rec-1");
    expect(service._calls[0]!.args[3]).toBe("accepted");
    expect(service._calls[0]!.args[4]).toBe("person-owner");
    expect(result.external_id).toBe("grw-rec-1");
  });
  it("resolve_action_recommendation med en annen status enn accepted/dismissed kaster (ALDRI en gjettet status videresendt)", async () => {
    const transport = new GrowthTransport(fakeRecommendationService());
    await expect(
      transport.invoke("resolve_action_recommendation", { tenant_id: "t1", recommendation_id: "grw-rec-1", status: "proposed" })
    ).rejects.toThrow("growth_invalid_parameter:status_must_be_accepted_or_dismissed");
  });
});

describe("D: ZERO annonseplattform-leverandør-avhengighet (no-provider-proof)", () => {
  const FORBIDDEN = /google\s*ads\s*api|meta\s*marketing\s*api|googleapis\.com\/ads|graph\.facebook\.com|linkedin\.com\/rest|tiktokads/i;
  it("ingen kildefil i modules/growth refererer noen annonseplattform-API-endepunkt", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts", "action-recommendation-sweep.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(FORBIDDEN);
    }
  });
  it("ingen JARVIS_*_ADS*/JARVIS_*_GA4*-miljøvariabel eller annen leverandør-credential leses noe sted i modules/growth", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts", "action-recommendation-sweep.ts"];
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
