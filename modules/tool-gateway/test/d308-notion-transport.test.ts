import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-308. `Authorization: Bearer`-header PLUSS en fast `Notion-Version`-
 * header mot Notion sitt REST-API v1. D-41: `create_page` er en ekte
 * klasse B-skrivehandling, ikke bare lesing fordi det er enklere -
 * `rollback_procedure` er manuell arkivering (ingen dedikert
 * arkiver-endepunkt bygget her ennå, samme DEFERRED-disiplin som Dropbox).
 */
describe("A: NotionTransport.invoke('search', ...) - POST /v1/search, ren lesing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med Bearer-header, fast Notion-Version-header og query i body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ results: [], has_more: false }) } as unknown as Response;
    });
    const transport = new NotionTransport();
    const result = await transport.invoke("search", { query: "Jarvis" }, "test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.notion.com/v1/search");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: "Bearer test-token", "content-type": "application/json", "Notion-Version": "2022-06-28"
    });
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ query: "Jarvis" }));
    expect(result.data).toEqual({ results: [], has_more: false });
  });

  it("manglende query sender et tomt body (søker på tvers av alt delt med integrasjonen)", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
    const transport = new NotionTransport();
    await transport.invoke("search", {}, "tok");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({}));
  });

  it("en HTTP-feil kaster 'notion_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new NotionTransport();
    await expect(transport.invoke("search", { query: "x" }, "bad-token")).rejects.toThrow("notion_error_401");
  });
});

describe("B: NotionTransport.invoke('create_page', ...) - POST /v1/pages, D-41 ekte skrivehandling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller mot /v1/pages med parent og properties i body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "page-123", object: "page" }) } as unknown as Response;
    });
    const transport = new NotionTransport();
    const parent = { database_id: "db-1" };
    const properties = { Name: { title: [{ text: { content: "Ny side" } }] } };
    const result = await transport.invoke("create_page", { parent, properties }, "test-token");
    expect(calls[0]!.url).toBe("https://api.notion.com/v1/pages");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ parent, properties }));
    expect(result.data).toEqual({ id: "page-123", object: "page" });
  });
});

describe("C: en ukjent handling kaster 'notion_unsupported_action_<action>'", () => {
  it("invoke('delete_page', ...) kaster (ikke registrert)", async () => {
    const transport = new NotionTransport();
    await expect(transport.invoke("delete_page", {}, "tok")).rejects.toThrow("notion_unsupported_action_delete_page");
  });
});

describe("D: firstWaveTools() registrerer notion.search som klasse A og notion.create_page som klasse B", () => {
  it("search er klasse A (ren lesing), create_page er klasse B (ekte skrivehandling, D-41)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "notion");
    expect(tools.map((t) => t.action).sort()).toEqual(["create_page", "search"]);
    const search = tools.find((t) => t.action === "search")!;
    expect(search.capability_class).toBe("A");
    expect(search.credential_ref).toBe("JARVIS_NOTION_API_KEY");
    expect(search.output_trust).toBe("untrusted");
    expect(search.idempotent_external).toBe(true);
    const createPage = tools.find((t) => t.action === "create_page")!;
    expect(createPage.capability_class).toBe("B");
    expect(createPage.credential_ref).toBe("JARVIS_NOTION_API_KEY");
    expect(createPage.idempotent_external).toBe(false);
    expect(createPage.rollback_procedure).toBe("arkiver siden manuelt i Notion");
  });
});
