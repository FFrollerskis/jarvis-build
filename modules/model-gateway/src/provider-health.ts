import type { ProviderErrorKind } from "@jarvis/provider-adapters";

/**
 * UA-1 provider-health (BO-08 §11): tilstand fra FAKTISKE resultater, ikke bare
 * at nøkkel finnes. CONFIGURED = nøkkel men aldri bevist; LIVE = nylig suksess.
 */
export type ProviderHealthState =
  | "NOT_CONFIGURED"
  | "CONFIGURED"
  | "LIVE"
  | "DEGRADED"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export interface ProviderStats {
  success: number;
  failures: number;
  consecutive_failures: number;
  last_error?: string;
  last_error_kind?: ProviderErrorKind;
  last_success_at?: number;
  last_failure_at?: number;
  rate_limited_until?: number;
  latencies_ms: number[];
  /** WP-D4: delmengder av vinduet over - kall som startet mens minst ett annet leverandørkall pågikk (parallell delegering) vs. kall som startet alene. */
  parallel_latencies_ms: number[];
  solo_latencies_ms: number[];
}

/** WP-D4: hemmelighetsfri detaljvisning av én leverandørs helse til `executive.get_ai_mesh_status` (kun tall, tilstand og feilklasse - aldri innhold). */
export interface ProviderHealthDetails {
  state: ProviderHealthState;
  success: number;
  failures: number;
  consecutive_failures: number;
  last_error?: string;
  last_error_kind?: ProviderErrorKind;
  last_failure_at?: number;
  last_success_at?: number;
  avg_latency_ms?: number;
  /** Median over vinduet (siste 50 vellykkede kall i denne prosessen). */
  p50_latency_ms?: number;
  p50_solo_latency_ms?: number;
  p50_parallel_latency_ms?: number;
  solo_samples: number;
  parallel_samples: number;
}

const LATENCY_WINDOW = 50;

/** Median (nærmeste-rang) av en liste tall; `undefined` for tom liste. */
export function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.5 * sorted.length) - 1))];
}

const RATE_LIMIT_BACKOFF_MS = 60_000;
const UNAVAILABLE_THRESHOLD = 3;
/** D-393 (JARVIS-033): UNAVAILABLE er en BEGRENSET pause (halv-åpen krets), ikke en dom til neste omstart. */
const UNAVAILABLE_COOLDOWN_BASE_MS = 30_000;
const UNAVAILABLE_COOLDOWN_MAX_MS = 5 * 60_000;

/** Pause etter N sammenhengende feil: 30 s ved terskelen, dobles per ekstra feil, maks 5 min. */
export function unavailableCooldownMs(consecutiveFailures: number): number {
  const extra = Math.max(0, consecutiveFailures - UNAVAILABLE_THRESHOLD);
  return Math.min(UNAVAILABLE_COOLDOWN_BASE_MS * 2 ** Math.min(extra, 10), UNAVAILABLE_COOLDOWN_MAX_MS);
}

export class ProviderHealthTracker {
  private readonly stats = new Map<string, ProviderStats>();

  constructor(private readonly now: () => number = Date.now) {}

  private ensure(provider: string): ProviderStats {
    let s = this.stats.get(provider);
    if (!s) {
      s = { success: 0, failures: 0, consecutive_failures: 0, latencies_ms: [], parallel_latencies_ms: [], solo_latencies_ms: [] };
      this.stats.set(provider, s);
    }
    return s;
  }

  /** `concurrent` (WP-D4): kallet startet mens minst ett annet leverandørkall pågikk. Valgfri - eldre kallere uten flagget regnes som alene. */
  recordSuccess(provider: string, latencyMs: number, concurrent = false): void {
    const s = this.ensure(provider);
    s.success += 1;
    s.consecutive_failures = 0;
    s.last_success_at = this.now();
    delete s.rate_limited_until;
    s.latencies_ms.push(latencyMs);
    if (s.latencies_ms.length > LATENCY_WINDOW) {
      s.latencies_ms.shift();
    }
    const bucket = concurrent ? s.parallel_latencies_ms : s.solo_latencies_ms;
    bucket.push(latencyMs);
    if (bucket.length > LATENCY_WINDOW) {
      bucket.shift();
    }
  }

  recordFailure(provider: string, kind: ProviderErrorKind, message: string): void {
    const s = this.ensure(provider);
    s.failures += 1;
    s.consecutive_failures += 1;
    s.last_error = message.slice(0, 200);
    s.last_error_kind = kind;
    s.last_failure_at = this.now();
    if (kind === "rate_limit") {
      s.rate_limited_until = this.now() + RATE_LIMIT_BACKOFF_MS;
    }
  }

  state(provider: string, configured: boolean): ProviderHealthState {
    if (!configured) {
      return "NOT_CONFIGURED";
    }
    const s = this.stats.get(provider);
    if (!s || (s.success === 0 && s.failures === 0)) {
      return "CONFIGURED";
    }
    if (s.rate_limited_until && s.rate_limited_until > this.now()) {
      return "RATE_LIMITED";
    }
    if (s.consecutive_failures >= UNAVAILABLE_THRESHOLD) {
      // D-393 (JARVIS-033): etter pausen slippes ETT prøvekall gjennom (DEGRADED); lykkes det nullstilles teller i `recordSuccess`,
      // feiler det starter en lengre pause. Uten dette var en provider med 3 feil utestengt til prosessen ble startet på nytt.
      const since = this.now() - (s.last_failure_at ?? 0);
      if (since < unavailableCooldownMs(s.consecutive_failures)) return "UNAVAILABLE";
      return "DEGRADED";
    }
    if (s.consecutive_failures > 0) {
      return "DEGRADED";
    }
    return s.success > 0 ? "LIVE" : "DEGRADED";
  }

  /** WP-D4: alt rapporten trenger om én leverandør, uten å røre tilstanden. En leverandør uten historikk gir nullstilte tall (og `CONFIGURED`/`NOT_CONFIGURED` fra `state`). */
  details(provider: string, configured: boolean): ProviderHealthDetails {
    const s = this.stats.get(provider);
    const avg = this.avgLatencyMs(provider);
    const p50 = medianOf(s?.latencies_ms ?? []);
    const solo = medianOf(s?.solo_latencies_ms ?? []);
    const parallel = medianOf(s?.parallel_latencies_ms ?? []);
    return {
      state: this.state(provider, configured),
      success: s?.success ?? 0,
      failures: s?.failures ?? 0,
      consecutive_failures: s?.consecutive_failures ?? 0,
      ...(s?.last_error ? { last_error: s.last_error } : {}),
      ...(s?.last_error_kind ? { last_error_kind: s.last_error_kind } : {}),
      ...(s?.last_failure_at !== undefined ? { last_failure_at: s.last_failure_at } : {}),
      ...(s?.last_success_at !== undefined ? { last_success_at: s.last_success_at } : {}),
      ...(avg !== undefined ? { avg_latency_ms: avg } : {}),
      ...(p50 !== undefined ? { p50_latency_ms: Math.round(p50) } : {}),
      ...(solo !== undefined ? { p50_solo_latency_ms: Math.round(solo) } : {}),
      ...(parallel !== undefined ? { p50_parallel_latency_ms: Math.round(parallel) } : {}),
      solo_samples: s?.solo_latencies_ms.length ?? 0,
      parallel_samples: s?.parallel_latencies_ms.length ?? 0
    };
  }

  avgLatencyMs(provider: string): number | undefined {
    const l = this.stats.get(provider)?.latencies_ms ?? [];
    if (l.length === 0) {
      return undefined;
    }
    return Math.round(l.reduce((a, b) => a + b, 0) / l.length);
  }

  snapshot(configured: Map<string, boolean>): Record<string, { state: ProviderHealthState; success: number; failures: number; avg_latency_ms?: number; last_error?: string }> {
    const out: Record<string, { state: ProviderHealthState; success: number; failures: number; avg_latency_ms?: number; last_error?: string }> = {};
    for (const [provider, isConfigured] of configured) {
      const s = this.stats.get(provider);
      const avg = this.avgLatencyMs(provider);
      out[provider] = {
        state: this.state(provider, isConfigured),
        success: s?.success ?? 0,
        failures: s?.failures ?? 0,
        ...(avg !== undefined ? { avg_latency_ms: avg } : {}),
        ...(s?.last_error ? { last_error: s.last_error } : {})
      };
    }
    return out;
  }
}
