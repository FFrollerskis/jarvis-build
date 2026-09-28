import { afterEach, describe, expect, it, vi } from "vitest";
import { HubSpotTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-333. HubSpot - FEMTE av de seks D-64-port-krevende CRM-/prosjekt-
 * styrings-leverandørene som faktisk er bygget (D-291 stengte porten;
 * D-329/D-330/D-331/D-332 bygget Todoist/Trello/Jira/Linear først).
 * API-formen er BEVISST verifisert via WebSearch denne økten: Bearer
 * private app-token mot `/crm/v3/objects/{objectType}` - EKSAKT samme
 * mønster for contacts/companies/deals, derfor et PÅKREVD `object_type`-
 * parameter fra kalleren i stedet for tre dupliserte handlingssett.
 */
describe("A: HubSpotTransport.invoke('list_objects'/'get_object'/'search_objects', ...) - GET/POST-lesing, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list_objects kaller GET /crm/v3/objects/<object_type>?limit=<n> med Bearer-header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ results: [{ id: "1" }] }) } as unknown as Response;
    });
    const transport = new HubSpotTransport();
    const result = await transport.invoke("list_objects", { object_type: "contacts", limit: 5 }, "tok-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts?limit=5");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer tok-abc" });
    expect(result.data).toEqual({ results: [{ id: "1" }] });
  });

  it("list_objects defaulter limit til 10 når ikke oppgitt", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new HubSpotTransport();
    await transport.invoke("list_objects", { object_type: "deals" }, "tok");
    expect(calls[0]).toBe("https://api.hubapi.com/crm/v3/objects/deals?limit=10");
  });

  it("get_object kaller GET /crm/v3/objects/<object_type>/<id>", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ id: "42" }) } as unknown as Response; });
    const transport = new HubSpotTransport();
    const result = await transport.invoke("get_object", { object_type: "companies", id: "42" }, "tok");
    expect(calls[0]).toBe("https://api.hubapi.com/crm/v3/objects/companies/42");
    expect(result.data).toMatchObject({ id: "42" });
  });

  it("search_objects POSTer filterGroups uendret fra kalleren til /search", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ results: [] }) } as unknown as Response;
    });
    const transport = new HubSpotTransport();
    const filterGroups = [{ filters: [{ propertyName: "email", operator: "EQ", value: "a@b.com" }] }];
    await transport.invoke("search_objects", { object_type: "contacts", filter_groups: filterGroups, limit: 25 }, "tok");
    expect(calls[0]!.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts/search");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ filterGroups, limit: 25 });
  });
});

describe("B: HubSpotTransport.invoke('create_object', ...) - POST /crm/v3/objects/{object_type}, EKTE ekstern tilstand skapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer properties uendret fra kalleren, returnerer external_id fra svarets id", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "999" }) } as unknown as Response;
    });
    const transport = new HubSpotTransport();
    const result = await transport.invoke("create_object", { object_type: "contacts", properties: { email: "a@b.com", firstname: "Anna" } }, "tok");
    expect(calls[0]!.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ properties: { email: "a@b.com", firstname: "Anna" } });
    expect(result.external_id).toBe("999");
  });

  it("en HTTP-feil kaster 'hubspot_error_<status>' UTEN å late som objektet ble skapt", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new HubSpotTransport();
    await expect(transport.invoke("create_object", { object_type: "contacts", properties: {} }, "bad-tok")).rejects.toThrow("hubspot_error_401");
  });
});

describe("C: HubSpotTransport.invoke('update_object', ...) - PATCH /crm/v3/objects/{object_type}/{id}", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHer properties til riktig object_type/id-sti", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "5" }) } as unknown as Response;
    });
    const transport = new HubSpotTransport();
    await transport.invoke("update_object", { object_type: "deals", id: "5", properties: { dealstage: "closedwon" } }, "tok");
    expect(calls[0]!.url).toBe("https://api.hubapi.com/crm/v3/objects/deals/5");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ properties: { dealstage: "closedwon" } });
  });
});

describe("D: en ukjent handling kaster 'hubspot_unsupported_action_<action>'", () => {
  it("invoke('delete_object', ...) kaster", async () => {
    await expect(new HubSpotTransport().invoke("delete_object", { object_type: "contacts" }, "tok")).rejects.toThrow("hubspot_unsupported_action_delete_object");
  });
});

describe("E: firstWaveTools() registrerer alle hubspot.*-handlinger med korrekt risikoklasse, object_type som enum", () => {
  it("hubspot.list_objects/get_object/search_objects er klasse A (lesing)", () => {
    for (const action of ["list_objects", "get_object", "search_objects"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "hubspot" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("A");
    }
  });

  it("hubspot.create_object/update_object er klasse B (muterer ekstern tilstand)", () => {
    for (const action of ["create_object", "update_object"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "hubspot" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("B");
      expect(tool!.credential_ref).toBe("JARVIS_HUBSPOT_API_KEY");
    }
  });

  it("INGEN hubspot.delete_object er registrert", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "hubspot" && t.action === "delete_object");
    expect(tool).toBeUndefined();
  });
});
