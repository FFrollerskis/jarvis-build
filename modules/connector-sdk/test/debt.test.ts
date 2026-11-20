import { describe, expect, it } from "vitest";
import {
  DEBT_FACTOR_IDS, DEFAULT_DEBT_THRESHOLDS, computeConnectorDebt, groupLedgerRows, summarizeConnectorDebt, type DebtInput
} from "../src/index.ts";

const NOW = new Date("2026-11-14T08:00:00.000Z");
const base = (over: Partial<DebtInput> = {}): DebtInput => ({
  connector_id: "acme", built: true, ledger: [], auth: { failures_in_window: 0, current_health: "healthy" }, sync: { lag_hours: 2, expected_interval_hours: 24 },
  api: { version_known: true, deprecation_documented: false }, ...over
});
const factor = (d: ReturnType<typeof computeConnectorDebt>, id: string) => d.factors.find((f) => f.id === id)!;

describe("connector-gjeld: ren lesemodell over vedlikeholdsjournal, auth-helse, synk og API-fakta", () => {
  it("de seks faktorene fra kap. 10 er med: auth-feil, API-endringer, vedlikeholdstimer, hendelser, synk-forsinkelse og utfasingsrisiko", () => {
    const d = computeConnectorDebt(base());
    expect(d.factors.map((f) => f.id)).toEqual([...DEBT_FACTOR_IDS]);
    expect([...DEBT_FACTOR_IDS]).toEqual(["auth_failures", "api_changes", "maintenance_hours", "incident_count", "sync_lag", "deprecation_risk"]);
  });

  it("ren connector: lav gjeld på det som er målt; utfasing er ukjent (aldri «ingen utfasing»), og ukjent teller ikke som null gjeld", () => {
    const d = computeConnectorDebt(base());
    expect(d.level).toBe("low");
    expect(d.score).toBe(0);
    expect(factor(d, "deprecation_risk").level).toBe("unknown");
    expect(factor(d, "deprecation_risk").detail_no).toContain("ukjent, ikke «ingen utfasing»");
    expect(d.unmeasured_factors).toEqual(["deprecation_risk"]);
    expect(d.measured_factors).toBe(5);
  });

  it("vedlikeholdstid: varsel fra 3 timer (Integrasjonssenterets 180 min), høy fra 8; hendelser og API-endringer telles per art", () => {
    const watch = computeConnectorDebt(base({ ledger: [{ event_kind: "manual_fix", events: 2, minutes: 200 }] }));
    expect(factor(watch, "maintenance_hours")).toMatchObject({ value: 3.3, level: "watch" });
    expect(watch.level).toBe("moderate");
    const high = computeConnectorDebt(base({ ledger: [{ event_kind: "upgrade", events: 1, minutes: 500 }] }));
    expect(factor(high, "maintenance_hours").level).toBe("high");
    expect(high.level).toBe("high");
    const kinds = computeConnectorDebt(base({ ledger: [{ event_kind: "incident", events: 1, minutes: 10 }, { event_kind: "outage", events: 2, minutes: 10 }, { event_kind: "api_change", events: 2, minutes: 30 }, { event_kind: "credential_rotation", events: 5, minutes: 5 }] }));
    expect(factor(kinds, "incident_count")).toMatchObject({ value: 3, level: "high" });
    expect(factor(kinds, "api_changes")).toMatchObject({ value: 2, level: "high" });
    expect(DEFAULT_DEBT_THRESHOLDS.maintenance_hours_watch * 60).toBe(180);
  });

  it("auth: feil i vinduet teller; en pågående auth-feil er alltid høy", () => {
    expect(factor(computeConnectorDebt(base({ auth: { failures_in_window: 1, current_health: "healthy" } })), "auth_failures").level).toBe("watch");
    expect(factor(computeConnectorDebt(base({ auth: { failures_in_window: 3, current_health: "healthy" } })), "auth_failures").level).toBe("high");
    const now = computeConnectorDebt(base({ auth: { failures_in_window: 0, current_health: "auth_failed" } }));
    expect(factor(now, "auth_failures")).toMatchObject({ level: "high" });
    expect(factor(now, "auth_failures").detail_no).toContain("akkurat nå");
  });

  it("synk-forsinkelse som multiplum av forventet intervall; ingen synk-jobb og ikke-målt forsinkelse er ukjent", () => {
    expect(factor(computeConnectorDebt(base({ sync: { lag_hours: 30, expected_interval_hours: 24 } })), "sync_lag").level).toBe("ok");
    expect(factor(computeConnectorDebt(base({ sync: { lag_hours: 40, expected_interval_hours: 24 } })), "sync_lag").level).toBe("watch");
    expect(factor(computeConnectorDebt(base({ sync: { lag_hours: 80, expected_interval_hours: 24 } })), "sync_lag").level).toBe("high");
    expect(factor(computeConnectorDebt(base({ sync: null })), "sync_lag").level).toBe("unknown");
    expect(factor(computeConnectorDebt(base({ sync: { lag_hours: null, expected_interval_hours: 24 } })), "sync_lag").level).toBe("unknown");
  });

  it("review LOW: ugyldige målinger (NaN, 0 eller negativt intervall, NaN/negativ/uendelig forsinkelse) er UKJENT - aldri stille «ok» (fail-open)", () => {
    const bad: Array<[string, { lag_hours: number | null; expected_interval_hours: number }]> = [
      ["NaN-intervall", { lag_hours: 80, expected_interval_hours: Number.NaN }],
      ["0-intervall (lag/0 = Infinity)", { lag_hours: 80, expected_interval_hours: 0 }],
      ["0 forsinkelse og 0 intervall (0/0 = NaN)", { lag_hours: 0, expected_interval_hours: 0 }],
      ["negativt intervall", { lag_hours: 80, expected_interval_hours: -24 }],
      ["NaN-forsinkelse", { lag_hours: Number.NaN, expected_interval_hours: 24 }],
      ["negativ forsinkelse", { lag_hours: -5, expected_interval_hours: 24 }],
      ["uendelig forsinkelse", { lag_hours: Number.POSITIVE_INFINITY, expected_interval_hours: 24 }],
      ["uendelig intervall", { lag_hours: 5, expected_interval_hours: Number.POSITIVE_INFINITY }]
    ];
    for (const [label, sync] of bad) {
      const d = computeConnectorDebt(base({ sync }));
      expect(factor(d, "sync_lag"), label).toMatchObject({ level: "unknown", value: null });
      expect(factor(d, "sync_lag").detail_no, label).toContain("ugyldig synk-måling");
      expect(d.unmeasured_factors, label).toContain("sync_lag");
      expect(d.measured_factors, label).toBe(4);
    }
    // Gyldige grenseverdier er fortsatt målinger: forsinkelse 0 mot et positivt intervall er «ok».
    expect(factor(computeConnectorDebt(base({ sync: { lag_hours: 0, expected_interval_hours: 24 } })), "sync_lag").level).toBe("ok");
    // Ugyldig auth-måling og ugyldig journal er også ukjent, aldri null gjeld.
    expect(factor(computeConnectorDebt(base({ auth: { failures_in_window: Number.NaN, current_health: "healthy" } })), "auth_failures")).toMatchObject({ level: "unknown", value: null });
    expect(factor(computeConnectorDebt(base({ auth: { failures_in_window: -1, current_health: "healthy" } })), "auth_failures").level).toBe("unknown");
    const badLedger = computeConnectorDebt(base({ ledger: [{ event_kind: "incident", events: Number.NaN, minutes: 10 }] }));
    for (const id of ["maintenance_hours", "incident_count", "api_changes"]) expect(factor(badLedger, id), id).toMatchObject({ level: "unknown", value: null });
    expect(factor(badLedger, "maintenance_hours").detail_no).toContain("ugyldige tall");
    const negLedger = computeConnectorDebt(base({ ledger: [{ event_kind: "manual_fix", events: 1, minutes: -600 }] }));
    expect(factor(negLedger, "maintenance_hours").level).toBe("unknown");
    // Alt ugyldig gir ukjent nivå, ikke «lav».
    const allBad = computeConnectorDebt(base({ ledger: [{ event_kind: "incident", events: Number.NaN, minutes: Number.NaN }], auth: { failures_in_window: Number.NaN, current_health: "healthy" }, sync: { lag_hours: Number.NaN, expected_interval_hours: 0 }, api: null }));
    expect(allBad.level).toBe("unknown");
    expect(allBad.score).toBeNull();
  });

  it("kjent utfasing er høy risiko; uten API-fakta er utfasing ukjent", () => {
    const d = computeConnectorDebt(base({ api: { version_known: true, deprecation_documented: true } }));
    expect(factor(d, "deprecation_risk")).toMatchObject({ level: "high", value: 1 });
    expect(d.level).toBe("high");
    expect(factor(computeConnectorDebt(base({ api: null })), "deprecation_risk").level).toBe("unknown");
  });

  it("ÆRLIGHET: uleselig journal og ingen målinger gir ukjent (aldri «ren»); for lite data gir level unknown uten score", () => {
    const d = computeConnectorDebt(base({ ledger: null, auth: null, sync: null, api: null }));
    expect(d.level).toBe("unknown");
    expect(d.score).toBeNull();
    expect(d.measured_factors).toBe(0);
    expect(d.unmeasured_factors).toEqual([...DEBT_FACTOR_IDS]);
    expect(d.recommendation_no).toContain("For lite målt");
    // Kun én faktor målt er fortsatt for lite.
    const one = computeConnectorDebt(base({ ledger: null, auth: { failures_in_window: 0, current_health: "healthy" }, sync: null, api: null }));
    expect(one.level).toBe("unknown");
    expect(one.measured_factors).toBe(1);
  });

  it("ubygd (backlog) connector har ingen gjeld å måle", () => {
    const d = computeConnectorDebt({ connector_id: "apple_music", built: false, ledger: null, auth: null, sync: null, api: null });
    expect(d).toMatchObject({ level: "unknown", score: null, review_for_retirement: false });
    expect(d.recommendation_no).toContain("backlog");
  });

  it("vedlikeholdsregelen (kap. 20): mye tid OG gjentatte hendelser gir «se på connectoren» - en oppfordring, aldri en beslutning", () => {
    const d = computeConnectorDebt(base({ ledger: [{ event_kind: "incident", events: 3, minutes: 600 }], maintenance_owner: "owner" }));
    expect(d.review_for_retirement).toBe(true);
    expect(d.recommendation_no).toContain("forenkle, erstatte eller avvikle");
    expect(d.recommendation_no).toContain("Vedlikeholdseier: owner");
    expect(computeConnectorDebt(base({ ledger: [{ event_kind: "incident", events: 1, minutes: 600 }] })).review_for_retirement).toBe(false);
    expect(computeConnectorDebt(base({ ledger: [{ event_kind: "manual_fix", events: 1, minutes: 600 }] })).review_for_retirement).toBe(false);
  });

  it("terskler kan overstyres, og funksjonen er ren (samme inndata = samme utdata, inndata muteres ikke)", () => {
    const input = base({ ledger: [{ event_kind: "manual_fix", events: 1, minutes: 120 }] });
    const frozen = JSON.stringify(input);
    expect(factor(computeConnectorDebt(input), "maintenance_hours").level).toBe("ok");
    expect(factor(computeConnectorDebt(input, { maintenance_hours_watch: 1 }), "maintenance_hours").level).toBe("watch");
    expect(JSON.stringify(computeConnectorDebt(input))).toBe(JSON.stringify(computeConnectorDebt(input)));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("sammenstilling: høyest gjeld først, ukjent sist, med navngitt liste over de som bør vurderes og de som ikke er målt", () => {
    const a = computeConnectorDebt(base({ connector_id: "a_low" }));
    const b = computeConnectorDebt(base({ connector_id: "b_high", ledger: [{ event_kind: "incident", events: 4, minutes: 700 }] }));
    const c = computeConnectorDebt(base({ connector_id: "c_unknown", ledger: null, auth: null, sync: null, api: null }));
    const s = summarizeConnectorDebt([a, c, b]);
    expect(s.ranked.map((d) => d.connector_id)).toEqual(["b_high", "a_low", "c_unknown"]);
    expect(s.by_level).toEqual({ low: 1, moderate: 0, high: 1, unknown: 1 });
    expect(s.review_for_retirement).toEqual(["b_high"]);
    expect(s.unknown_ids).toEqual(["c_unknown"]);
  });

  it("groupLedgerRows aggregerer rå journalrader per art innenfor vinduet (ukjent art = other; rader utenfor vinduet og ugyldige datoer ignoreres)", () => {
    const rows = [
      { event_kind: "incident", minutes: 30, occurred_at: "2026-11-10T00:00:00Z" },
      { event_kind: "incident", minutes: 15, occurred_at: "2026-11-12T00:00:00Z" },
      { event_kind: "mystery", minutes: 5, occurred_at: "2026-11-12T00:00:00Z" },
      { event_kind: "api_change", minutes: 60, occurred_at: "2026-09-01T00:00:00Z" },
      { event_kind: "upgrade", minutes: 10, occurred_at: "ikke-en-dato" },
      { event_kind: "manual_fix", minutes: 10, occurred_at: "2027-01-01T00:00:00Z" }
    ];
    const g = groupLedgerRows(rows, NOW);
    expect(g.find((x) => x.event_kind === "incident")).toEqual({ event_kind: "incident", events: 2, minutes: 45 });
    expect(g.find((x) => x.event_kind === "other")).toEqual({ event_kind: "other", events: 1, minutes: 5 });
    expect(g.map((x) => x.event_kind).sort()).toEqual(["incident", "other"]);
    expect(groupLedgerRows(rows, NOW, 365).some((x) => x.event_kind === "api_change")).toBe(true);
  });
});
