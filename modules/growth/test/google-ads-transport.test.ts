import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAdsApiError, GoogleAdsTransport, mapGoogleAdsCampaignStatus, microsToMinorUnits } from "../src/google-ads-transport.ts";
import type { GrowthService } from "../src/service.ts";

/**
 * UA-4 Google Ads-slice (D-83): rene wiring-/kontraktstester (INGEN embedded
 * Postgres - `GrowthService` er en fake her, samme mønster som
 * `transport-wiring.test.ts`). Beviser: GAQL-dispatch, retry/backoff KUN på
 * retry-bare statuser, feilklassifisering uten hemmelighetslekkasje,
 * mikros->minorenhet-konvertering, status-mapping, delvis-synk-sikkerhet
 * (én rad feiler, resten fortsetter), og streng dato-validering (GAQL har
 * INGEN parameteriserte spørringer).
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const OK_TOKEN_RESPONSE = () => new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200 });

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
    findCampaignByExternalId: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "findCampaignByExternalId", args });
      const externalId = args[3] as string;
      const found = campaignsByExternalId.get(externalId);
      return found ? { campaign_id: found.campaign_id } : null;
    }),
    recordSpendEvent: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "recordSpendEvent", args });
      const campaignId = args[2] as string;
      if (campaignId === "grw-cm-SPEND-FAIL") throw new Error("simulated_spend_failure");
      return {};
    }),
    registerCampaignTrackingTag: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "registerCampaignTrackingTag", args });
      return {};
    }),
    _calls: calls
  } as unknown as GrowthService & { _calls: Array<{ method: string; args: unknown[] }> };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "client-secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("A: konfigurasjonsvalidering - kaster FØR noe HTTP-kall gjøres", () => {
  it("mangler customer_id (verken konstruktør- eller parameter-satt) kaster google_ads_customer_id_not_configured", async () => {
    const transport = new GoogleAdsTransport(fakeGrowth(), undefined, "dev-token");
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token")).rejects.toThrow("google_ads_customer_id_not_configured");
  });
  it("mangler developer_token kaster google_ads_developer_token_not_configured", async () => {
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", undefined);
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token")).rejects.toThrow("google_ads_developer_token_not_configured");
  });
  it("mangler tenant_id kaster google_ads_missing_parameter:tenant_id", async () => {
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    await expect(transport.invoke("list_campaigns", {}, "refresh-token")).rejects.toThrow("google_ads_missing_parameter:tenant_id");
  });
  it("ukjent action kaster google_ads_action_not_implemented", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => OK_TOKEN_RESPONSE()));
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    await expect(transport.invoke("delete_forever", { tenant_id: "t1" }, "refresh-token")).rejects.toThrow("google_ads_action_not_implemented:delete_forever");
  });
});

describe("B: dato-validering - streng YYYY-MM-DD FØR strenginterpolering inn i GAQL (ingen parameteriserte spørringer)", () => {
  it("sync_spend med et ugyldig start_date-format kaster FØR noe GAQL-kall gjøres", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => OK_TOKEN_RESPONSE()));
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    await expect(
      transport.invoke("sync_spend", { tenant_id: "t1", start_date: "2026/08/01", end_date: "2026-08-19" }, "refresh-token")
    ).rejects.toThrow("google_ads_invalid_date_parameter:start_date");
  });
  it("sync_tracking_tags med et forsøk på GAQL-injeksjon i date-feltet kastes trygt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => OK_TOKEN_RESPONSE()));
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    await expect(
      transport.invoke("sync_tracking_tags", { tenant_id: "t1", date: "2026-08-19' OR '1'='1" }, "refresh-token")
    ).rejects.toThrow("google_ads_invalid_date_parameter:date");
  });
});

describe("C: list_campaigns - ren leverandør-speiling, INGEN GrowthService-skriving", () => {
  it("mapper campaign.id/name/status fra GAQL-respons korrekt, ingen DB-kall", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        return new Response(
          JSON.stringify({ results: [{ campaign: { id: "111", name: "Sommerkampanje", status: "ENABLED" } }] }),
          { status: 200 }
        );
      })
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token");
    expect(result.data).toEqual([{ external_campaign_id: "111", name: "Sommerkampanje", status: "active" }]);
    expect(growth._calls).toHaveLength(0);
  });

  it("developer-token/login-customer-id sendes i HEADERE, ALDRI i URL-en eller query-strengen", async () => {
    const fetchSpy = vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ results: [] }), { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "hemmelig-dev-token", "9999999999");
    await transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token");
    const gaqlCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes("googleads.googleapis.com"));
    expect(gaqlCall).toBeDefined();
    const [url, init] = gaqlCall as unknown as [string, RequestInit];
    expect(url).not.toContain("hemmelig-dev-token");
    const headers = init.headers as Record<string, string>;
    expect(headers["developer-token"]).toBe("hemmelig-dev-token");
    expect(headers["login-customer-id"]).toBe("9999999999");
    expect(headers.authorization).toBe("Bearer fake-access-token");
  });
});

describe("D: sync_campaigns - idempotent upsert via GrowthService, status-mapping deterministisk", () => {
  it("kaller upsertCampaignFromProvider med channel=google_ads og mappet status for hver kampanje", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        return new Response(
          JSON.stringify({
            results: [
              { campaign: { id: "111", name: "A", status: "ENABLED" } },
              { campaign: { id: "222", name: "B", status: "PAUSED" } },
              { campaign: { id: "333", name: "C", status: "REMOVED" } }
            ]
          }),
          { status: 200 }
        );
      })
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("sync_campaigns", { tenant_id: "t1" }, "refresh-token");
    expect(result.data).toMatchObject({ scanned: 3, synced: 3, failed: 0 });
    const statuses = growth._calls.filter((c) => c.method === "upsertCampaignFromProvider").map((c) => (c.args[2] as { status?: string }).status);
    expect(statuses).toEqual(["active", "paused", "ended"]);
  });

  it("en UKJENT provider-status utelater status-feltet helt (aldri en gjettet verdi)", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ results: [{ campaign: { id: "444", name: "D", status: "UNKNOWN" } }] }), { status: 200 })))
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    await transport.invoke("sync_campaigns", { tenant_id: "t1" }, "refresh-token");
    const input = growth._calls[0]!.args[2] as { status?: string };
    expect(input.status).toBeUndefined();
  });

  it("delvis-synk-sikkerhet: én kampanje som feiler velter ALDRI resten, feilårsak rapporteres per rad", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        return new Response(
          JSON.stringify({ results: [{ campaign: { id: "FAIL-ME", name: "Broken", status: "ENABLED" } }, { campaign: { id: "555", name: "OK", status: "ENABLED" } }] }),
          { status: 200 }
        );
      })
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("sync_campaigns", { tenant_id: "t1" }, "refresh-token");
    expect(result.data).toMatchObject({ scanned: 2, synced: 1, failed: 1 });
    expect((result.data as { errors: Array<{ external_campaign_id: string; reason: string }> }).errors).toEqual([
      { external_campaign_id: "FAIL-ME", reason: "simulated_upsert_failure" }
    ]);
  });

  it("pagineres via nextPageToken til alle sider er hentet", async () => {
    const growth = fakeGrowth();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        call++;
        if (call === 1) return new Response(JSON.stringify({ results: [{ campaign: { id: "1", name: "A", status: "ENABLED" } }], nextPageToken: "page2" }), { status: 200 });
        return new Response(JSON.stringify({ results: [{ campaign: { id: "2", name: "B", status: "ENABLED" } }] }), { status: 200 });
      })
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("sync_campaigns", { tenant_id: "t1" }, "refresh-token");
    expect(result.data).toMatchObject({ scanned: 2, synced: 2 });
  });
});

describe("E: sync_spend - mikros->minorenhet-konvertering, source_type=provider_sync, source_pointer-proveniens", () => {
  it("konverterer cost_micros korrekt og setter source_type=provider_sync + source_pointer", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        return new Response(
          JSON.stringify({
            results: [
              { campaign: { id: "111", name: "A", status: "ENABLED" }, segments: { date: "2026-08-18" }, metrics: { costMicros: "15500000", clicks: "42", impressions: "1000" } }
            ]
          }),
          { status: 200 }
        );
      })
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("sync_spend", { tenant_id: "t1", start_date: "2026-08-01", end_date: "2026-08-19" }, "refresh-token");
    expect(result.data).toMatchObject({ scanned: 1, synced: 1, failed: 0 });
    const spendCall = growth._calls.find((c) => c.method === "recordSpendEvent")!;
    const input = spendCall.args[3] as { event_date: string; spend_amount_ore: number; clicks: number; impressions: number; source_type: string; source_pointer: string };
    expect(input.event_date).toBe("2026-08-18");
    expect(input.spend_amount_ore).toBe(1_550); // 15_500_000 micros / 10_000 = 1550 øre = 15.50 kr
    expect(input.clicks).toBe(42);
    expect(input.impressions).toBe(1_000);
    expect(input.source_type).toBe("provider_sync");
    expect(input.source_pointer).toBe("googleads:customers/1234567890/campaigns/111");
  });

  it("delvis-synk-sikkerhet: recordSpendEvent-feil for én rad velter ALDRI resten", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        return new Response(
          JSON.stringify({
            results: [
              { campaign: { id: "SPEND-FAIL", name: "Broken", status: "ENABLED" }, segments: { date: "2026-08-18" }, metrics: { costMicros: "1000000" } },
              { campaign: { id: "666", name: "OK", status: "ENABLED" }, segments: { date: "2026-08-18" }, metrics: { costMicros: "1000000" } }
            ]
          }),
          { status: 200 }
        );
      })
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("sync_spend", { tenant_id: "t1", start_date: "2026-08-01", end_date: "2026-08-19" }, "refresh-token");
    expect(result.data).toMatchObject({ scanned: 2, synced: 1, failed: 1 });
  });
});

describe("F: sync_tracking_tags - D-82-integrasjon (gclid), krever kampanjen allerede synket", () => {
  it("registrerer gclid som click_id_param=gclid for en ALLEREDE synket kampanje", async () => {
    const growth = fakeGrowth();
    await growth.upsertCampaignFromProvider("t1", "business", { channel: "google_ads", external_campaign_id: "111", name: "A" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ results: [{ campaign: { id: "111" }, clickView: { gclid: "Cj0KEQjw" }, segments: { date: "2026-08-19" } }] }), { status: 200 })))
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("sync_tracking_tags", { tenant_id: "t1", date: "2026-08-19" }, "refresh-token");
    expect(result.data).toMatchObject({ scanned: 1, synced: 1, failed: 0 });
    const tagCall = growth._calls.find((c) => c.method === "registerCampaignTrackingTag")!;
    expect(tagCall.args[3]).toEqual({ click_id_param: "gclid", click_id_value: "Cj0KEQjw" });
  });

  it("en kampanje som IKKE er synket ennå gir campaign_not_yet_synced, ALDRI en oppdiktet kampanjerad", async () => {
    const growth = fakeGrowth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ results: [{ campaign: { id: "999" }, clickView: { gclid: "abc" }, segments: { date: "2026-08-19" } }] }), { status: 200 })))
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("sync_tracking_tags", { tenant_id: "t1", date: "2026-08-19" }, "refresh-token");
    expect(result.data).toMatchObject({ scanned: 1, synced: 0, failed: 1, errors: [{ external_campaign_id: "999", reason: "campaign_not_yet_synced" }] });
  });

  it("dedupliserer samme gclid innenfor samme batch (registrerer KUN én gang)", async () => {
    const growth = fakeGrowth();
    await growth.upsertCampaignFromProvider("t1", "business", { channel: "google_ads", external_campaign_id: "111", name: "A" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === TOKEN_URL
          ? OK_TOKEN_RESPONSE()
          : new Response(
              JSON.stringify({
                results: [
                  { campaign: { id: "111" }, clickView: { gclid: "same-gclid" }, segments: { date: "2026-08-19" } },
                  { campaign: { id: "111" }, clickView: { gclid: "same-gclid" }, segments: { date: "2026-08-19" } }
                ]
              }),
              { status: 200 }
            )
      )
    );
    const transport = new GoogleAdsTransport(growth, "1234567890", "dev-token");
    const result = await transport.invoke("sync_tracking_tags", { tenant_id: "t1", date: "2026-08-19" }, "refresh-token");
    expect(result.data).toMatchObject({ synced: 1 });
    expect(growth._calls.filter((c) => c.method === "registerCampaignTrackingTag")).toHaveLength(1);
  });
});

describe("G: retry/backoff - KUN på bekreftede retry-bare statuser, ALDRI en retry-storm", () => {
  it("429 etterfulgt av suksess lykkes ETTER retry (bounded, eksponentiell backoff)", async () => {
    let gaqlAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        gaqlAttempts++;
        if (gaqlAttempts === 1) return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "rate limited" } }), { status: 429 });
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      })
    );
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    const result = await transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token");
    expect(gaqlAttempts).toBe(2);
    expect(result.data).toEqual([]);
  }, 10_000);

  it("429 vedvarende over maks forsøk kaster GoogleAdsApiError, ALDRI en uendelig retry-løkke", async () => {
    let gaqlAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        gaqlAttempts++;
        return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "rate limited" } }), { status: 429 });
      })
    );
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token")).rejects.toBeInstanceOf(GoogleAdsApiError);
    expect(gaqlAttempts).toBe(3); // MAX_ATTEMPTS, aldri mer - "no retry storms"
  }, 10_000);

  it("401/403 (autentiserings-/autorisasjonsfeil) forsøkes ALDRI på nytt - kastes umiddelbart", async () => {
    let gaqlAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
        gaqlAttempts++;
        return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "developer token invalid" } }), { status: 403 });
      })
    );
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token")).rejects.toBeInstanceOf(GoogleAdsApiError);
    expect(gaqlAttempts).toBe(1); // ingen retry på en permanent feil
  });

  it("5xx utløser retry, men en ikke-JSON feilkropp klassifiseres trygt (UNCLASSIFIED_ERROR_BODY) uten å knekke", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response("<html>502 Bad Gateway</html>", { status: 502 })))
    );
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    await expect(transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token")).rejects.toThrow(/google_ads_api_error_502:UNCLASSIFIED_ERROR_BODY/);
  }, 10_000);
});

describe("H: nulllekkasje-regresjon - INGEN credential/token forekommer noe sted i kastede feilmeldinger", () => {
  it("en 403-feil sin melding inneholder ALDRI developer-tokenet, access-tokenet eller refresh-tokenet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "denied" } }), { status: 403 })
      )
    );
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "hemmelig-dev-token-xyz");
    try {
      await transport.invoke("list_campaigns", { tenant_id: "t1" }, "hemmelig-refresh-token-abc");
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("hemmelig-dev-token-xyz");
      expect(message).not.toContain("hemmelig-refresh-token-abc");
      expect(message).not.toContain("fake-access-token");
    }
  });

  it("Google sin generiske feilkropp avkortes til 200 tegn (samme presedens som live-transports.ts sin googleErrorDescription-avkorting)", async () => {
    const longMessage = "x".repeat(500);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ error: { status: "INTERNAL", message: longMessage } }), { status: 400 })))
    );
    const transport = new GoogleAdsTransport(fakeGrowth(), "1234567890", "dev-token");
    try {
      await transport.invoke("list_campaigns", { tenant_id: "t1" }, "refresh-token");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(250);
    }
  });
});

describe("I: rene funksjonstester - status-mapping og mikros-konvertering", () => {
  it("mapGoogleAdsCampaignStatus mapper ENABLED/PAUSED/REMOVED deterministisk, alt annet blir undefined", () => {
    expect(mapGoogleAdsCampaignStatus("ENABLED")).toBe("active");
    expect(mapGoogleAdsCampaignStatus("PAUSED")).toBe("paused");
    expect(mapGoogleAdsCampaignStatus("REMOVED")).toBe("ended");
    expect(mapGoogleAdsCampaignStatus("UNSPECIFIED")).toBeUndefined();
    expect(mapGoogleAdsCampaignStatus(undefined)).toBeUndefined();
  });
  it("microsToMinorUnits konverterer korrekt og degraderer trygt ved ugyldig input", () => {
    expect(microsToMinorUnits("15500000")).toBe(1_550);
    expect(microsToMinorUnits(0)).toBe(0);
    expect(microsToMinorUnits(undefined)).toBe(0);
    expect(microsToMinorUnits("not-a-number")).toBe(0);
  });
});
