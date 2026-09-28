import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-331. Jira - TREDJE av de seks D-64-port-krevende CRM-/prosjekt-
 * styrings-leverandørene som faktisk er bygget (D-291 stengte porten;
 * D-329/D-330 bygget Todoist/Trello først). API-formen er BEVISST
 * verifisert via WebSearch denne økten: Jira Cloud er PER-TENANT
 * (base-URL-resolver, samme mønster som Grafana/Prometheus), Basic auth
 * (`email:api_token`, IKKE bearer), og den gamle `/rest/api/3/search`-veien
 * er BEKREFTET fjernet i favør av `/rest/api/3/search/jql`.
 */
describe("A: JiraTransport.invoke('search_issues'/'get_issue'/'list_transitions', ...) - GET, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("search_issues kaller GET <base>/rest/api/3/search/jql?jql=... med Basic email:token-header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ issues: [] }) } as unknown as Response;
    });
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve("bob@acme.com"));
    const result = await transport.invoke("search_issues", { jql: "project = X" }, "tok-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/search/jql?jql=project%20%3D%20X");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("bob@acme.com:tok-abc").toString("base64")}`
    });
    expect(result.data).toEqual({ issues: [] });
  });

  it("fjerner trailing slash fra base-URL-en før stien bygges", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({}) } as unknown as Response; });
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net/"), () => Promise.resolve("bob@acme.com"));
    await transport.invoke("get_issue", { issue_key: "X-1" }, "tok");
    expect(calls[0]).toBe("https://acme.atlassian.net/rest/api/3/issue/X-1");
  });

  it("list_transitions kaller GET .../issue/<key>/transitions", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ transitions: [] }) } as unknown as Response; });
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve("bob@acme.com"));
    await transport.invoke("list_transitions", { issue_key: "X-1" }, "tok");
    expect(calls[0]).toBe("https://acme.atlassian.net/rest/api/3/issue/X-1/transitions");
  });

  it("mangler base-URL -> kaster 'jira_base_url_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({}) } as unknown as Response; });
    const transport = new JiraTransport(() => Promise.resolve(null), () => Promise.resolve("bob@acme.com"));
    await expect(transport.invoke("get_issue", { issue_key: "X-1" }, "tok")).rejects.toThrow("jira_base_url_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("mangler e-post -> kaster 'jira_email_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({}) } as unknown as Response; });
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve(null));
    await expect(transport.invoke("get_issue", { issue_key: "X-1" }, "tok")).rejects.toThrow("jira_email_not_configured");
    expect(calls).toHaveLength(0);
  });
});

describe("B: JiraTransport.invoke('create_issue', ...) - POST /rest/api/3/issue, EKTE ekstern tilstand skapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer fields med project/summary/issuetype, konverterer description til Atlassian Document Format", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, status: 200, json: async () => ({ key: "X-42" }) } as unknown as Response;
    });
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve("bob@acme.com"));
    const result = await transport.invoke(
      "create_issue",
      { project_key: "X", summary: "ny sak", issue_type: "Task", description: "detaljer her" },
      "tok"
    );
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      fields: {
        project: { key: "X" },
        summary: "ny sak",
        issuetype: { name: "Task" },
        description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "detaljer her" }] }] }
      }
    });
    expect(result.external_id).toBe("X-42");
  });

  it("uten description utelates feltet helt (ingen tom ADF-struktur sendt)", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, status: 200, json: async () => ({ key: "X-1" }) } as unknown as Response;
    });
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve("bob@acme.com"));
    await transport.invoke("create_issue", { project_key: "X", summary: "s", issue_type: "Task" }, "tok");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.fields.description).toBeUndefined();
  });

  it("en HTTP-feil kaster 'jira_error_<status>' UTEN å late som issuen ble skapt", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve("bob@acme.com"));
    await expect(transport.invoke("create_issue", { project_key: "X", summary: "s", issue_type: "Task" }, "bad-tok")).rejects.toThrow("jira_error_401");
  });
});

describe("C: JiraTransport.invoke('update_issue'/'transition_issue', ...) - PUT/POST, muterer eksisterende issue, håndterer 204", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("update_issue PUTer kun de oppgitte feltene", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 204, json: async () => { throw new Error("skal ikke kalles på 204"); } } as unknown as Response;
    });
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve("bob@acme.com"));
    const result = await transport.invoke("update_issue", { issue_key: "X-1", summary: "ny tittel" }, "tok");
    expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/issue/X-1");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ fields: { summary: "ny tittel" } });
    expect(result.data).toBeNull();
  });

  it("transition_issue POSTer {transition:{id}} til .../transitions", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 204, json: async () => { throw new Error("skal ikke kalles på 204"); } } as unknown as Response;
    });
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve("bob@acme.com"));
    await transport.invoke("transition_issue", { issue_key: "X-1", transition_id: "31" }, "tok");
    expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/issue/X-1/transitions");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ transition: { id: "31" } });
  });
});

describe("D: en ukjent handling kaster 'jira_unsupported_action_<action>'", () => {
  it("invoke('delete_issue', ...) kaster", async () => {
    const transport = new JiraTransport(() => Promise.resolve("https://acme.atlassian.net"), () => Promise.resolve("bob@acme.com"));
    await expect(transport.invoke("delete_issue", {}, "tok")).rejects.toThrow("jira_unsupported_action_delete_issue");
  });
});

describe("E: firstWaveTools() registrerer alle jira.*-handlinger med korrekt risikoklasse", () => {
  it("jira.search_issues/get_issue/list_transitions er klasse A (lesing)", () => {
    for (const action of ["search_issues", "get_issue", "list_transitions"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "jira" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("A");
    }
  });

  it("jira.create_issue/update_issue/transition_issue er klasse B (muterer ekstern tilstand)", () => {
    for (const action of ["create_issue", "update_issue", "transition_issue"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "jira" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("B");
      expect(tool!.credential_ref).toBe("JARVIS_JIRA_API_TOKEN");
    }
  });

  it("INGEN jira.delete_issue er registrert", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "jira" && t.action === "delete_issue");
    expect(tool).toBeUndefined();
  });
});
