import { describe, expect, it } from "vitest";
import {
  DRIFT_THRESHOLDS, SLO_CATALOG, composeSloReport, computeDataQuality, computeDrift, detectDrift, evaluateAllSlos, evaluateSlo, renderSloReportNo,
  type SeriesId, type SeriesWindow, type SloSource
} from "../src/index.ts";

const win = (over: Partial<SeriesWindow> = {}): SeriesWindow => ({ from: "a", to: "b", count: 100, ok: 100, p50_ms: 1000, p95_ms: 5000, ttft_p95_ms: 3000, cost_ore: 0, ...over });
const def = (id: string) => SLO_CATALOG.find((d) => d.id === id)!;
const NOW = "2026-10-06T12:00:00.000Z";

describe("EV-2 SLO-evaluering: ukjent er aldri OK", () => {
  it("success_rate: OK / BREACH / UNKNOWN (for få målinger)", () => {
    expect(evaluateSlo(def("chat_success"), win({ count: 100, ok: 97 }), NOW).status).toBe("OK");
    const breach = evaluateSlo(def("chat_success"), win({ count: 100, ok: 80 }), NOW);
    expect(breach.status).toBe("BREACH");
    expect(breach.detail).toContain("80 %");
    const few = evaluateSlo(def("chat_success"), win({ count: 3, ok: 3 }), NOW);
    expect(few.status).toBe("UNKNOWN");
    expect(few.detail).toContain("For få målinger");
  });
  it("latens og ttft: høyst-mål; manglende verdi er UNKNOWN selv med mange målinger", () => {
    expect(evaluateSlo(def("chat_ttft_p95"), win({ ttft_p95_ms: 9000 }), NOW).status).toBe("OK");
    expect(evaluateSlo(def("chat_ttft_p95"), win({ ttft_p95_ms: 40_000 }), NOW).status).toBe("BREACH");
    expect(evaluateSlo(def("chat_ttft_p95"), win({ ttft_p95_ms: null }), NOW).status).toBe("UNKNOWN");
    expect(evaluateSlo(def("chat_latency_p95"), win({ p95_ms: 90_000 }), NOW).status).toBe("BREACH");
  });
  it("evaluateAllSlos: en kilde som feiler gir UNKNOWN for den SLO-en, ikke en kastet feil", async () => {
    const source: SloSource = { window: async (s) => { if (s === "tools") throw new Error("db nede"); return win(); } };
    const res = await evaluateAllSlos(source, new Date(NOW));
    expect(res.find((r) => r.id === "tools_success")).toMatchObject({ status: "UNKNOWN" });
    expect(res.find((r) => r.id === "tools_success")?.detail).toContain("måling feilet");
    expect(res.find((r) => r.id === "chat_success")?.status).toBe("OK");
  });
  it("katalogen har unike id-er og gyldige mål", () => {
    expect(new Set(SLO_CATALOG.map((d) => d.id)).size).toBe(SLO_CATALOG.length);
    for (const d of SLO_CATALOG) {
      expect(d.min_samples).toBeGreaterThan(0);
      if (d.metric === "success_rate") expect(d.target).toBeGreaterThan(0.5);
    }
  });
});

describe("EV-2 drift", () => {
  const baseline = win({ count: 200, ok: 196, p95_ms: 8000, ttft_p95_ms: 4000, cost_ore: 200 });
  it("faller i suksessrate og økt latens/kost gir funn; stabilt gir ingen", () => {
    const worse = detectDrift("model:CHAT", baseline, win({ count: 40, ok: 30, p95_ms: 20_000, ttft_p95_ms: 12_000, cost_ore: 120 }));
    expect(worse.sufficient).toBe(true);
    expect(worse.findings.map((f) => f.metric).sort()).toEqual(["cost_per_call_ore", "p95_ms", "success_rate", "ttft_p95_ms"]);
    const stable = detectDrift("model:CHAT", baseline, win({ count: 40, ok: 39, p95_ms: 8500, ttft_p95_ms: 4200, cost_ore: 40 }));
    expect(stable.findings).toEqual([]);
  });
  it("for lite data i baseline eller siste vindu: ingen påstand (sufficient=false)", () => {
    expect(detectDrift("tools", win({ count: DRIFT_THRESHOLDS.min_baseline_samples - 1 }), win()).sufficient).toBe(false);
    expect(detectDrift("tools", baseline, win({ count: DRIFT_THRESHOLDS.min_recent_samples - 1 })).sufficient).toBe(false);
  });
  it("bagatell-endringer under minste absolutte endring gir ikke alarm", () => {
    const res = detectDrift("model:CHAT", win({ count: 100, ok: 100, p95_ms: 500, ttft_p95_ms: 400 }), win({ count: 50, ok: 50, p95_ms: 1400, ttft_p95_ms: 1100 }));
    expect(res.findings).toEqual([]);
  });
  it("computeDrift: sammenligner siste døgn mot uken før; feilende serie blir insufficient", async () => {
    const calls: Array<{ s: SeriesId; from: string; to: string }> = [];
    const source: SloSource = {
      window: async (s, from, to) => {
        calls.push({ s, from: from.toISOString(), to: to.toISOString() });
        if (s === "jobs") throw new Error("x");
        return to.toISOString() === NOW ? win({ count: 40, ok: 20 }) : win({ count: 200, ok: 198 });
      }
    };
    const rep = await computeDrift(source, new Date(NOW));
    expect(rep.findings.some((f) => f.series === "model:CHAT" && f.metric === "success_rate")).toBe(true);
    expect(rep.insufficient).toContain("jobs");
    expect(new Date(rep.recent_window.to).getTime() - new Date(rep.recent_window.from).getTime()).toBe(24 * 3_600_000);
    expect(new Date(rep.baseline_window.to).getTime() - new Date(rep.baseline_window.from).getTime()).toBe(7 * 86_400_000);
  });
});

describe("EV-2 dataskvalitet og rapport", () => {
  it("teller funn, feilende telling er null (ikke 0), og «korrupte data» er DEFERRED", async () => {
    const dq = await computeDataQuality({
      contradictory: async () => 2, duplicate: async () => 0, expiredButActive: async () => { throw new Error("x"); }, staleQuarantine: async () => 5
    }, new Date(NOW));
    expect(dq.checks.find((c) => c.kind === "contradictory")?.count).toBe(2);
    expect(dq.checks.find((c) => c.kind === "duplicate")?.count).toBe(0);
    expect(dq.checks.find((c) => c.kind === "expired_but_active")?.count).toBeNull();
    expect(dq.checks.find((c) => c.kind === "corrupted")).toMatchObject({ count: null });
    expect(dq.checks.find((c) => c.kind === "corrupted")?.deferred).toContain("DEFERRED");
  });
  it("norsk oppsummering: brudd, ukjent og ikke-målt sies tydelig; ingenting er «bra» uten data", () => {
    const slos = [
      evaluateSlo(def("chat_success"), win({ count: 100, ok: 70 }), NOW),
      evaluateSlo(def("tools_success"), win({ count: 2, ok: 2 }), NOW)
    ];
    const r = composeSloReport({ as_of: NOW, slos, drift: null, data_quality: null });
    expect(r.summary_no).toContain("1 av 2 tjenestemål er brutt");
    expect(r.summary_no).toContain("Ikke nok data");
    expect(r.summary_no).toContain("Forverring (drift) er ikke målt");
    expect(r.summary_no).toContain("Hallusinasjon/eval-score");
    const none = renderSloReportNo({ as_of: NOW, slos: slos.slice(1), drift: null, data_quality: null, not_measured: [] });
    expect(none).toContain("Ingen tjenestemål kan vurderes ennå");
  });
});
