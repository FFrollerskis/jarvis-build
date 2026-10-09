import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { MeshProviderDetail } from "@jarvis/model-gateway";
import { AI_MESH_WINDOW_DAYS, createAiMeshReportProvider, redactedErrorCode, toMeshProvider } from "../src/ai-mesh-source.ts";

/**
 * WP-D4 (JARVIS-033/036/078): datakilden til `executive.get_ai_mesh_status` mot en falsk pool - sammensetning, redigering av siste feil, ærlig «ukjent» ved ulesbar database og at kilden kun leser.
 * (SQL-en mot ekte Postgres og RLS: `wpd4-ai-mesh-source-db.test.ts`.)
 */
const NOW = new Date("2026-10-15T12:00:00.000Z");
// Fiktive, lavt-entropi verdier bygd i testen (ingen ekte nøkkelformat i kildefilen).
const PLANTED_BEARER = `Bearer ${"a".repeat(32)}`;
const PLANTED_ENV = `API_KEY=${"b".repeat(14)}`;

const detail = (over: Partial<MeshProviderDetail> = {}): MeshProviderDetail => ({
  provider: "kimi", model: "kimi-k3", configured: true, locality: "cloud", capabilities: ["text", "tool_calling"], hosted_free_tier: false,
  state: "LIVE", success: 3, failures: 0, consecutive_failures: 0, solo_samples: 0, parallel_samples: 0, ...over
});

interface Recorded { sql: string; params: unknown[] | undefined }
function fakePool(rows: Array<Record<string, unknown>> | Error): { pool: pg.Pool; log: Recorded[] } {
  const log: Recorded[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      if (/FROM cost_events/.test(sql)) {
        if (rows instanceof Error) throw rows;
        return { rows };
      }
      return { rows: [] };
    },
    release: () => undefined
  };
  const pool = rows instanceof Error && rows.message === "connect" ? { connect: async () => { throw rows; } } : { connect: async () => client };
  return { pool: pool as unknown as pg.Pool, log };
}
const row = (over: Record<string, unknown> = {}) => ({
  provider: "kimi", calls: 10, ok_calls: 8, failed_calls: 2, fallback_ok_calls: 1, cost_ore: "1234", tokens_in: "5000", tokens_out: "900", p50: "812.4", last_success_at: new Date("2026-10-14T08:30:00.000Z"), ...over
});

describe("redactedErrorCode", () => {
  it("udefinert og tom/blank tekst gir null", () => {
    expect(redactedErrorCode(undefined)).toBeNull();
    expect(redactedErrorCode("   \n ")).toBeNull();
  });

  it("en ren adapterkode slippes uendret gjennom", () => {
    expect(redactedErrorCode("kimi_auth_401")).toBe("kimi_auth_401");
  });

  it("hemmeligheter, URL-er og linjeskift fjernes - leverandørens frie tekst slipper aldri ut uredigert", () => {
    const raw = `feil\nved kall til https://api.example.test/v1/chat?key=${"c".repeat(20)} med ${PLANTED_BEARER} og ${PLANTED_ENV}`;
    const out = redactedErrorCode(raw) ?? "";
    expect(out).not.toContain("a".repeat(16));
    expect(out).not.toContain("b".repeat(10));
    expect(out).not.toContain("c".repeat(10));
    expect(out).not.toContain("https://");
    expect(out).not.toContain("\n");
    expect(out).toContain("[url]");
    expect(out).toContain("[REDACTED:");
  });

  it("kappes til 120 tegn med ellipse", () => {
    const out = redactedErrorCode("x".repeat(500)) ?? "";
    expect(out).toHaveLength(120);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("toMeshProvider", () => {
  it("frisk = LIVE akkurat nå; konfigurert-men-aldri-bevist og alt annet er ikke frisk", () => {
    expect(toMeshProvider(detail(), new Map()).healthy).toBe(true);
    for (const state of ["CONFIGURED", "DEGRADED", "RATE_LIMITED", "UNAVAILABLE", "NOT_CONFIGURED"] as const) {
      expect(toMeshProvider(detail({ state }), new Map()).healthy, state).toBe(false);
    }
  });

  it("parallell-overhead regnes ut kun med nok prøver i begge grupper", () => {
    const enough = toMeshProvider(detail({ p50_solo_latency_ms: 1000, p50_parallel_latency_ms: 1300, solo_samples: 4, parallel_samples: 3 }), new Map());
    expect(enough.runtime.parallel_overhead_ms).toBe(300);
    const thin = toMeshProvider(detail({ p50_solo_latency_ms: 1000, p50_parallel_latency_ms: 1300, solo_samples: 4, parallel_samples: 2 }), new Map());
    expect(thin.runtime.parallel_overhead_ms).toBeNull();
  });

  it("siste feil: klasse, redigert kode og ISO-tidspunkt; ingen feil gir null", () => {
    const at = Date.parse("2026-10-15T11:00:00.000Z");
    const failing = toMeshProvider(detail({ state: "UNAVAILABLE", last_error: `kimi_auth ${PLANTED_BEARER}`, last_error_kind: "auth", last_failure_at: at }), new Map());
    expect(failing.last_error).toMatchObject({ kind: "auth", at: "2026-10-15T11:00:00.000Z" });
    expect(failing.last_error?.message).not.toContain("a".repeat(16));
    expect(toMeshProvider(detail(), new Map()).last_error).toBeNull();
  });

  it("uten rad for leverandøren: nullstilt bruk (ikke null); ulesbar database (usage = null): usage_7d null", () => {
    expect(toMeshProvider(detail(), new Map()).usage_7d).toMatchObject({ calls: 0, ok_calls: 0, cost_ore: 0, p50_latency_ms: null, last_success_at: null });
    expect(toMeshProvider(detail(), null).usage_7d).toBeNull();
  });

  it("kopierer kapabiliteter (ingen delt referanse) og tar med presence-flagget, aldri noe nøkkelfelt", () => {
    const d = detail();
    const p = toMeshProvider(d, new Map());
    expect(p.capabilities).toEqual(["text", "tool_calling"]);
    expect(p.capabilities).not.toBe(d.capabilities);
    expect(Object.keys(p).join(",")).not.toMatch(/key|secret|token|authorization/i);
    expect(p.configured).toBe(true);
  });
});

describe("createAiMeshReportProvider", () => {
  const mesh = (fallback: "VERIFIED" | "READY" | "LOGIC_ONLY" = "READY") => () => ({ router: "HEALTHY" as const, fallback });

  it("setter sammen runtime og cost_events: tall fra databasen mappes, p50 rundes, siste suksess er ISO", async () => {
    const { pool } = fakePool([row()]);
    const report = await createAiMeshReportProvider({ pool, tenantId: "t1", details: () => [detail()], mesh: mesh(), now: () => NOW })();
    expect(report.acts).toBe(false);
    expect(report.as_of).toBe(NOW.toISOString());
    expect(report.providers[0]?.usage_7d).toEqual({
      calls: 10, ok_calls: 8, failed_calls: 2, fallback_ok_calls: 1, cost_ore: 1234, tokens_in: 5000, tokens_out: 900, p50_latency_ms: 812, last_success_at: "2026-10-14T08:30:00.000Z"
    });
    expect(report.acceptance.fallback_ok_calls_7d).toBe(1);
  });

  it("spør kun denne tenanten og kun de siste 7 døgnene, med én SELECT (ingen skriving)", async () => {
    const { pool, log } = fakePool([]);
    await createAiMeshReportProvider({ pool, tenantId: "tenant-x", details: () => [detail()], mesh: mesh(), now: () => NOW })();
    const select = log.find((l) => /FROM cost_events/.test(l.sql));
    expect(select?.params?.[0]).toBe("tenant-x");
    expect((select?.params?.[1] as Date).toISOString()).toBe(new Date(NOW.getTime() - AI_MESH_WINDOW_DAYS * 86_400_000).toISOString());
    expect(AI_MESH_WINDOW_DAYS).toBe(7);
    expect(select?.sql).toContain("tenant_id = $1");
    const statements = log.map((l) => l.sql.trim().split(/\s+/)[0]?.toUpperCase());
    expect(statements.filter((s) => s && !["BEGIN", "SELECT", "COMMIT"].includes(s))).toEqual([]);
    expect(log.map((l) => l.sql).join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });

  it("ulesbar database: usage_7d er null for alle (ukjent, aldri 0), rapporten sier det, og akseptansen blir UKJENT uten annet bevis", async () => {
    for (const failure of [new Error("connect"), new Error("relation does not exist")]) {
      const { pool } = fakePool(failure);
      const report = await createAiMeshReportProvider({ pool, tenantId: "t1", details: () => [detail({ provider: "a", state: "CONFIGURED" }), detail({ provider: "b", state: "CONFIGURED" })], mesh: mesh(), now: () => NOW })();
      expect(report.providers.map((p) => p.usage_7d)).toEqual([null, null]);
      expect(report.not_measured.join(" ")).toContain("Databasen kunne ikke leses");
      expect(report.acceptance.verdict).toBe("UNKNOWN");
      expect(report.summary_no).toContain("7 døgn: ukjent");
    }
  });

  it("fallback bevist i prosessen (meshStatus VERIFIED) teller som fallback-bevis; READY og LOGIC_ONLY gjør det ikke", async () => {
    const three = [detail({ provider: "a" }), detail({ provider: "b" }), detail({ provider: "c" })];
    const { pool } = fakePool([]);
    const verified = await createAiMeshReportProvider({ pool, tenantId: "t1", details: () => three, mesh: mesh("VERIFIED"), now: () => NOW })();
    expect(verified.acceptance).toMatchObject({ verdict: "MET", fallback_verified_in_process: true });
    for (const f of ["READY", "LOGIC_ONLY"] as const) {
      const report = await createAiMeshReportProvider({ pool, tenantId: "t1", details: () => three, mesh: mesh(f), now: () => NOW })();
      expect(report.acceptance.verdict, f).toBe("NOT_MET");
    }
  });

  it("kjeden og router-tilstanden videreføres; uten kjede er den null", async () => {
    const { pool } = fakePool([]);
    const withChain = await createAiMeshReportProvider({ pool, tenantId: "t1", details: () => [], mesh: () => ({ router: "DEGRADED", fallback: "READY" }), chain: () => ({ candidates: ["gemma_local", "gemma_hosted"], auto_fallback: false }), now: () => NOW })();
    expect(withChain.router).toBe("DEGRADED");
    expect(withChain.chain).toEqual({ candidates: ["gemma_local", "gemma_hosted"], auto_fallback: false });
    expect(withChain.summary_no).toContain("strengt kun kjeden");
    const without = await createAiMeshReportProvider({ pool, tenantId: "t1", details: () => [], mesh: mesh(), now: () => NOW })();
    expect(without.chain).toBeNull();
  });

  it("en planlagt hemmelighet i siste feil når aldri rapporten (verken JSON eller norsk oppsummering)", async () => {
    const { pool } = fakePool([row()]);
    const bad = detail({ state: "UNAVAILABLE", last_error: `kimi_http_401 ${PLANTED_BEARER} ${PLANTED_ENV}`, last_error_kind: "auth", last_failure_at: NOW.getTime() });
    const report = await createAiMeshReportProvider({ pool, tenantId: "t1", details: () => [bad], mesh: mesh(), now: () => NOW })();
    const all = JSON.stringify(report) + report.summary_no;
    expect(all).not.toContain("a".repeat(16));
    expect(all).not.toContain("b".repeat(10));
    expect(all).toContain("kimi_http_401");
  });

  it("leverandører uten rader får nullstilt bruk, ikke feil: en ikke-konfigurert leverandør har 0 kall", async () => {
    const { pool } = fakePool([row()]);
    const report = await createAiMeshReportProvider({
      pool, tenantId: "t1", details: () => [detail(), detail({ provider: "hermes", configured: false, state: "NOT_CONFIGURED" })], mesh: mesh(), now: () => NOW
    })();
    expect(report.providers.find((p) => p.provider === "hermes")).toMatchObject({ configured: false, healthy: false, usage_7d: { calls: 0 } });
  });
});
