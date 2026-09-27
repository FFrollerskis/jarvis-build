import { afterEach, describe, expect, it, vi } from "vitest";
import { PrometheusTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-306 (bygget parallelt mens D-305 sin CI kjørte). SAMME "typisk selv-
 * hostet"-struktur som Grafana (D-305) - base-URL-en må konfigureres, SAMME
 * resolver-argument-mønster. `Authorization: Bearer <token>` mot
 * Prometheus sitt HTTP-API (PromQL via query-parameter).
 */
describe("A: PrometheusTransport.invoke('query', ...) - GET /api/v1/query, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med Bearer-header og query-parameter mot den konfigurerte base-URL-en", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ status: "success", data: { resultType: "vector", result: [] } }) } as unknown as Response;
    });
    const transport = new PrometheusTransport(async () => "https://prometheus.example.com");
    const result = await transport.invoke("query", { query: "up" }, "test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://prometheus.example.com/api/v1/query?query=up");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(result.data).toEqual({ status: "success", data: { resultType: "vector", result: [] } });
  });

  it("strippes trailing slash fra base-URL-en", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new PrometheusTransport(async () => "https://prometheus.example.com/");
    await transport.invoke("query", { query: "up" }, "tok");
    expect(calls[0]).toBe("https://prometheus.example.com/api/v1/query?query=up");
  });

  it("manglende base-URL kaster 'prometheus_base_url_not_configured' - IKKE et fetch-kall gjøres", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new PrometheusTransport(async () => null);
    await expect(transport.invoke("query", { query: "up" }, "tok")).rejects.toThrow("prometheus_base_url_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("en HTTP-feil kaster 'prometheus_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new PrometheusTransport(async () => "https://prometheus.example.com");
    await expect(transport.invoke("query", { query: "up" }, "bad-token")).rejects.toThrow("prometheus_error_401");
  });
});

describe("B: PrometheusTransport.invoke('query_range', ...) - GET /api/v1/query_range", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med query/start/end/step som query-parametere", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ status: "success" }) } as unknown as Response;
    });
    const transport = new PrometheusTransport(async () => "https://prometheus.example.com");
    const result = await transport.invoke("query_range", { query: "up", start: "0", end: "100", step: "15" }, "tok");
    expect(calls[0]).toBe("https://prometheus.example.com/api/v1/query_range?query=up&start=0&end=100&step=15");
    expect(result.data).toEqual({ status: "success" });
  });
});

describe("C: en ukjent handling kaster 'prometheus_unsupported_action_<action>'", () => {
  it("invoke('delete_series', ...) kaster (ikke registrert, selv om Prometheus admin-API-et muligens tilbyr det)", async () => {
    const transport = new PrometheusTransport(async () => "https://prometheus.example.com");
    await expect(transport.invoke("delete_series", { query: "up" }, "tok")).rejects.toThrow("prometheus_unsupported_action_delete_series");
  });
});

describe("D: firstWaveTools() registrerer begge prometheus.*-handlinger som klasse A (lesing)", () => {
  it("prometheus.query og query_range er begge klasse A, ingen klasse B/C/D-handling finnes for denne connectoren", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "prometheus");
    expect(tools.map((t) => t.action).sort()).toEqual(["query", "query_range"]);
    for (const tool of tools) {
      expect(tool.capability_class).toBe("A");
      expect(tool.credential_ref).toBe("JARVIS_PROMETHEUS_TOKEN");
      expect(tool.output_trust).toBe("untrusted");
    }
  });
});
