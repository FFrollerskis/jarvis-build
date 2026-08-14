/**
 * BO-12 §36-§37: faktisk runtime-basert helse for talekjeden. Ingen "healthy"
 * uten et vellykket kall; TTS-feil degraderer tale men forkaster aldri svaret.
 */
export type VoiceComponentState = "NOT_CONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED" | "UNAVAILABLE";

interface ComponentStats {
  success: number;
  failures: number;
  consecutive_failures: number;
  last_error?: string;
}

export class VoiceHealth {
  private readonly stats = new Map<string, ComponentStats>();
  /** Runtime-evidens: satt først når en faktisk barge-in har skjedd. */
  bargeInSeen = false;

  private ensure(component: string): ComponentStats {
    let s = this.stats.get(component);
    if (!s) {
      s = { success: 0, failures: 0, consecutive_failures: 0 };
      this.stats.set(component, s);
    }
    return s;
  }

  recordSuccess(component: string): void {
    const s = this.ensure(component);
    s.success += 1;
    s.consecutive_failures = 0;
  }

  recordFailure(component: string, error: string): void {
    const s = this.ensure(component);
    s.failures += 1;
    s.consecutive_failures += 1;
    s.last_error = error.slice(0, 120);
  }

  state(component: string, configured: boolean): VoiceComponentState {
    if (!configured) {
      return "NOT_CONFIGURED";
    }
    const s = this.stats.get(component);
    if (!s || (s.success === 0 && s.failures === 0)) {
      return "CONFIGURED";
    }
    if (s.consecutive_failures >= 3) {
      return "UNAVAILABLE";
    }
    if (s.consecutive_failures > 0) {
      return "DEGRADED";
    }
    return "LIVE";
  }

  snapshot(configured: Record<string, boolean>): Record<string, { state: VoiceComponentState; success: number; failures: number }> {
    const out: Record<string, { state: VoiceComponentState; success: number; failures: number }> = {};
    for (const [component, isConfigured] of Object.entries(configured)) {
      const s = this.stats.get(component);
      out[component] = {
        state: this.state(component, isConfigured),
        success: s?.success ?? 0,
        failures: s?.failures ?? 0
      };
    }
    return out;
  }
}
