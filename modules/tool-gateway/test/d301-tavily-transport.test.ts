import { afterEach, describe, expect, it, vi } from "vitest";
import { TavilyTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-301 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - tilbake til ett-connector-per-PR etter D-297-300-samlingen).
 * Tavily Search API - `api_key` som FELT I POST-BODY-en (IKKE en header,
 * ULIK Brave Search/Sentry). STRUKTURELT LIK Brave Search: INGEN sideeffekt-
 * handling finnes - leverandøren tilbyr genuint bare lesing. Kun ÉTT reelt
 * dokumentert endepunkt (`POST /search`) - `web_search`/`news_search`
 * skiller seg KUN på `topic`-body-feltet (general/news).
 */
describe("A: TavilyTransport.invoke('web_search', ...) - POST /search, topic=general, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med api_key/query/topic i JSON-body, returnerer results-arrayet", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ results: [{ title: "hei", url: "https://example.com" }] }) } as unknown as Response;
    });
    const result = await new TavilyTransport().invoke("web_search", { query: "jarvis ai" }, "test-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.tavily.com/search");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ api_key: "test-key", query: "jarvis ai", topic: "general" });
    expect(result.data).toEqual([{ title: "hei", url: "https://example.com" }]);
  });

  it("sender 'max_results' i body når satt", async () => {
    const calls: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => { calls.push(init); return { ok: true, json: async () => ({ results: [] }) } as unknown as Response; });
    await new TavilyTransport().invoke("web_search", { query: "hei", max_results: 5 }, "tok");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ api_key: "tok", query: "hei", topic: "general", max_results: 5 });
  });

  it("en HTTP-feil kaster 'tavily_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    await expect(new TavilyTransport().invoke("web_search", { query: "hei" }, "bad-key")).rejects.toThrow("tavily_error_401");
  });
});

describe("B: TavilyTransport.invoke('news_search', ...) - SAMME endepunkt, topic=news", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller /search med topic=news og returnerer results-arrayet", async () => {
    const calls: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(init);
      return { ok: true, json: async () => ({ results: [{ title: "nyhet" }] }) } as unknown as Response;
    });
    const result = await new TavilyTransport().invoke("news_search", { query: "ai norge" }, "tok");
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ topic: "news", query: "ai norge" });
    expect(result.data).toEqual([{ title: "nyhet" }]);
  });
});

describe("C: en ukjent handling kaster 'tavily_unsupported_action_<action>'", () => {
  it("invoke('extract', ...) kaster (ikke registrert, selv om Tavily muligens tilbyr det)", async () => {
    await expect(new TavilyTransport().invoke("extract", { query: "hei" }, "tok")).rejects.toThrow("tavily_unsupported_action_extract");
  });
});

describe("D: firstWaveTools() registrerer begge tavily.*-handlinger som klasse A (lesing)", () => {
  it("tavily.web_search og news_search er begge klasse A, ingen klasse B/C/D-handling finnes for denne connectoren", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "tavily");
    expect(tools.map((t) => t.action).sort()).toEqual(["news_search", "web_search"]);
    for (const tool of tools) {
      expect(tool.capability_class).toBe("A");
      expect(tool.credential_ref).toBe("JARVIS_TAVILY_API_KEY");
      expect(tool.output_trust).toBe("untrusted");
    }
  });
});
