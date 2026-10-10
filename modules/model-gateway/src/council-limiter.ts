/**
 * D-395 (JARVIS-078): kostnadstak for AUTOMATISK råd-trigger. Et AI-råd er fem betalte modellkall pluss kryss-kritikk og syntese; den regex-baserte
 * høy-innvirkning-klassifiseringen kunne utløse det ubegrenset mange ganger (en prat om «500 000 kr» i en lang samtale). Eksplisitt eier-bestilling
 * («bruk AI-rådet») begrenses ALDRI - kun den automatiske triggeren har tak. Glidende vindu per tenant, i minnet (nullstilles ved omstart - et tak mot
 * løpsk kostnad, ikke et regnskap; revisjon skjer i trace/cost_events).
 *
 * WP-H0: `usage()` er en ren lesing for kontrollsenteret (parallell-delegasjonsoverhead): hvor mange av plassene som er brukt i vinduet, og hvor mange automatiske triggere som er gitt/nektet siden oppstart.
 */
export interface CouncilLimiterUsage {
  max_per_window: number;
  window_ms: number;
  /** Plasser brukt i det glidende vinduet for denne tenanten akkurat nå. */
  used_in_window: number;
  /** Triggere gitt siden prosessen startet (alle tenanter). Nullstilles ved omstart. */
  acquired_total: number;
  /** Triggere nektet fordi taket var nådd siden prosessen startet. Nullstilles ved omstart. */
  denied_total: number;
}

export class CouncilAutoTriggerLimiter {
  private readonly hits = new Map<string, number[]>();
  private acquiredTotal = 0;
  private deniedTotal = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number = 60 * 60 * 1000,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Forbruker en plass hvis ledig. false = taket er nådd (kall faller tilbake til vanlig samtale). */
  tryAcquire(tenantId: string): boolean {
    const t = this.now();
    const live = (this.hits.get(tenantId) ?? []).filter((at) => t - at < this.windowMs);
    if (live.length >= this.maxPerWindow) {
      this.hits.set(tenantId, live);
      this.deniedTotal += 1;
      return false;
    }
    live.push(t);
    this.hits.set(tenantId, live);
    this.acquiredTotal += 1;
    return true;
  }

  /** Kun lesing: forbruker ingen plass og endrer ingen teller. */
  usage(tenantId: string): CouncilLimiterUsage {
    const t = this.now();
    const live = (this.hits.get(tenantId) ?? []).filter((at) => t - at < this.windowMs);
    return { max_per_window: this.maxPerWindow, window_ms: this.windowMs, used_in_window: live.length, acquired_total: this.acquiredTotal, denied_total: this.deniedTotal };
  }
}
