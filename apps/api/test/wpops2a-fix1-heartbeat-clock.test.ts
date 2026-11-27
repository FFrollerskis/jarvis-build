import { afterEach, describe, expect, it, vi } from "vitest";
import { KillSwitch } from "@jarvis/policy";
import { MemoryAlertSink, Watchdog, type HealthCheck } from "@jarvis/watchdog";
import { WATCHDOG_HEARTBEAT_URL_ENV, startWatchdogHeartbeat, watchdogHeartbeatSelfCheck, watchdogTickMaxAgeMs } from "../src/watchdog-heartbeat.ts";

/**
 * WP-OPS2a fiks-runde 1 (review A-L2): alderen på siste fullførte vakthund-tikk regnes med en MONOTON klokke (`Watchdog.lastCompletedTickAgeMs`, performance.now), ikke veggklokken. Reviewerens repro: et hopp BAKOVER i `Date.now` under en
 * hengt vakthund ga ca. 9 min stillhet og deretter ca. 3 min FALSKE pings; et hopp FREM ga stillhet til neste tikk. Med en monoton alder gjør et klokkehopp aldri en hengt vakthund fersk og aldri en frisk vakthund gammel.
 */
const KEY = "not-real-not-real-not-real"; // lavt entropi-plassholder (ikke en ekte nøkkel)
const ENV_OK = { [WATCHDOG_HEARTBEAT_URL_ENV]: `https://hc-ping.example/${KEY}` };
const WALL0 = 1_800_000_000_000;
const stopAll: Array<() => void> = [];
afterEach(() => { for (const stop of stopAll.splice(0)) stop(); vi.restoreAllMocks(); });
const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ekte Watchdog med injisert veggklokke og monoton klokke + ekte heartbeat med samme monotone klokke for selvsjekkens egen tidtaking. */
function rig(watchdogIntervalMs = 60_000) {
  const wall = { t: WALL0 };
  const mono = { t: 5_000_000 };
  const state = { hang: false };
  const check: HealthCheck = { name: "maybe", runbook: "r", run: () => (state.hang ? new Promise(() => undefined) : Promise.resolve({ ok: true, severity: "info" as const, message: "" })) };
  const wd = new Watchdog(new MemoryAlertSink(), new KillSwitch(), 3_600_000, 0, () => wall.t, () => mono.t);
  wd.register(check);
  const sent: string[] = [];
  const hb = startWatchdogHeartbeat({
    env: ENV_OK, watchdog: wd, watchdogIntervalMs, dbPing: async () => undefined, log: () => undefined, now: () => mono.t,
    send: async (u) => { sent.push(u); return { ok: true, status: 200, reason: null }; }
  });
  stopAll.push(() => hb?.stop());
  /** La `ms` reell tid gå: begge klokker flytter seg like mye (veggklokken kan i tillegg hoppe separat). */
  const advance = (ms: number): void => { mono.t += ms; wall.t += ms; };
  return { wall, mono, state, wd, hb: hb!, sent, advance };
}

describe("hopp BAKOVER i veggklokken under en hengt vakthund: aldri falske pings", () => {
  it("vakthunden henger; veggklokken hopper 10 min bakover; stillheten begynner ved terskelen (3 min) og forblir - også når veggklokken «igjen» viser et ferskt tikk", async () => {
    const { wall, state, wd, hb, sent, advance } = rig();
    await wd.tick();
    expect(await hb.tick()).toBe("sent");
    state.hang = true;
    advance(60_000);
    void wd.tick(); // henger for alltid
    await settle();
    advance(60_000); // 2 min siden siste FULLFØRTE tikk: fortsatt innenfor
    expect(await hb.tick()).toBe("sent");
    wall.t -= 600_000; // NTP-steg / manuell endring: 10 min bakover
    expect(await hb.tick()).toBe("sent"); // 2 min monotont: fortsatt ferskt (veggklokke-regning ville gitt negativ alder = stillhet her)
    advance(60_000); // 3 min monotont: grensen
    expect(await hb.tick()).toBe("silent");
    // Reviewerens repro: etter ca. 10 min viser veggklokken «0 til 3 min siden siste tikk» igjen (falsk friskhet). Monotont er alderen > 10 min.
    let falsePings = 0;
    for (let i = 0; i < 25; i += 1) {
      advance(60_000);
      if ((await hb.tick()) === "sent") falsePings += 1;
    }
    expect(falsePings).toBe(0);
    expect(sent).toHaveLength(3); // kun pingene FØR terskelen (alder 0, 2 min, og 2 min etter hoppet)
  });
});

describe("hopp FREM i veggklokken: ingen falsk stillhet", () => {
  it("en frisk vakthund (tikker som normalt) får ikke stillhet av at veggklokken hopper 1 time frem (tidligere: alder 1 t = stillhet til neste tikk)", async () => {
    const { wall, wd, hb, sent, advance } = rig();
    await wd.tick();
    advance(30_000);
    wall.t += 3_600_000;
    expect(await hb.tick()).toBe("sent");
    wall.t += 86_400_000; // og 1 døgn til
    expect(await hb.tick()).toBe("sent");
    await wd.tick();
    advance(60_000);
    expect(await hb.tick()).toBe("sent");
    expect(sent).toHaveLength(3);
  });

  it("en hengt vakthund blir ikke fersk av noe hopp: et hopp frem gir fortsatt stillhet ved terskelen, og den monotone alderen avgjør", async () => {
    const { wall, state, wd, hb, advance } = rig();
    await wd.tick();
    state.hang = true;
    advance(60_000);
    void wd.tick();
    await settle();
    advance(150_000); // 3 min og 30 s siden siste fullførte
    wall.t += 3_600_000;
    expect(await hb.tick()).toBe("silent");
  });
});

describe("selvsjekken regner alder av lastCompletedTickAgeMs (strengt «yngre enn», ukjent/negativ/ugyldig = stillhet)", () => {
  const MAX = watchdogTickMaxAgeMs(60_000);
  const check = (age: () => number | null) => watchdogHeartbeatSelfCheck({ watchdog: { lastCompletedTickAgeMs: age }, intervalMs: 60_000, dbPing: async () => undefined });

  it("grenser: 0 og terskel-1 ms er fersk; terskelen og over er stille; null (aldri tikket), negativ, NaN og Infinity er stille; en leser som kaster er stille", async () => {
    expect(MAX).toBe(180_000);
    expect(await check(() => 0)()).toBe(true);
    expect(await check(() => MAX - 1)()).toBe(true);
    expect(await check(() => MAX)()).toBe(false);
    expect(await check(() => MAX + 1)()).toBe(false);
    for (const bad of [null, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(await check(() => bad)(), String(bad)).toBe(false);
    expect(await check(() => { throw new Error("boom"); })()).toBe(false);
  });

  it("selvsjekken bruker IKKE veggklokken: Date.now hopper ±10 min uten at utfallet endres (en injisert alder styrer alene)", async () => {
    const fresh = check(() => 1_000);
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(WALL0 - 600_000);
    expect(await fresh()).toBe(true);
    spy.mockReturnValue(WALL0 + 600_000);
    expect(await fresh()).toBe(true);
    const stale = check(() => MAX + 5_000);
    spy.mockReturnValue(WALL0 - 600_000);
    expect(await stale()).toBe(false);
    spy.mockReturnValue(WALL0 + 3_600_000);
    expect(await stale()).toBe(false);
  });
});

describe("tapt SELECT 1 regnes også med monoton tid (veggklokkehopp forsinker ikke gjenopptakelsen)", () => {
  it("en hengt spørring regnes som tapt etter 10 x fristen i reell tid, selv om veggklokken har hoppet 10 min bakover", async () => {
    let mode: "hang" | "ok" = "hang";
    let calls = 0;
    const check = watchdogHeartbeatSelfCheck({
      watchdog: { lastCompletedTickAgeMs: () => 0 }, intervalMs: 60_000, dbTimeoutMs: 20,
      dbPing: () => { calls += 1; return mode === "hang" ? new Promise<void>(() => undefined) : Promise.resolve(); }
    });
    expect(await check()).toBe(false); // fristen (20 ms) går ut
    expect(calls).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 600_000); // veggklokken hopper 10 min bakover (fra den ekte, så en veggklokke-regning ville sett «negativ tid»)
    expect(await check()).toBe(false); // forrige SELECT 1 henger fortsatt: ingen ny spørring legges oppå
    expect(calls).toBe(1);
    await settle(260); // 10 x 20 ms = 200 ms reell tid
    mode = "ok";
    expect(await check()).toBe(true);
    expect(calls).toBe(2);
  });
});
