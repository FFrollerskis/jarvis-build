/**
 * WP-I (D-472): virtuell klokke for kontraktstestene (fellesbriefen: «inject clocks», ingen ekte ventetid). `sleep` venter på virtuell tid og avbrytes av en `AbortSignal`;
 * `advance` flytter tiden og fyrer forfalte timere i rekkefølge, mens løftekjeder får fullføre mellom hver. Rent og deterministisk.
 */
export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

interface Timer {
  id: number;
  due: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** La ventende løftekjeder (microtasks og én makrotask) fullføre. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeClock {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(startMs: number = Date.parse("2026-11-14T08:00:00.000Z")) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  iso(): string {
    return new Date(this.t).toISOString();
  }

  /** Antall timere som venter (en connector som ikke rydder etter avbrudd lekker timere). */
  pending(): number {
    return this.timers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    return new Promise<void>((resolve, reject) => {
      const timer: Timer = { id: ++this.seq, due: this.t + Math.max(0, ms), resolve, reject };
      this.timers.push(timer);
      signal?.addEventListener("abort", () => {
        this.timers = this.timers.filter((x) => x.id !== timer.id);
        reject(new AbortedError());
      }, { once: true });
    });
  }

  /** Flytt tiden frem `ms` og fyr alle timere som forfaller i vinduet, i rekkefølge. */
  async advance(ms: number): Promise<void> {
    await settle();
    const target = this.t + Math.max(0, ms);
    for (;;) {
      const next = this.timers.filter((x) => x.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (next === undefined) break;
      this.t = Math.max(this.t, next.due);
      this.timers = this.timers.filter((x) => x.id !== next.id);
      next.resolve();
      await settle();
    }
    this.t = target;
    await settle();
  }
}
