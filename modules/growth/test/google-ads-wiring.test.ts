import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { GrowthService } from "../src/service.ts";
import { GoogleAdsTransport } from "../src/google-ads-transport.ts";

/**
 * UA-4 Google Ads-slice (D-83): ToolGateway-registrerings-/risikoklasse-
 * bevis (SAMME mønster som `transport-wiring.test.ts`) - INGEN embedded
 * Postgres, `GrowthService` er en fake.
 */
describe("A: googleads.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("list_campaigns/sync_campaigns/sync_spend/sync_tracking_tags finnes i registeret og peker til googleads-transporten", () => {
    const googleAdsTransport = new GoogleAdsTransport({} as unknown as GrowthService);
    const tools = firstWaveTools({ googleads: googleAdsTransport });
    const googleAdsTools = tools.filter((t) => t.tool_id === "googleads");
    expect(googleAdsTools.map((t) => t.action)).toEqual(
      expect.arrayContaining(["list_campaigns", "sync_campaigns", "sync_spend", "sync_tracking_tags"])
    );
    for (const tool of googleAdsTools) expect(tool.transport).toBe(googleAdsTransport);
  });
});

describe("B: risikoklasser - lesing er klasse A, Growth Core-synk er klasse B, INGEN klasse D (ingen mutate-/budsjett-/bud-skriving MOT Google i denne sliceen)", () => {
  it("list_campaigns er A, alle tre sync_*-handlinger er B, ingen googleads.*-handling er D", () => {
    const tools = firstWaveTools({ googleads: new GoogleAdsTransport({} as unknown as GrowthService) }).filter((t) => t.tool_id === "googleads");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["list_campaigns"]).toBe("A");
    expect(byAction["sync_campaigns"]).toBe("B");
    expect(byAction["sync_spend"]).toBe("B");
    expect(byAction["sync_tracking_tags"]).toBe("B");
    expect(tools.every((t) => t.capability_class !== "D")).toBe(true);
  });
});

describe("C: eget credential_ref, ATSKILT fra Gmail/Calendar/Drive sitt JARVIS_GOOGLE_TOKEN (annet OAuth-scope - adwords, ikke gmail/calendar/drive)", () => {
  it("alle googleads.*-handlinger bruker JARVIS_GOOGLE_ADS_REFRESH_TOKEN, aldri JARVIS_GOOGLE_TOKEN/JARVIS_EMAIL_TOKEN", () => {
    const tools = firstWaveTools({ googleads: new GoogleAdsTransport({} as unknown as GrowthService) }).filter((t) => t.tool_id === "googleads");
    expect(tools.every((t) => t.credential_ref === "JARVIS_GOOGLE_ADS_REFRESH_TOKEN")).toBe(true);
  });
});
