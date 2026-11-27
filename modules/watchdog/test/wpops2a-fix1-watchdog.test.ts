import { afterEach, describe, expect, it, vi } from "vitest";
import { KillSwitch } from "@jarvis/policy";
import { MemoryAlertSink, Watchdog, type Alert, type AlertSink, type HealthCheck } from "../src/index.ts";

/**
 * WP-OPS2a fiks-runde 1 (review A-L2 og A-L8: W03/W08): den EKSTERNE dead man's switch-en hviler på at «siste FULLFØRTE tikk» aldri flyttes av et tikk som henger. To hull ble funnet av mutanter:
 * tidspunktet kunne settes FØR en hengt varslingssink (W03) eller FØR en hengt restart-hook (W08) uten at noen test merket det (byggerens tester hang kun en SJEKK). Og alderen regnet av veggklokken (`Date.now`), som kan hoppe:
 * `lastCompletedTickAgeMs()` måler med en monoton klokke (`performance.now()`), så et klokkehopp aldri kan gjøre en hengt vakthund ferskere eller en frisk eldre.
 */
const failing: HealthCheck = { name: "bad_check", runbook: "r", async run() { return { ok: false, severity: "critical", message: "feil" }; } };
const healthy: HealthCheck = { name: "ok_check", runbook: "r", async run() { return { ok: true, severity: "info", message: "" }; } };
const never = (): Promise<never> => new Promise<never>(() => undefined);
const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));
afterEach(() => vi.restoreAllMocks());

describe("W03: en hengt varslingssink flytter ikke «siste fullførte tikk» (stillhet = alarm)", () => {
  it("første tikk: sinken henger -> tikket blir aldri fullført: lastCompletedTickAt og lastCompletedTickAgeMs er fortsatt null", async () => {
    const clock = { t: 1_000 };
    const mono = { t: 50 };
    const hangingSink: AlertSink = { send: () => never() };
    const wd = new Watchdog(hangingSink, new KillSwitch(), 20_000, 0, () => clock.t, () => mono.t);
    wd.register(failing);
    void wd.tick();
    await settle();
    expect(wd.isTicking()).toBe(true);
    expect(wd.lastCompletedTickAt()).toBeNull();
    expect(wd.lastCompletedTickAgeMs()).toBeNull();
  });

  it("senere tikk: sinken begynner å henge -> tidspunktet står på siste FULLFØRTE tikk (ikke på det som henger), og alderen vokser med den monotone klokken", async () => {
    const clock = { t: 1_000 };
    const mono = { t: 500 };
    let hang = false;
    const sink: AlertSink = { send: (_a: Alert) => (hang ? never() : Promise.resolve()) };
    const wd = new Watchdog(sink, new KillSwitch(), 20_000, 0, () => clock.t, () => mono.t);
    wd.register(failing);
    await wd.tick();
    expect(wd.lastCompletedTickAt()).toBe(1_000);
    expect(wd.lastCompletedTickAgeMs()).toBe(0);
    hang = true;
    clock.t = 61_000;
    mono.t = 60_500;
    void wd.tick();
    await settle();
    expect(wd.isTicking()).toBe(true);
    expect(wd.lastCompletedTickAt()).toBe(1_000);
    mono.t = 180_500;
    expect(wd.lastCompletedTickAgeMs()).toBe(180_000);
  });
});

describe("W08: en hengt restart-hook flytter ikke «siste fullførte tikk»", () => {
  it("første tikk: hooken henger -> aldri fullført (null); senere tikk: tidspunktet blir stående på det forrige", async () => {
    const clock = { t: 2_000 };
    const mono = { t: 10 };
    let hang = true;
    const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch(), 20_000, 0, () => clock.t, () => mono.t);
    wd.register(failing);
    wd.registerAction("bad_check", () => (hang ? never() : Promise.resolve()), 5);
    void wd.tick();
    await settle();
    expect(wd.isTicking()).toBe(true);
    expect(wd.lastCompletedTickAt()).toBeNull();
    expect(wd.lastCompletedTickAgeMs()).toBeNull();

    // Ny vakthund: ett fullført tikk (hooken svarer), deretter henger hooken.
    hang = false;
    const wd2 = new Watchdog(new MemoryAlertSink(), new KillSwitch(), 20_000, 0, () => clock.t, () => mono.t);
    wd2.register(failing);
    wd2.registerAction("bad_check", () => (hang ? never() : Promise.resolve()), 5);
    await wd2.tick();
    expect(wd2.lastCompletedTickAt()).toBe(2_000);
    hang = true;
    clock.t = 62_000;
    mono.t = 60_010;
    void wd2.tick();
    await settle();
    expect(wd2.isTicking()).toBe(true);
    expect(wd2.lastCompletedTickAt()).toBe(2_000);
    expect(wd2.lastCompletedTickAgeMs()).toBe(60_010 - 10);
  });
});

describe("A-L2: lastCompletedTickAgeMs måles med en monoton klokke, ikke veggklokken", () => {
  it("null før første fullførte tikk; deretter monoton differanse (uavhengig av veggklokken); settes samtidig med lastCompletedTickAt", async () => {
    const wall = { t: 1_800_000_000_000 };
    const mono = { t: 1_000 };
    const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch(), 20_000, 0, () => wall.t, () => mono.t);
    wd.register(healthy);
    expect(wd.lastCompletedTickAgeMs()).toBeNull();
    await wd.tick();
    expect(wd.lastCompletedTickAt()).toBe(1_800_000_000_000);
    expect(wd.lastCompletedTickAgeMs()).toBe(0);
    mono.t += 90_000;
    expect(wd.lastCompletedTickAgeMs()).toBe(90_000);
    wall.t -= 600_000; // veggklokken hopper 10 min BAKOVER
    expect(wd.lastCompletedTickAgeMs()).toBe(90_000);
    wall.t += 7_200_000; // og 2 t FREM
    expect(wd.lastCompletedTickAgeMs()).toBe(90_000);
    await wd.tick(); // nytt tikk: alderen nullstilles mot den monotone klokken
    expect(wd.lastCompletedTickAgeMs()).toBe(0);
  });

  it("et hoppet overlappende tikk flytter ikke alderen, og et tikk som henger heller ikke (kun FULLFØRTE tikk)", async () => {
    const mono = { t: 100 };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let slow = false;
    const check: HealthCheck = { name: "maybe_slow", runbook: "r", async run() { if (slow) await gate; return { ok: true, severity: "info", message: "" }; } };
    const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch(), 3_600_000, 0, () => 5_000, () => mono.t);
    wd.register(check);
    await wd.tick();
    slow = true;
    mono.t = 60_100;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const running = wd.tick();
    await settle();
    mono.t = 90_100;
    await wd.tick(); // hoppes over (overlapp)
    expect(wd.lastCompletedTickAgeMs()).toBe(90_000); // fortsatt alderen siden FØRSTE tikk
    expect(warn).toHaveBeenCalled();
    release();
    await running;
    expect(wd.lastCompletedTickAgeMs()).toBe(0);
  });

  it("standardklokkene: veggklokken kan hoppe ±10 min uten at alderen (performance.now) endres; verdien er liten, ikke negativ og vokser med reell tid", async () => {
    const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch());
    wd.register(healthy);
    await wd.tick();
    const real = Date.now();
    const age0 = wd.lastCompletedTickAgeMs();
    expect(age0).not.toBeNull();
    expect(age0!).toBeGreaterThanOrEqual(0);
    expect(age0!).toBeLessThan(2_000);
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(real - 600_000);
    const afterBack = wd.lastCompletedTickAgeMs()!;
    spy.mockReturnValue(real + 600_000);
    const afterForward = wd.lastCompletedTickAgeMs()!;
    expect(afterBack).toBeGreaterThanOrEqual(age0!);
    expect(afterBack).toBeLessThan(2_000);
    expect(afterForward).toBeLessThan(2_000);
    await settle(30);
    expect(wd.lastCompletedTickAgeMs()!).toBeGreaterThanOrEqual(afterForward + 20);
  });

  it("lastCompletedTickAt er uendret (veggklokke, ms) - fortsatt tilgjengelig for den som trenger et tidspunkt", async () => {
    const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch(), 20_000, 0, () => 123_456, () => 1);
    wd.register(healthy);
    expect(wd.lastCompletedTickAt()).toBeNull();
    await wd.tick();
    expect(wd.lastCompletedTickAt()).toBe(123_456);
  });
});
