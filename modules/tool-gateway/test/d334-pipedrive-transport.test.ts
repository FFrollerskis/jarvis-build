import { afterEach, describe, expect, it, vi } from "vitest";
import { PipedriveTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-334. Pipedrive - SJETTE og SISTE av de seks D-64-port-krevende CRM-/
 * prosjektstyrings-leverandørene som faktisk er bygget (D-291 stengte
 * porten; D-329 til D-333 bygget Todoist/Trello/Jira/Linear/HubSpot
 * først). API-formen er BEVISST verifisert via WebSearch denne økten:
 * PER-TENANT base-URL (samme struktur som Jira), `x-api-token`-header
 * (IKKE Authorization: Bearer), `/api/v2/{objectType}`-symmetri for
 * persons/organizations/deals (samme mønster som HubSpot), og et
 * `{success, data}`-svarskonvolutt.
 */
describe("A: PipedriveTransport.invoke('list_objects'/'get_object'/'search_objects', ...) - GET, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list_objects kaller GET <base>/api/v2/<object_type>?limit=<n> med x-api-token-header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ success: true, data: [{ id: 1 }] }) } as unknown as Response;
    });
    const transport = new PipedriveTransport(() => Promise.resolve("https://acme.pipedrive.com"));
    const result = await transport.invoke("list_objects", { object_type: "persons", limit: 5 }, "tok-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://acme.pipedrive.com/api/v2/persons?limit=5");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({ "x-api-token": "tok-abc" });
    expect(result.data).toEqual({ success: true, data: [{ id: 1 }] });
  });

  it("fjerner trailing slash fra base-URL-en før stien bygges", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new PipedriveTransport(() => Promise.resolve("https://acme.pipedrive.com/"));
    await transport.invoke("get_object", { object_type: "deals", id: "7" }, "tok");
    expect(calls[0]).toBe("https://acme.pipedrive.com/api/v2/deals/7");
  });

  it("search_objects kaller GET .../<object_type>/search?term=...", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ success: true, data: [] }) } as unknown as Response; });
    const transport = new PipedriveTransport(() => Promise.resolve("https://acme.pipedrive.com"));
    await transport.invoke("search_objects", { object_type: "organizations", term: "acme corp" }, "tok");
    expect(calls[0]).toBe("https://acme.pipedrive.com/api/v2/organizations/search?term=acme%20corp");
  });

  it("mangler base-URL -> kaster 'pipedrive_base_url_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new PipedriveTransport(() => Promise.resolve(null));
    await expect(transport.invoke("get_object", { object_type: "deals", id: "1" }, "tok")).rejects.toThrow("pipedrive_base_url_not_configured");
    expect(calls).toHaveLength(0);
  });
});

describe("B: PipedriveTransport.invoke('create_object', ...) - POST /api/v2/{object_type}, EKTE ekstern tilstand skapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer properties uendret fra kalleren, returnerer external_id fra {success,data:{id}}-konvolutten", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ success: true, data: { id: 999 } }) } as unknown as Response;
    });
    const transport = new PipedriveTransport(() => Promise.resolve("https://acme.pipedrive.com"));
    const result = await transport.invoke("create_object", { object_type: "deals", properties: { title: "ny avtale", org_id: 5 } }, "tok");
    expect(calls[0]!.url).toBe("https://acme.pipedrive.com/api/v2/deals");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ title: "ny avtale", org_id: 5 });
    expect(result.external_id).toBe("999");
  });

  it("en HTTP-feil kaster 'pipedrive_error_<status>' UTEN å late som objektet ble skapt", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new PipedriveTransport(() => Promise.resolve("https://acme.pipedrive.com"));
    await expect(transport.invoke("create_object", { object_type: "deals", properties: {} }, "bad-tok")).rejects.toThrow("pipedrive_error_401");
  });
});

describe("C: PipedriveTransport.invoke('update_object', ...) - PATCH /api/v2/{object_type}/{id}", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHer properties til riktig object_type/id-sti", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ success: true, data: { id: 5 } }) } as unknown as Response;
    });
    const transport = new PipedriveTransport(() => Promise.resolve("https://acme.pipedrive.com"));
    await transport.invoke("update_object", { object_type: "persons", id: "5", properties: { name: "Ola" } }, "tok");
    expect(calls[0]!.url).toBe("https://acme.pipedrive.com/api/v2/persons/5");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: "Ola" });
  });
});

describe("D: en ukjent handling kaster 'pipedrive_unsupported_action_<action>'", () => {
  it("invoke('delete_object', ...) kaster", async () => {
    const transport = new PipedriveTransport(() => Promise.resolve("https://acme.pipedrive.com"));
    await expect(transport.invoke("delete_object", { object_type: "deals" }, "tok")).rejects.toThrow("pipedrive_unsupported_action_delete_object");
  });
});

describe("E: firstWaveTools() registrerer alle pipedrive.*-handlinger med korrekt risikoklasse, object_type som enum", () => {
  it("pipedrive.list_objects/get_object/search_objects er klasse A (lesing)", () => {
    for (const action of ["list_objects", "get_object", "search_objects"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "pipedrive" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("A");
    }
  });

  it("pipedrive.create_object/update_object er klasse B (muterer ekstern tilstand)", () => {
    for (const action of ["create_object", "update_object"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "pipedrive" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("B");
      expect(tool!.credential_ref).toBe("JARVIS_PIPEDRIVE_API_KEY");
    }
  });

  it("INGEN pipedrive.delete_object er registrert", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "pipedrive" && t.action === "delete_object");
    expect(tool).toBeUndefined();
  });
});
