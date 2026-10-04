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
      s = { success: 0, failures: 0, consecutive_failures: 0, latencies_ms: [] };
      this.stats.set(provider, s);
    }
    return s;
  }

  recordSuccess(provider: string, latencyMs: number): void {
    const s = this.ensure(provider);
    s.success += 1;
    s.consecutive_failures = 0;
    s.last_success_at = this.now();
    delete s.rate_limited_until;
    s.latencies_ms.push(latencyMs);
    if (s.latencies_ms.length > 50) {
      s.latencies_ms.shift();
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
