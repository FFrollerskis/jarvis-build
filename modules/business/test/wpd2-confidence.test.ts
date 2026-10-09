import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_RULE_VERSION, CONFIDENCE_V1, buildCalibrationReport, calibrationByType, computeLoopConfidence, corroboratesEachOther, isHeuristicLoopType, loopFamily,
  summarizeCalibration, type CalibrationObservation, type LoopConfidenceInput, type LoopOutcome
} from "../src/confidence.ts";
import { HEURISTIC_LOOP_TYPES, deterministicLoopConfidence } from "../src/open-loop-types.ts";

/**
 * WP-D2 (JARVIS-045): confidence fra flere signaler + kalibreringsrapport. Ren logikk - determinisme, grenser, «heuristikk kan ikke nå SUGGEST uten kalibrering»,
 * og at rapporten er ærlig om hva som er merket og ikke.
 */
const HARD = "overdue_followup";
const HEUR = "stalled_opportunity";
const input = (over: Partial<LoopConfidenceInput> = {}): LoopConfidenceInput => ({
  loop_type: HARD, persisted_days: 0, overdue_days: null, corroborating_domains: 0, intrinsic_signals: 0, calibration: null, ...over
});
const conf = (over: Partial<LoopConfidenceInput>): number => computeLoopConfidence(input(over)).confidence;

describe("A: uten ekstra signaler er confidence nøyaktig basisverdien (ingen stille endring av eksisterende oppførsel)", () => {
  it("hardt faktum 0.9, heuristikk 0.7, med tom forklaring", () => {
    for (const t of ["overdue_followup", "support_ticket_needs_reply", "contract_obligation_due", "finance_spend_unexpected", "bank_transaction_unmatched"]) {
      const r = computeLoopConfidence(input({ loop_type: t }));
      expect(r.confidence, t).toBe(0.9);
      expect(r.basis).toMatchObject({ rule_version: CONFIDENCE_RULE_VERSION, base: 0.9, adjustments: [], capped: null, calibrated: false, calibration_n: null, observed_hit_rate: null });
    }
    for (const t of HEURISTIC_LOOP_TYPES) {
      expect(conf({ loop_type: t }), t).toBe(0.7);
      expect(deterministicLoopConfidence(t)).toBe(0.7);
    }
    expect(isHeuristicLoopType("customer_churn_risk")).toBe(true);
    expect(isHeuristicLoopType("overdue_followup")).toBe(false);
  });
});

describe("B-E: hvert signal legger kun til, beste nivå gjelder (ikke kumulativt innen samme signal)", () => {
  it("persistens: < 3 dager ingenting, 3 dager +0.02, 7 dager +0.03", () => {
    expect(conf({ persisted_days: 2.9 })).toBe(0.9);
    expect(conf({ loop_type: HEUR, persisted_days: 3 })).toBe(0.72);
    expect(conf({ loop_type: HEUR, persisted_days: 6.99 })).toBe(0.72);
    expect(conf({ loop_type: HEUR, persisted_days: 7 })).toBe(0.73);
    expect(conf({ loop_type: HEUR, persisted_days: 400 })).toBe(0.73);
  });
  it("forfallsstørrelse (kun når frist finnes): 7 dager +0.01, 14 dager +0.02", () => {
    expect(conf({ overdue_days: null })).toBe(0.9);
    expect(conf({ overdue_days: 6.9 })).toBe(0.9);
    expect(conf({ overdue_days: 7 })).toBe(0.91);
    expect(conf({ overdue_days: 14 })).toBe(0.92);
    expect(conf({ overdue_days: 99 })).toBe(0.92);
  });
  it("uavhengig bekreftelse fra andre domener: 1 domene +0.03, 2+ domener +0.05", () => {
    expect(conf({ corroborating_domains: 0 })).toBe(0.9);
    expect(conf({ corroborating_domains: 1 })).toBe(0.93);
    expect(conf({ corroborating_domains: 2 })).toBe(0.95);
    expect(conf({ corroborating_domains: 9 })).toBe(0.95);
  });
  it("regelens egne uavhengige signalfamilier: +0.03 hver utover den første, maks to; negative/ugyldige tall gir ingenting", () => {
    expect(conf({ loop_type: HEUR, intrinsic_signals: 1 })).toBe(0.73);
    expect(conf({ loop_type: HEUR, intrinsic_signals: 2 })).toBe(0.74);
    expect(computeLoopConfidence(input({ loop_type: HEUR, intrinsic_signals: 5 })).basis.intrinsic_signals).toBe(2);
    expect(conf({ loop_type: HEUR, intrinsic_signals: -3 })).toBe(0.7);
  });
  it("forklaringen lister hver justering med kode, delta og begrunnelse", () => {
    const r = computeLoopConfidence(input({ persisted_days: 8, overdue_days: 15, corroborating_domains: 2, intrinsic_signals: 1 }));
    expect(r.basis.adjustments.map((a) => [a.code, a.delta])).toEqual([["persistence", 0.03], ["overdue_magnitude", 0.02], ["corroboration", 0.05], ["independent_signals", 0.03]]);
    for (const a of r.basis.adjustments) expect(a.note.length).toBeGreaterThan(10);
    expect(r.confidence).toBe(0.97); // 0.9 + 0.13 = 1.03 -> hardt tak
    expect(r.basis.capped).toBe("hard_ceiling");
  });
});

describe("F-G: tak - hardt faktum 0.97; ukalibrert heuristikk når ALDRI SUGGEST-terskelen", () => {
  it("hardt faktum kappes ved 0.97", () => {
    expect(conf({ persisted_days: 30, overdue_days: 30, corroborating_domains: 5, intrinsic_signals: 2 })).toBe(0.97);
  });
  it("heuristikk kappes ved 0.74 (under 0.75) uansett hvor mange signaler som slår ut - for ALLE heuristiske typer og alle kombinasjoner", () => {
    let combos = 0;
    for (const t of HEURISTIC_LOOP_TYPES) {
      for (const persisted of [0, 3, 7, 100]) for (const overdue of [null, 7, 14]) for (const corr of [0, 1, 2, 5]) for (const intr of [0, 1, 2]) {
        const r = computeLoopConfidence(input({ loop_type: t, persisted_days: persisted, overdue_days: overdue, corroborating_domains: corr, intrinsic_signals: intr }));
        combos += 1;
        expect(r.confidence, `${t}/${persisted}/${overdue}/${corr}/${intr}`).toBeLessThan(CONFIDENCE_V1.suggest_threshold);
        expect(r.confidence).toBeLessThanOrEqual(CONFIDENCE_V1.heuristic_ceiling);
      }
    }
    expect(combos).toBeGreaterThan(500);
    const capped = computeLoopConfidence(input({ loop_type: HEUR, persisted_days: 30, corroborating_domains: 5, intrinsic_signals: 2 }));
    expect(capped).toMatchObject({ confidence: 0.74 });
    expect(capped.basis.capped).toBe("heuristic_ceiling");
  });
  it("monotont: et nytt signal senker aldri confidence (ukalibrert)", () => {
    for (const t of [HARD, HEUR]) {
      let prev = conf({ loop_type: t });
      for (const step of [{ persisted_days: 3 }, { persisted_days: 7 }, { persisted_days: 7, overdue_days: 14 }, { persisted_days: 7, overdue_days: 14, corroborating_domains: 1 }, { persisted_days: 7, overdue_days: 14, corroborating_domains: 2, intrinsic_signals: 2 }]) {
        const now = conf({ loop_type: t, ...step });
        expect(now).toBeGreaterThanOrEqual(prev);
        prev = now;
      }
    }
  });
});

describe("H: kalibrering - krever nok merkede utfall, kan senke, og er eneste vei for en heuristikk til SUGGEST", () => {
  it("under 20 merkede utfall ignoreres kalibreringen helt", () => {
    const r = computeLoopConfidence(input({ calibration: { n_labelled: 19, hit_rate: 0.1 } }));
    expect(r.confidence).toBe(0.9);
    expect(r.basis).toMatchObject({ calibrated: false, calibration_n: 19, observed_hit_rate: null });
  });
  it("20 merkede utfall med treffrate 0.5 trekker 0.9 ned mot observert (vekt 20/70)", () => {
    const r = computeLoopConfidence(input({ calibration: { n_labelled: 20, hit_rate: 0.5 } }));
    expect(r.confidence).toBe(0.79);
    expect(r.basis.calibrated).toBe(true);
    expect(r.basis.adjustments.at(-1)).toMatchObject({ code: "calibration" });
    expect((r.basis.adjustments.at(-1) as { delta: number }).delta).toBeLessThan(0);
  });
  it("vekten er maks 0.5 uansett antall; treffrate 0 halverer et hardt faktum", () => {
    expect(conf({ calibration: { n_labelled: 100_000, hit_rate: 0 } })).toBe(0.45);
    expect(conf({ calibration: { n_labelled: 50, hit_rate: 0 } })).toBe(0.45);
  });
  it("heuristikk: høy observert treffrate (>= 0.75) løfter taket og kan nå SUGGEST; lavere treffrate gjør det ikke", () => {
    const good = computeLoopConfidence(input({ loop_type: HEUR, persisted_days: 7, corroborating_domains: 2, intrinsic_signals: 2, calibration: { n_labelled: 50, hit_rate: 0.9 } }));
    expect(good.confidence).toBeGreaterThanOrEqual(CONFIDENCE_V1.suggest_threshold);
    expect(good.basis.capped).toBeNull();
    const mediocre = computeLoopConfidence(input({ loop_type: HEUR, persisted_days: 7, corroborating_domains: 2, intrinsic_signals: 2, calibration: { n_labelled: 50, hit_rate: 0.7 } }));
    expect(mediocre.confidence).toBeLessThan(CONFIDENCE_V1.suggest_threshold);
    expect(mediocre.basis.capped).toBe("heuristic_ceiling");
    // for få utfall: taket løftes ikke selv om treffraten ser perfekt ut
    const thin = computeLoopConfidence(input({ loop_type: HEUR, persisted_days: 7, corroborating_domains: 2, intrinsic_signals: 2, calibration: { n_labelled: 19, hit_rate: 1 } }));
    expect(thin.confidence).toBeLessThan(CONFIDENCE_V1.suggest_threshold);
  });
  it("treffrate utenfor [0,1] klemmes, og resultatet er alltid innenfor [floor, ceiling] med to desimaler", () => {
    for (const hit of [-5, 0, 0.3, 1, 7]) {
      for (const t of [HARD, HEUR]) {
        const r = computeLoopConfidence(input({ loop_type: t, persisted_days: 10, calibration: { n_labelled: 80, hit_rate: hit } }));
        expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENCE_V1.floor);
        expect(r.confidence).toBeLessThanOrEqual(CONFIDENCE_V1.hard_ceiling);
        expect(Math.round(r.confidence * 100) / 100).toBe(r.confidence);
      }
    }
  });
});

describe("I: determinisme og renhet", () => {
  it("samme input gir identisk resultat og input muteres ikke", () => {
    const i = input({ loop_type: HEUR, persisted_days: 9, overdue_days: 8, corroborating_domains: 1, intrinsic_signals: 1, calibration: { n_labelled: 30, hit_rate: 0.8 } });
    const frozen = JSON.parse(JSON.stringify(i)) as LoopConfidenceInput;
    expect(computeLoopConfidence(i)).toEqual(computeLoopConfidence(JSON.parse(JSON.stringify(i)) as LoopConfidenceInput));
    expect(i).toEqual(frozen);
  });
});

describe("J: kalibreringsrapport", () => {
  const obs = (loop_type: string, confidence: number | null, outcome: LoopOutcome, n = 1): CalibrationObservation[] => Array.from({ length: n }, () => ({ loop_type, confidence, outcome }));

  it("overkonfident: forutsagt 0.9 mot observert 0.5 over 30 merkede utfall - treffrate, gap, Brier og pålitelighetsbøtter stemmer", () => {
    const report = buildCalibrationReport([...obs(HARD, 0.9, "acted", 15), ...obs(HARD, 0.9, "dismissed", 15)]);
    const t = report.by_type.find((x) => x.loop_type === HARD)!;
    expect(t).toMatchObject({ n_total: 30, n_labelled: 30, n_acted: 15, n_dismissed: 15, mean_confidence: 0.9, hit_rate: 0.5, gap: 0.4, brier: 0.41, verdict: "overconfident", heuristic: false });
    const bucket = t.buckets.find((b) => b.lower === 0.9)!;
    expect(bucket).toMatchObject({ n: 30, mean_confidence: 0.9, hit_rate: 0.5, upper: 1 });
    expect(t.buckets.filter((b) => b.n > 0)).toHaveLength(1);
    expect(report.notes.join("\n")).toContain("overkonfident");
    expect(report.overall).toMatchObject({ n_labelled: 30, verdict: "overconfident" });
  });

  it("godt kalibrert og underkonfident; heuristikk markeres", () => {
    const report = buildCalibrationReport([...obs(HEUR, 0.7, "acted", 28), ...obs(HEUR, 0.7, "dismissed", 12), ...obs("support_ticket_overdue", 0.5, "acted", 36), ...obs("support_ticket_overdue", 0.5, "dismissed", 4)]);
    const heur = report.by_type.find((x) => x.loop_type === HEUR)!;
    expect(heur).toMatchObject({ hit_rate: 0.7, gap: 0, verdict: "well_calibrated", heuristic: true });
    const sup = report.by_type.find((x) => x.loop_type === "support_ticket_overdue")!;
    expect(sup).toMatchObject({ hit_rate: 0.9, gap: -0.4, verdict: "underconfident" });
    expect(report.notes.join("\n")).toContain("underkonfident");
  });

  it("ærlig om hva som er umerket: forsvunnet-av-seg-selv, lukket uten utfall og åpne loops teller ikke som treff eller bom", () => {
    const report = buildCalibrationReport([
      ...obs(HARD, 0.9, "acted", 3), ...obs(HARD, 0.9, "dismissed", 1), ...obs(HARD, 0.9, "condition_cleared", 7), ...obs(HARD, 0.9, "unlabelled", 2), ...obs(HARD, 0.9, "open", 5)
    ]);
    const t = report.by_type[0]!;
    expect(t).toMatchObject({ n_total: 18, n_labelled: 4, n_acted: 3, n_dismissed: 1, n_condition_cleared: 7, n_unlabelled: 2, n_open: 5, hit_rate: 0.75, verdict: "insufficient_data" });
    expect(report.notes.join("\n")).toContain("4 av 13 lukkede loops har et merket utfall");
    expect(report.notes.join("\n")).toContain("for få merkede utfall (4 av 20");
  });

  it("merket utfall uten forutsagt confidence kan ikke sammenlignes og telles som umerket", () => {
    const g = summarizeCalibration([...obs(HARD, null, "acted", 3), ...obs(HARD, Number.NaN, "dismissed", 2)]);
    expect(g).toMatchObject({ n_total: 5, n_labelled: 0, n_unlabelled: 5, hit_rate: null, brier: null, verdict: "insufficient_data" });
  });

  it("tom rapport og kun-umerkede gir tydelige notater og ingen falske tall", () => {
    expect(buildCalibrationReport([]).notes[0]).toBe("Ingen loops å vurdere ennå.");
    expect(buildCalibrationReport([]).overall).toMatchObject({ n_total: 0, hit_rate: null, brier: null, mean_confidence: null, gap: null });
    const only = buildCalibrationReport(obs(HARD, 0.9, "unlabelled", 4));
    expect(only.notes[0]).toContain("Ingen av 4 lukkede loops har et merket utfall");
    expect(only.by_type[0]).toMatchObject({ hit_rate: null, verdict: "insufficient_data" });
  });

  it("rapporten endrer ingenting av seg selv og sier det", () => {
    expect(buildCalibrationReport(obs(HARD, 0.9, "acted", 25)).notes.at(-1)).toContain("NEEDS_TOBIAS");
  });

  it("brukerdefinert minimum (tester) og grensen akkurat ved min_samples", () => {
    const at = summarizeCalibration([...obs(HARD, 0.9, "acted", 10), ...obs(HARD, 0.9, "dismissed", 10)]);
    expect(at.verdict).toBe("overconfident"); // nøyaktig 20 = nok
    const below = summarizeCalibration([...obs(HARD, 0.9, "acted", 10), ...obs(HARD, 0.9, "dismissed", 9)]);
    expect(below.verdict).toBe("insufficient_data");
    expect(summarizeCalibration([...obs(HARD, 0.9, "acted", 3), ...obs(HARD, 0.9, "dismissed", 2)], 5).verdict).toBe("overconfident");
  });

  it("kalibreringsrapporten mates tilbake: kun typer med nok merkede utfall får et kalibreringsgrunnlag, og confidence faller for overkonfidente typer", () => {
    const report = buildCalibrationReport([...obs(HARD, 0.9, "acted", 15), ...obs(HARD, 0.9, "dismissed", 15), ...obs(HEUR, 0.7, "acted", 5)]);
    const map = calibrationByType(report);
    expect([...map.keys()]).toEqual([HARD]);
    expect(map.get(HARD)).toEqual({ n_labelled: 30, hit_rate: 0.5 });
    const before = conf({ loop_type: HARD });
    const after = conf({ loop_type: HARD, calibration: map.get(HARD) ?? null });
    expect(after).toBeLessThan(before);
    expect(conf({ loop_type: HEUR, calibration: map.get(HEUR) ?? null })).toBe(0.7); // ikke nok data -> uendret
  });
});

describe("K: uavhengig bekreftelse krever ulike familier (og churn/support dobbelttelles ikke)", () => {
  it("familiekart og korroborasjonsregel", () => {
    expect(loopFamily("overdue_followup")).toBe("pipeline");
    expect(loopFamily("stalled_opportunity")).toBe("pipeline");
    expect(loopFamily("support_ticket_overdue")).toBe("support");
    expect(loopFamily("contract_renewal_due")).toBe("contract");
    expect(loopFamily("product_item_needs_triage")).toBe("product");
    expect(loopFamily("operations_task_overdue")).toBe("operations");
    expect(loopFamily("customer_churn_risk")).toBe("retention");
    expect(loopFamily("marketing_spend_anomaly")).toBe("growth");
    expect(loopFamily("bank_consent_attention")).toBe("finance");
    expect(corroboratesEachOther("pipeline", "pipeline")).toBe(false);
    expect(corroboratesEachOther("retention", "support")).toBe(false);
    expect(corroboratesEachOther("support", "retention")).toBe(false);
    expect(corroboratesEachOther("retention", "pipeline")).toBe(true);
    expect(corroboratesEachOther("support", "contract")).toBe(true);
  });
});
