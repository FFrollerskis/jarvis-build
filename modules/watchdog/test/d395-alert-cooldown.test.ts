import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { MemoryAlertSink, Watchdog, costWarningCheck, type HealthCheck } from "../src/watchdog.ts";

/**
 * D-395 (JARVIS-039): et vedvarende avvik (f.eks. over hardgrensen med kill switch aktiv) varslet HVERT tick (hvert minutt) i det uendelige, og
 * varselgrensen (1 000 kr) ble aldri varslet. Nå: identisk gjentakelse varsles først etter nedkjøling; endret melding eller et mellomliggende «ok» varsler straks.
 */
const killSwitch = {} as never;
function failing(name: string, message: () => string, cooldownMs?: number): HealthCheck & { ok: boolean } {
  const check = {
    name, runbook: "r", ok: false,
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    async run() { return check.ok ? { ok: true, severity: "info" as const, message: "" } : { ok: false, severity: "critical" as const, message: message() }; }
  };
  return check;
}

describe("Watchdog: varsel-nedkjøling", () => {
  it("identisk avvik varsles ÉN gang innenfor nedkjølingen, ikke hvert tick", async () => {
    let now = 0;
    const sink = new MemoryAlertSink();
    const wd = new Watchdog(sink, killSwitch, 5000, 60_000, () => now);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    wd.register(failing("cost_explosion", () => "over hardgrense (kill switch allerede aktiv)"));
    await wd.tick();
    now = 10_000; await wd.tick();
    now = 59_000; await wd.tick();
    expect(sink.alerts).toHaveLength(1);
    now = 61_000; await wd.tick();
    expect(sink.alerts).toHaveLength(2); // nedkjølingen er over
  });

  it("endret melding varsler straks, og et mellomliggende ok nullstiller nedkjølingen", async () => {
    let now = 0;
    let msg = "A";
    const sink = new MemoryAlertSink();
    const wd = new Watchdog(sink, killSwitch, 5000, 600_000, () => now);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const check = failing("c", () => msg);
    wd.register(check);
    await wd.tick();
    msg = "B"; now = 1000; await wd.tick();
    expect(sink.alerts.map((a) => a.message)).toEqual(["A", "B"]);
    check.ok = true; now = 2000; await wd.tick();
    check.ok = false; msg = "B"; now = 3000; await wd.tick();
    expect(sink.alerts.map((a) => a.message)).toEqual(["A", "B", "B"]); // ok i mellom = nytt avvik
  });

  it("per-sjekk cooldownMs overstyrer standarden", async () => {
    let now = 0;
    const sink = new MemoryAlertSink();
    const wd = new Watchdog(sink, killSwitch, 5000, 1_000, () => now);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    wd.register(failing("daily", () => "x", 86_400_000));
    await wd.tick();
    now = 3_600_000; await wd.tick();
    expect(sink.alerts).toHaveLength(1);
  });

  it("en mislykket levering regnes ikke som sendt: neste tick prøver igjen", async () => {
    let now = 0;
    let fail = true;
    const delivered: string[] = [];
    const sink = { send: async (a: { message: string }) => { if (fail) throw new Error("telegram nede"); delivered.push(a.message); } };
    const wd = new Watchdog(sink, killSwitch, 5000, 600_000, () => now);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    wd.register(failing("c", () => "avvik"));
    await wd.tick();
    fail = false; now = 1000; await wd.tick();
    expect(delivered).toEqual(["avvik"]);
  });
});

describe("costWarningCheck", () => {
  const poolWith = (spent: number): pg.Pool => {
    const client = { query: async (sql: string) => (/sum\(amount_ore\)/.test(sql) ? { rows: [{ spent }] } : { rows: [] }), release: () => undefined };
    return { connect: async () => client } as unknown as pg.Pool;
  };
  it("ok under varselgrensen; varsler (warning) med konstant melding og døgn-nedkjøling over", async () => {
    const below = await costWarningCheck(poolWith(99_999), "t", 100_000).run();
    expect(below.ok).toBe(true);
    const check = costWarningCheck(poolWith(150_000), "t", 100_000);
    const over = await check.run();
    expect(over).toMatchObject({ ok: false, severity: "warning" });
    expect(over.message).toContain("1000 kr");
    expect((await check.run()).message).toBe(over.message); // konstant => nedkjølingen virker
    expect(check.cooldownMs).toBe(86_400_000);
  });
});
