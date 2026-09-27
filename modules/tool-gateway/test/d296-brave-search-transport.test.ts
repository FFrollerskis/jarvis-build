import { afterEach, describe, expect, it, vi } from "vitest";
import { BraveSearchTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-296 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - fjerde slice). Brave Search API - `X-Subscription-Token`-
 * header (IKKE Bearer). STRUKTURELT ULIK de forrige fire connectorene:
 * INGEN sideeffekt-handling finnes i det hele tatt - leverandøren tilbyr
 * genuint bare lesing, så `web_search` selv er trygg nok til å brukes som
 * `live_test` uten en egen "get_account_info"-handling.
 */
describe("A: BraveSearchTransport.invoke('web_search', ...) - GET /res/v1/web/search, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med X-Subscription-Token-header og 'q'-query-parameter, returnerer web.results", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ web: { results: [{ title: "hei", url: "https://example.com" }] } }) } as unknown as Response;
    });
    const transport = new BraveSearchTransport();
    const result = await transport.invoke("web_search", { query: "jarvis ai" }, "test-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.search.brave.com/res/v1/web/search?q=jarvis+ai");
    expect(calls[0]!.init?.headers).toMatchObject({ "x-subscription-token": "test-key" });
    expect(result.data).toEqual([{ title: "hei", url: "https://example.com" }]);
  });

  it("sender 'count' som query-parameter når satt", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ web: { results: [] } }) } as unknown as Response; });
    await new BraveSearchTransport().invoke("web_search", { query: "hei", count: 5 }, "tok");
    expect(calls[0]).toBe("https://api.search.brave.com/res/v1/web/search?q=hei&count=5");
  });

  it("en HTTP-feil kaster 'brave_search_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    await expect(new BraveSearchTransport().invoke("web_search", { query: "hei" }, "bad-key")).rejects.toThrow("brave_search_error_401");
  });
});

describe("B: BraveSearchTransport.invoke('news_search', ...) - GET /res/v1/news/search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller /res/v1/news/search og returnerer results-arrayet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ results: [{ title: "nyhet" }] }) } as unknown as Response;
    });
    const result = await new BraveSearchTransport().invoke("news_search", { query: "ai norge" }, "tok");
    expect(calls[0]).toBe("https://api.search.brave.com/res/v1/news/search?q=ai+norge");
    expect(result.data).toEqual([{ title: "nyhet" }]);
  });
});

describe("C: en ukjent handling kaster 'brave_search_unsupported_action_<action>'", () => {
  it("invoke('image_search', ...) kaster (ikke registrert, selv om Brave tilbyr det)", async () => {
    await expect(new BraveSearchTransport().invoke("image_search", { query: "hei" }, "tok")).rejects.toThrow("brave_search_unsupported_action_image_search");
  });
});

describe("D: firstWaveTools() registrerer begge brave_search.*-handlinger som klasse A (lesing)", () => {
  it("brave_search.web_search og news_search er begge klasse A, ingen klasse B/C/D-handling finnes for denne connectoren", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "brave_search");
    expect(tools.map((t) => t.action).sort()).toEqual(["news_search", "web_search"]);
    for (const tool of tools) {
      expect(tool.capability_class).toBe("A");
      expect(tool.credential_ref).toBe("JARVIS_BRAVE_SEARCH_API_KEY");
      expect(tool.output_trust).toBe("untrusted");
    }
  });
});
