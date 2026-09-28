import { afterEach, describe, expect, it, vi } from "vitest";
import { TrelloTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-330. Trello - ANDRE av de seks D-64-port-krevende CRM-/prosjekt-
 * styrings-leverandørene som faktisk er bygget (D-291 stengte porten;
 * D-329 bygget Todoist FØRST, samme mønster gjenbrukt her). API-formen er
 * BEVISST verifisert via WebSearch denne økten - `key`/`token` som QUERY-
 * PARAMETERE, IKKE en Authorization-header, en STRUKTURELT annen auth-form
 * enn hver annen connector i denne filen.
 */
describe("A: TrelloTransport.invoke('list_boards'/'list_cards'/'get_card', ...) - GET, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list_boards kaller GET /1/members/me/boards med key+token som query-parametere", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ([{ id: "b1", name: "Sprint" }]) } as unknown as Response;
    });
    const transport = new TrelloTransport(() => Promise.resolve("api-key-1"));
    const result = await transport.invoke("list_boards", {}, "tok-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.trello.com/1/members/me/boards?key=api-key-1&token=tok-abc");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(result.data).toEqual([{ id: "b1", name: "Sprint" }]);
  });

  it("list_cards kaller GET /1/boards/<board_id>/cards", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ([{ id: "c1" }]) } as unknown as Response;
    });
    const transport = new TrelloTransport(() => Promise.resolve("key"));
    await transport.invoke("list_cards", { board_id: "b1" }, "tok");
    expect(calls[0]).toBe("https://api.trello.com/1/boards/b1/cards?key=key&token=tok");
  });

  it("get_card kaller GET /1/cards/<card_id>", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ id: "c1", name: "x" }) } as unknown as Response;
    });
    const transport = new TrelloTransport(() => Promise.resolve("key"));
    const result = await transport.invoke("get_card", { card_id: "c1" }, "tok");
    expect(calls[0]).toBe("https://api.trello.com/1/cards/c1?key=key&token=tok");
    expect(result.data).toMatchObject({ id: "c1" });
  });

  it("mangler api_key -> kaster 'trello_api_key_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new TrelloTransport(() => Promise.resolve(null));
    await expect(transport.invoke("list_boards", {}, "tok")).rejects.toThrow("trello_api_key_not_configured");
    expect(calls).toHaveLength(0);
  });
});

describe("B: TrelloTransport.invoke('create_card', ...) - POST /1/cards, EKTE ekstern tilstand skapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer idList + name + valgfri desc, returnerer external_id fra svarets id", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "c999", name: "ny oppgave" }) } as unknown as Response;
    });
    const transport = new TrelloTransport(() => Promise.resolve("key"));
    const result = await transport.invoke("create_card", { list_id: "l1", name: "ny oppgave", desc: "detaljer" }, "tok");
    expect(calls[0]!.url).toBe("https://api.trello.com/1/cards?key=key&token=tok");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ idList: "l1", name: "ny oppgave", desc: "detaljer" });
    expect(result.external_id).toBe("c999");
  });

  it("en HTTP-feil kaster 'trello_error_<status>' UTEN å late som kortet ble skapt", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new TrelloTransport(() => Promise.resolve("key"));
    await expect(transport.invoke("create_card", { list_id: "l1", name: "x" }, "bad-tok")).rejects.toThrow("trello_error_401");
  });
});

describe("C: TrelloTransport.invoke('update_card'/'close_card'/'reopen_card', ...) - PUT, muterer eksisterende kort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("update_card PUTer kun de oppgitte feltene til /1/cards/<card_id>", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "c5" }) } as unknown as Response;
    });
    const transport = new TrelloTransport(() => Promise.resolve("key"));
    await transport.invoke("update_card", { card_id: "c5", name: "ny tittel" }, "tok");
    expect(calls[0]!.url).toBe("https://api.trello.com/1/cards/c5?key=key&token=tok");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: "ny tittel" });
  });

  it("close_card PUTer {closed:true} til /1/cards/<card_id>", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "c5", closed: true }) } as unknown as Response;
    });
    const transport = new TrelloTransport(() => Promise.resolve("key"));
    await transport.invoke("close_card", { card_id: "c5" }, "tok");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ closed: true });
  });

  it("reopen_card PUTer {closed:false} til /1/cards/<card_id>", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ id: "c5", closed: false }) } as unknown as Response;
    });
    const transport = new TrelloTransport(() => Promise.resolve("key"));
    await transport.invoke("reopen_card", { card_id: "c5" }, "tok");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ closed: false });
  });
});

describe("D: en ukjent handling kaster 'trello_unsupported_action_<action>'", () => {
  it("invoke('delete_card', ...) kaster", async () => {
    await expect(new TrelloTransport(() => Promise.resolve("key")).invoke("delete_card", {}, "tok")).rejects.toThrow("trello_unsupported_action_delete_card");
  });
});

describe("E: firstWaveTools() registrerer alle trello.*-handlinger med korrekt risikoklasse", () => {
  it("trello.list_boards/list_cards/get_card er klasse A (lesing)", () => {
    for (const action of ["list_boards", "list_cards", "get_card"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "trello" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("A");
    }
  });

  it("trello.create_card/update_card/close_card/reopen_card er klasse B (muterer ekstern tilstand)", () => {
    for (const action of ["create_card", "update_card", "close_card", "reopen_card"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "trello" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("B");
      expect(tool!.credential_ref).toBe("JARVIS_TRELLO_TOKEN");
    }
  });

  it("INGEN trello.delete_card er registrert", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "trello" && t.action === "delete_card");
    expect(tool).toBeUndefined();
  });
});
