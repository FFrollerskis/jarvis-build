import { afterEach, describe, expect, it, vi } from "vitest";
import { ExaTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-302 (Tobias direkte i chat: "fortsett og jobbe ikke vent på ci" - niende
 * slice). Exa sitt nevrale søke-API - `x-api-key`-HEADER (IKKE
 * `Authorization: Bearer`, IKKE et body-felt som Tavily). TO separate, EGNE
 * endepunkter (`POST /search`/`POST /findSimilar`), ULIK Tavily sitt delte
 * endepunkt. STRUKTURELT LIK Brave Search/Tavily: INGEN sideeffekt-handling
 * finnes - leverandøren tilbyr genuint bare lesing.
 */
describe("A: ExaTransport.invoke('web_search', ...) - POST /search, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med x-api-key-header og query i JSON-body, returnerer results-arrayet", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ results: [{ title: "hei", url: "https://example.com" }] }) } as unknown as Response;
    });
    const result = await new ExaTransport().invoke("web_search", { query: "jarvis ai" }, "test-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.exa.ai/search");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({ "content-type": "application/json", "x-api-key": "test-key" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ query: "jarvis ai" });
    expect(result.data).toEqual([{ title: "hei", url: "https://example.com" }]);
  });

  it("sender 'numResults' i body når 'num_results' er satt", async () => {
    const calls: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => { calls.push(init); return { ok: true, json: async () => ({ results: [] }) } as unknown as Response; });
    await new ExaTransport().invoke("web_search", { query: "hei", num_results: 5 }, "tok");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ query: "hei", numResults: 5 });
  });

  it("en HTTP-feil kaster 'exa_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    await expect(new ExaTransport().invoke("web_search", { query: "hei" }, "bad-key")).rejects.toThrow("exa_error_401");
  });
});

describe("B: ExaTransport.invoke('find_similar', ...) - EGET endepunkt POST /findSimilar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller /findSimilar med url i body, returnerer results-arrayet", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ results: [{ title: "lignende" }] }) } as unknown as Response;
    });
    const result = await new ExaTransport().invoke("find_similar", { url: "https://example.com/artikkel" }, "tok");
    expect(calls[0]!.url).toBe("https://api.exa.ai/findSimilar");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ url: "https://example.com/artikkel" });
    expect(result.data).toEqual([{ title: "lignende" }]);
  });
});

describe("C: en ukjent handling kaster 'exa_unsupported_action_<action>'", () => {
  it("invoke('get_contents', ...) kaster (ikke registrert, selv om Exa muligens tilbyr det)", async () => {
    await expect(new ExaTransport().invoke("get_contents", { query: "hei" }, "tok")).rejects.toThrow("exa_unsupported_action_get_contents");
  });
});

describe("D: firstWaveTools() registrerer begge exa.*-handlinger som klasse A (lesing)", () => {
  it("exa.web_search og find_similar er begge klasse A, ingen klasse B/C/D-handling finnes for denne connectoren", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "exa");
    expect(tools.map((t) => t.action).sort()).toEqual(["find_similar", "web_search"]);
    for (const tool of tools) {
      expect(tool.capability_class).toBe("A");
      expect(tool.credential_ref).toBe("JARVIS_EXA_API_KEY");
      expect(tool.output_trust).toBe("untrusted");
    }
  });
});
