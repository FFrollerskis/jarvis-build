import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { LANGFUSE_CAPABILITIES, LangfuseTransport, maskPublicKey } from "../src/langfuse-transport.ts";
import { FakeLangfuse } from "./support/fake-langfuse.ts";

/**
 * WP-E1: `LangfuseTransport` mot en LOKAL fake Langfuse-server (ekte node:http + guardedFetch). Bevist: helse uten autentisering, prosjekt-/nøkkel-metadata med MASKERT
 * public key, trace-TELLING fra daglige aggregater (og fallback på meta.totalItems) - og at trace-INNHOLD (prompt/svar/bruker/sesjon) og nøkler aldri kommer ut.
 */
let lf: FakeLangfuse;
let sleeps: number[];

beforeAll(async () => { lf = new FakeLangfuse(); await lf.start(); });
afterAll(async () => { await lf.stop(); });
beforeEach(() => {
  lf.requests.length = 0;
  lf.dailyMetricsAvailable = true;
  lf.healthStatus = 200;
  lf.healthBody = { status: "OK", version: "2.95.11" };
  sleeps = [];
});

const transport = (over: { baseUrl?: string | null; publicKey?: string | null } = {}): LangfuseTransport =>
  new LangfuseTransport({
    baseUrl: async () => ("baseUrl" in over ? over.baseUrl ?? null : lf.baseUrl),
    publicKey: async () => ("publicKey" in over ? over.publicKey ?? null : lf.publicKey),
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => Date.parse("2026-10-09T12:00:00Z")
  });
const call = async <T = Record<string, unknown>>(action: string, params: Record<string, JsonValue> = {}, secret: string = lf.secretKey, t: LangfuseTransport = transport()): Promise<T> =>
  ((await t.invoke(action, params, secret)).data ?? null) as unknown as T;
const rejection = async (p: Promise<unknown>): Promise<Error> => { try { await p; } catch (e) { return e as Error; } throw new Error("forventet avvisning"); };

describe("A: helse", () => {
  it("200 -> healthy med versjon; kallet gjøres UTEN autentisering og ber om databasekontroll", async () => {
    const r = await call<{ reachable: boolean; healthy: boolean; version: string; database_checked: boolean }>("get_health");
    expect(r).toMatchObject({ reachable: true, healthy: true, http_status: 200, version: "2.95.11", database_checked: true });
    expect(lf.requests).toEqual([{ method: "GET", path: "/api/public/health", query: { failIfDatabaseUnavailable: "true" }, auth: "missing" }]);
  });

  it("503 er «nede» (ikke en feil) og gjentas ikke; en svarkropp uten versjon eller med rar versjon gir version:null", async () => {
    lf.healthStatus = 503;
    lf.healthBody = { status: "Service Unavailable", version: "<script>x</script>" };
    const down = await call<{ healthy: boolean; http_status: number; version: string | null }>("get_health");
    expect(down).toMatchObject({ reachable: true, healthy: false, http_status: 503, version: null });
    expect(lf.requests).toHaveLength(1);
    lf.healthStatus = 200;
    lf.healthBody = "ikke json";
    expect(await call<{ healthy: boolean; version: unknown }>("get_health")).toMatchObject({ healthy: true, version: null });
  });

  it("ingen lytter -> langfuse_unreachable (ikke en hengende forespørsel eller en maskert konfig-feil)", async () => {
    const err = await rejection(transport({ baseUrl: "http://127.0.0.1:1" }).invoke("get_health", {}, lf.secretKey));
    expect(err.message).toBe("langfuse_unreachable");
  });
});

describe("B: prosjekt- og nøkkel-metadata", () => {
  it("returnerer hvitlistede felt, en MASKERT public key, og aldri secret key eller hele public key", async () => {
    const r = await transport().invoke("get_project", {}, lf.secretKey);
    const text = JSON.stringify(r);
    expect(r.data).toMatchObject({ credentials_valid: true, key: { scope: "project" }, project_count: 1, projects: [{ id: "proj-1", name: "Jarvis", organization_id: "org-1", organization_name: "Tobias" }] });
    expect((r.data as { key: { public_key_hint: string } }).key.public_key_hint).toBe(maskPublicKey(lf.publicKey));
    expect(text).not.toContain(lf.secretKey);
    expect(text).not.toContain(lf.publicKey);
    expect(text).not.toContain("skal-ikke-videre");
    expect(lf.requests[0]).toMatchObject({ path: "/api/public/projects", auth: "ok" });
  });

  it("feil secret key gir ÉN 401 (ingen retry), og nøklene står ikke i feilen", async () => {
    const wrong = "sk-lf-feil-nokkel-123456";
    const err = await rejection(transport().invoke("get_project", {}, wrong));
    expect(err.message).toMatch(/^langfuse_error_401:/);
    expect(err.message).not.toContain(wrong);
    expect(err.message).not.toContain(lf.publicKey);
    expect(lf.requests).toHaveLength(1);
  });

  it("manglende konfig feiler lukket før noe sendes: base-URL, public key og ugyldig base-URL (ingen sti/query/brukerinfo)", async () => {
    expect((await rejection(transport({ baseUrl: null }).invoke("get_project", {}, lf.secretKey))).message).toBe("langfuse_base_url_not_configured");
    expect((await rejection(transport({ publicKey: null }).invoke("get_project", {}, lf.secretKey))).message).toBe("langfuse_public_key_not_configured");
    for (const bad of ["http://host/sti", "http://u:p@host", "ftp://host", "http://host?x=1", "javascript:alert(1)"]) {
      expect((await rejection(transport({ baseUrl: bad }).invoke("get_health", {}, lf.secretKey))).message, bad).toBe("langfuse_base_url_invalid");
    }
    expect(lf.requests).toHaveLength(0);
  });

  it("maskPublicKey viser nok til å kjenne igjen nøkkelen og aldri nok til å bruke den", () => {
    expect(maskPublicKey("pk-lf-12345678-abcd-ef01-2345-6789abcdef01")).toBe("pk-lf-123…ef01");
    expect(maskPublicKey("kort")).toBe("***");
  });
});

describe("C: trace-telling - kun tall, aldri innhold", () => {
  it("daglige aggregater: summerer traces/observasjoner/kost; bruker-/modell-/sesjons-/trace-innhold kommer ikke med", async () => {
    const r = await call<{ source: string; days: Array<Record<string, unknown>>; total_traces: number; total_observations: number; total_cost_usd: number; window_days: number }>("get_trace_counts", { window_days: 3 });
    expect(r).toMatchObject({ source: "metrics_daily", window_days: 3, total_traces: 42, total_observations: 130, total_cost_usd: 0.6234 });
    expect(r.days).toEqual([
      { date: "2026-10-07", traces: 12, observations: 40, cost_usd: 0.1234 },
      { date: "2026-10-08", traces: 30, observations: 90, cost_usd: 0.5 }
    ]);
    expect(JSON.stringify(r)).not.toContain("gpt-x");
    const req = lf.requests.find((x) => x.path === "/api/public/metrics/daily")!;
    expect(req.query).toMatchObject({ fromTimestamp: "2026-10-06T12:00:00.000Z", toTimestamp: "2026-10-09T12:00:00.000Z" });
  });

  it("uten daglige aggregater (404) leses KUN meta.totalItems fra trace-listen (limit=1) - trace-innholdet i svaret forlater aldri transporten", async () => {
    lf.dailyMetricsAvailable = false;
    const r = await call<{ source: string; total_traces: number }>("get_trace_counts");
    expect(r).toMatchObject({ source: "traces_meta", total_traces: 4321 });
    const text = JSON.stringify(r);
    for (const leak of ["HEMMELIG-PROMPT-INNHOLD", "HEMMELIG-SVAR", "bruker-42", "sesjon-7", "tenant-x"]) expect(text).not.toContain(leak);
    expect(lf.requests.find((x) => x.path === "/api/public/traces")!.query).toMatchObject({ limit: "1", page: "1" });
  });

  it("window_days valideres (1..31), og en leser aldri mer enn det som trengs", async () => {
    for (const bad of [0, 32, 1.5, "7", -1]) {
      expect((await rejection(transport().invoke("get_trace_counts", { window_days: bad as never }, lf.secretKey))).message, String(bad)).toBe("langfuse_invalid_window_days");
    }
    expect(lf.requests).toHaveLength(0);
  });

  it("lesing gjentas på 5xx (begrenset) og gir opp etter 3 forsøk; ukjent handling kaster", async () => {
    lf.failNext(/GET \/api\/public\/projects/, 503, 1);
    expect(await call("get_project")).toMatchObject({ credentials_valid: true });
    expect(sleeps).toEqual([500]);
    lf.requests.length = 0;
    lf.failNext(/GET \/api\/public\/projects/, 500, 5);
    expect((await rejection(transport().invoke("get_project", {}, lf.secretKey))).message).toMatch(/^langfuse_error_500:/);
    expect(lf.requests.filter((r) => r.path === "/api/public/projects")).toHaveLength(3);
    await expect(transport().invoke("delete_traces", {}, lf.secretKey)).rejects.toThrow("langfuse_unsupported_action_delete_traces");
  });
});

describe("D: kapabilitetsmatrisen (D-41) er ærlig", () => {
  it("alt som ikke er bygget står som DEFERRED med begrunnelse (sletting av traces og nøkkelrotasjon), og alle bygde handlinger er klasse A", () => {
    const deferred = LANGFUSE_CAPABILITIES.filter((c) => c.status === "DEFERRED");
    expect(deferred.some((c) => /Slette traces/.test(c.capability))).toBe(true);
    expect(deferred.some((c) => /nøkler/.test(c.capability))).toBe(true);
    for (const c of deferred) expect(c.note.length, c.capability).toBeGreaterThan(30);
    expect(LANGFUSE_CAPABILITIES.filter((c) => c.status !== "DEFERRED" && c.risk !== "-").every((c) => c.risk === "A")).toBe(true);
  });
});
