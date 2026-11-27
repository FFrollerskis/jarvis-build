import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Observation } from "@jarvis/executive";
import { parseWatchdogIntervalMs } from "@jarvis/watchdog";
import { buildSelfModelReaders, type SelfModelReaderDeps } from "../src/self-model-readers.ts";
import * as status from "../src/watchdog-status.ts";
import type { WatchdogRunRow } from "../src/watchdog-status.ts";
import { watchdogTickMaxAgeMs } from "../src/watchdog-heartbeat.ts";

/**
 * WP-OPS2a fiks-runde 1, K1 (review B-L1, B-L2, B-L3 og testhullet fmtAge): terskelen regnes av VAKTHUND-intervallet (raden skrives per vakthund-tikk), klokken tas etter lesingen med 2 s toleranse,
 * og den rene funksjonen kaster aldri (ingen TypeError-tekst i selvdiagnosen). Moduleksporter åpnes via `status.*` slik at en manglende eksport gir en rød TEST, ikke en rød import.
 */
const NOW = new Date("2026-11-27T10:00:00.000Z");
const agoMs = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const mmss = (m: number, s: number): number => (m * 60 + s) * 1000;
const row = (over: Partial<WatchdogRunRow> = {}): WatchdogRunRow => ({ last_started_at: agoMs(mmss(1, 0)), last_status: "ok", facts_seen: 0, consecutive_failures: 0, ...over });
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("B-L1: grensen er max(3 x VAKTHUND-intervallet, 2 min) - samme formel som heartbeaten (K3)", () => {
  it("formelen: gulv 2 min (til og med 40 s), deretter 3 x intervallet, opp til 3 timer ved 1 time", () => {
    const table: Array<[number, number]> = [[1_000, 120_000], [10_000, 120_000], [40_000, 120_000], [41_000, 123_000], [60_000, 180_000], [300_000, 900_000], [3_600_000, 10_800_000]];
    for (const [interval, limit] of table) {
      expect(status.watchdogFreshLimitMs(interval), `${interval} ms`).toBe(limit);
    }
    expect(status.WATCHDOG_MIN_FRESH_MS).toBe(120_000);
  });

  it("K1 og K3 bruker SAMME formel (heartbeatens `watchdogTickMaxAgeMs` er den samme funksjonen) for alle gyldige intervaller", () => {
    for (const interval of [1_000, 30_000, 40_000, 40_001, 60_000, 90_000, 600_000, 3_600_000]) {
      expect(status.watchdogFreshLimitMs(interval)).toBe(watchdogTickMaxAgeMs(interval));
    }
  });

  it("standard vakthund-intervall (60 s): 3:00 er OK, 3:01 er DOWN (ikke 15 min som med produsent-intervallet)", () => {
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(mmss(3, 0)) }), NOW, 60_000).status).toBe("OK");
    const down = status.observeWatchdogRun(row({ last_started_at: agoMs(mmss(3, 1)) }), NOW, 60_000);
    expect(down.status).toBe("DOWN");
    expect(down.detail).toContain("grensen er 3 min");
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(mmss(14, 0)) }), NOW, 60_000).status).toBe("DOWN");
  });

  it("kort vakthund-intervall (10 s): gulvet på 2 min gjelder (2:00 OK, 2:01 DOWN), ikke 3 x 10 s = 30 s", () => {
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(mmss(0, 31)) }), NOW, 10_000).status).toBe("OK");
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(mmss(2, 0)) }), NOW, 10_000).status).toBe("OK");
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(mmss(2, 1)) }), NOW, 10_000).status).toBe("DOWN");
  });

  it("langt vakthund-intervall (1 time): et tikk som er 2 t 50 min gammelt er OK (vakthunden tikker bare hver time), 3 t 00 OK, 3 t 01 DOWN", () => {
    const h = (hh: number, mm: number, ss = 0): number => ((hh * 60 + mm) * 60 + ss) * 1000;
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(h(2, 50)) }), NOW, 3_600_000).status).toBe("OK");
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(h(3, 0)) }), NOW, 3_600_000).status).toBe("OK");
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(h(3, 0, 1)) }), NOW, 3_600_000).status).toBe("DOWN");
  });

  it("main.ts sender VAKTHUND-intervallet (JARVIS_WATCHDOG_INTERVAL_MS), ikke incident-produsentenes: ordlyden er festet i kilden", () => {
    const main = readFileSync(join(ROOT, "apps/api/src/main.ts"), "utf8");
    expect(main).toContain("watchdogRunSource(new ProducerRunStore(pool), owner.tenant_id, watchdogIntervalMsFromEnv(process.env))");
    const call = main.slice(main.indexOf("watchdogRunSource(new ProducerRunStore"), main.indexOf("watchdogRunSource(new ProducerRunStore") + 200);
    expect(call).not.toContain("incidentProducerConfig.intervalMs");
    expect(main.match(/watchdogRunSource\(/g)).toHaveLength(1);
  });
});

describe("watchdogIntervalMsFromEnv: samme variabel og samme område som worker (paritet med parseWatchdogIntervalMs)", () => {
  it("usatt og tom streng (compose sender tom streng for en usatt variabel) = standard 60 s", () => {
    expect(status.watchdogIntervalMsFromEnv({})).toBe(60_000);
    expect(status.watchdogIntervalMsFromEnv({ JARVIS_WATCHDOG_INTERVAL_MS: "" })).toBe(60_000);
    expect(status.watchdogIntervalMsFromEnv({ JARVIS_WATCHDOG_INTERVAL_MS: "   " })).toBe(60_000);
  });

  it("gyldige verdier uendret; ugyldige gir NaN (aldri et kast, aldri en gjettet verdi)", () => {
    for (const ok of ["1000", "30000", "60000", "3600000"]) expect(status.watchdogIntervalMsFromEnv({ JARVIS_WATCHDOG_INTERVAL_MS: ok }), ok).toBe(Number(ok));
    for (const bad of ["999", "3600001", "0", "-1000", "abc", "NaN", "Infinity", "1.5", "1e3x", "60 000"]) {
      expect(Number.isNaN(status.watchdogIntervalMsFromEnv({ JARVIS_WATCHDOG_INTERVAL_MS: bad })), bad).toBe(true);
    }
  });

  it("paritet: for hver verdi gir API-leseren det samme som `parseWatchdogIntervalMs` (unntatt tom streng, som worker avviser og API tolker som standard)", () => {
    for (const v of [undefined, "1000", "999", "60000", "3600000", "3600001", "0", "-5", "abc", "NaN", "Infinity", "1.5", "30000", "250000"]) {
      let expected: number;
      try { expected = parseWatchdogIntervalMs(v); } catch { expected = Number.NaN; }
      const actual = status.watchdogIntervalMsFromEnv(v === undefined ? {} : { JARVIS_WATCHDOG_INTERVAL_MS: v });
      if (Number.isNaN(expected)) expect(Number.isNaN(actual), String(v)).toBe(true);
      else expect(actual, String(v)).toBe(expected);
    }
  });

  it("ugyldig intervall gjør leseren UKJENT med årsaken (aldri en gjettet grense)", () => {
    const o = status.observeWatchdogRun(row(), NOW, status.watchdogIntervalMsFromEnv({ JARVIS_WATCHDOG_INTERVAL_MS: "abc" }));
    expect(o.status).toBe("UNKNOWN");
    expect(o.detail).toContain("intervall");
  });
});

describe("B-L2: klokken tas ETTER lesingen, og en liten negativ alder (rad skrevet under lesingen) er ikke klokkeavvik", () => {
  const baseDeps = (over: Partial<SelfModelReaderDeps> = {}): SelfModelReaderDeps => ({
    pool: { query: async () => ({ rows: [] }) } as never, tenantId: "t", now: () => NOW, meshStatus: () => ({ providers: [] }),
    controlState: async () => ({ kill_switch: { active: false }, frozen_connectors: [], revoked_credentials: [] }), connectorStatus: async () => [], ...over
  });

  it("rekkefølgen: `read()` kalles før `now()` (en rad skrevet 4 s inn i en 5 s lang lesing er OK, ikke «frem i tid»)", async () => {
    let clock = NOW.getTime();
    const order: string[] = [];
    const source = {
      intervalMs: 60_000,
      read: async (): Promise<WatchdogRunRow> => {
        order.push("read");
        const written = new Date(clock + 4_000).toISOString(); // workeren skriver raden 4 s etter at lesingen startet
        clock += 5_000; // lesingen tok 5 s
        return row({ last_started_at: written });
      }
    };
    const readers = buildSelfModelReaders(baseDeps({ now: () => { order.push("now"); return new Date(clock); }, watchdogRuns: source }));
    const o = (await readers.watchdog!()) as Observation;
    expect(order).toEqual(["read", "now"]);
    expect(o.status, o.detail).toBe("OK");
    expect(o.data).toMatchObject({ age_s: 1 });
  });

  it("readWatchdogObservation tar klokken som en funksjon og kaller den nøyaktig én gang, etter lesingen", async () => {
    const calls: string[] = [];
    const o = await status.readWatchdogObservation({ intervalMs: 60_000, read: async () => { calls.push("read"); return row(); } }, () => { calls.push("now"); return NOW; });
    expect(calls).toEqual(["read", "now"]);
    expect(o.status).toBe("OK");
    const off = await status.readWatchdogObservation(undefined, () => { throw new Error("klokken skal ikke leses uten kilde"); });
    expect(off.status).toBe("UNKNOWN");
    const failed = await status.readWatchdogObservation({ intervalMs: 60_000, read: async () => { throw new Error("nede"); } }, () => { throw new Error("klokken skal ikke leses ved lesefeil"); });
    expect(failed.detail).toBe(status.WATCHDOG_UNREADABLE_DETAIL);
  });

  it("toleransen er 2 s: 0 til 2000 ms frem regnes som alder 0 (OK), 2001 ms frem er klokkeavvik (UKJENT)", () => {
    expect(status.WATCHDOG_CLOCK_TOLERANCE_MS).toBe(2_000);
    for (const aheadMs of [1, 500, 1999, 2000]) {
      const o = status.observeWatchdogRun(row({ last_started_at: new Date(NOW.getTime() + aheadMs).toISOString() }), NOW, 60_000);
      expect(o.status, `${aheadMs} ms frem`).toBe("OK");
      expect(o.data).toMatchObject({ age_s: 0 });
      expect(o.detail).toContain("tikket for 0 s siden");
    }
    for (const aheadMs of [2001, 5000, 60_000, 3_600_000]) {
      const o = status.observeWatchdogRun(row({ last_started_at: new Date(NOW.getTime() + aheadMs).toISOString() }), NOW, 60_000);
      expect(o.status, `${aheadMs} ms frem`).toBe("UNKNOWN");
      expect(o.detail).toContain("klokkeavvik");
      expect(o.observed_at).toBeNull();
    }
  });
});

describe("B-L3: den rene funksjonen kaster aldri og gir UKJENT for ugyldige innganger (ingen TypeError-tekst i selvdiagnosen)", () => {
  it("manglende rad (null, undefined) er UKJENT", () => {
    for (const missing of [null, undefined]) {
      const o = status.observeWatchdogRun(missing as never, NOW, 60_000);
      expect(o.status).toBe("UNKNOWN");
      expect(o.detail).toContain("Ingen vakthund-tikk er registrert");
    }
  });

  it("ugyldig klokke (Invalid Date, ikke en Date) er UKJENT - aldri OK med «NaN d»", () => {
    for (const badNow of [new Date(Number.NaN), new Date("ikke en dato"), "2026-11-27T10:00:00Z", null, undefined, 1_700_000_000_000]) {
      const o = status.observeWatchdogRun(row(), badNow as never, 60_000);
      expect(o.status, String(badNow)).toBe("UNKNOWN");
      expect(JSON.stringify(o)).not.toContain("NaN");
    }
  });

  it("tidspunkt som er null/undefined/tomt er UKJENT (null gir ellers 1970 og dermed en falsk DOWN)", () => {
    for (const bad of [null, undefined, "", "   ", "ikke-en-dato"]) {
      const o = status.observeWatchdogRun(row({ last_started_at: bad as never }), NOW, 60_000);
      expect(o.status, String(bad)).toBe("UNKNOWN");
      expect(o.detail).toContain("ugyldig tidspunkt");
    }
  });

  it("selve leseren: en kilde som gir `undefined` kaster ikke og lekker ingen feiltekst", async () => {
    const readers = buildSelfModelReaders({
      pool: { query: async () => ({ rows: [] }) } as never, tenantId: "t", now: () => NOW, meshStatus: () => ({ providers: [] }),
      controlState: async () => ({ kill_switch: { active: false }, frozen_connectors: [], revoked_credentials: [] }), connectorStatus: async () => [],
      watchdogRuns: { intervalMs: 60_000, read: async () => undefined as never }
    });
    const o = (await readers.watchdog!()) as Observation;
    expect(o.status).toBe("UNKNOWN");
    expect(JSON.stringify(o)).not.toMatch(/TypeError|Cannot read|undefined/);
  });
});

describe("fmtAge (tekst i detaljen): sekunder under 2 min, minutter under 2 t, timer under 2 døgn, ellers døgn", () => {
  const okDetail = (ageMs: number): string => status.observeWatchdogRun(row({ last_started_at: agoMs(ageMs) }), NOW, 3_600_000).detail;

  it("under 2 min vises sekunder (aldri minutter): 0 s, 45 s, 119 s; fra 120 s vises minutter", () => {
    expect(okDetail(0)).toContain("tikket for 0 s siden");
    expect(okDetail(45_000)).toContain("tikket for 45 s siden");
    expect(okDetail(119_000)).toContain("tikket for 119 s siden");
    expect(okDetail(119_999)).toContain("tikket for 119 s siden");
    expect(okDetail(120_000)).toContain("tikket for 2 min siden");
    expect(okDetail(mmss(59, 0))).toContain("tikket for 59 min siden");
  });

  it("minutter til og med 119 min; fra 2 t vises timer med komma; fra 48 t vises døgn", () => {
    expect(okDetail(mmss(119, 59))).toContain("tikket for 119 min siden");
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(mmss(120, 0)) }), NOW, 3_600_000).detail).toContain("tikket for 2,0 t siden");
    expect(status.observeWatchdogRun(row({ last_started_at: agoMs(mmss(150, 0)) }), NOW, 3_600_000).detail).toContain("tikket for 2,5 t siden");
    const down = status.observeWatchdogRun(row({ last_started_at: agoMs(72 * 3_600_000) }), NOW, 60_000);
    expect(down.status).toBe("DOWN");
    expect(down.detail).toContain("har ikke tikket på 3,0 d (grensen er 3 min)");
  });
});
