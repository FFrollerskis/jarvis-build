import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { GrowthService } from "../src/service.ts";
import { MetaAdsTransport } from "../src/meta-ads-transport.ts";

/**
 * D-335 (UA-4 Meta Ads-slice): ToolGateway-registrerings-/risikoklasse-bevis
 * (SAMME mønster som `google-ads-wiring.test.ts`) - INGEN embedded Postgres,
 * `GrowthService` er en fake.
 */
describe("A: metaads.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("list_campaigns/sync_campaigns/sync_spend finnes i registeret og peker til metaads-transporten", () => {
    const metaAdsTransport = new MetaAdsTransport({} as unknown as GrowthService);
    const tools = firstWaveTools({ metaads: metaAdsTransport });
    const metaAdsTools = tools.filter((t) => t.tool_id === "metaads");
    expect(metaAdsTools.map((t) => t.action)).toEqual(expect.arrayContaining(["list_campaigns", "sync_campaigns", "sync_spend"]));
    for (const tool of metaAdsTools) expect(tool.transport).toBe(metaAdsTransport);
  });

  it("INGEN metaads.sync_tracking_tags er registrert (D-41 BEVISST DEFERRED, ikke stille utelatt)", () => {
    const tools = firstWaveTools({ metaads: new MetaAdsTransport({} as unknown as GrowthService) });
    expect(tools.find((t) => t.tool_id === "metaads" && t.action === "sync_tracking_tags")).toBeUndefined();
  });
});

describe("B: risikoklasser - lesing er klasse A, Growth Core-synk er klasse B, INGEN klasse D (ingen mutate-/budsjett-skriving MOT Meta i denne sliceen)", () => {
  it("list_campaigns er A, begge sync_*-handlinger er B, ingen metaads.*-handling er D", () => {
    const tools = firstWaveTools({ metaads: new MetaAdsTransport({} as unknown as GrowthService) }).filter((t) => t.tool_id === "metaads");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["list_campaigns"]).toBe("A");
    expect(byAction["sync_campaigns"]).toBe("B");
    expect(byAction["sync_spend"]).toBe("B");
    expect(tools.every((t) => t.capability_class !== "D")).toBe(true);
  });
});

describe("C: eget credential_ref, ATSKILT fra Google Ads/Gmail/Calendar/Drive sine tokens", () => {
  it("alle metaads.*-handlinger bruker JARVIS_META_ADS_ACCESS_TOKEN, aldri et Google-token", () => {
    const tools = firstWaveTools({ metaads: new MetaAdsTransport({} as unknown as GrowthService) }).filter((t) => t.tool_id === "metaads");
    expect(tools.every((t) => t.credential_ref === "JARVIS_META_ADS_ACCESS_TOKEN")).toBe(true);
  });
});
