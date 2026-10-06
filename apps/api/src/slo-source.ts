// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import {
  composeSloReport, computeDataQuality, computeDrift, evaluateAllSlos,
  type DataQualityCounts, type Observation, type ObservationReader, type SeriesId, type SeriesWindow, type SloReport, type SloSource
} from "@jarvis/executive";

/**
 * EV-2 (D-417): datakilden for SLO/drift/dataskvalitet. Leser KUN eksisterende observerbarhet (`cost_events`, `tool_executions`, `tasks`,
 * `memory_items`) under tenant-RLS - ingen ny tabell, ingen parallell telemetri. Kun aggregater/antall; aldri innhold.
 */
const BACKGROUND_PURPOSES = ["EXTRACT", "SUMMARIZE", "QUICK_CLASSIFICATION", "BACKGROUND"];
type Pool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function createSloSource(pool: Pool, tenantId: string): SloSource {
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
    withTenantTransaction(pool as pg.Pool, tenantId, async (client) => (await client.query(sql, params)).rows as T[]);
  return {
    async window(series: SeriesId, from: Date, to: Date): Promise<SeriesWindow> {
      const base = { from: from.toISOString(), to: to.toISOString() };
      if (series === "model:CHAT" || series === "model:BACKGROUND") {
        const purposes = series === "model:CHAT" ? ["CHAT"] : BACKGROUND_PURPOSES;
        const [r] = await q<{ count: number; ok: number; p50: unknown; p95: unknown; ttft: unknown; cost: number }>(
          `SELECT count(*)::int AS count, count(*) FILTER (WHERE success)::int AS ok,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS p50,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS p95,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE ttft_ms IS NOT NULL) AS ttft,
                  coalesce(sum(amount_ore), 0)::int AS cost
             FROM cost_events WHERE at >= $1 AND at < $2 AND purpose = ANY($3::text[])`,
          [from, to, purposes]
        );
        return { ...base, count: r?.count ?? 0, ok: r?.ok ?? 0, p50_ms: num(r?.p50), p95_ms: num(r?.p95), ttft_p95_ms: num(r?.ttft), cost_ore: r?.cost ?? 0 };
      }
      if (series === "tools") {
        const [r] = await q<{ count: number; ok: number }>(
          `SELECT count(*)::int AS count, count(*) FILTER (WHERE status = 'succeeded')::int AS ok
             FROM tool_executions WHERE executed_at >= $1 AND executed_at < $2 AND status IN ('succeeded', 'failed')`,
          [from, to]
        );
        return { ...base, count: r?.count ?? 0, ok: r?.ok ?? 0, p50_ms: null, p95_ms: null, ttft_p95_ms: null, cost_ore: 0 };
      }
      const [r] = await q<{ count: number; ok: number }>(
        `SELECT count(*)::int AS count, count(*) FILTER (WHERE status = 'completed')::int AS ok
           FROM tasks WHERE finished_at >= $1 AND finished_at < $2 AND status IN ('completed', 'failed')`,
        [from, to]
      );
      return { ...base, count: r?.count ?? 0, ok: r?.ok ?? 0, p50_ms: null, p95_ms: null, ttft_p95_ms: null, cost_ore: 0 };
    }
  };
}

/**
 * Minne-RLS krever space-kontekst. Kun ANTALL leses (aldri innhold), og `health`/`guest` er BEVISST utelatt: health kan aldri kombineres med
 * andre rom (MEMORY_ARCHITECTURE §4), og kvaliteten der måles ikke herfra (se `SLO_NOT_MEASURED`).
 */
const QUALITY_SPACES = ["personal", "business", "project", "home", "shared"] as const;

export function createDataQualityCounts(pool: Pool, tenantId: string): DataQualityCounts {
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    withMemoryTransaction(pool as pg.Pool, tenantId, QUALITY_SPACES, async (client) => Number((await client.query(sql, params)).rows[0]?.n ?? 0));
  return {
    contradictory: () => count(`SELECT count(*)::int AS n FROM memory_items WHERE status = 'active' AND has_conflict`),
    duplicate: () =>
      count(`SELECT coalesce(sum(n - 1), 0)::int AS n FROM (SELECT count(*) AS n FROM memory_items WHERE status = 'active' GROUP BY space, md5(content) HAVING count(*) > 1) t`),
    expiredButActive: () => count(`SELECT count(*)::int AS n FROM memory_items WHERE status = 'active' AND valid_to IS NOT NULL AND valid_to < now()`),
    staleQuarantine: (days) => count(`SELECT count(*)::int AS n FROM memory_items WHERE status = 'quarantined' AND created_at < now() - make_interval(days => $1::int)`, [days])
  };
}

/** Rapport-leverandør med kort cache (selvdiagnose + verktøy + hurtigbane skal ikke gi N dyre aggregeringer). Feilende deler blir UNKNOWN, aldri en feil. */
export function createSloReportProvider(
  pool: Pool,
  tenantId: string,
  options: { now?: () => Date; ttlMs?: number } = {}
): () => Promise<SloReport> {
  const now = options.now ?? (() => new Date());
  const ttl = options.ttlMs ?? 30_000;
  const source = createSloSource(pool, tenantId);
  const counts = createDataQualityCounts(pool, tenantId);
  let cached: { at: number; report: Promise<SloReport> } | undefined;
  return () => {
    const t = now().getTime();
    if (cached && t - cached.at < ttl) return cached.report;
    const report = (async () => {
      const at = now();
      const [slos, drift, data_quality] = await Promise.all([
        evaluateAllSlos(source, at),
        computeDrift(source, at).catch(() => null),
        computeDataQuality(counts, at).catch(() => null)
      ]);
      return composeSloReport({ as_of: at.toISOString(), slos, drift, data_quality });
    })();
    cached = { at: t, report };
    report.catch(() => { if (cached?.report === report) cached = undefined; });
    return report;
  };
}

/** Selvmodell-lesere (EV-1) for områdene EV-2 leverer: `slo`, `drift`, `data_quality`. Ukjent er UNKNOWN - aldri «frisk». */
export function buildSloReaders(report: () => Promise<SloReport>): Record<string, ObservationReader> {
  return {
    async slo(): Promise<Observation> {
      const r = await report();
      const breaches = r.slos.filter((s) => s.status === "BREACH");
      const ok = r.slos.filter((s) => s.status === "OK");
      const data = { breached: breaches.length, ok: ok.length, unknown: r.slos.length - breaches.length - ok.length };
      const base = { source: "cost_events/tool_executions/tasks (SLO-katalog, forslag)", observed_at: r.as_of, data };
      if (breaches.length > 0) return { ...base, status: "DEGRADED", detail: `${breaches.length} tjenestemål brutt: ${breaches.map((s) => `${s.label} - ${s.detail}`).join(" | ")}` };
      if (ok.length === 0) return { status: "UNKNOWN", source: base.source, observed_at: null, detail: "For få målinger til å vurdere noen tjenestemål (SLO).", data };
      return { ...base, status: "OK", detail: `${ok.length} av ${r.slos.length} tjenestemål er innfridd; ${data.unknown} har for lite data.` };
    },
    async drift(): Promise<Observation> {
      const r = await report();
      const source = "cost_events/tool_executions/tasks (siste døgn mot uken før)";
      if (!r.drift) return { status: "UNKNOWN", source, observed_at: null, detail: "Forverring (drift) kunne ikke måles." };
      if (r.drift.findings.length > 0) {
        return { status: "DEGRADED", source, observed_at: r.as_of, detail: `Gradvis forverring: ${r.drift.findings.map((f) => `${f.series}: ${f.detail}`).join(" | ")}`, data: { findings: r.drift.findings.length } };
      }
      if (r.drift.insufficient.length >= 4) return { status: "UNKNOWN", source, observed_at: null, detail: "For lite data (baseline) til å vurdere forverring." };
      return { status: "OK", source, observed_at: r.as_of, detail: r.drift.insufficient.length > 0 ? `Ingen forverring funnet; for lite data for: ${r.drift.insufficient.join(", ")}.` : "Ingen gradvis forverring funnet." };
    },
    async data_quality(): Promise<Observation> {
      const r = await report();
      const source = "memory_items (dataskvalitet)";
      const dq = r.data_quality;
      if (!dq || dq.checks.every((c) => c.count === null)) return { status: "UNKNOWN", source, observed_at: null, detail: "Dataskvalitet kunne ikke måles." };
      const bad = dq.checks.filter((c) => (c.count ?? 0) > 0);
      if (bad.length > 0) return { status: "DEGRADED", source, observed_at: dq.observed_at, detail: `Dataskvalitet: ${bad.map((c) => `${c.count} ${c.label}`).join(", ")}.` };
      return { status: "OK", source, observed_at: dq.observed_at, detail: "Ingen funn i det som er målt (korrupte data er ikke målt ennå)." };
    }
  };
}
