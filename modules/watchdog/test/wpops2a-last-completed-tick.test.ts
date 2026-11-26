import { describe, expect, it, vi } from "vitest";
import { KillSwitch } from "@jarvis/policy";
import { MemoryAlertSink, Watchdog, type HealthCheck } from "../src/index.ts";

/**
 * WP-OPS2a K3: `Watchdog.lastCompletedTickAt()` er det EKSTERNE dead man's switch-pinget hviler på: tidspunktet (ms, fra vakthundens egen klokke) da siste tikk FULLFØRTE. Et hoppet overlappende tikk setter det ikke, og et tikk som
 * aldri blir ferdig (en hengt varslingssink, en sjekk uten tidsavbrudd) flytter det ikke - da blir det gammelt, og pinget uteblir (stillhet = alarm).
 */
const healthy: HealthCheck = { name: "ok_check", runbook: "r", async run() { return { ok: true, severity: "info", message: "" }; } };
const failing: HealthCheck = { name: "bad_check", runbook: "r", async run() { return { ok: false, severity: "warning", message: "feil" }; } };

function makeWatchdog(check: HealthCheck, clock: { t: number }, checkTimeoutMs = 20_000) {
  const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch(), checkTimeoutMs, 0, () => clock.t);
  wd.register(check);
  return wd;
}

describe("lastCompletedTickAt", () => {
  it("er null før første tikk, og satt til klokken når et tikk er FULLFØRT", async () => {
    const clock = { t: 1_000 };
    const wd = makeWatchdog(healthy, clock);
    expect(wd.lastCompletedTickAt()).toBeNull();
    clock.t = 5_000;
    await wd.tick();
    expect(wd.lastCompletedTickAt()).toBe(5_000);
    clock.t = 65_000;
    await wd.tick();
    expect(wd.lastCompletedTickAt()).toBe(65_000);
  });

  it("et tikk med feilende sjekker er likevel FULLFØRT (vakthunden lever og har målt); det samme gjelder en sjekk som tidsavbryter", async () => {
    const clock = { t: 10_000 };
    const bad = makeWatchdog(failing, clock);
    await bad.tick();
    expect(bad.lastCompletedTickAt()).toBe(10_000);
    const hangs: HealthCheck = { name: "hangs", runbook: "r", run: () => new Promise(() => undefined) };
    const slow = makeWatchdog(hangs, clock, 30); // sjekk-fristen slår inn etter 30 ms
    clock.t = 77_000;
    await slow.tick();
    expect(slow.lastCompletedTickAt()).toBe(77_000);
  });

  it("et hoppet overlappende tikk setter det IKKE (og flytter det ikke)", async () => {
    const clock = { t: 1_000 };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowCheck: HealthCheck = { name: "slow", runbook: "r", async run() { await gate; return { ok: true, severity: "info", message: "" }; } };
    const wd = makeWatchdog(slowCheck, clock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const first = wd.tick(); // pågår
      clock.t = 9_000;
      await wd.tick(); // hoppes over (overlapp)
      expect(wd.lastCompletedTickAt()).toBeNull();
      clock.t = 12_000;
      release();
      await first;
      expect(wd.lastCompletedTickAt()).toBe(12_000); // satt av det FULLFØRTE tikket, ikke av det hoppede
    } finally {
      warn.mockRestore();
    }
  });

  it("et tikk som aldri blir ferdig (hengt sjekk uten praktisk frist) flytter ikke tidspunktet - det blir stående på siste FULLFØRTE tikk", async () => {
    const clock = { t: 1_000 };
    let hang = false;
    const maybeHangs: HealthCheck = { name: "maybe", runbook: "r", run: () => (hang ? new Promise(() => undefined) : Promise.resolve({ ok: true, severity: "info" as const, message: "" })) };
    const wd = makeWatchdog(maybeHangs, clock, 3_600_000); // fristen er så lang at sjekken «aldri» avbrytes i testen
    await wd.tick();
    expect(wd.lastCompletedTickAt()).toBe(1_000);
    hang = true;
    clock.t = 600_000;
    void wd.tick(); // starter og blir hengende
    await new Promise((r) => setTimeout(r, 20));
    expect(wd.isTicking()).toBe(true);
    expect(wd.lastCompletedTickAt()).toBe(1_000);
  });

  it("standardklokken er Date.now (ms) - verdien kan sammenlignes direkte med Date.now()", async () => {
    const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch());
    wd.register(healthy);
    const before = Date.now();
    await wd.tick();
    const at = wd.lastCompletedTickAt();
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(before);
    expect(at!).toBeLessThanOrEqual(Date.now());
  });

  it("påvirker ikke oppførselen: varsler, nedkjøling og returverdi er som før", async () => {
    const clock = { t: 0 };
    const sink = new MemoryAlertSink();
    const wd = new Watchdog(sink, new KillSwitch(), 20_000, 30 * 60_000, () => clock.t);
    wd.register(failing);
    expect((await wd.tick()).map((a) => a.check)).toEqual(["bad_check"]);
    clock.t = 60_000;
    expect((await wd.tick()).map((a) => a.check)).toEqual(["bad_check"]); // fyrt, men varselet dempes av nedkjølingen
    expect(sink.alerts).toHaveLength(1);
  });
});
