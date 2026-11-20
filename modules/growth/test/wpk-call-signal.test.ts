import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGoogleAccessTokenCache, runWithCallSignal, type ToolInvocationContext } from "@jarvis/tool-gateway";
import { GoogleAdsTransport } from "../src/google-ads-transport.ts";
import { MetaAdsTransport } from "../src/meta-ads-transport.ts";
import type { GrowthService } from "../src/service.ts";

/**
 * WP-K (D-471, JARVIS-018): annonse-transportene bruker rå `fetch` (ingen `guardedFetch`) og hadde INGEN frist. Nå avbrytes forespørselen av gatewayens kallsignal (ambient eller det
 * eksplisitte 5. argumentet), ventetiden mellom forsøk avbrytes, og et avbrutt kall sender aldri et nytt forsøk. Ren transport-nivå (ingen database); gatewayens eget tidsavbrudd er bevist i
 * `modules/tool-gateway/test/wpk-018-gateway-abort.test.ts`.
 */
const growth = {} as GrowthService;
const ctx = {} as ToolInvocationContext;
const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];

function stubFetch(reply: (url: string) => Response | "hang"): void {
  calls.length = 0;
  vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, signal: init.signal ?? undefined });
    const out = reply(url);
    if (out !== "hang") return Promise.resolve(out);
    return new Promise<Response>((_, reject) => {
      const s = init.signal;
      if (!s) return; // uten signal henger den for alltid (den gamle feilen)
      if (s.aborted) { reject(s.reason); return; }
      s.addEventListener("abort", () => reject(s.reason), { once: true });
    });
  });
}
const tokenOk = (): Response => new Response(JSON.stringify({ access_token: "fake-access-token-for-test", expires_in: 3600 }), { status: 200 });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "fake-client-id-for-test");
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "fake-client-secret-for-test");
  resetGoogleAccessTokenCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Google Ads (GAQL over POST, retry på 5xx)", () => {
  const isSearch = (url: string): boolean => url.includes("googleads.googleapis.com");
  const transport = (): GoogleAdsTransport => new GoogleAdsTransport(growth, "1234567890", "fake-developer-token");

  it("en hengende forespørsel avbrytes av det ambiente kallsignalet, og sendes ikke på nytt", async () => {
    stubFetch((url) => (isSearch(url) ? "hang" : tokenOk()));
    const c = new AbortController();
    const pending = runWithCallSignal(c.signal, () => transport().invoke("list_campaigns", { tenant_id: "t1" }, "fake-credential-for-test"));
    const assertion = expect(pending).rejects.toThrow("tool_timeout");
    await vi.waitFor(() => expect(calls.filter((x) => isSearch(x.url))).toHaveLength(1));
    const search = calls.find((x) => isSearch(x.url))!;
    expect(search.signal).toBeInstanceOf(AbortSignal);
    expect(search.signal?.aborted).toBe(false);
    c.abort(new Error("tool_timeout"));
    await assertion;
    expect(search.signal?.aborted).toBe(true);
    await sleep(700);
    expect(calls.filter((x) => isSearch(x.url))).toHaveLength(1);
  });

  it("det EKSPLISITTE signal-argumentet (uten ambient kontekst) gjelder like godt", async () => {
    stubFetch((url) => (isSearch(url) ? "hang" : tokenOk()));
    const c = new AbortController();
    const pending = transport().invoke("list_campaigns", { tenant_id: "t1" }, "fake-credential-for-test", ctx, c.signal);
    const assertion = expect(pending).rejects.toThrow("tool_timeout");
    await vi.waitFor(() => expect(calls.filter((x) => isSearch(x.url))).toHaveLength(1));
    c.abort(new Error("tool_timeout"));
    await assertion;
    expect(calls.find((x) => isSearch(x.url))?.signal?.aborted).toBe(true);
  });

  it("503 -> backoff (500 ms): avbrudd under ventingen gir ingen forsøk 2", async () => {
    stubFetch((url) => (isSearch(url) ? new Response(JSON.stringify({ error: { message: "nede" } }), { status: 503 }) : tokenOk()));
    const c = new AbortController();
    const pending = runWithCallSignal(c.signal, () => transport().invoke("list_campaigns", { tenant_id: "t1" }, "fake-credential-for-test"));
    const assertion = expect(pending).rejects.toThrow("tool_timeout");
    await vi.waitFor(() => expect(calls.filter((x) => isSearch(x.url))).toHaveLength(1));
    c.abort(new Error("tool_timeout")); // under første backoff
    await assertion;
    await sleep(800);
    expect(calls.filter((x) => isSearch(x.url))).toHaveLength(1);
  });

  it("uten avbrudd er oppførselen uendret: 503 gjentas (3 forsøk) og feilen kastes", async () => {
    stubFetch((url) => (isSearch(url) ? new Response(JSON.stringify({ error: { message: "nede" } }), { status: 503 }) : tokenOk()));
    await expect(transport().invoke("list_campaigns", { tenant_id: "t1" }, "fake-credential-for-test")).rejects.toThrow(/google_ads_api_error_503/);
    expect(calls.filter((x) => isSearch(x.url))).toHaveLength(3);
  }, 10_000);

  it("et allerede avbrutt kall sender ingen forespørsel mot annonse-API-et", async () => {
    stubFetch((url) => (isSearch(url) ? "hang" : tokenOk()));
    const c = new AbortController();
    c.abort(new Error("tool_timeout"));
    await expect(runWithCallSignal(c.signal, () => transport().invoke("list_campaigns", { tenant_id: "t1" }, "fake-credential-for-test"))).rejects.toThrow("tool_timeout");
    expect(calls.filter((x) => isSearch(x.url))).toHaveLength(0);
  });
});

describe("Meta Ads (Graph API GET, retry på 5xx)", () => {
  const isGraph = (url: string): boolean => url.includes("graph.facebook.com");
  const transport = (): MetaAdsTransport => new MetaAdsTransport(growth, "12345");

  it("en hengende forespørsel avbrytes (ambient og eksplisitt signal) og sendes ikke på nytt", async () => {
    stubFetch(() => "hang");
    const c = new AbortController();
    const pending = runWithCallSignal(c.signal, () => transport().invoke("list_campaigns", { tenant_id: "t1" }, "fake-credential-for-test"));
    const assertion = expect(pending).rejects.toThrow("tool_timeout");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(isGraph(calls[0]!.url)).toBe(true);
    c.abort(new Error("tool_timeout"));
    await assertion;
    expect(calls[0]!.signal?.aborted).toBe(true);
    await sleep(700);
    expect(calls).toHaveLength(1);

    stubFetch(() => "hang");
    const d = new AbortController();
    const explicit = transport().invoke("list_campaigns", { tenant_id: "t1" }, "fake-credential-for-test", ctx, d.signal);
    const explicitAssertion = expect(explicit).rejects.toThrow("tool_timeout");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    d.abort(new Error("tool_timeout"));
    await explicitAssertion;
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("500 -> backoff: avbrudd under ventingen gir ingen forsøk 2", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: "nede" } }), { status: 500 }));
    const c = new AbortController();
    const pending = runWithCallSignal(c.signal, () => transport().invoke("list_campaigns", { tenant_id: "t1" }, "fake-credential-for-test"));
    const assertion = expect(pending).rejects.toThrow("tool_timeout");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    c.abort(new Error("tool_timeout"));
    await assertion;
    await sleep(800);
    expect(calls).toHaveLength(1);
  });
});
