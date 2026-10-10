// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { scanForSecrets, withTenantTransaction } from "@jarvis/core";
import { composeAiMeshReport, parallelOverheadMs, type AiMeshChain, type AiMeshLastError, type AiMeshProvider, type AiMeshReport, type AiMeshUsage7d } from "@jarvis/executive";
import type { MeshProviderDetail, MeshStatus } from "@jarvis/model-gateway";

/**
 * WP-D4 (JARVIS-033/036/078): datakilden for `executive.get_ai_mesh_status`. Slår sammen (a) leverandørhelse i denne prosessen (`ModelGateway.meshDetails()`: konfigurert, tilstand, siste feil, latens
 * siden oppstart, parallell-overhead) og (b) `cost_events` siste 7 døgn under tenant-RLS (kall, feil, kostnad, tokens, p50-latens, vellykket fallback). KUN lesing: ingen modellkall, ingen skriving, ingen
 * nøkler (kun presence) og aldri innhold - kun tall, tilstander og en kort, redigert feilkode. Kan ikke databasen leses, blir `usage_7d` `null` (UKJENT) - aldri 0 og aldri «frisk».
 */
type Pool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

export interface AiMeshSourceDeps {
  pool: Pool;
  tenantId: string;
  /** `ModelGateway.meshDetails()` (kun strukturen vi trenger). */
  details: () => MeshProviderDetail[];
  /** `ModelGateway.meshStatus()` (kun router-tilstand og om fallback er bevist i prosessen). */
  mesh: () => Pick<MeshStatus, "router" | "fallback">;
  /** Standardkjeden for vanlig prat (`JARVIS_CHAT_CANDIDATES`); `null`/udefinert = ikke koblet inn. */
  chain?: () => AiMeshChain | null;
  now?: () => Date;
}

export const AI_MESH_WINDOW_DAYS = 7;
/** Maks lengde på siste-feil-teksten i rapporten. */
const LAST_ERROR_MAX = 120;

interface UsageRow {
  provider: string;
  calls: number;
  ok_calls: number;
  failed_calls: number;
  fallback_ok_calls: number;
  cost_ore: number;
  tokens_in: string | number | null;
  tokens_out: string | number | null;
  p50: string | number | null;
  last_success_at: Date | string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const ZERO_USAGE: AiMeshUsage7d = { calls: 0, ok_calls: 0, failed_calls: 0, fallback_ok_calls: 0, cost_ore: 0, tokens_in: 0, tokens_out: 0, p50_latency_ms: null, last_success_at: null };

/** Kort, redigert feiltekst: hemmeligheter og URL-er fjernes, linjeskift flates ut, lengden kappes. En leverandørs frie tekst slipper aldri uredigert ut. */
export function redactedErrorCode(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cleaned = scanForSecrets(raw).text.replace(/https?:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;
  return cleaned.length > LAST_ERROR_MAX ? `${cleaned.slice(0, LAST_ERROR_MAX - 1)}…` : cleaned;
}

/** `cost_events` siste N døgn per leverandør. Kastet feil = `null` (kallet bestemmer hva «ukjent» betyr). Kun modellrader (`kind LIKE 'model:%'`), kun denne tenanten. */
async function readUsage(pool: Pool, tenantId: string, from: Date): Promise<Map<string, AiMeshUsage7d> | null> {
  try {
    const rows = await withTenantTransaction(pool as pg.Pool, tenantId, async (client) =>
      (
        await client.query(
          `SELECT provider,
                  count(*)::int AS calls,
                  count(*) FILTER (WHERE success)::int AS ok_calls,
                  count(*) FILTER (WHERE NOT success)::int AS failed_calls,
                  count(*) FILTER (WHERE success AND fallback)::int AS fallback_ok_calls,
                  coalesce(sum(amount_ore), 0)::int AS cost_ore,
                  coalesce(sum(input_tokens), 0)::bigint AS tokens_in,
                  coalesce(sum(output_tokens), 0)::bigint AS tokens_out,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE success AND latency_ms IS NOT NULL) AS p50,
                  max(at) FILTER (WHERE success) AS last_success_at
             FROM cost_events
            WHERE tenant_id = $1 AND at >= $2 AND provider IS NOT NULL AND kind LIKE 'model:%'
            GROUP BY provider`,
          [tenantId, from]
        )
      ).rows as UsageRow[]
    );
    const out = new Map<string, AiMeshUsage7d>();
    for (const r of rows) {
      const p50 = num(r.p50);
      out.set(r.provider, {
        calls: Number(r.calls),
        ok_calls: Number(r.ok_calls),
        failed_calls: Number(r.failed_calls),
        fallback_ok_calls: Number(r.fallback_ok_calls),
        cost_ore: Number(r.cost_ore),
        tokens_in: Number(r.tokens_in ?? 0),
        tokens_out: Number(r.tokens_out ?? 0),
        p50_latency_ms: p50 === null ? null : Math.round(p50),
        last_success_at: r.last_success_at === null ? null : new Date(r.last_success_at).toISOString()
      });
    }
    return out;
  } catch {
    return null;
  }
}

function lastErrorOf(d: MeshProviderDetail): AiMeshLastError | null {
  if (d.last_error === undefined && d.last_error_kind === undefined && d.last_failure_at === undefined) return null;
  return {
    kind: d.last_error_kind ?? null,
    message: redactedErrorCode(d.last_error),
    at: d.last_failure_at === undefined ? null : new Date(d.last_failure_at).toISOString()
  };
}

export function toMeshProvider(d: MeshProviderDetail, usage: Map<string, AiMeshUsage7d> | null): AiMeshProvider {
  return {
    provider: d.provider,
    model: d.model,
    locality: d.locality,
    hosted_free_tier: d.hosted_free_tier,
    capabilities: [...d.capabilities],
    configured: d.configured,
    ...(d.paused === true ? { paused: true } : {}),
    state: d.state,
    // En pauset leverandør er aldri «frisk» i denne rapporten, selv om helsen er LIVE (eieren har stengt den).
    healthy: d.state === "LIVE" && d.paused !== true,
    runtime: {
      success: d.success,
      failures: d.failures,
      consecutive_failures: d.consecutive_failures,
      p50_latency_ms: d.p50_latency_ms ?? null,
      avg_latency_ms: d.avg_latency_ms === undefined ? null : Math.round(d.avg_latency_ms),
      p50_solo_latency_ms: d.p50_solo_latency_ms ?? null,
      p50_parallel_latency_ms: d.p50_parallel_latency_ms ?? null,
      solo_samples: d.solo_samples,
      parallel_samples: d.parallel_samples,
      parallel_overhead_ms: parallelOverheadMs({ p50_solo: d.p50_solo_latency_ms ?? null, p50_parallel: d.p50_parallel_latency_ms ?? null, solo_samples: d.solo_samples, parallel_samples: d.parallel_samples })
    },
    last_error: lastErrorOf(d),
    // Ikke-konfigurerte leverandører kalles aldri; en leverandør uten rader har simpelthen null kall. Ulesbar database = null (ukjent), aldri 0.
    usage_7d: usage === null ? null : (usage.get(d.provider) ?? ZERO_USAGE)
  };
}

export function createAiMeshReportProvider(deps: AiMeshSourceDeps): () => Promise<AiMeshReport> {
  const now = deps.now ?? (() => new Date());
  return async () => {
    const at = now();
    const from = new Date(at.getTime() - AI_MESH_WINDOW_DAYS * 86_400_000);
    const usage = await readUsage(deps.pool, deps.tenantId, from);
    const mesh = deps.mesh();
    return composeAiMeshReport({
      as_of: at.toISOString(),
      router: mesh.router,
      providers: deps.details().map((d) => toMeshProvider(d, usage)),
      chain: deps.chain?.() ?? null,
      fallback_verified_in_process: mesh.fallback === "VERIFIED",
      ...(usage === null ? { extra_not_measured: ["Databasen kunne ikke leses, så tallene siste 7 døgn (kall, feil, kostnad, p50, fallback) er ukjente."] } : {})
    });
  };
}
