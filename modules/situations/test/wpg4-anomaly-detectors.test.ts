import { describe, expect, it } from "vitest";
import {
  ANOMALY_MIN_BASELINE_DAYS, SPEND_SPIKE_DEFAULTS, detectSpendSpike, detectStaleJobs, mapSpendSpikeToCandidate, mapStaleJobToCandidate, type DailyAmount, type JobCadence
} from "../src/anomaly-detectors.ts";
import { computeTargetStage } from "../src/service.ts";
import { SituationCandidateInputSchema } from "../src/types.ts";

/**
 * WP-G4 (D-466) P2e: rene enhetsbevis for de to manglende anomali-detektorene (kostnadssprang, stilnet jobb). Ingen database, ingen klokke (`NOW` injiseres), ingen modell.
 * Begge gir kun INFORM-kandidater (aldri konfidens), har harde grenser på alle terskler og har ingen innhold utover forholdstall/jobbnavn i teksten.
 */
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const dayOf = (daysBack: number): string => new Date(NOW - daysBack * DAY).toISOString().slice(0, 10);
/** Siste element = i går (siste fullførte døgn). */
const series = (amounts: readonly number[]): DailyAmount[] => amounts.map((amount, i) => ({ day: dayOf(amounts.length - i), amount }));
/** 28 døgn rundt 10 000 øre (vanlig dag ~100 kr) med litt naturlig variasjon. */
const baseline = (n = 28): number[] => Array.from({ length: n }, (_, i) => 10_000 + ((i % 5) - 2) * 400);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

describe("A: detectSpendSpike - eierens egen baseline, kun oppover, ingen gjetning", () => {
  it("et klart sprang (6x vanlig dag) gir `strong` med forholdstall; 3,4x gir `moderate`", () => {
    const strong = detectSpendSpike(series([...baseline(), 60_000]), NOW);
    expect(strong).toMatchObject({ day: dayOf(1), severity: "strong", baseline_days: 28 });
    expect(strong!.ratio).toBeGreaterThanOrEqual(5.5);
    const moderate = detectSpendSpike(series([...baseline(), 34_000]), NOW);
    expect(moderate).toMatchObject({ day: dayOf(1), severity: "moderate" });
    expect(moderate!.ratio).toBeGreaterThan(3);
    expect(moderate!.ratio).toBeLessThan(4);
  });

  it("ingen avvik: vanlig dag, lite sprang (1,5x), lavt beløp (liten absolutt økning), eller billigere dag gir `null`", () => {
    expect(detectSpendSpike(series([...baseline(), 10_300]), NOW)).toBeNull();
    expect(detectSpendSpike(series([...baseline(), 15_000]), NOW)).toBeNull(); // 1,5x < 2x
    expect(detectSpendSpike(series([...baseline(), 1_000]), NOW)).toBeNull(); // nedover er aldri en situasjon
    const tiny = Array.from({ length: 28 }, () => 100); // ~1 kr/dag
    expect(detectSpendSpike(series([...tiny, 900]), NOW)).toBeNull(); // 9x, men kun 8 kr: under minste absolutte økning
  });

  it("ikke nok historikk, gammel serie, eller en vanlig dag på 0 gir ingen påstand", () => {
    expect(detectSpendSpike(series([...baseline(ANOMALY_MIN_BASELINE_DAYS - 2), 90_000]), NOW)).toBeNull(); // 13 døgn historikk
    expect(detectSpendSpike(series([...baseline(ANOMALY_MIN_BASELINE_DAYS), 90_000]), NOW)).not.toBeNull(); // nøyaktig nok
    // serien slutter for fem døgn siden: gammelt utsnitt
    const stale = [...baseline(), 90_000].map((amount, i, arr) => ({ day: dayOf(arr.length - i + 4), amount }));
    expect(detectSpendSpike(stale, NOW)).toBeNull();
    // median 0 (sjelden/periodisk kostnad): ingen «vanlig dag» å avvike fra
    expect(detectSpendSpike(series([...Array.from({ length: 27 }, () => 0), 80_000]), NOW)).toBeNull();
    expect(detectSpendSpike([], NOW)).toBeNull();
    expect(detectSpendSpike(series([5_000]), NOW)).toBeNull();
  });

  it("dagens (ufullførte) døgn teller ikke, og døgn som mangler regnes som 0", () => {
    const withToday: DailyAmount[] = [...series(baseline()), { day: dayOf(0), amount: 999_999 }];
    expect(detectSpendSpike(withToday, NOW)).toBeNull(); // kun «i dag» er stort: ikke fullført
    // hver fjerde dag mangler i baselinen (= 0): fortsatt median > 0, så et sprang vurderes mot et lavere vanlig nivå, ikke ignorert
    const sparse = [...baseline()].map((amount, i, arr) => ({ day: dayOf(arr.length - i + 1), amount })).filter((_, i) => i % 4 !== 0);
    sparse.push({ day: dayOf(1), amount: 60_000 });
    expect(detectSpendSpike(sparse, NOW)).not.toBeNull();
  });

  it("ugyldige punkter (feil dato, NaN, negativ, uendelig) hoppes over; flere rader samme dag (to leverandører) summeres", () => {
    const base = series(baseline());
    const junk = [{ day: "2026-13-45", amount: 1 }, { day: "i-går", amount: 2 }, { day: dayOf(3), amount: Number.NaN }, { day: dayOf(4), amount: -5 }, { day: dayOf(5), amount: Number.POSITIVE_INFINITY }] as DailyAmount[];
    expect(detectSpendSpike([...base, ...junk], NOW)).toBeNull();
    const split = [...series(baseline()), { day: dayOf(1), amount: 30_000 }, { day: dayOf(1), amount: 30_000 }];
    expect(detectSpendSpike(split, NOW)).toMatchObject({ severity: "strong" }); // 60 000 totalt
    expect(detectSpendSpike([null, undefined, 5] as never, NOW)).toBeNull();
    expect(detectSpendSpike(series([...baseline(), 60_000]), Number.NaN)).toBeNull();
  });

  it("terskelvalg har harde grenser: ugyldig/utenfor-intervall klemmes, aldri stille av", () => {
    const s = series([...baseline(), 28_000]); // 2,8x, delta 18 000
    expect(detectSpendSpike(s, NOW)).not.toBeNull();
    // et forsøk på å senke grensene til null/negativt kan ikke slå av beskyttelsen: minste forholdstall 1,5, minste økning 100, z 3
    expect(detectSpendSpike(series([...baseline(), 10_300]), NOW, { zThreshold: 0, minRatio: 0, minDelta: -1 })).toBeNull();
    expect(detectSpendSpike(s, NOW, { zThreshold: Number.NaN, minRatio: Number.NaN, minDelta: Number.NaN })).not.toBeNull(); // NaN gir standardene
    // et høyt valg klemmes til tak (z 8, 20x, 10 000 000 øre), så et enormt sprang fremdeles fanges - men et middels sprang gjør det ikke (taket er reelt)
    expect(detectSpendSpike(series([...baseline(), 200_000_000]), NOW, { minRatio: 1e9, minDelta: 1e12, zThreshold: 1e6 })).not.toBeNull();
    expect(detectSpendSpike(series([...baseline(), 900_000]), NOW, { minRatio: 1e9, minDelta: 1e12, zThreshold: 1e6 })).toBeNull();
    expect(SPEND_SPIKE_DEFAULTS).toEqual({ zThreshold: 3.5, minRatio: 2, minDelta: 5_000 });
  });

  it("ren: dypt frosset input røres aldri, og samme input gir samme svar", () => {
    const frozen = deepFreeze(series([...baseline(), 60_000]));
    expect(detectSpendSpike(frozen, NOW)).toEqual(detectSpendSpike(frozen, NOW));
  });

  it("kandidaten er INFORM-kun: ingen konfidens, nøkkel per døgn, `high` kun for `strong`, ingen beløp i teksten, og gyldig mot motorens skjema", () => {
    const strong = mapSpendSpikeToCandidate(detectSpendSpike(series([...baseline(), 60_000]), NOW)!, "ai_cost");
    const moderate = mapSpendSpikeToCandidate(detectSpendSpike(series([...baseline(), 34_000]), NOW)!, "ai_cost");
    expect(strong).toMatchObject({ domain: "spend", detection_key: `spend_anomaly:ai_cost:${dayOf(1)}`, priority: "high" });
    expect(moderate.priority).toBe("normal");
    for (const c of [strong, moderate]) {
      expect(Object.keys(c)).not.toContain("confidence");
      expect(SituationCandidateInputSchema.safeParse(c).success).toBe(true);
      expect(c.reason).toMatch(/^Kostnaden for AI-bruken \d{4}-\d{2}-\d{2} var ca\. \d+(,\d)? ganger høyere enn din vanlige dag$/);
      expect(c.reason).not.toMatch(/\d{4,}\s*(kr|øre|nok)/i);
      // uten konfidens kan stadiet aldri gå forbi `inform` (heller ikke `suggest`)
      expect(computeTargetStage(c.priority, c.confidence, false)).toBe("inform");
    }
    expect(strong.detection_key).toBe(mapSpendSpikeToCandidate(detectSpendSpike(series([...baseline(), 62_000]), NOW)!, "ai_cost").detection_key); // samme døgn = samme situasjon
  });
});

describe("B: detectStaleJobs - forventet kadens oppgis av eier/katalog, aldri gjettet", () => {
  const job = (over: Partial<JobCadence> = {}): JobCadence => ({ job_name: "situation-sweep", last_completed_at: new Date(NOW - 30 * HOUR).toISOString(), expected_interval_hours: 24, ...over });

  it("stilnet først etter mer enn graceFactor (2x) forventede intervaller; nøyaktig 2x er ikke stilnet", () => {
    expect(detectStaleJobs([job({ last_completed_at: new Date(NOW - 47 * HOUR).toISOString() })], NOW)).toEqual([]);
    expect(detectStaleJobs([job({ last_completed_at: new Date(NOW - 48 * HOUR).toISOString() })], NOW)).toEqual([]);
    const stale = detectStaleJobs([job({ last_completed_at: new Date(NOW - 49 * HOUR).toISOString() })], NOW);
    expect(stale).toEqual([{ job_name: "situation-sweep", last_completed_at: new Date(NOW - 49 * HOUR).toISOString(), hours_since: 49, overdue_factor: 2, expected_interval_hours: 24 }]);
  });

  it("aldri-fullført, ugyldig navn, ugyldig kadens og fremtidig fullføring hoppes over (ingen baseline = ingen påstand)", () => {
    const old = new Date(NOW - 400 * HOUR).toISOString();
    const bad: JobCadence[] = [
      { job_name: "aldri-kjørt", last_completed_at: null, expected_interval_hours: 24 },
      { job_name: "Stort Navn", last_completed_at: old, expected_interval_hours: 24 },
      { job_name: "x", last_completed_at: old, expected_interval_hours: 24 },
      { job_name: "feil-kadens-0", last_completed_at: old, expected_interval_hours: 0 },
      { job_name: "feil-kadens-stor", last_completed_at: old, expected_interval_hours: 745 },
      { job_name: "feil-kadens-nan", last_completed_at: old, expected_interval_hours: Number.NaN },
      { job_name: "ugyldig-tid", last_completed_at: "ikke-en-tid", expected_interval_hours: 24 },
      { job_name: "fremtid", last_completed_at: new Date(NOW + 2 * HOUR).toISOString(), expected_interval_hours: 24 }
    ];
    expect(detectStaleJobs(bad, NOW)).toEqual([]);
    expect(detectStaleJobs([null, 3, "x"] as never, NOW)).toEqual([]);
    expect(detectStaleJobs([job({ last_completed_at: old })], Number.NaN)).toEqual([]);
  });

  it("sortert etter hvor forsinket jobben er (deretter navn), og høyst 50 jobber vurderes", () => {
    const jobs: JobCadence[] = [
      job({ job_name: "b-jobb", last_completed_at: new Date(NOW - 100 * HOUR).toISOString() }),
      job({ job_name: "a-jobb", last_completed_at: new Date(NOW - 100 * HOUR).toISOString() }),
      job({ job_name: "c-jobb", last_completed_at: new Date(NOW - 250 * HOUR).toISOString() })
    ];
    expect(detectStaleJobs(jobs, NOW).map((j) => j.job_name)).toEqual(["c-jobb", "a-jobb", "b-jobb"]);
    const many: JobCadence[] = Array.from({ length: 80 }, (_, i) => job({ job_name: `jobb-${String(i).padStart(2, "0")}`, last_completed_at: new Date(NOW - 100 * HOUR).toISOString() }));
    expect(detectStaleJobs(many, NOW)).toHaveLength(50);
  });

  it("graceFactor har harde grenser (1,5..10): et forsøk på 0 slår ikke av beskyttelsen", () => {
    const j = job({ last_completed_at: new Date(NOW - 30 * HOUR).toISOString() }); // 1,25 intervaller
    expect(detectStaleJobs([j], NOW, { graceFactor: 0 })).toEqual([]); // klemt til 1,5
    expect(detectStaleJobs([job({ last_completed_at: new Date(NOW - 40 * HOUR).toISOString() })], NOW, { graceFactor: 0 })).toHaveLength(1); // 1,67 > 1,5
    expect(detectStaleJobs([job({ last_completed_at: new Date(NOW - 300 * HOUR).toISOString() })], NOW, { graceFactor: 1e9 })).toHaveLength(1); // klemt til 10: 12,5 > 10
  });

  it("kandidaten: domenet `operations` (ikke `infra`), nøkkel per episode, `high` fra 4 intervaller, ingen konfidens, gyldig skjema", () => {
    const normal = mapStaleJobToCandidate(detectStaleJobs([job({ last_completed_at: new Date(NOW - 60 * HOUR).toISOString() })], NOW)[0]!);
    const severe = mapStaleJobToCandidate(detectStaleJobs([job({ last_completed_at: new Date(NOW - 100 * HOUR).toISOString() })], NOW)[0]!);
    expect(normal.domain).toBe("operations");
    expect(normal.priority).toBe("normal");
    expect(severe.priority).toBe("high");
    expect(normal.detection_key).toBe(`job_stale:situation-sweep@${new Date(NOW - 60 * HOUR).toISOString()}`);
    expect(normal.detection_key).not.toBe(severe.detection_key); // ny fullføring = ny episode
    // samme episode (samme siste fullføring) gir samme nøkkel selv når tiden går
    const later = mapStaleJobToCandidate(detectStaleJobs([job({ last_completed_at: new Date(NOW - 60 * HOUR).toISOString() })], NOW + 10 * HOUR)[0]!);
    expect(later.detection_key).toBe(normal.detection_key);
    for (const c of [normal, severe]) {
      expect(Object.keys(c)).not.toContain("confidence");
      expect(Object.keys(c)).not.toContain("owner_person_id");
      expect(SituationCandidateInputSchema.safeParse(c).success).toBe(true);
      expect(c.reason).toMatch(/^Planlagt jobb «situation-sweep» har ikke fullført på \d+ timer \(forventet hvert 24\. time\)$/);
    }
  });

  it("ren: dypt frosset input røres aldri", () => {
    const frozen = deepFreeze([job({ last_completed_at: new Date(NOW - 100 * HOUR).toISOString() })]);
    expect(detectStaleJobs(frozen, NOW)).toEqual(detectStaleJobs(frozen, NOW));
  });
});
