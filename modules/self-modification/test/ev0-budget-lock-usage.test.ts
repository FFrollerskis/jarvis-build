import { describe, expect, it } from "vitest";
import {
  BudgetLock, EVOLUTION_COST_CATEGORIES, startOfUtcDay, startOfUtcHour, startOfUtcIsoWeek, startOfUtcMonth, type BudgetCaps, type BudgetVerdict, type LedgerCounter,
  type UsageCounter, type UsageKind
} from "../src/index.ts";

/**
 * WP-EV0 (HF2 EV-0, K5): BudgetLock mot forbruksregisteret - deploys pr TIME (i tillegg til døgn), kostnad pr KATEGORI (+ totalt) og eier-tid (uke + pr endring).
 * Alt fail-closed: ukjent/ugyldig forbruk, manglende kilde, feil ved lesing eller ugyldige tak gir «ikke tillatt». Ren logikk med fiktive tellere.
 */
const CAPS: BudgetCaps = {
  max_auto_merges_per_day: 5, max_deploys_per_day: 4, max_deploys_per_hour: 2, max_owner_proposals_per_day: 6, max_evolution_cost_ore_per_month: 1000,
  max_radar_cost_ore_per_month: 100, max_eval_cost_ore_per_month: 200, max_redteam_cost_ore_per_month: 150, max_shadow_cost_ore_per_month: 250, max_review_cost_ore_per_month: 300,
  owner_time_budget_minutes_per_week: 120, max_owner_minutes_per_autonomous_change: 20
};
const NOW = "2026-12-09T12:30:45.678Z"; // onsdag
const fixed = (iso: string) => () => new Date(iso);

interface CountCall { since: string; decisions: readonly string[]; classes: readonly string[] }
const ledgerBy = (bySince: Record<string, number>, calls: CountCall[] = []): LedgerCounter => ({
  countSince: async (since, decisions, classes) => { calls.push({ since, decisions, classes }); return bySince[since] ?? 0; }
});
const ledgerConst = (n: unknown): LedgerCounter => ({ countSince: async () => n as number });

interface SumCall { kind: UsageKind; categories: readonly string[] | null; since: string }
const usageOf = (opts: { spend?: Partial<Record<string, number>>; ownerWeek?: number; byChange?: Record<string, number>; calls?: SumCall[] }): UsageCounter => ({
  sumSince: async (kind, categories, since) => {
    opts.calls?.push({ kind, categories, since });
    if (kind === "spend") {
      const entries = Object.entries(opts.spend ?? {});
      return entries.filter(([c]) => categories === null || categories.includes(c)).reduce((n, [, v]) => n + (v ?? 0), 0);
    }
    return opts.ownerWeek ?? 0;
  },
  sumForChange: async (_kind, changeId) => opts.byChange?.[changeId] ?? 0
});
const lock = (usage?: UsageCounter, ledger: LedgerCounter = ledgerConst(0), caps: BudgetCaps = CAPS, now = NOW) => new BudgetLock(caps, ledger, fixed(now), usage);
const failed = (v: BudgetVerdict): boolean => !v.allowed && v.reason === "budget_check_failed";

describe("A: vindusstart - time, døgn, måned og ISO-uke (alt UTC)", () => {
  it("A1: hele timen, døgnet og kalendermåneden", () => {
    expect(startOfUtcHour(new Date("2026-12-09T12:59:59.999Z"))).toBe("2026-12-09T12:00:00.000Z");
    expect(startOfUtcHour(new Date("2026-12-09T13:00:00.000Z"))).toBe("2026-12-09T13:00:00.000Z");
    expect(startOfUtcHour(new Date("2026-12-09T00:00:00.000Z"))).toBe("2026-12-09T00:00:00.000Z");
    expect(startOfUtcDay(new Date("2026-12-09T23:59:59.999Z"))).toBe("2026-12-09T00:00:00.000Z");
    expect(startOfUtcMonth(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-01T00:00:00.000Z");
    expect(startOfUtcMonth(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01-01T00:00:00.000Z");
    expect(startOfUtcMonth(new Date("2026-02-28T12:00:00.000Z"))).toBe("2026-02-01T00:00:00.000Z");
  });

  it("A2: ISO-uken starter mandag 00:00 UTC (søndag 23:59:59.999 hører til forrige mandag, mandag 00:00:00.000 starter ny uke, også over årsskifte)", () => {
    expect(startOfUtcIsoWeek(new Date("2026-12-09T12:00:00.000Z"))).toBe("2026-12-07T00:00:00.000Z"); // onsdag
    expect(startOfUtcIsoWeek(new Date("2026-12-13T23:59:59.999Z"))).toBe("2026-12-07T00:00:00.000Z"); // søndag
    expect(startOfUtcIsoWeek(new Date("2026-12-14T00:00:00.000Z"))).toBe("2026-12-14T00:00:00.000Z"); // mandag
    expect(startOfUtcIsoWeek(new Date("2026-12-07T00:00:00.000Z"))).toBe("2026-12-07T00:00:00.000Z");
    expect(startOfUtcIsoWeek(new Date("2027-01-01T10:00:00.000Z"))).toBe("2026-12-28T00:00:00.000Z"); // fredag over årsskiftet
    expect(startOfUtcIsoWeek(new Date("2026-03-01T00:00:00.000Z"))).toBe("2026-02-23T00:00:00.000Z"); // søndag over månedsskiftet
  });

  it("A3: en ugyldig dato kaster (og blir «ikke tillatt» i låsene, se E)", () => {
    for (const f of [startOfUtcHour, startOfUtcMonth, startOfUtcIsoWeek, startOfUtcDay]) expect(() => f(new Date(Number.NaN))).toThrow();
  });
});

describe("B: deploys pr TIME og pr døgn", () => {
  const HOUR = "2026-12-09T12:00:00.000Z";
  const DAY = "2026-12-09T00:00:00.000Z";

  it("B1: checkDeployHour teller `deployed` (E0/E1/E2) siden hel time mot max_deploys_per_hour (under slipper, ved grensen stopper)", async () => {
    const calls: CountCall[] = [];
    expect(await lock(undefined, ledgerBy({ [HOUR]: 1 }, calls)).checkDeployHour()).toMatchObject({ allowed: true, kind: "deploy_hour", used: 1, limit: 2, remaining: 1 });
    expect(calls).toEqual([{ since: HOUR, decisions: ["deployed"], classes: ["E0", "E1", "E2"] }]);
    expect(await lock(undefined, ledgerBy({ [HOUR]: 2 })).checkDeployHour()).toMatchObject({ allowed: false, kind: "deploy_hour", reason: "budget_exhausted", used: 2, limit: 2 });
    expect(await lock(undefined, ledgerBy({ [HOUR]: 7 })).checkDeployHour()).toMatchObject({ allowed: false, reason: "budget_exhausted" });
  });

  it("B2: timegrensen bruker timevinduet, ikke døgnvinduet (en deploy for 5 timer siden teller ikke mot timen)", async () => {
    const v = await lock(undefined, ledgerBy({ [DAY]: 3, [HOUR]: 0 })).checkDeployHour();
    expect(v).toMatchObject({ allowed: true, used: 0 });
  });

  it("B3: checkDeploy sjekker BEGGE vinduer: døgn først (kind deploy), så time (kind deploy_hour); begge ok gir minste gjenstående", async () => {
    expect(await lock(undefined, ledgerBy({ [DAY]: 4, [HOUR]: 0 })).checkDeploy()).toMatchObject({ allowed: false, kind: "deploy", reason: "budget_exhausted", used: 4, limit: 4 });
    expect(await lock(undefined, ledgerBy({ [DAY]: 1, [HOUR]: 2 })).checkDeploy()).toMatchObject({ allowed: false, kind: "deploy_hour", reason: "budget_exhausted", used: 2, limit: 2 });
    expect(await lock(undefined, ledgerBy({ [DAY]: 4, [HOUR]: 2 })).checkDeploy()).toMatchObject({ allowed: false, kind: "deploy" });
    expect(await lock(undefined, ledgerBy({ [DAY]: 3, [HOUR]: 1 })).checkDeploy()).toMatchObject({ allowed: true, kind: "deploy", used: 3, limit: 4, remaining: 1 });
    expect(await lock(undefined, ledgerBy({ [DAY]: 0, [HOUR]: 0 })).checkDeploy()).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("B4: timevinduet følger klokka: 12:59:59.999 og 13:00:00.000 gir ulike vinduer", async () => {
    const calls: CountCall[] = [];
    await lock(undefined, ledgerBy({}, calls), CAPS, "2026-12-09T12:59:59.999Z").checkDeployHour();
    await lock(undefined, ledgerBy({}, calls), CAPS, "2026-12-09T13:00:00.000Z").checkDeployHour();
    expect(calls.map((c) => c.since)).toEqual(["2026-12-09T12:00:00.000Z", "2026-12-09T13:00:00.000Z"]);
  });

  it("B5: grense 0 stenger alltid (time og døgn)", async () => {
    expect((await lock(undefined, ledgerConst(0), { ...CAPS, max_deploys_per_hour: 0 }).checkDeployHour()).allowed).toBe(false);
    expect((await lock(undefined, ledgerConst(0), { ...CAPS, max_deploys_per_day: 0, max_deploys_per_hour: 0 }).checkDeploy()).allowed).toBe(false);
  });
});

describe("C: kostnad pr KATEGORI og totalt (måned)", () => {
  const MONTH = "2026-12-01T00:00:00.000Z";

  it("C1: hver kategori bruker SITT tak (ulike tak i testen): radar 100, eval 200, redteam 150, shadow 250, review 300", async () => {
    const limits: Record<string, number> = { radar: 100, eval: 200, redteam: 150, shadow: 250, review: 300 };
    for (const c of EVOLUTION_COST_CATEGORIES) {
      const l = limits[c]!;
      expect(await lock(usageOf({ spend: { [c]: l - 10 } })).checkCategorySpend(c, 10), c).toMatchObject({ allowed: true, kind: "category_spend", used: l - 10, limit: l, remaining: 0, scope: `category:${c}` });
      expect(await lock(usageOf({ spend: { [c]: l - 10 } })).checkCategorySpend(c, 11), c).toMatchObject({ allowed: false, reason: "budget_exhausted", used: l - 10, limit: l, scope: `category:${c}` });
    }
  });

  it("C2: forbruk i ANDRE kategorier påvirker ikke kategoritaket (kun totalen)", async () => {
    expect(await lock(usageOf({ spend: { eval: 200, shadow: 250 } })).checkCategorySpend("radar", 100)).toMatchObject({ allowed: true, scope: "category:radar", remaining: 0 });
  });

  it("C3: totaltaket binder når summen av ALLE kategorier + forespørsel overstiger det (selv om kategoritaket ikke er nådd)", async () => {
    const caps = { ...CAPS, max_evolution_cost_ore_per_month: 400 };
    const spend = { eval: 200, shadow: 150 }; // totalt 350
    expect(await lock(usageOf({ spend }), undefined, caps).checkCategorySpend("radar", 50)).toMatchObject({ allowed: true, scope: "total", used: 350, limit: 400, remaining: 0 });
    expect(await lock(usageOf({ spend }), undefined, caps).checkCategorySpend("radar", 51)).toMatchObject({ allowed: false, reason: "budget_exhausted", scope: "total", used: 350, limit: 400 });
  });

  it("C4: kategori først, så total: begge over gir kategori-verdikten; kun total over gir total", async () => {
    const caps = { ...CAPS, max_evolution_cost_ore_per_month: 120 };
    expect(await lock(usageOf({ spend: { radar: 90, eval: 30 } }), undefined, caps).checkCategorySpend("radar", 20)).toMatchObject({ allowed: false, scope: "category:radar" });
    expect(await lock(usageOf({ spend: { radar: 50, eval: 60 } }), undefined, caps).checkCategorySpend("radar", 20)).toMatchObject({ allowed: false, scope: "total", used: 110, limit: 120 });
  });

  it("C5: tellingen bruker kalendermåneden (UTC), og totalen leses uten kategorifilter", async () => {
    const calls: SumCall[] = [];
    await lock(usageOf({ calls }), undefined, CAPS, "2026-12-31T23:59:59.999Z").checkCategorySpend("eval", 1);
    expect(calls).toEqual([{ kind: "spend", categories: ["eval"], since: MONTH }, { kind: "spend", categories: null, since: MONTH }]);
  });

  it("C6: forespørsel 0 er tillatt når kategorien ikke er over taket; negativ/brøk/NaN/Infinity/ikke-tall avvises (fail-closed)", async () => {
    expect((await lock(usageOf({ spend: { radar: 100 } })).checkCategorySpend("radar", 0)).allowed).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number, undefined as unknown as number]) {
      expect(failed(await lock(usageOf({})).checkCategorySpend("radar", bad)), String(bad)).toBe(true);
    }
  });

  it("C7: ukjent kategori avvises (fail-closed) - også prototype-navn og feil store/små bokstaver", async () => {
    for (const bad of ["total", "Radar", "constructor", "__proto__", "", "radar "]) {
      expect(failed(await lock(usageOf({})).checkCategorySpend(bad as never, 1)), bad).toBe(true);
    }
  });
});

describe("D: eier-tid - uke (ISO, mandag 00:00 UTC) og pr autonom endring", () => {
  const WEEK = "2026-12-07T00:00:00.000Z";

  it("D1: ukebudsjettet: under slipper, nøyaktig opp til taket slipper, ett minutt over stopper", async () => {
    expect(await lock(usageOf({ ownerWeek: 100 })).checkOwnerTime(20)).toMatchObject({ allowed: true, kind: "owner_time", used: 100, limit: 120, remaining: 0, scope: "week" });
    expect(await lock(usageOf({ ownerWeek: 100 })).checkOwnerTime(21)).toMatchObject({ allowed: false, reason: "budget_exhausted", used: 100, limit: 120, scope: "week" });
    expect(await lock(usageOf({ ownerWeek: 0 })).checkOwnerTime(0)).toMatchObject({ allowed: true });
  });

  it("D2: pr endring: summen for endringen + forespørsel mot max_owner_minutes_per_autonomous_change; andre endringer teller ikke", async () => {
    const usage = usageOf({ ownerWeek: 10, byChange: { "chg-a": 15, "chg-b": 1 } });
    expect(await lock(usage).checkOwnerTime(5, "chg-a")).toMatchObject({ allowed: true, scope: "change", used: 15, limit: 20, remaining: 0 });
    expect(await lock(usage).checkOwnerTime(6, "chg-a")).toMatchObject({ allowed: false, reason: "budget_exhausted", scope: "change", used: 15, limit: 20 });
    expect(await lock(usage).checkOwnerTime(6, "chg-b")).toMatchObject({ allowed: true });
    expect(await lock(usage).checkOwnerTime(6, "chg-ukjent")).toMatchObject({ allowed: true });
  });

  it("D3: uten endrings-id sjekkes kun uken; med endrings-id sjekkes begge, og uken vinner når den er nådd først", async () => {
    expect(await lock(usageOf({ ownerWeek: 110, byChange: { c: 100 } })).checkOwnerTime(5)).toMatchObject({ allowed: true, scope: "week" });
    expect(await lock(usageOf({ ownerWeek: 119, byChange: { c: 0 } })).checkOwnerTime(5, "c")).toMatchObject({ allowed: false, scope: "week" });
  });

  it("D4: tellingen bruker ISO-ukens start (mandag 00:00 UTC)", async () => {
    const calls: SumCall[] = [];
    await lock(usageOf({ calls }), undefined, CAPS, "2026-12-13T23:59:59.999Z").checkOwnerTime(1);
    await lock(usageOf({ calls }), undefined, CAPS, "2026-12-14T00:00:00.000Z").checkOwnerTime(1);
    expect(calls).toEqual([{ kind: "owner_time", categories: null, since: WEEK }, { kind: "owner_time", categories: null, since: "2026-12-14T00:00:00.000Z" }]);
  });

  it("D5: ugyldig forespørsel (negativ, brøk, NaN, ikke-tall) eller tom endrings-id avvises lukket", async () => {
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number]) expect(failed(await lock(usageOf({})).checkOwnerTime(bad)), String(bad)).toBe(true);
    for (const bad of ["", "   ", 5 as unknown as string]) expect(failed(await lock(usageOf({})).checkOwnerTime(1, bad)), String(bad)).toBe(true);
  });
});

describe("E: fail-closed - alt som ikke kan måles trygt er «ikke tillatt»", () => {
  it("E1: uten forbruksregister (usage) kan verken kategori-kostnad eller eier-tid sjekkes - avvist", async () => {
    expect(failed(await lock(undefined).checkCategorySpend("radar", 1))).toBe(true);
    expect(failed(await lock(undefined).checkOwnerTime(1))).toBe(true);
  });

  it("E2: feil ved lesing (kast) gir budget_check_failed for ALLE sjekker", async () => {
    const boom: UsageCounter = { sumSince: async () => { throw new Error("db nede"); }, sumForChange: async () => { throw new Error("db nede"); } };
    const boomLedger: LedgerCounter = { countSince: async () => { throw new Error("db nede"); } };
    expect(failed(await lock(boom).checkCategorySpend("radar", 1))).toBe(true);
    expect(failed(await lock(boom).checkOwnerTime(1))).toBe(true);
    expect(failed(await lock(boom).checkOwnerTime(1, "c"))).toBe(true);
    expect(failed(await lock(undefined, boomLedger).checkDeployHour())).toBe(true);
    expect(failed(await lock(undefined, boomLedger).checkDeploy())).toBe(true);
    expect(failed(await lock(undefined, boomLedger).checkAutoMerge())).toBe(true);
    expect(failed(await lock(undefined, boomLedger).checkOwnerProposal())).toBe(true);
  });

  it("E3: ugyldige tellerverdier (NaN, negativ, brøk, uendelig, streng, null) gir budget_check_failed - aldri «tillatt»", async () => {
    for (const bad of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY, "3", null, undefined]) {
      const l = lock(undefined, ledgerConst(bad));
      expect(failed(await l.checkDeployHour()), `hour ${String(bad)}`).toBe(true);
      expect(failed(await l.checkDeploy()), `deploy ${String(bad)}`).toBe(true);
      expect(failed(await l.checkAutoMerge()), `auto ${String(bad)}`).toBe(true);
      expect(failed(await l.checkOwnerProposal()), `prop ${String(bad)}`).toBe(true);
      const u: UsageCounter = { sumSince: async () => bad as number, sumForChange: async () => bad as number };
      expect(failed(await lock(u).checkCategorySpend("radar", 1)), `cat ${String(bad)}`).toBe(true);
      expect(failed(await lock(u).checkOwnerTime(1, "c")), `owner ${String(bad)}`).toBe(true);
    }
  });

  it("E4: et inkonsistent register (kategori-sum større enn total-sum) avvises lukket", async () => {
    const u: UsageCounter = { sumSince: async (_k, categories) => (categories === null ? 10 : 20), sumForChange: async () => 0 };
    expect(failed(await lock(u).checkCategorySpend("radar", 1))).toBe(true);
  });

  it("E5: ugyldige tak (negative, NaN, brøk) i en håndbygd lås avvises lukket - aldri «ubegrenset»", async () => {
    for (const bad of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(failed(await lock(undefined, ledgerConst(0), { ...CAPS, max_deploys_per_hour: bad }).checkDeployHour()), String(bad)).toBe(true);
      expect(failed(await lock(undefined, ledgerConst(0), { ...CAPS, max_auto_merges_per_day: bad }).checkAutoMerge()), String(bad)).toBe(true);
      expect(failed(await lock(usageOf({}), undefined, { ...CAPS, max_radar_cost_ore_per_month: bad }).checkCategorySpend("radar", 1)), String(bad)).toBe(true);
      expect(failed(await lock(usageOf({}), undefined, { ...CAPS, max_evolution_cost_ore_per_month: bad }).checkCategorySpend("radar", 1)), String(bad)).toBe(true);
      expect(failed(await lock(usageOf({}), undefined, { ...CAPS, owner_time_budget_minutes_per_week: bad }).checkOwnerTime(1)), String(bad)).toBe(true);
      expect(failed(await lock(usageOf({}), undefined, { ...CAPS, max_owner_minutes_per_autonomous_change: bad }).checkOwnerTime(1)), String(bad)).toBe(true);
    }
  });

  it("E6: en ugyldig klokke (Invalid Date) gir budget_check_failed i alle sjekker (kaster ikke ut til kalleren)", async () => {
    const badClock = new BudgetLock(CAPS, ledgerConst(0), () => new Date(Number.NaN), usageOf({}));
    for (const v of [await badClock.checkAutoMerge(), await badClock.checkDeploy(), await badClock.checkDeployHour(), await badClock.checkOwnerProposal(), await badClock.checkCategorySpend("radar", 1), await badClock.checkOwnerTime(1)]) {
      expect(failed(v)).toBe(true);
    }
  });

  it("E7: eksisterende checkSpend er uendret (total, pure) - og fromConstitution tar med forbruksregisteret", async () => {
    expect(lock().checkSpend(900, 100)).toMatchObject({ allowed: true, kind: "spend", remaining: 0 });
    expect(lock().checkSpend(900, 101)).toMatchObject({ allowed: false, reason: "budget_exhausted" });
    const viaConstitution = BudgetLock.fromConstitution({ budget: CAPS }, ledgerConst(0), fixed(NOW), usageOf({ ownerWeek: 119 }));
    expect(await viaConstitution.checkOwnerTime(1)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await viaConstitution.checkOwnerTime(2)).toMatchObject({ allowed: false });
  });
});
