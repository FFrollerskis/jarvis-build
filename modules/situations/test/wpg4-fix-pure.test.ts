import { describe, expect, it } from "vitest";
import { bridgeHealthObservation, detectDeviation, HEALTH_NEUTRAL_REASON, type DailyPoint } from "../src/health-bridge.ts";
import { bridgeHomeObservation, type HomeObservation } from "../src/home-bridge.ts";
import { deriveEventType, type SignalObservation } from "../src/signal-bridges.ts";
import { resolveRuleThreshold, type BridgeContext, type RuleDefinition } from "../src/signal-types.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, rene enhetsbevis (ingen database) for broene. Reviewer B (LOW-9, INFO-11) og de overlevende mutantene M09d/M24/M26.
 * Hver grense er målt på selve funksjonene (like under og like over), så en forskjøvet terskel eller en ny tolkning av «på rad» faller.
 */
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const DAY = 86_400_000;
const ctx = (): BridgeContext => ({ nowMs: NOW, threshold: (rule: RuleDefinition) => resolveRuleThreshold(rule, null) });
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const dayStr = (offsetFromToday: number): string => new Date(NOW - offsetFromToday * DAY).toISOString().slice(0, 10);

/** Døgnserie fra et oppslag `dagforskyvning -> verdi` (1 = i går). Dager uten oppføring er HULL (ingen data det døgnet). Hver dag har 6 prøver. */
function series(values: Readonly<Record<number, number>>): DailyPoint[] {
  return Object.entries(values)
    .map(([offset, value]) => ({ offset: Number(offset), value }))
    .sort((a, b) => b.offset - a.offset)
    .map(({ offset, value }) => ({ day: dayStr(offset), value, samples: 6 }));
}
/** 28 flate baselinedager (verdi 100: MAD 0, sigma = 3 % av medianen = 3) på forskyvningene `from..from+27`, pluss `extra`. */
function flat(from: number, extra: Readonly<Record<number, number>>, base = 100): DailyPoint[] {
  const values: Record<number, number> = {};
  for (let offset = from; offset < from + 28; offset += 1) values[offset] = base;
  return series({ ...values, ...extra });
}

describe("B-LOW-9: «3 dager på rad» er KALENDERdøgn, ikke de tre siste datadagene", () => {
  it("tre sammenhengende kalenderdøgn over baselinen gir avvik; episoden starter på første dag i løpet", () => {
    const d = detectDeviation(flat(4, { 3: 130, 2: 130, 1: 130 }), 2, NOW);
    expect(d).toMatchObject({ direction: "above", consecutive_days: 3, episode_start_day: dayStr(3) });
  });

  it("et HULL (en dag uten data) i de tre siste dagene gir INGEN signal: tre datadager spredt over en uke er ikke «3 dager på rad»", () => {
    // i går og i forgårs avviker, tredje dag mangler, fjerde dag avviker: tre DATADAGER, men bare to kalenderdøgn på rad
    expect(detectDeviation(flat(5, { 4: 130, 2: 130, 1: 130 }), 2, NOW)).toBeNull();
    // hullet like bak siste dag (i forgårs mangler): siste dag står alene, selv om dag 3 og 4 også avviker
    expect(detectDeviation(flat(5, { 4: 130, 3: 130, 1: 130 }), 2, NOW)).toBeNull();
    // uten hullet er det et avvik (kontroll: det er hullet, ikke dagene, som fjerner signalet)
    expect(detectDeviation(flat(5, { 4: 130, 3: 130, 2: 130, 1: 130 }), 2, NOW)).toMatchObject({ consecutive_days: 4 });
  });

  it("løpet avsluttes av et hull lenger bak: tre sammenhengende dager teller, dagene på den andre siden av hullet gjør det ikke", () => {
    // dag 1-3 avviker, dag 4 mangler, dag 5-6 avviker (tidligere episode): løpet er 3 og starter på dag 3
    const d = detectDeviation(flat(7, { 3: 130, 2: 130, 1: 130, 6: 130, 5: 130 }), 2, NOW);
    expect(d).toMatchObject({ consecutive_days: 3, episode_start_day: dayStr(3) });
  });

  it("hull i BASELINEN er greit så lenge det er minst 14 baselinedager (baselinen er en fordeling, ikke et løp)", () => {
    const values: Record<number, number> = { 3: 130, 2: 130, 1: 130 };
    for (let offset = 4; offset < 4 + 40; offset += 2) values[offset] = 100; // annenhver dag: 20 baselinedager over 40 døgn
    expect(detectDeviation(series(values), 2, NOW)).toMatchObject({ consecutive_days: 3 });
    const sparse: Record<number, number> = { 3: 130, 2: 130, 1: 130 };
    for (let offset = 4; offset < 4 + 26; offset += 2) sparse[offset] = 100; // 13 baselinedager: for få
    expect(detectDeviation(series(sparse), 2, NOW)).toBeNull();
  });
});

describe("B-LOW-9: en baseline uten utslag gir aldri et avvik", () => {
  it("baseline av bare nuller (enheten var ikke i bruk) og 10 skritt de siste dagene: INGEN signal (ikke «sterkt avvik»)", () => {
    expect(detectDeviation(flat(4, { 3: 10, 2: 10, 1: 10 }, 0), 2, NOW)).toBeNull();
    const out = bridgeHealthObservation({ source: "health", metric: "steps", series: flat(4, { 3: 10, 2: 10, 1: 10 }, 0) }, ctx());
    expect(out).toBeNull();
  });

  it("en liten, men ikke-null baseline fungerer fortsatt (relativ gulvverdi), og negativ baseline likeså", () => {
    expect(detectDeviation(flat(4, { 3: 3, 2: 3, 1: 3 }, 1), 2, NOW)?.direction).toBe("above");
    expect(detectDeviation(flat(4, { 3: -130, 2: -130, 1: -130 }, -100), 2, NOW)?.direction).toBe("below");
  });
});

describe("B-LOW-9 / Q-G4-6: helseteksten er NØYTRAL (navner aldri kategorien)", () => {
  it.each(["resting_heart_rate", "sleep_duration_minutes", "steps"] as const)("%s: reason er den faste nøytrale teksten, kategorien står kun i fakta og nøkkel", (metric) => {
    const r = bridgeHealthObservation({ source: "health", metric, series: flat(4, { 3: 130, 2: 130, 1: 130 }) }, ctx());
    expect(r).not.toBeNull();
    expect(r!.candidate.reason).toBe(HEALTH_NEUTRAL_REASON);
    expect(HEALTH_NEUTRAL_REASON).toBe("Avvik i helsedata fra din egen baseline - åpne Jarvis for detaljer. Dette er ikke medisinsk rådgivning.");
    expect(r!.candidate.reason).not.toMatch(/hvilepuls|puls|søvn|aktivitet|skritt|steps|sleep|heart/i);
    expect(r!.facts).toMatchObject({ metric });
    expect(r!.candidate.detection_key.startsWith(`health:${metric}:above:`)).toBe(true);
  });
});

describe("M09d: dagens ufullstendige døgn teller aldri med", () => {
  it("to fullførte avvikende døgn + et avvikende ufullstendig døgn i dag er IKKE tre på rad (kun fullførte døgn teller)", () => {
    const points = [...flat(4, { 3: 100, 2: 130, 1: 130 }), { day: dayStr(0), value: 130, samples: 2 }];
    expect(detectDeviation(points, 2, NOW)).toBeNull();
    // kontroll: med tre FULLFØRTE avvikende døgn er det et avvik, og dagens ufullstendige døgn endrer ingenting
    expect(detectDeviation([...flat(4, { 3: 130, 2: 130, 1: 130 }), { day: dayStr(0), value: 100, samples: 2 }], 2, NOW)).toMatchObject({ consecutive_days: 3, episode_start_day: dayStr(3) });
  });
});

describe("M26: alvorlighetsgrensene mild/moderat/sterk (z-gjennomsnitt 3 og 4) ligger der de skal", () => {
  /** Flat baseline 100 (sigma 3): verdien v gir z = (v - 100) / 3 for alle tre dagene. */
  const severity = (v: number): string | undefined => detectDeviation(flat(4, { 3: v, 2: v, 1: v }), 2, NOW)?.severity;

  it("rett under, PÅ og rett over hver grense (grensene er «>= 3» og «>= 4»)", () => {
    expect(severity(106.5)).toBe("mild"); // z 2,17
    expect(severity(108.99)).toBe("mild"); // z 2,997: rett under 3
    expect(severity(109)).toBe("moderate"); // z = 3 nøyaktig (9 / 3): på grensen er det moderat
    expect(severity(109.01)).toBe("moderate"); // z 3,003: rett over 3
    expect(severity(110.5)).toBe("moderate"); // z 3,5
    expect(severity(111.99)).toBe("moderate"); // z 3,997: rett under 4
    expect(severity(112)).toBe("strong"); // z = 4 nøyaktig (12 / 3): på grensen er det sterkt
    expect(severity(112.01)).toBe("strong"); // z 4,003: rett over 4
    expect(severity(130)).toBe("strong");
  });

  it("alvorlighet styrer prioriteten (sterk = high, ellers normal), aldri konfidens", () => {
    const at = (v: number) => bridgeHealthObservation({ source: "health", metric: "steps", series: flat(4, { 3: v, 2: v, 1: v }) }, ctx());
    expect(at(108.99)?.candidate.priority).toBe("normal");
    expect(at(111.99)?.candidate.priority).toBe("normal");
    expect(at(112.01)?.candidate.priority).toBe("high");
    expect(at(130)?.candidate.confidence).toBeUndefined();
  });
});

describe("M24: «lenge åpen» er nøyaktig 4 x terskelen (ikke 3 x)", () => {
  const door = (minutes: number, over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: minutesAgo(minutes), ...over });

  it("standardterskel 15: normal til og med 59 min, høy fra 60; tunet terskel 30: normal til 119, høy fra 120", () => {
    for (const minutes of [15, 30, 46, 59]) expect(bridgeHomeObservation(door(minutes), ctx())?.candidate.priority, `${minutes} min`).toBe("normal");
    expect(bridgeHomeObservation(door(60), ctx())?.candidate.priority).toBe("high");
    const tuned: BridgeContext = { nowMs: NOW, threshold: () => 30 };
    expect(bridgeHomeObservation(door(119), tuned)?.candidate.priority).toBe("normal");
    expect(bridgeHomeObservation(door(120), tuned)?.candidate.priority).toBe("high");
    // lukkbar port: først ved 4 x terskel foreslås handlingen (konfidens)
    expect(bridgeHomeObservation(door(59, { role: "garage_door", entity_id: "cover.garasje", state: "open" }), ctx())?.candidate.confidence).toBeUndefined();
    expect(bridgeHomeObservation(door(60, { role: "garage_door", entity_id: "cover.garasje", state: "open" }), ctx())?.candidate.confidence).toBe(0.9);
  });
});

describe("B-INFO-11: hendelsestypen slås opp KUN på egne nøkler (aldri Object.prototype)", () => {
  const homeObs = (role: string): SignalObservation => ({ source: "home_assistant", entity_id: "binary_sensor.a", role: role as never, state: "on", last_changed: minutesAgo(1) });
  const healthObs = (metric: string): SignalObservation => ({ source: "health", metric: metric as never, series: [] });

  it("prototype-medlemmer som rolle/metrikk gir null (ingen regel), ikke en funksjon eller en streng", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf", "__defineGetter__"]) {
      expect(deriveEventType(homeObs(key)), `rolle ${key}`).toBeNull();
      expect(deriveEventType(healthObs(key)), `metrikk ${key}`).toBeNull();
    }
  });

  it("ekte roller og metrikker gir fortsatt riktig hendelsestype", () => {
    expect(deriveEventType(homeObs("door"))).toBe("door_open_too_long");
    expect(deriveEventType(homeObs("leak"))).toBe("water_leak");
    expect(deriveEventType(homeObs("alarm"))).toBe("alarm_triggered");
    expect(deriveEventType(homeObs("power"))).toBe("power_over_limit");
    expect(deriveEventType(healthObs("resting_heart_rate"))).toBe("resting_heart_rate_deviation");
    expect(deriveEventType(healthObs("sleep_duration_minutes"))).toBe("sleep_duration_deviation");
    expect(deriveEventType(healthObs("steps"))).toBe("activity_deviation");
  });
});
