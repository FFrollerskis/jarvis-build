import { afterEach, describe, expect, it, vi } from "vitest";
import { GrafanaTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-305 (bygget parallelt mens D-304 sin CI kjørte). FØRSTE connector i
 * denne rekken som er TYPISK selv-hostet - base-URL-en må konfigureres
 * (`JARVIS_GRAFANA_API_BASE_URL`), samme resolver-argument-mønster som
 * `SentryTransport` sin org-slug (D-297). `Authorization: Bearer <api_key>`.
 */
describe("A: GrafanaTransport.invoke('search_dashboards', ...) - GET /api/search, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med Bearer-header mot den konfigurerte base-URL-en, returnerer hele JSON-responsen", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => [{ uid: "abc", title: "Dashboard 1" }] } as unknown as Response;
    });
    const transport = new GrafanaTransport(async () => "https://grafana.example.com");
    const result = await transport.invoke("search_dashboards", {}, "test-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://grafana.example.com/api/search");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(result.data).toEqual([{ uid: "abc", title: "Dashboard 1" }]);
  });

  it("sender 'query' som query-parameter når satt, og strippes trailing slash fra base-URL-en", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => [] } as unknown as Response; });
    const transport = new GrafanaTransport(async () => "https://grafana.example.com/");
    await transport.invoke("search_dashboards", { query: "cpu" }, "tok");
    expect(calls[0]).toBe("https://grafana.example.com/api/search?query=cpu");
  });

  it("manglende base-URL kaster 'grafana_base_url_not_configured' - IKKE et fetch-kall gjøres", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => [] } as unknown as Response; });
    const transport = new GrafanaTransport(async () => null);
    await expect(transport.invoke("search_dashboards", {}, "tok")).rejects.toThrow("grafana_base_url_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("en HTTP-feil kaster 'grafana_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new GrafanaTransport(async () => "https://grafana.example.com");
    await expect(transport.invoke("search_dashboards", {}, "bad-key")).rejects.toThrow("grafana_error_401");
  });
});

describe("B: GrafanaTransport.invoke('get_dashboard', ...) - GET /api/dashboards/uid/{uid}", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med uid i stien, returnerer hele JSON-responsen", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ dashboard: { uid: "abc" } }) } as unknown as Response;
    });
    const transport = new GrafanaTransport(async () => "https://grafana.example.com");
    const result = await transport.invoke("get_dashboard", { uid: "abc" }, "tok");
    expect(calls[0]).toBe("https://grafana.example.com/api/dashboards/uid/abc");
    expect(result.data).toEqual({ dashboard: { uid: "abc" } });
  });
});

describe("C: en ukjent handling kaster 'grafana_unsupported_action_<action>'", () => {
  it("invoke('create_dashboard', ...) kaster (ikke registrert, selv om Grafana tilbyr det)", async () => {
    const transport = new GrafanaTransport(async () => "https://grafana.example.com");
    await expect(transport.invoke("create_dashboard", {}, "tok")).rejects.toThrow("grafana_unsupported_action_create_dashboard");
  });
});

describe("D: firstWaveTools() registrerer begge grafana.*-handlinger som klasse A (lesing)", () => {
  it("grafana.search_dashboards og get_dashboard er begge klasse A, ingen klasse B/C/D-handling finnes for denne connectoren", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "grafana");
    expect(tools.map((t) => t.action).sort()).toEqual(["get_dashboard", "search_dashboards"]);
    for (const tool of tools) {
      expect(tool.capability_class).toBe("A");
      expect(tool.credential_ref).toBe("JARVIS_GRAFANA_API_KEY");
      expect(tool.output_trust).toBe("untrusted");
    }
  });
});
