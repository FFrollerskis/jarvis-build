import { describe, expect, it } from "vitest";
import {
  ALLOWED_CHURN_FACTOR_CODES, CHURN_RISK_RULE_VERSION, CHURN_V1, assertNoProhibitedFactorCodes, calculateChurnRiskV1, churnLevelForScore, churnNextAction,
  describeChurnRisk, type ChurnSignals
} from "../src/index.ts";

/**
 * WP-D2 (UA-3 «churn/product usage»): ren regelmotor (churn_risk_v1). Determinisme, grenseverdier, forklarbarhet og at «ingen data» aldri blir et risikosignal.
 */
const base = (over: Partial<ChurnSignals> = {}): ChurnSignals => ({
  days_since_last_usage: 1, account_age_days: 120, usage_recent_14d: 100, usage_baseline_prev_14d: 100,
  open_support_tickets: 0, high_priority_open_tickets: 0, overdue_invoices: null, support_ticket_ids: [], billing_event_id: null, ...over
});
const codes = (s: Partial<ChurnSignals>): string[] => calculateChurnRiskV1(base(s)).factors.map((f) => f.code);

describe("A: determinisme og renhet", () => {
  it("samme input gir identisk resultat, og input muteres ikke", () => {
    const input = base({ days_since_last_usage: 40, open_support_tickets: 3, high_priority_open_tickets: 1, support_ticket_ids: ["t-1", "t-2"], overdue_invoices: 2, billing_event_id: "pue-1" });
    const frozen = JSON.parse(JSON.stringify(input)) as ChurnSignals;
    const a = calculateChurnRiskV1(input);
    const b = calculateChurnRiskV1(JSON.parse(JSON.stringify(input)) as ChurnSignals);
    expect(a).toEqual(b);
    expect(input).toEqual(frozen);
    expect(CHURN_RISK_RULE_VERSION).toBe("churn_risk_v1");
  });
  it("frisk konto uten signaler: score 0, nivå low, ingen faktorer, men IKKE «ingen data»", () => {
    const r = calculateChurnRiskV1(base());
    expect(r).toMatchObject({ score: 0, level: "low", factors: [], families: [], evidence: [] });
    expect(r.metrics.insufficient_data).toBe(false);
  });
});

describe("B: ingen bruksdata = ingen vurdering (fravær av data er aldri et signal)", () => {
  it("uten en eneste bruksobservasjon er score 0 uansett supportsaker og forfalte fakturaer", () => {
    const r = calculateChurnRiskV1(base({
      days_since_last_usage: null, account_age_days: null, usage_recent_14d: 0, usage_baseline_prev_14d: 0,
      open_support_tickets: 9, high_priority_open_tickets: 4, overdue_invoices: 7, support_ticket_ids: ["t-1"], billing_event_id: "pue-1"
    }));
    expect(r).toMatchObject({ score: 0, level: "low", factors: [], families: [], evidence: [] });
    expect(r.metrics).toMatchObject({ insufficient_data: true, days_since_last_usage: null, open_support_tickets: 9, overdue_invoices: 7 });
  });
});

describe("C: inaktivitet - eksakte terskler, gjensidig utelukkende", () => {
  it("13 dager: ingenting; 14: inactive_14d; 29: inactive_14d; 30: inactive_30d (aldri begge)", () => {
    expect(codes({ days_since_last_usage: 13, usage_recent_14d: 5, usage_baseline_prev_14d: 0 })).toEqual([]);
    expect(codes({ days_since_last_usage: 14, usage_recent_14d: 0 })).toEqual(["inactive_14d"]);
    expect(codes({ days_since_last_usage: 29, usage_recent_14d: 0 })).toEqual(["inactive_14d"]);
    expect(codes({ days_since_last_usage: 30, usage_recent_14d: 0 })).toEqual(["inactive_30d"]);
    expect(codes({ days_since_last_usage: 400, usage_recent_14d: 0 })).toEqual(["inactive_30d"]);
  });
  it("vekt og begrunnelse inneholder antall dager", () => {
    const r = calculateChurnRiskV1(base({ days_since_last_usage: 34, usage_recent_14d: 0 }));
    expect(r.factors).toEqual([{ code: "inactive_30d", label: "Ingen produktbruk på 34 dager", weight: 45, contribution: 45 }]);
    expect(r.score).toBe(45);
    expect(r.level).toBe("medium");
  });
});

describe("D: fall i bruk - kun med nok grunnlag, aldri dobbelttelt mot inaktivitet", () => {
  it("40 % fall = middels faktor, 70 % fall = høy faktor, 39 % = ingenting (heltallsavrunding nedover)", () => {
    expect(codes({ usage_recent_14d: 60, usage_baseline_prev_14d: 100 })).toEqual(["usage_drop_40pct"]);
    expect(codes({ usage_recent_14d: 61, usage_baseline_prev_14d: 100 })).toEqual([]);
    expect(codes({ usage_recent_14d: 30, usage_baseline_prev_14d: 100 })).toEqual(["usage_drop_70pct"]);
    expect(codes({ usage_recent_14d: 31, usage_baseline_prev_14d: 100 })).toEqual(["usage_drop_40pct"]);
  });
  it("eksakte prosentgrenser avrundes aldri feil pga. flyttall (55 av 100 = 45 % fall, ikke 44)", () => {
    expect(calculateChurnRiskV1(base({ usage_recent_14d: 55, usage_baseline_prev_14d: 100 })).metrics.usage_drop_pct).toBe(45);
    for (let baseline = 20; baseline <= 200; baseline += 1) {
      for (let recent = 0; recent < baseline; recent += 1) {
        const expected = Math.floor(((baseline - recent) * 100) / baseline);
        expect(calculateChurnRiskV1(base({ usage_recent_14d: recent, usage_baseline_prev_14d: baseline })).metrics.usage_drop_pct).toBe(expected);
      }
    }
  });
  it("for lite grunnlag (baseline < 20) eller for ung konto (< 28 dager) gir aldri et fall-signal", () => {
    expect(codes({ usage_recent_14d: 1, usage_baseline_prev_14d: 19 })).toEqual([]);
    expect(codes({ usage_recent_14d: 1, usage_baseline_prev_14d: 20 })).toEqual(["usage_drop_70pct"]);
    expect(codes({ usage_recent_14d: 1, usage_baseline_prev_14d: 100, account_age_days: 27 })).toEqual([]);
    expect(codes({ usage_recent_14d: 1, usage_baseline_prev_14d: 100, account_age_days: 28 })).toEqual(["usage_drop_70pct"]);
  });
  it("økt eller lik bruk er ikke et fall", () => {
    expect(codes({ usage_recent_14d: 100, usage_baseline_prev_14d: 100 })).toEqual([]);
    expect(codes({ usage_recent_14d: 500, usage_baseline_prev_14d: 100 })).toEqual([]);
  });
  it("tomt siste vindu (inaktiv) dekkes av inaktivitet og telles ikke som fall i tillegg, men vises i målene", () => {
    const r = calculateChurnRiskV1(base({ days_since_last_usage: 20, usage_recent_14d: 0, usage_baseline_prev_14d: 100 }));
    expect(r.factors.map((f) => f.code)).toEqual(["inactive_14d"]);
    expect(r.metrics.usage_drop_pct).toBe(100);
  });
  it("målet usage_drop_pct er null når grunnlaget er for lite eller bruken ikke har falt", () => {
    expect(calculateChurnRiskV1(base({ usage_baseline_prev_14d: 10 })).metrics.usage_drop_pct).toBeNull();
    expect(calculateChurnRiskV1(base({ usage_recent_14d: 150 })).metrics.usage_drop_pct).toBeNull();
    expect(calculateChurnRiskV1(base({ usage_recent_14d: 75 })).metrics.usage_drop_pct).toBe(25);
  });
});

describe("E: åpne supportsaker", () => {
  it("1-2 åpne = open_support_tickets (10), 3+ = many (20), høy prioritet legger til 10; evidens-id-er begrenses til 5", () => {
    expect(codes({ open_support_tickets: 0 })).toEqual([]);
    expect(codes({ open_support_tickets: 1 })).toEqual(["open_support_tickets"]);
    expect(codes({ open_support_tickets: 2 })).toEqual(["open_support_tickets"]);
    expect(codes({ open_support_tickets: 3 })).toEqual(["many_open_support_tickets"]);
    const r = calculateChurnRiskV1(base({ open_support_tickets: 7, high_priority_open_tickets: 2, support_ticket_ids: ["a", "b", "c", "d", "e", "f", "g"] }));
    expect(r.factors.map((f) => [f.code, f.contribution])).toEqual([["many_open_support_tickets", 20], ["high_priority_ticket_open", 10]]);
    expect(r.evidence).toEqual(["a", "b", "c", "d", "e"].map((id) => ({ type: "support_ticket", id })));
    expect(r.families).toEqual(["support"]);
  });
});

describe("F: forfalte fakturaer (siste billing_status)", () => {
  it("ukjent (null) og 0 gir ingenting; 1-2 = overdue_invoice (15); 3+ = many (25); evidens kun når scoret", () => {
    expect(codes({ overdue_invoices: null, billing_event_id: "pue-x" })).toEqual([]);
    expect(codes({ overdue_invoices: 0, billing_event_id: "pue-x" })).toEqual([]);
    expect(calculateChurnRiskV1(base({ overdue_invoices: 0, billing_event_id: "pue-x" })).evidence).toEqual([]);
    expect(codes({ overdue_invoices: 1 })).toEqual(["overdue_invoice"]);
    expect(codes({ overdue_invoices: 2 })).toEqual(["overdue_invoice"]);
    expect(codes({ overdue_invoices: 3 })).toEqual(["many_overdue_invoices"]);
    const r = calculateChurnRiskV1(base({ overdue_invoices: 4, billing_event_id: "pue-x" }));
    expect(r.evidence).toEqual([{ type: "billing_event", id: "pue-x" }]);
    expect(r.families).toEqual(["billing"]);
  });
});

describe("G: score, nivå og forklarbarhet", () => {
  it("nivågrenser: 29 low, 30 medium, 54 medium, 55 high", () => {
    expect([29, 30, 54, 55].map(churnLevelForScore)).toEqual(["low", "medium", "medium", "high"]);
    expect(CHURN_V1.level_medium).toBe(30);
    expect(CHURN_V1.level_high).toBe(55);
  });
  it("eksempler: 25 = low; 25+15 = 40 = medium; 45+10 = 55 = high (nøyaktig grensen)", () => {
    expect(calculateChurnRiskV1(base({ days_since_last_usage: 14, usage_recent_14d: 0 }))).toMatchObject({ score: 25, level: "low" });
    expect(calculateChurnRiskV1(base({ days_since_last_usage: 14, usage_recent_14d: 0, overdue_invoices: 1 }))).toMatchObject({ score: 40, level: "medium" });
    expect(calculateChurnRiskV1(base({ days_since_last_usage: 30, usage_recent_14d: 0, open_support_tickets: 1 }))).toMatchObject({ score: 55, level: "high" });
  });
  it("høyeste mulige score er nøyaktig 100 (aldri over), og hver faktor har contribution = weight", () => {
    const r = calculateChurnRiskV1(base({
      days_since_last_usage: 90, usage_recent_14d: 0, open_support_tickets: 5, high_priority_open_tickets: 5, overdue_invoices: 9, support_ticket_ids: ["t"], billing_event_id: "b"
    }));
    expect(r.score).toBe(100);
    expect(r.families.slice().sort()).toEqual(["billing", "support", "usage"]);
    for (const f of r.factors) expect(f.contribution).toBe(f.weight);
    expect(r.factors.reduce((s, f) => s + f.contribution, 0)).toBe(100);
  });
  it("hver faktor er forklart: kode fra hvitelisten, ikke-tom begrunnelse, positiv vekt", () => {
    const r = calculateChurnRiskV1(base({ days_since_last_usage: 45, usage_recent_14d: 0, open_support_tickets: 3, high_priority_open_tickets: 1, overdue_invoices: 3 }));
    expect(r.factors.length).toBeGreaterThanOrEqual(4);
    for (const f of r.factors) {
      expect(ALLOWED_CHURN_FACTOR_CODES as readonly string[]).toContain(f.code);
      expect(f.label.length).toBeGreaterThan(5);
      expect(f.weight).toBeGreaterThan(0);
    }
  });
  it("rekkefølgen er deterministisk: bruk, support, fakturering", () => {
    const r = calculateChurnRiskV1(base({ days_since_last_usage: 45, usage_recent_14d: 0, open_support_tickets: 1, overdue_invoices: 1 }));
    expect(r.factors.map((f) => f.code)).toEqual(["inactive_30d", "open_support_tickets", "overdue_invoice"]);
  });
});

describe("H: rutenett - invarianter holder for alle kombinasjoner", () => {
  it("score er heltall i [0,100], nivå følger score, faktorsum = score, alle koder tillatt", () => {
    let n = 0;
    for (const days of [null, 0, 5, 13, 14, 29, 30, 100]) for (const recent of [0, 5, 60, 100]) for (const baseline of [0, 19, 20, 100]) {
      for (const tickets of [0, 1, 2, 3, 10]) for (const high of [0, 1]) for (const overdue of [null, 0, 1, 3]) for (const age of [null, 10, 28, 200]) {
        const r = calculateChurnRiskV1({
          days_since_last_usage: days, account_age_days: age, usage_recent_14d: recent, usage_baseline_prev_14d: baseline,
          open_support_tickets: tickets, high_priority_open_tickets: Math.min(high, tickets), overdue_invoices: overdue, support_ticket_ids: [], billing_event_id: null
        });
        n += 1;
        expect(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100).toBe(true);
        expect(r.level).toBe(churnLevelForScore(r.score));
        expect(r.factors.reduce((s, f) => s + f.contribution, 0)).toBe(r.score);
        for (const f of r.factors) expect(ALLOWED_CHURN_FACTOR_CODES as readonly string[]).toContain(f.code);
        if (days === null) expect(r.score).toBe(0);
        // inaktivitet og fall i bruk teller aldri begge
        const usageCodes = r.factors.filter((f) => /^(inactive|usage_drop)/.test(f.code));
        expect(usageCodes.length).toBeLessThanOrEqual(1);
      }
    }
    expect(n).toBeGreaterThan(5000);
  });
});

describe("I: personvern - ingen faktorkode kan referere en beskyttet trekk-kategori", () => {
  it("hvitelisten passerer forbudsvakten; en forbudt kode kastes", () => {
    expect(() => assertNoProhibitedFactorCodes(ALLOWED_CHURN_FACTOR_CODES)).not.toThrow();
    expect(() => assertNoProhibitedFactorCodes(["inactive_30d", "health_status"])).toThrowError(/prohibited_factor_code_detected/);
    expect(() => assertNoProhibitedFactorCodes(["gender_bias"])).toThrowError(/prohibited_factor_code_detected/);
  });
  it("inputtypen har ingen person-/bruker-felt (kun aggregerte tall og id-er til supportsaker/faktura)", () => {
    const keys = Object.keys(base()).sort();
    expect(keys).toEqual([
      "account_age_days", "billing_event_id", "days_since_last_usage", "high_priority_open_tickets", "open_support_tickets", "overdue_invoices",
      "support_ticket_ids", "usage_baseline_prev_14d", "usage_recent_14d"
    ]);
    for (const k of keys) expect(k).not.toMatch(/user|person|email|name|phone|ip_/);
  });
});

describe("J: tekster til open loop-en", () => {
  it("entall/flertall på norsk og nivåord", () => {
    const one = calculateChurnRiskV1(base({ days_since_last_usage: 30, usage_recent_14d: 0, open_support_tickets: 1, high_priority_open_tickets: 1, overdue_invoices: 1 }));
    expect(describeChurnRisk(one)).toBe("Churn-risiko høy (80/100): Ingen produktbruk på 30 dager; 1 åpen supportsak; 1 åpen sak med høy prioritet; 1 forfalt faktura.");
    const many = calculateChurnRiskV1(base({ days_since_last_usage: 20, usage_recent_14d: 0, open_support_tickets: 2, high_priority_open_tickets: 2, overdue_invoices: 2 }));
    expect(describeChurnRisk(many)).toBe("Churn-risiko høy (60/100): Ingen produktbruk på 20 dager; 2 åpne supportsaker; 2 åpene saker med høy prioritet; 2 forfalte fakturaer.");
    expect(describeChurnRisk({ score: 40, level: "medium", factors: [{ code: "x", label: "L", weight: 1, contribution: 1 }] })).toBe("Churn-risiko middels (40/100): L.");
  });
  it("neste handling tilpasses signalene og er deterministisk tekst", () => {
    const plain = calculateChurnRiskV1(base({ days_since_last_usage: 30, usage_recent_14d: 0 }));
    expect(churnNextAction(plain)).toBe("Ta kontakt med kunden og avklar bruk og eventuelle hindringer.");
    const full = calculateChurnRiskV1(base({ days_since_last_usage: 30, usage_recent_14d: 0, open_support_tickets: 1, overdue_invoices: 1 }));
    expect(churnNextAction(full)).toBe("Ta kontakt med kunden og avklar bruk og eventuelle hindringer; følg opp forfalte fakturaer; løs de åpne supportsakene.");
  });
});
