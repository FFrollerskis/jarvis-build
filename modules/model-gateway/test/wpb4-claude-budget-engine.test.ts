import { describe, expect, it } from "vitest";
import {
  BUDGET_ORIGINS, BUDGET_TIERS, CLAUDE_BUDGET_NOTE_PREFIX, DEFAULT_PACING_PARAMS, DEFAULT_TIER_TABLE, InvalidClaudeBudgetConfigError, PRICING_NOK_PER_USD,
  blockedMessageNo, budgetWindow, claudeBudgetConfigFromEnv, claudeBudgetNoteNo, classifyContentSensitivity, decide, deriveBudgetOrigin, describeStateNo, dueAlertKeys,
  formatDateNo, pacingState, parseTierOverrides, tierFor, tierTableRows, zonedMidnightUtcMs,
  type BudgetOrigin, type BudgetTier, type PacingLevel
} from "../src/index.ts";

/**
 * WP-B4 (D-476): den RENE tempomotoren. Alt her er deterministisk med injisert klokke (ingen I/O). Tallene i forventningene er regnet for hånd fra formlene i filhodet til `claude-budget.ts`:
 * B = 100 USD × 10,5 × 100 = 105 000 øre · P = B × 0,85 = 89 250 · M = B × 0,05 = 5 250 · C(f) = 5 250 + 84 000 × f · tight når S > 1,3 × C eller S ≥ P · exhausted når S ≥ B.
 *
 * Eierens svar (Q-67): kreditten FORNYES DEN 15. HVER MÅNED, så perioden er 15. kl. 00:00 (Europe/Oslo) til neste 15. - 28 til 31 døgn, ikke kalendermåneden - og ved 100 % gjelder hard stopp.
 */
const B = 105_000;
const P = 89_250;
const M = 5_250;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Perioden 15. nov → 15. des 2026: 15. nov 00:00 Oslo (+01:00 etter sommertid) = 14. nov 23:00Z; 15. des 00:00 Oslo = 14. des 23:00Z - nøyaktig 30 døgn, uten sommertidsovergang inni. */
const START = Date.UTC(2026, 10, 14, 23, 0, 0);
const END = Date.UTC(2026, 11, 14, 23, 0, 0);
const curveAt = (f: number): number => Math.min(P, Math.round(M + (P - M) * f));
const at = (days: number): number => START + days * DAY;

describe("konfigurasjon: av som standard, ugyldig = feil ved oppstart (aldri en stille rar verdi)", () => {
  it("tom, usatt og `off` gir null (AV): ingen tempostyring finnes, og de andre variablene leses ikke", () => {
    expect(claudeBudgetConfigFromEnv({})).toBeNull();
    expect(claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "" })).toBeNull();
    expect(claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "  " })).toBeNull();
    expect(claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "off" })).toBeNull();
    expect(claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "OFF" })).toBeNull();
    // uten budsjett har de øvrige variablene ingen virkning - selv en ugyldig verdi der stopper ikke oppstarten
    expect(claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_RESET_DAY: "99", JARVIS_CLAUDE_BUDGET_HARD_STOP: "kanskje" })).toBeNull();
  });

  it("100 USD gir standardene: 105 000 øre (kurs 10,5), FORNYELSE DEN 15. (Q-67), reserve 15 %, margin 5 %, tempoforhold 1,3, HARD STOPP på, terskler 50/75/90/100", () => {
    const cfg = claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100" });
    expect(cfg).not.toBeNull();
    expect(cfg).toMatchObject({ budget_usd: 100, budget_ore: B, nok_per_usd: PRICING_NOK_PER_USD, reset_day: 15, reserve_pct: 15, margin_pct: 5, tight_ratio: 1.3, hard_stop: true, alert_pcts: [50, 75, 90, 100] });
    expect(DEFAULT_PACING_PARAMS.reset_day).toBe(15);
    expect(DEFAULT_PACING_PARAMS.hard_stop).toBe(true);
    expect(cfg?.tiers).toBe(DEFAULT_TIER_TABLE);
    // hardstoppen er på også når variabelen er tom (compose sender «» for en variabel som ikke er satt i .env)
    expect(claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", JARVIS_CLAUDE_BUDGET_HARD_STOP: "" })?.hard_stop).toBe(true);
    expect(claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", JARVIS_CLAUDE_BUDGET_RESET_DAY: "" })?.reset_day).toBe(15);
  });

  it("alle overstyringer leses og valideres", () => {
    const cfg = claudeBudgetConfigFromEnv({
      JARVIS_CLAUDE_BUDGET_USD: "42.50", JARVIS_CLAUDE_BUDGET_RESET_DAY: "17", JARVIS_CLAUDE_BUDGET_HARD_STOP: "OFF", JARVIS_CLAUDE_BUDGET_RESERVE_PCT: "0",
      JARVIS_CLAUDE_BUDGET_MARGIN_PCT: "20", JARVIS_CLAUDE_BUDGET_TIGHT_RATIO: "1.05", JARVIS_CLAUDE_BUDGET_ALERT_PCTS: "10, 20,100", JARVIS_CLAUDE_BUDGET_TIERS: "owner_turn.CODE=important"
    });
    expect(cfg).toMatchObject({ budget_usd: 42.5, budget_ore: Math.round(42.5 * 10.5 * 100), reset_day: 17, hard_stop: false, reserve_pct: 0, margin_pct: 20, tight_ratio: 1.05, alert_pcts: [10, 20, 100] });
    expect(tierFor(cfg!.tiers, "owner_turn", "CODE")).toBe("important");
    expect(tierFor(cfg!.tiers, "owner_turn", "CHAT")).toBe("essential");
  });

  const bad = (env: Record<string, string>): unknown => { try { claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", ...env }); return null; } catch (e) { return e; } };
  it("ugyldig budsjett kaster InvalidClaudeBudgetConfigError (0, negativ, tekst, tre desimaler, for stort, vitenskapelig notasjon)", () => {
    for (const usd of ["0", "0.00", "-5", "abc", "100.123", "100001", "1e3", "NaN", "Infinity", "100 USD", "$100"]) {
      const err = (() => { try { claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: usd }); return null; } catch (e) { return e; } })();
      expect(err, usd).toBeInstanceOf(InvalidClaudeBudgetConfigError);
      expect((err as InvalidClaudeBudgetConfigError).variable).toBe("JARVIS_CLAUDE_BUDGET_USD");
    }
  });

  it("ugyldige øvrige verdier kaster og peker på riktig variabel", () => {
    const cases: Array<[string, string, string]> = [
      ["RESET_DAY", "0", "JARVIS_CLAUDE_BUDGET_RESET_DAY"], ["RESET_DAY", "32", "JARVIS_CLAUDE_BUDGET_RESET_DAY"], ["RESET_DAY", "1.5", "JARVIS_CLAUDE_BUDGET_RESET_DAY"], ["RESET_DAY", "femtende", "JARVIS_CLAUDE_BUDGET_RESET_DAY"],
      ["HARD_STOP", "false", "JARVIS_CLAUDE_BUDGET_HARD_STOP"], ["HARD_STOP", "0", "JARVIS_CLAUDE_BUDGET_HARD_STOP"],
      ["RESERVE_PCT", "51", "JARVIS_CLAUDE_BUDGET_RESERVE_PCT"], ["RESERVE_PCT", "-1", "JARVIS_CLAUDE_BUDGET_RESERVE_PCT"], ["RESERVE_PCT", "15.5", "JARVIS_CLAUDE_BUDGET_RESERVE_PCT"],
      ["MARGIN_PCT", "21", "JARVIS_CLAUDE_BUDGET_MARGIN_PCT"],
      ["TIGHT_RATIO", "1.04", "JARVIS_CLAUDE_BUDGET_TIGHT_RATIO"], ["TIGHT_RATIO", "5.1", "JARVIS_CLAUDE_BUDGET_TIGHT_RATIO"], ["TIGHT_RATIO", "1,3", "JARVIS_CLAUDE_BUDGET_TIGHT_RATIO"],
      ["ALERT_PCTS", "50,50", "JARVIS_CLAUDE_BUDGET_ALERT_PCTS"], ["ALERT_PCTS", "75,50", "JARVIS_CLAUDE_BUDGET_ALERT_PCTS"], ["ALERT_PCTS", "0,50", "JARVIS_CLAUDE_BUDGET_ALERT_PCTS"],
      ["ALERT_PCTS", "50,101", "JARVIS_CLAUDE_BUDGET_ALERT_PCTS"], ["ALERT_PCTS", "1,2,3,4,5,6,7,8,9", "JARVIS_CLAUDE_BUDGET_ALERT_PCTS"], ["ALERT_PCTS", "halv", "JARVIS_CLAUDE_BUDGET_ALERT_PCTS"],
      ["TIERS", "CHAT=essential", "JARVIS_CLAUDE_BUDGET_TIERS"], ["TIERS", "owner_turn.CHAT=kritisk", "JARVIS_CLAUDE_BUDGET_TIERS"], ["TIERS", "gjest.CHAT=essential", "JARVIS_CLAUDE_BUDGET_TIERS"],
      ["TIERS", "owner_turn.MUSIKK=essential", "JARVIS_CLAUDE_BUDGET_TIERS"], ["TIERS", "owner_turn.CHAT=essential,owner_turn.CHAT=background", "JARVIS_CLAUDE_BUDGET_TIERS"]
    ];
    for (const [name, value, variable] of cases) {
      const err = bad({ [`JARVIS_CLAUDE_BUDGET_${name}`]: value });
      expect(err, `${name}=${value}`).toBeInstanceOf(InvalidClaudeBudgetConfigError);
      expect((err as InvalidClaudeBudgetConfigError).variable, `${name}=${value}`).toBe(variable);
    }
  });
});

describe("behovsprioritering: formål × opphav → tier", () => {
  it("standardtabellen: eierens egne turer er ESSENSIELLE, bestilte jobber VIKTIGE, alt annet BAKGRUNN", () => {
    const t = (origin: BudgetOrigin, purpose: string | undefined): BudgetTier => tierFor(DEFAULT_TIER_TABLE, origin, purpose);
    for (const p of ["CHAT", "CODE", "REASON", "PLAN", "RESEARCH", "VISION", undefined]) expect(t("owner_turn", p), String(p)).toBe("essential");
    expect(t("owner_turn", "CRITIQUE")).toBe("important");
    // minneuttrekk og sammendrag bærer økt-id (utledes som eier-tur) men er bakgrunnsarbeid
    for (const p of ["EXTRACT", "SUMMARIZE", "QUICK_CLASSIFICATION", "BACKGROUND"]) expect(t("owner_turn", p), p).toBe("background");
    for (const p of ["CHAT", "BACKGROUND", "REASON", "EXTRACT", "VISION", undefined]) expect(t("owner_task", p), p).toBe("important");
    for (const p of ["CHAT", "REASON", "CODE", "VISION", "EXTRACT", undefined]) expect(t("background", p), p).toBe("background");
  });

  it("tabellen dekker alle formål i kontrakten × alle opphav (ingen hull) og alle tier-verdier er gyldige", () => {
    const rows = tierTableRows(DEFAULT_TIER_TABLE);
    expect(rows.map((r) => r.purpose)).toEqual(expect.arrayContaining(["CHAT", "QUICK_CLASSIFICATION", "SUMMARIZE", "EXTRACT", "CODE", "REASON", "PLAN", "RESEARCH", "CRITIQUE", "VISION", "BACKGROUND", "UNSPECIFIED"]));
    for (const row of rows) for (const origin of BUDGET_ORIGINS) expect(BUDGET_TIERS).toContain(row[origin]);
  });

  it("opphav: eksplisitt hint vinner; ellers jobb-id = bakgrunn, økt uten jobb = eier-tur, ingenting = bakgrunn; en ugyldig hint ignoreres til utledning", () => {
    expect(deriveBudgetOrigin({ budget_origin: "owner_task", task_id: "t", session_id: "s" })).toBe("owner_task");
    expect(deriveBudgetOrigin({ task_id: "t", session_id: "s" })).toBe("background");
    expect(deriveBudgetOrigin({ session_id: "s" })).toBe("owner_turn");
    expect(deriveBudgetOrigin({})).toBe("background");
    expect(deriveBudgetOrigin({ budget_origin: "admin", session_id: "s" })).toBe("owner_turn");
    expect(deriveBudgetOrigin({ budget_origin: 5, task_id: "t" })).toBe("background");
  });

  it("overstyring fra miljøet endrer kun de oppgitte cellene", () => {
    const t = parseTierOverrides("owner_turn.CODE=important, background.VISION=important,owner_task.UNSPECIFIED=background");
    expect(tierFor(t, "owner_turn", "CODE")).toBe("important");
    expect(tierFor(t, "background", "VISION")).toBe("important");
    expect(tierFor(t, "owner_task", undefined)).toBe("background");
    expect(tierFor(t, "owner_turn", "CHAT")).toBe("essential");
    expect(tierFor(DEFAULT_TIER_TABLE, "owner_turn", "CODE")).toBe("essential"); // standardtabellen er urørt
    expect(parseTierOverrides(undefined)).toBe(DEFAULT_TIER_TABLE);
    expect(parseTierOverrides("   ")).toBe(DEFAULT_TIER_TABLE);
  });
});

describe("kredittperioden 15. → 15. i Europe/Oslo (Q-67): 28-31 døgn, skuddår og sommertid", () => {
  it("standard fornyelsesdag er 15.: 15. nov 00:00 Oslo til 15. des 00:00 Oslo, uavhengig av hvor i perioden vi er (eksklusiv slutt)", () => {
    for (const now of [START, START + 1, at(10), END - 1]) {
      expect(budgetWindow(now, DEFAULT_PACING_PARAMS.reset_day)).toEqual({ start_ms: START, end_ms: END, start_date: "2026-11-15", end_date: "2026-12-15" });
      expect(pacingState({ now, budget_ore: B, spent_ore: 0 }).window).toMatchObject({ start_ms: START, end_ms: END, start_date: "2026-11-15", end_date: "2026-12-15", days_total: 30 });
    }
    expect(budgetWindow(END, 15).start_ms).toBe(END);
  });

  it("GRENSEN 14./15. for hver måned (2026 og jan-mar 2027): rett før lokal midnatt natt til den 15. er forrige periode, akkurat ved midnatt er den nye, og vinduene henger sammen", () => {
    // Europe/Oslo-forskyvning den 15. i hver måned: +01:00 vinter, +02:00 sommer (sommertid 29. mars - 25. oktober 2026; 28. mars 2027)
    const offsetHours: Record<string, number> = {
      "2026-01": 1, "2026-02": 1, "2026-03": 1, "2026-04": 2, "2026-05": 2, "2026-06": 2, "2026-07": 2, "2026-08": 2, "2026-09": 2, "2026-10": 2, "2026-11": 1, "2026-12": 1,
      "2027-01": 1, "2027-02": 1, "2027-03": 1
    };
    for (const [ym, offset] of Object.entries(offsetHours)) {
      const [y, m] = ym.split("-").map(Number) as [number, number];
      const renewal = Date.UTC(y, m - 1, 15, -offset, 0, 0); // 15. 00:00 lokal tid
      const before = budgetWindow(renewal - 1, 15);
      const after = budgetWindow(renewal, 15);
      expect(after.start_ms, ym).toBe(renewal);
      expect(after.start_date, ym).toBe(`${ym}-15`);
      expect(before.end_ms, ym).toBe(renewal);
      expect(before.start_ms, ym).toBeLessThan(renewal);
      const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
      expect(before.start_date, ym).toBe(`${prev}-15`);
      // 14. kl. 12 lokal tid er fortsatt forrige periode; 15. kl. 00:00:01 er dag 1 i den nye
      expect(budgetWindow(renewal - 12 * HOUR, 15).start_date, ym).toBe(`${prev}-15`);
      expect(pacingState({ now: renewal + 1000, budget_ore: B, spent_ore: 0 }).window.day_of_window, ym).toBe(1);
      expect(pacingState({ now: renewal - 1, budget_ore: B, spent_ore: 0 }).window.days_left_whole, ym).toBe(1);
    }
  });

  it("lokal midnatt, ikke UTC-midnatt: vinter 14. nov 22:59:59Z er fortsatt forrige periode, 23:00:00Z den nye; sommer 14. jul 21:59:59Z / 22:00:00Z", () => {
    expect(budgetWindow(Date.UTC(2026, 10, 14, 22, 59, 59), 15).start_date).toBe("2026-10-15");
    expect(budgetWindow(Date.UTC(2026, 10, 14, 23, 0, 0), 15).start_date).toBe("2026-11-15");
    expect(budgetWindow(Date.UTC(2026, 6, 14, 21, 59, 59), 15).start_date).toBe("2026-06-15");
    expect(budgetWindow(Date.UTC(2026, 6, 14, 22, 0, 0), 15).start_date).toBe("2026-07-15");
    // UTC-midnatt natt til den 15. er allerede 01:00/02:00 den 15. i Oslo
    expect(budgetWindow(Date.UTC(2026, 10, 15, 0, 0, 0), 15).start_date).toBe("2026-11-15");
    expect(budgetWindow(Date.UTC(2026, 6, 15, 0, 0, 0), 15).start_date).toBe("2026-07-15");
  });

  it("DEN FAKTISKE PERIODELENGDEN: jan→feb 31 døgn, feb→mar 28 døgn (2027) og 29 døgn (skuddår 2028), des→jan 31 døgn, nov→des 30 døgn", () => {
    const len = (now: number): number => { const w = budgetWindow(now, 15); return (w.end_ms - w.start_ms) / DAY; };
    expect(len(Date.UTC(2027, 0, 20, 12, 0, 0))).toBe(31); // 15. jan → 15. feb 2027
    expect(len(Date.UTC(2027, 1, 20, 12, 0, 0))).toBe(28); // 15. feb → 15. mar 2027
    expect(len(Date.UTC(2028, 1, 20, 12, 0, 0))).toBe(29); // 15. feb → 15. mar 2028 (skuddår)
    expect(len(Date.UTC(2026, 11, 20, 12, 0, 0))).toBe(31); // 15. des 2026 → 15. jan 2027 (årsskiftet)
    expect(len(Date.UTC(2026, 10, 20, 12, 0, 0))).toBe(30); // 15. nov → 15. des 2026
    expect(budgetWindow(Date.UTC(2027, 0, 5, 12, 0, 0), 15)).toMatchObject({ start_date: "2026-12-15", end_date: "2027-01-15", start_ms: Date.UTC(2026, 11, 14, 23, 0, 0), end_ms: Date.UTC(2027, 0, 14, 23, 0, 0) });
    expect(budgetWindow(Date.UTC(2026, 11, 31, 23, 30, 0), 15)).toMatchObject({ start_date: "2026-12-15", end_date: "2027-01-15" }); // nyttårsnatt
    expect(budgetWindow(Date.UTC(2027, 1, 14, 22, 59, 59), 15)).toMatchObject({ start_date: "2027-01-15", end_date: "2027-02-15" });
    expect(budgetWindow(Date.UTC(2027, 1, 14, 23, 0, 0), 15)).toMatchObject({ start_date: "2027-02-15", end_date: "2027-03-15" });
    expect(budgetWindow(Date.UTC(2027, 2, 14, 23, 0, 0), 15)).toMatchObject({ start_date: "2027-03-15", end_date: "2027-04-15" });
  });

  it("sommertid: perioden 15. mar → 15. apr 2026 er 1 time KORTERE og 15. okt → 15. nov 2026 1 time LENGRE enn hele døgn, og midnatt er alltid lokal midnatt", () => {
    const mar = budgetWindow(Date.UTC(2026, 2, 20, 12, 0, 0), 15);
    expect(mar.start_ms).toBe(Date.UTC(2026, 2, 14, 23, 0, 0)); // +01:00
    expect(mar.end_ms).toBe(Date.UTC(2026, 3, 14, 22, 0, 0)); // +02:00
    expect(mar.end_ms - mar.start_ms).toBe(31 * DAY - HOUR);
    const oct = budgetWindow(Date.UTC(2026, 9, 20, 12, 0, 0), 15);
    expect(oct.start_ms).toBe(Date.UTC(2026, 9, 14, 22, 0, 0)); // +02:00
    expect(oct.end_ms).toBe(Date.UTC(2026, 10, 14, 23, 0, 0)); // +01:00
    expect(oct.end_ms - oct.start_ms).toBe(31 * DAY + HOUR);
    // selve omleggingsdagene brukt som fornyelsesdag (reset 29. mars og 25. oktober)
    expect(zonedMidnightUtcMs(2026, 3, 29)).toBe(Date.UTC(2026, 2, 28, 23, 0, 0));
    expect(zonedMidnightUtcMs(2026, 3, 30)).toBe(Date.UTC(2026, 2, 29, 22, 0, 0));
    expect(zonedMidnightUtcMs(2026, 10, 25)).toBe(Date.UTC(2026, 9, 24, 22, 0, 0));
    expect(zonedMidnightUtcMs(2026, 10, 26)).toBe(Date.UTC(2026, 9, 25, 23, 0, 0));
  });

  it("andre fornyelsesdager er fortsatt støttet: kalendermåned (1.), og dag 31 avkortes til månedens siste dag (29. feb 2028, 28. feb 2027)", () => {
    expect(budgetWindow(Date.UTC(2026, 10, 20, 12, 0, 0), 1)).toEqual({ start_ms: Date.UTC(2026, 9, 31, 23, 0, 0), end_ms: Date.UTC(2026, 10, 30, 23, 0, 0), start_date: "2026-11-01", end_date: "2026-12-01" });
    expect(budgetWindow(Date.UTC(2028, 1, 29, 12, 0, 0), 31)).toMatchObject({ start_date: "2028-02-29", end_date: "2028-03-31", start_ms: Date.UTC(2028, 1, 28, 23, 0, 0) });
    expect(budgetWindow(Date.UTC(2028, 1, 10, 12, 0, 0), 31)).toMatchObject({ start_date: "2028-01-31", end_date: "2028-02-29" });
    expect(budgetWindow(Date.UTC(2027, 1, 28, 12, 0, 0), 31)).toMatchObject({ start_date: "2027-02-28", end_date: "2027-03-31" });
    expect(budgetWindow(Date.UTC(2027, 3, 10, 12, 0, 0), 30)).toMatchObject({ start_date: "2027-03-30", end_date: "2027-04-30" });
  });

  it("vinduene henger sammen uten hull eller overlapp gjennom et helt år (hvert 7. time, fornyelsesdag 15 - og 1/29/31 til sammenligning)", () => {
    for (const resetDay of [15, 1, 29, 31]) {
      let now = Date.UTC(2026, 0, 1, 0, 0, 0);
      let previousEnd: number | null = null;
      let previousStart = -1;
      const stop = Date.UTC(2027, 0, 20, 0, 0, 0);
      for (; now < stop; now += 7 * HOUR) {
        const w = budgetWindow(now, resetDay);
        expect(w.start_ms, `reset ${resetDay} ${new Date(now).toISOString()}`).toBeLessThanOrEqual(now);
        expect(now, `reset ${resetDay} ${new Date(now).toISOString()}`).toBeLessThan(w.end_ms);
        expect(w.end_ms - w.start_ms).toBeGreaterThanOrEqual(27 * DAY + 23 * HOUR);
        expect(w.end_ms - w.start_ms).toBeLessThanOrEqual(32 * DAY);
        if (previousEnd !== null && w.start_ms !== previousStart) expect(w.start_ms, `reset ${resetDay} ${new Date(now).toISOString()}`).toBe(previousEnd);
        previousEnd = w.end_ms;
        previousStart = w.start_ms;
      }
    }
  });
});

describe("kurve, prognose og dagsrom bruker den FAKTISKE periodelengden", () => {
  const periodStart = (year: number, month: number): number => budgetWindow(Date.UTC(year, month - 1, 20, 12, 0, 0), 15).start_ms;

  it("28-døgnsperiode (15. feb → 15. mar 2027): midtpunktet (dag 14) er halve kurven, 14 døgn igjen, prognosen ganger daglig snitt med 14 - ikke 15 eller 16", () => {
    const start = periodStart(2027, 2);
    const s = pacingState({ now: start + 14 * DAY, budget_ore: B, spent_ore: 28_000 });
    expect(s.window).toMatchObject({ days_total: 28, days_left: 14, days_left_whole: 14, day_of_window: 15, start_date: "2027-02-15", end_date: "2027-03-15" });
    expect(s.curve_ore).toBe(47_250);
    expect(s.forecast_end_ore).toBe(28_000 + 2_000 * 14); // 56 000
    expect(s.daily_room_ore).toBe(Math.round((P - 28_000) / 14));
  });

  it("29-døgnsperiode (skuddår 15. feb → 15. mar 2028): midtpunktet er dag 14,5; 31-døgnsperiode (15. jan → 15. feb 2027): dag 14 er 14/31 av veien", () => {
    const leapStart = periodStart(2028, 2);
    expect(pacingState({ now: leapStart + 14.5 * DAY, budget_ore: B, spent_ore: 0 })).toMatchObject({ curve_ore: 47_250, window: { days_total: 29 } });
    const janStart = periodStart(2027, 1);
    const jan = pacingState({ now: janStart + 14 * DAY, budget_ore: B, spent_ore: 0 });
    expect(jan.window).toMatchObject({ days_total: 31, start_date: "2027-01-15", end_date: "2027-02-15" });
    expect(jan.curve_ore).toBe(43_185); // 5 250 + 84 000 × 14/31 = 43 185,48 (med 30 døgn ville det vært 44 450)
    expect(jan.window.days_left_whole).toBe(17);
  });

  it("des → jan (årsskiftet): dag 20 av perioden 15. des 2026 → 15. jan 2027 ligger i 2027, men tilhører fortsatt samme periode og samme kurve", () => {
    const decStart = periodStart(2026, 12);
    const s = pacingState({ now: decStart + 20 * DAY, budget_ore: B, spent_ore: 0 });
    expect(new Date(decStart + 20 * DAY).getUTCFullYear()).toBe(2027);
    expect(s.window).toMatchObject({ start_date: "2026-12-15", end_date: "2027-01-15", days_total: 31, day_of_window: 21 });
    expect(s.curve_ore).toBe(Math.round(5_250 + (84_000 * 20) / 31));
  });

  it("sommertid skjuler seg ikke i kurven: midtpunktet i en 1 time kortere/lengre periode er alltid halve kurven (fraksjonen går på ekte millisekunder)", () => {
    for (const [y, m] of [[2026, 3], [2026, 10]] as const) {
      const w = budgetWindow(Date.UTC(y, m - 1, 20, 12, 0, 0), 15);
      const mid = w.start_ms + (w.end_ms - w.start_ms) / 2;
      const s = pacingState({ now: mid, budget_ore: B, spent_ore: 0 });
      expect(s.curve_ore, `${y}-${m}`).toBe(47_250);
      expect(s.window.days_total, `${y}-${m}`).toBe(31);
      expect(s.window.elapsed_fraction, `${y}-${m}`).toBeCloseTo(0.5, 12);
    }
  });

  it("fornyelsen: akkurat ved 15. 00:00 teller forrige periodes forbruk ikke - samme tilstand med forbruk 0 er på tempo, dag 1, kurven på forhåndsmarginen", () => {
    const justBefore = pacingState({ now: END - 1, budget_ore: B, spent_ore: B + 1_000 });
    expect(justBefore.level).toBe("exhausted");
    const justAfter = pacingState({ now: END, budget_ore: B, spent_ore: 0 });
    expect(justAfter).toMatchObject({ level: "on_pace", curve_ore: M, window: { day_of_window: 1, start_date: "2026-12-15", end_date: "2027-01-15" } });
    expect(decide({ now: END, budget_ore: B, spent_ore: 0, tier: "background" })).toMatchObject({ action: "allow", level: "on_pace" });
  });
});

describe("tilstand og kurve (100 USD, 15. nov → 15. des 2026)", () => {
  it("dag 0: ingenting brukt = på tempo, kurven starter på forhåndsmarginen (5 %), rommet er hele tempobudsjettet, ingen prognose", () => {
    const s = pacingState({ now: START, budget_ore: B, spent_ore: 0 });
    expect(s).toMatchObject({ level: "on_pace", budget_ore: B, spent_ore: 0, pacing_budget_ore: P, reserve_ore: B - P, curve_ore: M, room_to_curve_ore: M, remaining_ore: B, in_reserve: false });
    expect(s.window).toMatchObject({ days_total: 30, elapsed_days: 0, days_left: 30, days_left_whole: 30, day_of_window: 1 });
    expect(s.daily_room_ore).toBe(Math.round(P / 30));
    expect(s.forecast_end_ore).toBeNull();
    expect(s.pace_ratio).toBe(0);
  });

  it("kurven er lineær fra 5 % til 85 % og kumulativ: midt i perioden 47 250, siste dag = tempobudsjettet", () => {
    expect(pacingState({ now: at(15), budget_ore: B, spent_ore: 0 }).curve_ore).toBe(47_250);
    expect(pacingState({ now: at(7.5), budget_ore: B, spent_ore: 0 }).curve_ore).toBe(curveAt(0.25));
    expect(pacingState({ now: END - 1, budget_ore: B, spent_ore: 0 }).curve_ore).toBe(P);
    // ubrukt rom overføres: ingenting brukt til dag 20 gir et rom på hele kurven (ikke bare «dagens andel»)
    const s = pacingState({ now: at(20), budget_ore: B, spent_ore: 0 });
    expect(s.room_to_curve_ore).toBe(curveAt(20 / 30));
    expect(s.room_to_curve_ore).toBeGreaterThan(60_000);
  });

  it("nivåene ved grensene: S = C er på tempo, S = C + 1 foran tempo, S = 1,3 × C er fortsatt foran, over er stramt, S ≥ P er stramt uansett kurve, S ≥ B er oppbrukt", () => {
    const now = at(15); // C = 47 250
    const level = (spent: number): PacingLevel => pacingState({ now, budget_ore: B, spent_ore: spent }).level;
    expect(level(47_250)).toBe("on_pace");
    expect(level(47_251)).toBe("ahead");
    expect(level(Math.floor(47_250 * 1.3))).toBe("ahead"); // 61 425
    expect(level(Math.floor(47_250 * 1.3) + 1)).toBe("tight");
    expect(level(P - 1)).toBe("tight"); // 89 249 er over 1,3 × C
    expect(level(P)).toBe("tight");
    expect(level(B - 1)).toBe("tight");
    expect(level(B)).toBe("exhausted");
    expect(level(B + 5_000)).toBe("exhausted");
    // på siste dag er kurven P: forbruk akkurat der er tight (reserven er det som er igjen)
    expect(pacingState({ now: END - 1, budget_ore: B, spent_ore: P }).level).toBe("tight");
    expect(pacingState({ now: END - 1, budget_ore: B, spent_ore: P - 1 }).level).toBe("on_pace");
  });

  it("reserve 0 % gjør tempobudsjettet lik hele budsjettet: tight kommer kun av tempoet, og S ≥ B er direkte oppbrukt", () => {
    const params = { reserve_pct: 0 };
    // uten reserve er tempobudsjettet = B, så å være 1 øre under B er aldri «tight» (ikke inne i noen reserve) - kurven (≈104 970) er bare passert, så nivået er «foran»
    const nearlyOut = pacingState({ now: at(29.99), budget_ore: B, spent_ore: B - 1, params });
    expect(nearlyOut.pacing_budget_ore).toBe(B);
    expect(nearlyOut.in_reserve).toBe(false);
    expect(nearlyOut.level).toBe("ahead");
    expect(pacingState({ now: at(29.99), budget_ore: B, spent_ore: B, params }).level).toBe("exhausted");
    expect(pacingState({ now: at(2), budget_ore: B, spent_ore: 50_000, params }).level).toBe("tight");
  });

  it("dagsrom og prognose: rom = rest av tempobudsjettet / gjenstående døgn (opp), prognose = forbruk + daglig snitt × døgn igjen; siste-7-dagers snitt brukes når det er oppgitt", () => {
    const s = pacingState({ now: at(10), budget_ore: B, spent_ore: 30_000 });
    expect(s.window.days_left_whole).toBe(20);
    expect(s.daily_room_ore).toBe(Math.round((P - 30_000) / 20));
    expect(s.daily_room_incl_reserve_ore).toBe(Math.round((B - 30_000) / 20));
    expect(s.forecast_end_ore).toBe(Math.round(30_000 + (30_000 / 10) * 20)); // 90 000
    expect(s.forecast_pct).toBeCloseTo((90_000 / B) * 100, 6);
    const recent = pacingState({ now: at(10), budget_ore: B, spent_ore: 30_000, trailing: { spent_ore: 14_000, days: 7 } });
    expect(recent.forecast_end_ore).toBe(Math.round(30_000 + (14_000 / 7) * 20)); // 70 000
    // under ett døgns data: ingen prognose (aldri en tilfeldig ekstrapolering fra en time)
    expect(pacingState({ now: at(0.5), budget_ore: B, spent_ore: 9_000 }).forecast_end_ore).toBeNull();
    expect(pacingState({ now: at(2), budget_ore: B, spent_ore: 9_000, trailing: { spent_ore: 100, days: 0.5 } }).forecast_end_ore).toBe(Math.round(9_000 + (9_000 / 2) * 28));
  });

  it("siste døgn: gjenstående døgn er minst 1 (aldri deling på 0), og rommet er null når tempobudsjettet er brukt", () => {
    const last = pacingState({ now: END - 1000, budget_ore: B, spent_ore: 80_000 });
    expect(last.window.days_left_whole).toBe(1);
    expect(last.daily_room_ore).toBe(P - 80_000);
    expect(pacingState({ now: at(28), budget_ore: B, spent_ore: P + 100 }).daily_room_ore).toBe(0);
    expect(pacingState({ now: at(28), budget_ore: B, spent_ore: P + 100 }).daily_room_incl_reserve_ore).toBe(Math.round((B - P - 100) / 2));
  });

  it("Date og tall som klokke gir samme svar, og tilstanden er ren (samme input = samme output)", () => {
    const a = pacingState({ now: new Date(at(12)), budget_ore: B, spent_ore: 12_345 });
    const b = pacingState({ now: at(12), budget_ore: B, spent_ore: 12_345 });
    expect(a).toEqual(b);
  });
});

describe("beslutning: nivå × tier (politikken)", () => {
  const level = (spent: number, now = at(15)): PacingLevel => pacingState({ now, budget_ore: B, spent_ore: spent }).level;
  const SPENT: Record<PacingLevel, number> = { on_pace: 40_000, ahead: 55_000, tight: 70_000, exhausted: B };
  const act = (l: PacingLevel, tier: BudgetTier, extra: { hard_stop?: boolean; spent?: number; now?: number } = {}) =>
    decide({ now: extra.now ?? at(15), budget_ore: B, spent_ore: extra.spent ?? SPENT[l], tier, params: extra.hard_stop === undefined ? {} : { hard_stop: extra.hard_stop } });

  it("utgangspunktene stemmer med nivåene", () => {
    for (const l of ["on_pace", "ahead", "tight", "exhausted"] as const) expect(level(SPENT[l]), l).toBe(l);
  });

  it("på tempo: alt tillatt", () => {
    for (const tier of BUDGET_TIERS) expect(act("on_pace", tier)).toMatchObject({ action: "allow", reason: "within_curve", level: "on_pace" });
  });

  it("foran tempo: BAKGRUNN nedgraderes (billigere modell/annen leverandør), ESSENSIELL og VIKTIG er uendret", () => {
    expect(act("ahead", "essential")).toMatchObject({ action: "allow", reason: "ahead_allowed" });
    expect(act("ahead", "important")).toMatchObject({ action: "allow", reason: "ahead_allowed" });
    expect(act("ahead", "background")).toMatchObject({ action: "downgrade", reason: "ahead_background_downgrade" });
  });

  it("stramt: kun ESSENSIELL og VIKTIG på Anthropic; BAKGRUNN utsettes; VIKTIG utsettes også når tempobudsjettet er brukt opp (reserven er kun for ESSENSIELL)", () => {
    expect(act("tight", "essential")).toMatchObject({ action: "allow", reason: "tight_essential_allowed" });
    expect(act("tight", "important")).toMatchObject({ action: "allow", reason: "tight_important_allowed" });
    expect(act("tight", "background")).toMatchObject({ action: "defer", reason: "tight_background_deferred" });
    const inReserve = { spent: P + 1_000 };
    expect(act("tight", "essential", inReserve)).toMatchObject({ action: "allow", reason: "tight_essential_allowed", level: "tight" });
    expect(act("tight", "important", inReserve)).toMatchObject({ action: "defer", reason: "reserve_kept_for_essential" });
    expect(act("tight", "background", inReserve)).toMatchObject({ action: "defer", reason: "tight_background_deferred" });
  });

  it("oppbrukt (≥ 100 %): HARD STOPP - Anthropic er stengt for alt; med hardstopp av fortsetter ESSENSIELL og VIKTIG (kun varsling), BAKGRUNN utsettes fortsatt", () => {
    for (const tier of BUDGET_TIERS) expect(act("exhausted", tier)).toMatchObject({ action: "deny", reason: "exhausted_closed", level: "exhausted" });
    expect(act("exhausted", "essential", { hard_stop: false })).toMatchObject({ action: "allow", reason: "exhausted_hard_stop_off" });
    expect(act("exhausted", "important", { hard_stop: false })).toMatchObject({ action: "allow", reason: "exhausted_hard_stop_off" });
    expect(act("exhausted", "background", { hard_stop: false })).toMatchObject({ action: "defer", reason: "exhausted_hard_stop_off_background_deferred" });
  });

  it("tier utledes av opphav + formål når den ikke er oppgitt (og ekko av formålet)", () => {
    const d = decide({ now: at(15), budget_ore: B, spent_ore: 70_000, origin: "owner_turn", purpose: "CHAT" });
    expect(d).toMatchObject({ tier: "essential", action: "allow", purpose: "CHAT" });
    expect(decide({ now: at(15), budget_ore: B, spent_ore: 70_000, origin: "background", purpose: "EXTRACT" })).toMatchObject({ tier: "background", action: "defer" });
    expect(decide({ now: at(15), budget_ore: B, spent_ore: 70_000, origin: "owner_task" })).toMatchObject({ tier: "important", action: "allow", purpose: null });
  });

  it("tidspunkt for nytt rom: foran-tempo-utsettelse løftes når kurven har tatt igjen forbruket/1,3; reserve og oppbrukt åpner først ved fornyelsen", () => {
    // S = 42 000 på dag 3 (C = 13 650, 1,3 × C = 17 745) → tight. Forbruket delt på 1,3 = 32 307,7 → f = (32 307,7 − 5 250) / 84 000
    const d = decide({ now: at(3), budget_ore: B, spent_ore: 42_000, tier: "background" });
    expect(d.action).toBe("defer");
    const f = (42_000 / 1.3 - M) / (P - M);
    expect(d.resume_at_ms).toBe(Math.ceil(START + f * (END - START)));
    expect(d.resume_at_ms).toBeGreaterThan(at(9));
    expect(d.resume_at_ms).toBeLessThan(at(10));
    // faktisk lagt dit: ved det tidspunktet er forbruket ikke lenger «tight»
    const later = pacingState({ now: d.resume_at_ms as number, budget_ore: B, spent_ore: 42_000 });
    expect(later.level).toBe("ahead");
    expect(decide({ now: at(20), budget_ore: B, spent_ore: P + 10, tier: "important" }).resume_at_ms).toBe(END);
    expect(decide({ now: at(20), budget_ore: B, spent_ore: B, tier: "essential" })).toMatchObject({ action: "deny", resume_at_ms: END });
    expect(decide({ now: at(20), budget_ore: B, spent_ore: 40_000, tier: "background" }).resume_at_ms).toBeNull(); // tillatt: ingen utsettelse
  });
});

describe("hele perioden med injisert klokke", () => {
  it("jevnt forbruk nøyaktig på kurven (hver time gjennom hele perioden): alltid på tempo, alltid tillatt for alle tier - ingen falske alarmer", () => {
    for (let h = 0; h < 30 * 24; h += 1) {
      const now = START + h * HOUR;
      const spent = curveAt((now - START) / (END - START));
      for (const tier of BUDGET_TIERS) {
        const d = decide({ now, budget_ore: B, spent_ore: spent, tier });
        expect(d.level, `time ${h}`).toBe("on_pace");
        expect(d.action, `time ${h} ${tier}`).toBe("allow");
      }
    }
  });

  it("jevnt forbruk på kurven gjennom en KORT periode (28 døgn, feb 2027) og en LANG (31 døgn med sommertid, okt 2026): samme garanti med den faktiske lengden", () => {
    for (const day of [Date.UTC(2027, 1, 20, 12, 0, 0), Date.UTC(2026, 9, 20, 12, 0, 0), Date.UTC(2026, 2, 20, 12, 0, 0)]) {
      const w = budgetWindow(day, 15);
      for (let now = w.start_ms; now < w.end_ms; now += 5 * HOUR) {
        const spent = curveAt((now - w.start_ms) / (w.end_ms - w.start_ms));
        const d = decide({ now, budget_ore: B, spent_ore: spent, tier: "background" });
        expect(d.level, `${w.start_date} ${new Date(now).toISOString()}`).toBe("on_pace");
      }
    }
  });

  it("ingenting brukt: på tempo hele perioden, rommet vokser (kumulativ kurve), prognosen er 0 etter første døgn", () => {
    let previousRoom = -1;
    for (let day = 0; day < 30; day += 1) {
      const s = pacingState({ now: at(day) + 12 * HOUR, budget_ore: B, spent_ore: 0 });
      expect(s.level).toBe("on_pace");
      expect(s.room_to_curve_ore).toBeGreaterThan(previousRoom);
      previousRoom = s.room_to_curve_ore;
      if (day >= 1) expect(s.forecast_end_ore).toBe(0);
    }
  });

  it("overforbruk dag 3 (40 USD): stramt - BAKGRUNN utsettes, ESSENSIELL/VIKTIG går - og det normaliseres av seg selv uten nytt forbruk (stramt → foran → på tempo)", () => {
    const S = 42_000; // 40 USD
    const first = decide({ now: at(3), budget_ore: B, spent_ore: S, tier: "background" });
    expect(first.level).toBe("tight");
    expect(decide({ now: at(3), budget_ore: B, spent_ore: S, tier: "important" }).action).toBe("allow");
    expect(decide({ now: at(3), budget_ore: B, spent_ore: S, tier: "essential" }).action).toBe("allow");
    const trail: string[] = [];
    for (let day = 3; day <= 30; day += 1) {
      const level = pacingState({ now: Math.min(at(day), END - 1), budget_ore: B, spent_ore: S }).level;
      if (trail[trail.length - 1] !== level) trail.push(level);
    }
    expect(trail).toEqual(["tight", "ahead", "on_pace"]);
    // dag 9 er fortsatt stramt, dag 11 foran, dag 16 på tempo (C(16) = 5 250 + 84 000 × 16/30 = 50 050 ≥ 42 000)
    expect(pacingState({ now: at(9), budget_ore: B, spent_ore: S }).level).toBe("tight");
    expect(pacingState({ now: at(11), budget_ore: B, spent_ore: S }).level).toBe("ahead");
    expect(pacingState({ now: at(16), budget_ore: B, spent_ore: S }).level).toBe("on_pace");
  });

  it("brent gjennom tempobudsjettet tidlig (90 USD dag 20): reserven er kun for ESSENSIELL de siste dagene, helt til oppbrukt - da hard stopp for alle", () => {
    const S = 94_500; // 90 USD > P (89 250) men < B
    for (const day of [20, 25, 29.5]) {
      expect(decide({ now: at(day), budget_ore: B, spent_ore: S, tier: "essential" }).action, `dag ${day}`).toBe("allow");
      expect(decide({ now: at(day), budget_ore: B, spent_ore: S, tier: "important" }).action, `dag ${day}`).toBe("defer");
      expect(decide({ now: at(day), budget_ore: B, spent_ore: S, tier: "background" }).action, `dag ${day}`).toBe("defer");
    }
    for (const tier of BUDGET_TIERS) expect(decide({ now: at(29.5), budget_ore: B, spent_ore: B, tier }).action).toBe("deny");
  });

  it("siste dag med lite brukt: alt tillatt (kreditten bortfaller uansett, ingen unødig bremsing)", () => {
    for (const tier of BUDGET_TIERS) expect(decide({ now: END - HOUR, budget_ore: B, spent_ore: 20_000, tier }).action).toBe("allow");
  });

  it("fornyelsesdag 1. (kalendermåned) fungerer som alternativ: samme motor, annet vindu", () => {
    const params = { reset_day: 1 };
    expect(pacingState({ now: Date.UTC(2026, 10, 20, 12, 0, 0), budget_ore: B, spent_ore: 0, params }).window).toMatchObject({ start_date: "2026-11-01", end_date: "2026-12-01", days_total: 30 });
    expect(pacingState({ now: Date.UTC(2026, 10, 30, 22, 59, 59), budget_ore: B, spent_ore: 0, params }).window.start_date).toBe("2026-11-01");
    expect(pacingState({ now: Date.UTC(2026, 10, 30, 23, 0, 0), budget_ore: B, spent_ore: 0, params }).window.start_date).toBe("2026-12-01");
  });
});

describe("varsler: terskler som er passert", () => {
  const cfg = { alert_pcts: [50, 75, 90, 100], tight_ratio: 1.3 } as const;
  const keys = (spent: number, now = at(20)): string[] => dueAlertKeys(pacingState({ now, budget_ore: B, spent_ore: spent }), cfg);

  it("én nøkkel per passert prosentterskel (stigende), og `pace` når tempoet er over 1,3 × kurven", () => {
    expect(keys(0)).toEqual([]);
    expect(keys(40_000)).toEqual([]); // dag 20: C = 61 250, 38 %
    expect(keys(B * 0.5, at(25))).toEqual(["pct:50"]);
    expect(keys(B * 0.76, at(29))).toEqual(["pct:50", "pct:75"]);
    expect(keys(B * 0.91, at(29))).toEqual(["pct:50", "pct:75", "pct:90"]);
    expect(keys(B)).toEqual(["pct:50", "pct:75", "pct:90", "pct:100"]);
    // 40 USD dag 3: 40 % (ingen prosentterskel), men 3 × kurven → pace
    expect(keys(42_000, at(3))).toEqual(["pace"]);
    expect(keys(B * 0.55, at(3))).toEqual(["pct:50", "pace"]);
  });

  it("pace utløses ikke ved akkurat 1,3 × kurven, og ikke når kreditten er oppbrukt (da er prosentterskelen 100 % det som gjelder)", () => {
    const now = at(15); // C = 47 250 → 1,3 × C = 61 425
    expect(keys(61_425, now)).not.toContain("pace");
    expect(keys(61_426, now)).toContain("pace");
    expect(keys(B + 10, now)).not.toContain("pace");
  });
});

describe("tekster: kun kategorier og tall, norsk, og ufarlige for samtalen", () => {
  const cfg = { nok_per_usd: PRICING_NOK_PER_USD, budget_usd: 100 };

  it("tilstandslinjen (kun til eieren) viser USD og kr, nivå, døgn og prognose", () => {
    const line = describeStateNo(pacingState({ now: at(10), budget_ore: B, spent_ore: 30_000 }), cfg);
    expect(line).toContain("28,57 av 100,00 USD");
    expect(line).toContain("29 %");
    expect(line).toContain("300 kr");
    expect(line).toContain("på tempo");
    expect(line).toContain("Dag 11 av 30");
    expect(line).toContain("prognose ved fornyelsen 86 %");
    expect(describeStateNo(pacingState({ now: at(10), budget_ore: B, spent_ore: B }), cfg)).toContain("oppbrukt");
    expect(describeStateNo(pacingState({ now: at(10), budget_ore: B, spent_ore: B }), cfg)).not.toContain("rom ca.");
  });

  it("feilmeldinger og merknader som havner i samtalen har ingen beløp, ingen parenteser, og utløser aldri sensitivitetsklassifiseringen", () => {
    const texts = [
      blockedMessageNo("exhausted", "exhausted_closed", null, END), blockedMessageNo("deferred", "tight_background_deferred", at(9.7), END), blockedMessageNo("deferred", "tight_background_deferred", null, END),
      blockedMessageNo("deferred", "reserve_kept_for_essential", END, END), blockedMessageNo("deferred", "exhausted_hard_stop_off_background_deferred", END, END),
      claudeBudgetNoteNo("deny", "exhausted_closed", END), claudeBudgetNoteNo("defer", "reserve_kept_for_essential", END), claudeBudgetNoteNo("defer", "tight_background_deferred", END),
      claudeBudgetNoteNo("deny", "exhausted_closed", END, "jobben"), claudeBudgetNoteNo("defer", "tight_background_deferred", END, "jobben"),
      claudeBudgetNoteNo("defer", "exhausted_hard_stop_off_background_deferred", END, "jobben")
    ];
    for (const text of texts) {
      expect(classifyContentSensitivity({ texts: [text] }).sensitivity, text).toBe("PUBLIC_OR_LOW_SENSITIVITY");
      expect(text, text).not.toMatch(/[()]/);
      expect(text, text).not.toMatch(/\d+\s*(?:USD|kr|øre)/i);
      expect(text, text).not.toMatch(/budsjett/i);
    }
    for (const note of texts.slice(5)) expect(note.startsWith(CLAUDE_BUDGET_NOTE_PREFIX), note).toBe(true);
  });

  it("hard stopp AV: bakgrunn som utsettes fordi kreditten er brukt opp sier det (ikke «foran tempo»), og sier at hardstoppen er av - og notatet sier at perioden er brukt opp", () => {
    const blocked = blockedMessageNo("deferred", "exhausted_hard_stop_off_background_deferred", END, END);
    expect(blocked).toContain("brukt opp");
    expect(blocked).toContain("hardstoppen er av");
    expect(blocked).toContain("fornyes 15. desember");
    expect(blocked).not.toContain("foran periodens tempo");
    const note = claudeBudgetNoteNo("defer", "exhausted_hard_stop_off_background_deferred", END, "jobben");
    expect(note).toContain("perioden er brukt opp");
    expect(note).toContain("15. desember");
    expect(note).not.toContain("foran periodens tempo");
  });

  it("hard stopp uten lokalt alternativ gir et tydelig norsk svar som sier hva som skjedde, når det åpner igjen og hvordan eieren kan endre det", () => {
    const text = blockedMessageNo("exhausted", "exhausted_closed", END, END);
    expect(text).toContain("Claude-kreditten");
    expect(text).toContain("brukt opp");
    expect(text).toContain("ingen lokal modell");
    expect(text).toContain("fornyes 15. desember");
    expect(text).toContain("JARVIS_CLAUDE_BUDGET_USD");
    expect(text).toContain("JARVIS_CLAUDE_BUDGET_HARD_STOP=off");
  });

  it("datoformat er norsk (fornyelse 15. desember)", () => {
    expect(formatDateNo(END)).toBe("15. desember");
    expect(claudeBudgetNoteNo("deny", "exhausted_closed", END)).toContain("15. desember");
  });
});
