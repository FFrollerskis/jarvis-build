import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-332. Linear - FJERDE av de seks D-64-port-krevende CRM-/prosjekt-
 * styrings-leverandørene som faktisk er bygget (D-291 stengte porten;
 * D-329/D-330/D-331 bygget Todoist/Trello/Jira først). API-formen er
 * BEVISST verifisert via WebSearch denne økten: Linear har INGEN REST-API,
 * ETT GraphQL-endepunkt for BÅDE lesing og skriving, og autentisering er
 * en RÅ API-nøkkel i Authorization-headeren (BEKREFTET UTEN Bearer-
 * prefiks - et lett å gjette-feil).
 */
describe("A: LinearTransport.invoke('list_teams'/'list_issues'/'get_issue', ...) - GraphQL-lesing, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list_teams POSTer til https://api.linear.app/graphql med RÅ API-nøkkel (INGEN Bearer-prefiks)", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: { teams: { nodes: [{ id: "t1", name: "Engineering" }] } } }) } as unknown as Response;
    });
    const transport = new LinearTransport();
    const result = await transport.invoke("list_teams", {}, "lin_api_abc123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.linear.app/graphql");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "lin_api_abc123" });
    expect(JSON.parse(String(calls[0]!.init?.body)).query).toContain("teams");
    expect(result.data).toEqual([{ id: "t1", name: "Engineering" }]);
  });

  it("list_issues UTEN team_id sender en ufiltrert query", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ data: { issues: { nodes: [{ id: "i1" }] } } }) } as unknown as Response;
    });
    const transport = new LinearTransport();
    const result = await transport.invoke("list_issues", {}, "tok");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.query).not.toContain("$teamId");
    expect(result.data).toEqual([{ id: "i1" }]);
  });

  it("list_issues MED team_id sender en team-filtrert query med variables", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ data: { team: { issues: { nodes: [{ id: "i2" }] } } } }) } as unknown as Response;
    });
    const transport = new LinearTransport();
    const result = await transport.invoke("list_issues", { team_id: "team-1" }, "tok");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.query).toContain("$teamId");
    expect(body.variables).toEqual({ teamId: "team-1" });
    expect(result.data).toEqual([{ id: "i2" }]);
  });

  it("get_issue sender issue_id som variabel og aksepterer BÅDE UUID og identifier-form", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ data: { issue: { id: "i1", identifier: "ENG-123", title: "x" } } }) } as unknown as Response;
    });
    const transport = new LinearTransport();
    const result = await transport.invoke("get_issue", { issue_id: "ENG-123" }, "tok");
    expect(JSON.parse(String(calls[0]!.init?.body)).variables).toEqual({ id: "ENG-123" });
    expect(result.data).toMatchObject({ identifier: "ENG-123" });
  });
});

describe("B: LinearTransport - GraphQL-feilhåndtering (HTTP 200 med errors-felt er en EKTE feil)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("en HTTP-feil kaster 'linear_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new LinearTransport();
    await expect(transport.invoke("list_teams", {}, "bad-tok")).rejects.toThrow("linear_error_401");
  });

  it("HTTP 200 MED et 'errors'-felt i svarskroppen kaster 'linear_graphql_error' - response.ok ALENE er IKKE nok", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ errors: [{ message: "field error" }] }) }) as unknown as Response);
    const transport = new LinearTransport();
    await expect(transport.invoke("list_teams", {}, "tok")).rejects.toThrow("linear_graphql_error");
  });
});

describe("C: LinearTransport.invoke('create_issue'/'update_issue', ...) - GraphQL-mutasjon, EKTE ekstern tilstand", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("create_issue sender teamId/title/description som input-variabel, returnerer external_id fra identifier", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ data: { issueCreate: { success: true, issue: { id: "i9", identifier: "ENG-99", title: "ny sak" } } } }) } as unknown as Response;
    });
    const transport = new LinearTransport();
    const result = await transport.invoke("create_issue", { team_id: "team-1", title: "ny sak", description: "detaljer" }, "tok");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.variables).toEqual({ input: { teamId: "team-1", title: "ny sak", description: "detaljer" } });
    expect(result.external_id).toBe("ENG-99");
  });

  it("update_issue sender kun de oppgitte feltene, inkl. state_id -> stateId", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }) } as unknown as Response;
    });
    const transport = new LinearTransport();
    await transport.invoke("update_issue", { issue_id: "ENG-99", state_id: "state-uuid" }, "tok");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.variables).toEqual({ id: "ENG-99", input: { stateId: "state-uuid" } });
  });
});

describe("D: en ukjent handling kaster 'linear_unsupported_action_<action>'", () => {
  it("invoke('delete_issue', ...) kaster", async () => {
    await expect(new LinearTransport().invoke("delete_issue", {}, "tok")).rejects.toThrow("linear_unsupported_action_delete_issue");
  });
});

describe("E: firstWaveTools() registrerer alle linear.*-handlinger med korrekt risikoklasse", () => {
  it("linear.list_teams/list_issues/get_issue er klasse A (lesing)", () => {
    for (const action of ["list_teams", "list_issues", "get_issue"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "linear" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("A");
    }
  });

  it("linear.create_issue/update_issue er klasse B (muterer ekstern tilstand)", () => {
    for (const action of ["create_issue", "update_issue"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "linear" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("B");
      expect(tool!.credential_ref).toBe("JARVIS_LINEAR_API_KEY");
    }
  });

  it("INGEN linear.delete_issue er registrert", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "linear" && t.action === "delete_issue");
    expect(tool).toBeUndefined();
  });
});
