import { describe, expect, it } from "vitest";
import { forecastBreach } from "@jarvis/self-modification";
import { monthTrendSamples, sumToleranceOre, type DailyCost } from "../src/cost-trend.ts";

/**
 * WP-B3 (D-475), gjennomgang M1 - `monthTrendSamples`: kumulative månedssummer til trendprognosen, SEEDET med forbruket før dagsvinduet.
 * Feilen var at kun vindusdagene (run-rate: siste 14 døgn; EV-16-seksjonen: siste 15) ble lagt sammen, så «hittil i måneden» mistet alt forbruk fra før vinduet fra dag 15/16.
 */
const day = (month: string, d: number): string => `${month}-${String(d).padStart(2, "0")}`;
/** Realistisk 14-døgnsvindu på dag 20 (kl. 10:00): 15 kalenderdøgn, første og siste delvise (4 000 av 10 000 øre). */
const window20: DailyCost[] = Array.from({ length: 15 }, (_, i) => ({ day: day("2026-11", 6 + i), ore: i === 0 || i === 14 ? 4_000 : 10_000 }));
const MTD20 = 19 * 10_000 + 4_000; // fulle døgn 1-19 + dagens delvise

describe("monthTrendSamples: seedet kumulativ serie", () => {
  it("vinduet dekker hele måneden (dag 10): frøet er 0 og serien er den vanlige kumulative summen", () => {
    const daily: DailyCost[] = Array.from({ length: 10 }, (_, i) => ({ day: day("2026-11", i + 1), ore: 1_000 }));
    const r = monthTrendSamples({ month: "2026-11", month_to_date_ore: 10_000, daily });
    expect(r).toMatchObject({ ok: true, seed_ore: 0 });
    if (r.ok) {
      expect(r.samples.map((s) => s.value)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000]);
      expect(r.samples[0]?.at).toBe("2026-11-01T12:00:00.000Z");
    }
  });

  it("vinduet starter midt i måneden (dag 20, siste 14 døgn): frøet er forbruket FØR vinduet, og siste verdi er månedssummen", () => {
    const r = monthTrendSamples({ month: "2026-11", month_to_date_ore: MTD20, daily: window20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 194 000 - (4 000 + 13 x 10 000 + 4 000) = dag 1-5 (50 000) + dag 6 før klokkeslettet (6 000)
    expect(r.seed_ore).toBe(56_000);
    expect(r.samples).toHaveLength(15);
    expect(r.samples[0]?.value).toBe(60_000); // = forbruket ved utgangen av dag 6 (5 x 10 000 + 10 000)
    expect(r.samples.at(-1)?.value).toBe(MTD20);
  });

  it("FØR/ETTER: uten frø ville trenden sagt ca. 16 døgn (OK); med frø er den ca. 11 døgn (WARN-nivå) - samme som rekkevidden", () => {
    const seeded = monthTrendSamples({ month: "2026-11", month_to_date_ore: MTD20, daily: window20 });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    let acc = 0;
    const unseeded = window20.map((d) => ({ at: `${d.day}T12:00:00.000Z`, value: (acc += d.ore) })); // den gamle (feil) serien
    const old = forecastBreach(unseeded, 300_000, 45, 5);
    const fixed = forecastBreach(seeded.samples, 300_000, 45, 5);
    expect(old.days_to_breach).toBeGreaterThan(14);
    expect(fixed.days_to_breach).toBeGreaterThan(9);
    expect(fixed.days_to_breach).toBeLessThanOrEqual(14);
    const runwayDays = (300_000 - MTD20) / (MTD20 / 20);
    expect(Math.abs((fixed.days_to_breach ?? 0) - runwayDays)).toBeLessThan(1.5);
  });

  it("dager fra en annen måned (vinduet krysser månedsskiftet) teller ikke med, og de frø-regnes ikke", () => {
    const daily: DailyCost[] = [...Array.from({ length: 5 }, (_, i) => ({ day: day("2026-10", 27 + i), ore: 9_000 })), ...Array.from({ length: 5 }, (_, i) => ({ day: day("2026-11", i + 1), ore: 500 }))];
    const r = monthTrendSamples({ month: "2026-11", month_to_date_ore: 2_500, daily });
    expect(r).toMatchObject({ ok: true, seed_ore: 0 });
    if (r.ok) expect(r.samples.map((s) => s.value)).toEqual([500, 1_000, 1_500, 2_000, 2_500]);
  });

  it("flere rader per dag (EV-16-seksjonen har én per leverandør) legges sammen, og serien sorteres stigende uansett rekkefølge", () => {
    const daily: DailyCost[] = [{ day: "2026-11-03", ore: 100 }, { day: "2026-11-01", ore: 40 }, { day: "2026-11-03", ore: 50 }, { day: "2026-11-01", ore: 10 }, { day: "2026-11-02", ore: 5 }];
    const r = monthTrendSamples({ month: "2026-11", month_to_date_ore: 205, daily });
    expect(r.ok && r.samples.map((s) => [s.at.slice(0, 10), s.value])).toEqual([["2026-11-01", 50], ["2026-11-02", 55], ["2026-11-03", 205]]);
  });

  it("ingen vindusdager i måneden: frøet er hele månedssummen og serien er tom (kalleren sier «for lite data»)", () => {
    expect(monthTrendSamples({ month: "2026-11", month_to_date_ore: 7_000, daily: [] })).toEqual({ ok: true, samples: [], seed_ore: 7_000 });
  });
});

describe("monthTrendSamples: usamstemte kilder og ugyldig input er aldri en trend", () => {
  it("toleransen er minst 5 kr, ellers 2 % av månedssummen", () => {
    expect(sumToleranceOre(0)).toBe(500);
    expect(sumToleranceOre(10_000)).toBe(500);
    expect(sumToleranceOre(100_000)).toBe(2_000);
  });

  it("dagssummene større enn månedssummen utover toleransen = `inconsistent_sums`; innenfor toleransen tåles det (frø 0)", () => {
    const daily: DailyCost[] = [{ day: "2026-11-01", ore: 10_000 }];
    expect(monthTrendSamples({ month: "2026-11", month_to_date_ore: 9_500, daily })).toMatchObject({ ok: true, seed_ore: 0 }); // 500 = akkurat toleransen
    expect(monthTrendSamples({ month: "2026-11", month_to_date_ore: 9_499, daily })).toEqual({ ok: false, reason: "inconsistent_sums" });
    expect(monthTrendSamples({ month: "2026-11", month_to_date_ore: 0, daily })).toEqual({ ok: false, reason: "inconsistent_sums" });
  });

  it("ugyldig input gir `invalid_input`: månedsformat, månedssum (NaN, uendelig, negativ, ikke tall), dagsliste som ikke er en liste, og rader med ugyldig dag/beløp - også utenfor måneden", () => {
    const good: DailyCost[] = [{ day: "2026-11-01", ore: 100 }];
    const invalid = (input: Parameters<typeof monthTrendSamples>[0]) => monthTrendSamples(input);
    for (const month of ["2026-1", "2026-13", "2026-11-01", "", "november"]) expect(invalid({ month, month_to_date_ore: 100, daily: good }), month).toEqual({ ok: false, reason: "invalid_input" });
    for (const mtd of [Number.NaN, Number.POSITIVE_INFINITY, -1, "100" as never, null as never, undefined as never]) expect(invalid({ month: "2026-11", month_to_date_ore: mtd, daily: good }), String(mtd)).toEqual({ ok: false, reason: "invalid_input" });
    for (const daily of [null, undefined, {}, "x", 5] as never[]) expect(invalid({ month: "2026-11", month_to_date_ore: 100, daily }), String(daily)).toEqual({ ok: false, reason: "invalid_input" });
    const badRows: unknown[] = [
      { day: "2026-11-xx", ore: 5 }, { day: "2026-11-32", ore: 5 }, { day: "2026-13-01", ore: 5 }, { day: 20261101, ore: 5 }, { day: "2026-11-01", ore: Number.NaN }, { day: "2026-11-01", ore: -1 },
      { day: "2026-11-01", ore: "5" }, { day: "2026-11-01" }, null, "rad", { day: "2026-10-31", ore: Number.POSITIVE_INFINITY }
    ];
    for (const row of badRows) expect(invalid({ month: "2026-11", month_to_date_ore: 100, daily: [...good, row as never] }), JSON.stringify(row)).toEqual({ ok: false, reason: "invalid_input" });
  });
});
