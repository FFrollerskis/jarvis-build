import { afterEach, describe, expect, it, vi } from "vitest";
import { SentryTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-297 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - femte slice). Sentry sitt organisasjonsscopede REST API v0 -
 * `Bearer`-autentisering, `org_slug` injisert via en resolver-closure (SAMME
 * mønster som Twilio sin AccountSid, D-295) siden `credential_ref` er
 * singular men Sentry krever slug-en i URL-stien for alle fire handlinger.
 * **Ikke denne-økten-verifisert mot live dokumentasjon** (nettverksegress
 * blokkert, se D-297 i DECISIONS_AND_ASSUMPTIONS.md) - testene under bekrefter
 * KODEN sin egen oppførsel, ikke at formen matcher Sentry sitt ekte API.
 */
describe("A: SentryTransport.invoke('list_projects', ...) - GET, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /organizations/{org}/projects/ med Bearer-header og returnerer svaret som data", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ([{ slug: "jarvis" }]) } as unknown as Response;
    });
    const transport = new SentryTransport(() => Promise.resolve("acme-org"));
    const result = await transport.invoke("list_projects", {}, "tok-xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://sentry.io/api/0/organizations/acme-org/projects/");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer tok-xyz" });
    expect(result.data).toEqual([{ slug: "jarvis" }]);
  });

  it("mangler org_slug -> kaster 'sentry_org_slug_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new SentryTransport(() => Promise.resolve(null));
    await expect(transport.invoke("list_projects", {}, "tok")).rejects.toThrow("sentry_org_slug_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("en HTTP-feil kaster 'sentry_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new SentryTransport(() => Promise.resolve("acme-org"));
    await expect(transport.invoke("list_projects", {}, "bad-token")).rejects.toThrow("sentry_error_401");
  });
});

describe("B: SentryTransport.invoke('list_issues', ...) - GET, standard query default", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uten 'query' bruker default 'is:unresolved'", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ([]) } as unknown as Response; });
    await new SentryTransport(() => Promise.resolve("acme-org")).invoke("list_issues", {}, "tok");
    expect(calls[0]).toBe("https://sentry.io/api/0/organizations/acme-org/issues/?query=is%3Aunresolved");
  });

  it("med 'query' bruker den oppgitte verdien", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ([]) } as unknown as Response; });
    await new SentryTransport(() => Promise.resolve("acme-org")).invoke("list_issues", { query: "is:ignored" }, "tok");
    expect(calls[0]).toBe("https://sentry.io/api/0/organizations/acme-org/issues/?query=is%3Aignored");
  });
});

describe("C: SentryTransport.invoke('get_issue', ...) - GET ett issue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /organizations/{org}/issues/{id}/, returnerer issue-objektet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ id: "42", title: "TypeError" }) } as unknown as Response;
    });
    const result = await new SentryTransport(() => Promise.resolve("acme-org")).invoke("get_issue", { issue_id: "42" }, "tok");
    expect(calls[0]).toBe("https://sentry.io/api/0/organizations/acme-org/issues/42/");
    expect(result.data).toMatchObject({ id: "42", title: "TypeError" });
  });
});

describe("D: SentryTransport.invoke('update_issue', ...) - PUT, ekte tilstandsendring (klasse B)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTer {status} til /organizations/{org}/issues/{id}/", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "42", status: "resolved" }) } as unknown as Response;
    });
    const result = await new SentryTransport(() => Promise.resolve("acme-org")).invoke(
      "update_issue", { issue_id: "42", status: "resolved" }, "tok"
    );
    expect(calls[0]!.url).toBe("https://sentry.io/api/0/organizations/acme-org/issues/42/");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: "resolved" });
    expect(result.data).toMatchObject({ status: "resolved" });
  });
});

describe("E: en ukjent handling kaster 'sentry_unsupported_action_<action>'", () => {
  it("invoke('delete_issue', ...) kaster", async () => {
    await expect(new SentryTransport(() => Promise.resolve("acme-org")).invoke("delete_issue", {}, "tok")).rejects.toThrow("sentry_unsupported_action_delete_issue");
  });
});

describe("F: firstWaveTools() registrerer alle fire sentry.*-handlinger med korrekt risikoklasse", () => {
  it("sentry.update_issue er klasse B (reell tilstandsendring)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "sentry" && t.action === "update_issue");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("B");
    expect(tool!.credential_ref).toBe("JARVIS_SENTRY_API_TOKEN");
  });

  it("sentry.list_projects/list_issues/get_issue er alle klasse A (lesing)", () => {
    const tools = firstWaveTools();
    for (const action of ["list_projects", "list_issues", "get_issue"]) {
      const tool = tools.find((t) => t.tool_id === "sentry" && t.action === action);
      expect(tool, `sentry.${action} skal finnes`).toBeDefined();
      expect(tool!.capability_class).toBe("A");
    }
  });
});
