import type { ModelPurpose } from "@jarvis/contracts";

/**
 * D-414: «chat først». På en lokal modell med én GPU (PC-en: llama3.1:8b + bge-m3 i 8 GB VRAM) står chatten i kø bak bakgrunnsarbeid
 * (minneuttrekk, sammendrag): observert på NAS 2026-10-06 med CHAT `ttft` 100 s mens EXTRACT kjørte samtidig, mens et «hei» tar 0,5 s.
 * Bakgrunnsformål venter derfor til ingen interaktiv forespørsel har vært aktiv på `quietMs`, men aldri lenger enn `maxWaitMs`
 * (bakgrunnsarbeid skal forsinkes, ikke sultes). Låsen er per prosess (API-et der chatten kjører).
 */
export const INTERACTIVE_PURPOSES: ReadonlySet<ModelPurpose> = new Set<ModelPurpose>(["CHAT", "CODE", "REASON", "PLAN", "RESEARCH", "CRITIQUE", "VISION"]);
export const BACKGROUND_PURPOSE_SET: ReadonlySet<ModelPurpose> = new Set<ModelPurpose>(["EXTRACT", "SUMMARIZE", "QUICK_CLASSIFICATION", "BACKGROUND"]);

export interface YieldResult {
  waited_ms: number;
  /** `idle`: interaktiv aktivitet sluttet; `timeout`: ventet maks og fortsetter; `disabled`: låsen er av. */
  reason: "idle" | "timeout" | "disabled";
}

export interface PriorityGateOptions {
  /** Maks ventetid for bakgrunnsformål. 0 = av. */
  maxWaitMs: number;
  /** Hvor lenge det må ha vært stille (ingen aktiv interaktiv forespørsel) før bakgrunn slippes til. Dekker verktøyrunder i en chat-tur. */
  quietMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class InteractivePriorityGate {
  private active = 0;
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  private yields = 0;
  private timeouts = 0;
  private totalWaitedMs = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PriorityGateOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Kalles når en interaktiv forespørsel starter; returnerer en funksjon som MÅ kalles når den er ferdig (idempotent). */
  enterInteractive(): () => void {
    this.active += 1;
    this.lastActivityAt = this.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active -= 1;
      this.lastActivityAt = this.now();
    };
  }

  /** Venter til det er stille (ingen aktiv interaktiv forespørsel siste `quietMs`), maks `maxWaitMs`. Kaster aldri. */
  async yieldToInteractive(): Promise<YieldResult> {
    if (this.opts.maxWaitMs <= 0) return { waited_ms: 0, reason: "disabled" };
    const start = this.now();
    for (;;) {
      const quietFor = this.now() - this.lastActivityAt;
      if (this.active === 0 && quietFor >= this.opts.quietMs) {
        const waited = this.now() - start;
        if (waited > 0) { this.yields += 1; this.totalWaitedMs += waited; }
        return { waited_ms: waited, reason: "idle" };
      }
      const waited = this.now() - start;
      if (waited >= this.opts.maxWaitMs) {
        this.yields += 1; this.timeouts += 1; this.totalWaitedMs += waited;
        return { waited_ms: waited, reason: "timeout" };
      }
      await this.sleep(Math.min(250, Math.max(10, this.opts.maxWaitMs - waited)));
    }
  }

  stats(): { active_interactive: number; yields: number; timeouts: number; total_waited_ms: number } {
    return { active_interactive: this.active, yields: this.yields, timeouts: this.timeouts, total_waited_ms: this.totalWaitedMs };
  }
}
