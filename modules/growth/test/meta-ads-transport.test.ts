import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaAdsApiError, MetaAdsTransport, decimalCurrencyToMinorUnits, mapMetaAdsCampaignStatus } from "../src/meta-ads-transport.ts";
import type { GrowthService } from "../src/service.ts";

/**
 * D-335 (UA-4 Meta Ads-slice): rene wiring-/kontraktstester (INGEN embedded
 * Postgres - `GrowthService` er en fake her, SAMME mønster som
 * `google-ads-transport.test.ts`). Beviser: Graph API-dispatch (access_token
 * som QUERY-PARAMETER, ALDRI header), retry/backoff KUN på retry-bare
 * statuser, feilklassifisering uten hemmelighetslekkasje, desimal->
 * minorenhet-konvertering (IKKE mikros), status-mapping, delvis-synk-
 * sikkerhet, streng dato-validering, og bounded `paging.next`-paginering.
 */

function fakeGrowth() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const campaignsByExternalId = new Map<string, { campaign_id: string; status: string }>();
  return {
    upsertCampaignFromProvider: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "upsertCampaignFromProvider", args });
      const input = args[2] as { external_campaign_id: string; status?: string };
      if (input.external_campaign_id === "FAIL-ME") throw new Error("simulated_upsert_failure");
      const existing = campaignsByExternalId.get(input.external_campaign_id);
      const campaign_id = existing?.campaign_id ?? `grw-cm-${input.external_campaign_id}`;
      const row = { campaign_id, status: input.status ?? existing?.status ?? "draft" };
      campaignsByExternalId.set(input.external_campaign_id, row);
      return row;
    }),
    recordSpendEvent: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "recordSpendEvent", args });
      const campaignId = args[2] as string;
      if (campaignId === "grw-cm-SPEND-FAIL") throw new Error("simulated_spend_failure");
      return {};
    }),
    _calls: calls
  } as unknown as GrowthService & { _calls: Array<{ method: string; args: unknown[] }> };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_META_ADS_AD_ACCOUNT_ID", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("A: konfigurasjonsvalidering - kaster FØR noe HTTP-kall gjøres", () => {
  it("mangler ad_account_id (verken konstruktør- eller parameter-satt) kaster meta_ads_ad_account_id_not_configured", async () => {
    const transport = new MetaAdsTransport(fakeGrowth(), undefined);
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "access-token")).rejects.toThrow("meta_ads_ad_account_id_not_configured");
  });
  it("mangler tenant_id kaster meta_ads_missing_parameter:tenant_id", async () => {
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    await expect(transport.invoke("list_campaigns", {}, "access-token")).rejects.toThrow("meta_ads_missing_parameter:tenant_id");
  });
  it("ukjent action kaster meta_ads_action_not_implemented", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    await expect(transport.invoke("delete_forever", { tenant_id: "t1" }, "access-token")).rejects.toThrow("meta_ads_action_not_implemented:delete_forever");
  });
  it("INGEN sync_tracking_tags-handling er implementert (D-41 BEVISST DEFERRED, ikke stille utelatt)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    await expect(transport.invoke("sync_tracking_tags", { tenant_id: "t1" }, "access-token")).rejects.toThrow("meta_ads_action_not_implemented:sync_tracking_tags");
  });
});

describe("B: dato-validering - streng YYYY-MM-DD FØR sync_spend gjør noe Graph-kall", () => {
  it("sync_spend med et ugyldig start_date-format kaster FØR noe fetch-kall gjøres", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    await expect(
      transport.invoke("sync_spend", { tenant_id: "t1", start_date: "2026/08/01", end_date: "2026-08-19" }, "access-token")
    ).rejects.toThrow("meta_ads_invalid_date_parameter:start_date");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("C: list_campaigns - ren leverandør-speiling, INGEN GrowthService-skriving, access_token som QUERY-PARAMETER (ALDRI header)", () => {
  it("mapper id/name/status fra Graph-respons korrekt, ingen DB-kall", async () => {
    const growth = fakeGrowth();
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: "111", name: "Sommerkampanje", status: "ACTIVE" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new MetaAdsTransport(growth, "12345");
    const result = await transport.invoke("list_campaigns", { tenant_id: "t1" }, "hemmelig-access-token");
    expect(result.data).toEqual([{ external_campaign_id: "111", name: "Sommerkampanje", status: "active" }]);
    expect(growth._calls).toHaveLength(0);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("https://graph.facebook.com/v26.0/act_12345/campaigns");
    expect(url).toContain("access_token=hemmelig-access-token");
    expect(fetchSpy.mock.calls[0]![1]).toBeUndefined();
  });

  it("følger paging.next til alle sider er hentet (bounded, ALDRI en uendelig løkke)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) return new Response(JSON.stringify({ data: [{ id: "1", name: "A", status: "ACTIVE" }], paging: { next: "https://graph.facebook.com/v26.0/act_12345/campaigns?after=xyz" } }), { status: 200 });
        return new Response(JSON.stringify({ data: [{ id: "2", name: "B", status: "PAUSED" }] }), { status: 200 });
      })
    );
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    const result = await transport.invoke("list_campaigns", { tenant_id: "t1" }, "access-token");
    expect(result.data).toEqual([
      { external_campaign_id: "1", name: "A", status: "active" },
      { external_campaign_id: "2", name: "B", status: "paused" }
    ]);
    expect(call).toBe(2);
  });
});

describe("D: sync_campaigns - idempotent upsert via GrowthService, status-mapping deterministisk", () => {
  it("kaller upsertCampaignFromProvider med channel=meta_ads og mappet status for hver kampanje", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "111", name: "A", status: "ACTIVE" },
              { id: "222", name: "B", status: "PAUSED" },
              { id: "333", name: "C", status: "ARCHIVED" },
              { id: "444", name: "D", status: "DELETED" }
            ]
          }),
          { status: 200 }
        )
      )
    );
    const transport = new MetaAdsTransport(growth, "12345");
    const result = await transport.invoke("sync_campaigns", { tenant_id: "t1" }, "access-token");
    expect(result.data).toMatchObject({ scanned: 4, synced: 4, failed: 0 });
    const calls = growth._calls.filter((c) => c.method === "upsertCampaignFromProvider");
    expect(calls.every((c) => (c.args[2] as { channel: string }).channel === "meta_ads")).toBe(true);
    expect(calls.map((c) => (c.args[2] as { status?: string }).status)).toEqual(["active", "paused", "ended", "ended"]);
  });

  it("en UKJENT provider-status utelater status-feltet helt (aldri en gjettet verdi)", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "555", name: "E", status: "SOMETHING_NEW" }] }), { status: 200 })));
    const transport = new MetaAdsTransport(growth, "12345");
    await transport.invoke("sync_campaigns", { tenant_id: "t1" }, "access-token");
    const input = growth._calls[0]!.args[2] as { status?: string };
    expect(input.status).toBeUndefined();
  });

  it("delvis-synk-sikkerhet: én kampanje som feiler velter ALDRI resten, feilårsak rapporteres per rad", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: "FAIL-ME", name: "Broken", status: "ACTIVE" }, { id: "666", name: "OK", status: "ACTIVE" }] }), { status: 200 })
      )
    );
    const transport = new MetaAdsTransport(growth, "12345");
    const result = await transport.invoke("sync_campaigns", { tenant_id: "t1" }, "access-token");
    expect(result.data).toMatchObject({ scanned: 2, synced: 1, failed: 1 });
    expect((result.data as { errors: Array<{ external_campaign_id: string; reason: string }> }).errors).toEqual([
      { external_campaign_id: "FAIL-ME", reason: "simulated_upsert_failure" }
    ]);
  });
});

describe("E: sync_spend - desimal->minorenhet-konvertering (IKKE mikros), source_type=provider_sync, source_pointer-proveniens, INGEN status sendt", () => {
  it("konverterer spend korrekt og setter source_type=provider_sync + source_pointer, uten et status-felt", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("act_12345/insights");
        expect(url).toContain("time_increment=1");
        expect(url).toContain("level=campaign");
        return new Response(
          JSON.stringify({ data: [{ campaign_id: "111", campaign_name: "A", spend: "15.5", clicks: "42", impressions: "1000", date_start: "2026-08-18" }] }),
          { status: 200 }
        );
      })
    );
    const transport = new MetaAdsTransport(growth, "12345");
    const result = await transport.invoke("sync_spend", { tenant_id: "t1", start_date: "2026-08-01", end_date: "2026-08-19" }, "access-token");
    expect(result.data).toMatchObject({ scanned: 1, synced: 1, failed: 0 });
    const upsertCall = growth._calls.find((c) => c.method === "upsertCampaignFromProvider")!;
    expect((upsertCall.args[2] as { status?: string }).status).toBeUndefined();
    const spendCall = growth._calls.find((c) => c.method === "recordSpendEvent")!;
    const input = spendCall.args[3] as { event_date: string; spend_amount_ore: number; clicks: number; impressions: number; source_type: string; source_pointer: string };
    expect(input.event_date).toBe("2026-08-18");
    expect(input.spend_amount_ore).toBe(1_550); // 15.5 kr = 1550 øre
    expect(input.clicks).toBe(42);
    expect(input.impressions).toBe(1_000);
    expect(input.source_type).toBe("provider_sync");
    expect(input.source_pointer).toBe("metaads:act_12345/campaigns/111");
  });

  it("delvis-synk-sikkerhet: recordSpendEvent-feil for én rad velter ALDRI resten", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { campaign_id: "SPEND-FAIL", campaign_name: "Broken", spend: "10", date_start: "2026-08-18" },
              { campaign_id: "777", campaign_name: "OK", spend: "10", date_start: "2026-08-18" }
            ]
          }),
          { status: 200 }
        )
      )
    );
    const transport = new MetaAdsTransport(growth, "12345");
    const result = await transport.invoke("sync_spend", { tenant_id: "t1", start_date: "2026-08-01", end_date: "2026-08-19" }, "access-token");
    expect(result.data).toMatchObject({ scanned: 2, synced: 1, failed: 1 });
  });
});

describe("F: retry/backoff - KUN på bekreftede retry-bare statuser, ALDRI en retry-storm", () => {
  it("429 etterfulgt av suksess lykkes ETTER retry (bounded, eksponentiell backoff)", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts++;
        if (attempts === 1) return new Response(JSON.stringify({ error: { type: "OAuthException", code: 4, message: "rate limited" } }), { status: 429 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      })
    );
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    const result = await transport.invoke("list_campaigns", { tenant_id: "t1" }, "access-token");
    expect(attempts).toBe(2);
    expect(result.data).toEqual([]);
  }, 10_000);

  it("429 vedvarende over maks forsøk kaster MetaAdsApiError, ALDRI en uendelig retry-løkke", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts++;
        return new Response(JSON.stringify({ error: { type: "OAuthException", code: 4, message: "rate limited" } }), { status: 429 });
      })
    );
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "access-token")).rejects.toBeInstanceOf(MetaAdsApiError);
    expect(attempts).toBe(3); // MAX_ATTEMPTS, aldri mer - "no retry storms"
  }, 10_000);

  it("401/403 (autentiserings-/autorisasjonsfeil) forsøkes ALDRI på nytt - kastes umiddelbart", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts++;
        return new Response(JSON.stringify({ error: { type: "OAuthException", code: 190, message: "token expired" } }), { status: 401 });
      })
    );
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "access-token")).rejects.toBeInstanceOf(MetaAdsApiError);
    expect(attempts).toBe(1); // ingen retry på en permanent feil
  });

  it("5xx utløser retry, men en ikke-JSON feilkropp klassifiseres trygt (UNCLASSIFIED_ERROR_BODY) uten å knekke", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })));
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "access-token")).rejects.toThrow(/meta_ads_api_error_502:UNCLASSIFIED_ERROR_BODY/);
  }, 10_000);
});

describe("G: nulllekkasje-regresjon - INGEN access_token forekommer noe sted i kastede feilmeldinger", () => {
  it("en 401-feil sin melding inneholder ALDRI access-tokenet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { type: "OAuthException", code: 190, message: "denied" } }), { status: 401 })));
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    try {
      await transport.invoke("list_campaigns", { tenant_id: "t1" }, "hemmelig-access-token-xyz");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("hemmelig-access-token-xyz");
    }
  });

  it("Meta sin generiske feilkropp avkortes til 200 tegn (samme presedens som classifyGoogleAdsErrorBody-avkorting)", async () => {
    const longMessage = "x".repeat(500);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { type: "APIError", code: 1, message: longMessage } }), { status: 400 })));
    const transport = new MetaAdsTransport(fakeGrowth(), "12345");
    try {
      await transport.invoke("list_campaigns", { tenant_id: "t1" }, "access-token");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(250);
    }
  });
});

describe("H: rene funksjonstester - status-mapping og desimal-konvertering", () => {
  it("mapMetaAdsCampaignStatus mapper ACTIVE/PAUSED/ARCHIVED/DELETED deterministisk, alt annet blir undefined", () => {
    expect(mapMetaAdsCampaignStatus("ACTIVE")).toBe("active");
    expect(mapMetaAdsCampaignStatus("PAUSED")).toBe("paused");
    expect(mapMetaAdsCampaignStatus("ARCHIVED")).toBe("ended");
    expect(mapMetaAdsCampaignStatus("DELETED")).toBe("ended");
    expect(mapMetaAdsCampaignStatus("SOMETHING_NEW")).toBeUndefined();
    expect(mapMetaAdsCampaignStatus(undefined)).toBeUndefined();
  });
  it("decimalCurrencyToMinorUnits konverterer korrekt og degraderer trygt ved ugyldig input", () => {
    expect(decimalCurrencyToMinorUnits("15.5")).toBe(1_550);
    expect(decimalCurrencyToMinorUnits("5339.5")).toBe(533_950);
    expect(decimalCurrencyToMinorUnits(0)).toBe(0);
    expect(decimalCurrencyToMinorUnits(undefined)).toBe(0);
    expect(decimalCurrencyToMinorUnits("not-a-number")).toBe(0);
  });
});
