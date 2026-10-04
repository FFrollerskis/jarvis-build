/**
 * D-395 (JARVIS-078): kostnadstak for AUTOMATISK råd-trigger. Et AI-råd er fem betalte modellkall pluss kryss-kritikk og syntese; den regex-baserte
 * høy-innvirkning-klassifiseringen kunne utløse det ubegrenset mange ganger (en prat om «500 000 kr» i en lang samtale). Eksplisitt eier-bestilling
 * («bruk AI-rådet») begrenses ALDRI - kun den automatiske triggeren har tak. Glidende vindu per tenant, i minnet (nullstilles ved omstart - et tak mot
 * løpsk kostnad, ikke et regnskap; revisjon skjer i trace/cost_events).
 */
export class CouncilAutoTriggerLimiter {
  private readonly hits = new Map<string, number[]>();

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
      return false;
    }
    live.push(t);
    this.hits.set(tenantId, live);
    return true;
  }
}
