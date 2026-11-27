import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUDGET_HARD_CEILINGS, BudgetCapsSchema, CATEGORY_CAP_KEYS, ConstitutionError, EVOLUTION_COST_CATEGORIES, buildConstitution, type BudgetCaps
} from "../src/index.ts";

/**
 * WP-EV0 (HF2 EV-0, K1): kategori-caps + eier-tid i det SIGNERTE manifestet. Ren logikk (ingen DB).
 * Manifestet er kilden (øre/minutter); harde tak i koden gjelder selv et signert manifest (`constitution_weakened`);
 * interne motsigelser gir `constitution_invalid`.
 */
const manifest = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("../../../config/evolution/constitution.v1.json", import.meta.url), "utf8"));
const repoCaps = (): BudgetCaps => (manifest()["budget_caps"] as BudgetCaps);
const code = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return (err as ConstitutionError).code === undefined ? `other:${(err as Error).message}` : `${(err as ConstitutionError).code}:${(err as Error).message.split(":").slice(1).join(":")}`; }
  return "no_error";
};
const build = (caps: unknown): string => code(() => buildConstitution({ ...manifest(), budget_caps: caps }));
const withCaps = (over: Partial<BudgetCaps>): BudgetCaps => ({ ...repoCaps(), ...over });

const EXPECTED_KEYS = [
  "max_auto_merges_per_day", "max_deploys_per_day", "max_deploys_per_hour", "max_eval_cost_ore_per_month", "max_evolution_cost_ore_per_month",
  "max_owner_minutes_per_autonomous_change", "max_owner_proposals_per_day", "max_radar_cost_ore_per_month", "max_redteam_cost_ore_per_month",
  "max_review_cost_ore_per_month", "max_shadow_cost_ore_per_month", "owner_time_budget_minutes_per_week"
];

describe("A: skjemaet er strengt og komplett (6 kostnadstak + eier-tid + deploys pr time)", () => {
  it("A1: nøyaktig de 12 feltene - og hvert felt har et hardt tak i koden (ingen felt uten tak)", () => {
    expect(Object.keys(BudgetCapsSchema.shape).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(BUDGET_HARD_CEILINGS).sort()).toEqual(EXPECTED_KEYS);
  });

  it("A2: repoets manifest har nøyaktig disse feltene og består det strenge skjemaet", () => {
    expect(Object.keys(repoCaps()).sort()).toEqual(EXPECTED_KEYS);
    expect(BudgetCapsSchema.safeParse(repoCaps()).success).toBe(true);
  });

  it("A3: hvert felt er PÅKREVD (manglende felt => constitution_invalid, aldri en stille standard)", () => {
    for (const key of EXPECTED_KEYS) {
      const caps: Record<string, unknown> = { ...repoCaps() };
      delete caps[key];
      expect(build(caps), key).toMatch(/^constitution_invalid:/);
    }
  });

  it("A4: ukjent felt, negativ verdi, brøk, streng, null, Infinity og NaN avvises per felt", () => {
    expect(build({ ...repoCaps(), extra_cap: 1 })).toMatch(/^constitution_invalid:/);
    for (const key of EXPECTED_KEYS) {
      for (const bad of [-1, 1.5, "5", null, Number.POSITIVE_INFINITY, Number.NaN, true]) {
        expect(build({ ...repoCaps(), [key]: bad }), `${key}=${String(bad)}`).toMatch(/^constitution_invalid:/);
      }
    }
  });

  it("A5: kategorinavnene og nøkkelkartet er nøyaktig de fem kostnadskategoriene (total er max_evolution_cost_ore_per_month)", () => {
    expect([...EVOLUTION_COST_CATEGORIES]).toEqual(["radar", "eval", "redteam", "shadow", "review"]);
    expect(CATEGORY_CAP_KEYS).toEqual({
      radar: "max_radar_cost_ore_per_month", eval: "max_eval_cost_ore_per_month", redteam: "max_redteam_cost_ore_per_month",
      shadow: "max_shadow_cost_ore_per_month", review: "max_review_cost_ore_per_month"
    });
  });
});

describe("B: harde tak - selv et signert manifest kan ikke sette en grense over taket (constitution_weakened)", () => {
  it("B1: taket for Evolution totalt og hver kategori er ≤ 1000 kr/mnd (ADR-001 §2.3 pkt 4), og eier-tid-takene er de bevisste", () => {
    expect(BUDGET_HARD_CEILINGS.max_evolution_cost_ore_per_month).toBe(100_000);
    for (const c of EVOLUTION_COST_CATEGORIES) expect(BUDGET_HARD_CEILINGS[CATEGORY_CAP_KEYS[c]], c).toBeLessThanOrEqual(BUDGET_HARD_CEILINGS.max_evolution_cost_ore_per_month);
    expect(BUDGET_HARD_CEILINGS.max_deploys_per_hour).toBe(3);
    expect(BUDGET_HARD_CEILINGS.owner_time_budget_minutes_per_week).toBe(600);
    expect(BUDGET_HARD_CEILINGS.max_owner_minutes_per_autonomous_change).toBe(60);
    expect(Object.isFrozen(BUDGET_HARD_CEILINGS)).toBe(true);
  });

  it("B2: tak + 1 => constitution_weakened for HVERT felt (taket kommer foran koherenssjekkene)", () => {
    for (const key of EXPECTED_KEYS as Array<keyof BudgetCaps>) {
      expect(build(withCaps({ [key]: BUDGET_HARD_CEILINGS[key] + 1 })), key).toBe(`constitution_weakened:budget_above_ceiling:${key}`);
    }
  });

  it("B3: nøyaktig på taket er tillatt når manifestet ellers er koherent (taket er «>» ikke «>=»)", () => {
    const zeroCats = { max_radar_cost_ore_per_month: 0, max_eval_cost_ore_per_month: 0, max_redteam_cost_ore_per_month: 0, max_shadow_cost_ore_per_month: 0, max_review_cost_ore_per_month: 0 };
    const full = withCaps({
      ...zeroCats, max_evolution_cost_ore_per_month: 100_000, max_auto_merges_per_day: 20, max_deploys_per_day: 10, max_deploys_per_hour: 3,
      max_owner_proposals_per_day: 50, owner_time_budget_minutes_per_week: 600, max_owner_minutes_per_autonomous_change: 60
    });
    expect(build(full)).toBe("no_error");
    for (const c of EVOLUTION_COST_CATEGORIES) {
      expect(build({ ...full, [CATEGORY_CAP_KEYS[c]]: 100_000 }), c).toBe("no_error");
    }
  });
});

describe("C: koherens - manifestet må henge sammen (constitution_invalid)", () => {
  it("C1: summen av kategoritakene kan ikke overstige totaltaket (totaltaket er ikke et «tak» hvis delene summerer over det)", () => {
    const caps = withCaps({ max_evolution_cost_ore_per_month: 10_000, max_radar_cost_ore_per_month: 5_000, max_eval_cost_ore_per_month: 5_000, max_redteam_cost_ore_per_month: 1, max_shadow_cost_ore_per_month: 0, max_review_cost_ore_per_month: 0 });
    expect(build(caps)).toBe("constitution_invalid:budget_categories_exceed_total");
    expect(build({ ...caps, max_redteam_cost_ore_per_month: 0 })).toBe("no_error");
  });

  it("C2: ett enkelt kategoritak over totaltaket avvises også (uavhengig av hvilken kategori)", () => {
    for (const c of EVOLUTION_COST_CATEGORIES) {
      const zero = { max_radar_cost_ore_per_month: 0, max_eval_cost_ore_per_month: 0, max_redteam_cost_ore_per_month: 0, max_shadow_cost_ore_per_month: 0, max_review_cost_ore_per_month: 0 };
      expect(build(withCaps({ ...zero, max_evolution_cost_ore_per_month: 1000, [CATEGORY_CAP_KEYS[c]]: 1001 })), c).toBe("constitution_invalid:budget_categories_exceed_total");
    }
  });

  it("C3: deploys pr time kan ikke overstige deploys pr døgn", () => {
    expect(build(withCaps({ max_deploys_per_day: 1, max_deploys_per_hour: 2 }))).toBe("constitution_invalid:deploys_per_hour_above_per_day");
    expect(build(withCaps({ max_deploys_per_day: 2, max_deploys_per_hour: 2 }))).toBe("no_error");
    expect(build(withCaps({ max_deploys_per_day: 0, max_deploys_per_hour: 0 }))).toBe("no_error");
  });

  it("C4: eier-minutter pr endring kan ikke overstige ukebudsjettet", () => {
    expect(build(withCaps({ owner_time_budget_minutes_per_week: 10, max_owner_minutes_per_autonomous_change: 11 }))).toBe("constitution_invalid:owner_change_minutes_above_weekly_budget");
    expect(build(withCaps({ owner_time_budget_minutes_per_week: 10, max_owner_minutes_per_autonomous_change: 10 }))).toBe("no_error");
  });

  it("C5: alt på 0 er et gyldig (maksimalt stengt) manifest - 0 stenger alltid, aldri «ubegrenset»", () => {
    const zero = Object.fromEntries(EXPECTED_KEYS.map((k) => [k, 0]));
    expect(build(zero)).toBe("no_error");
    expect(Object.values(buildConstitution({ ...manifest(), budget_caps: zero }).budget).every((v) => v === 0)).toBe(true);
  });
});

describe("D: repoets UTKAST-verdier (eier MÅ vurdere før signering)", () => {
  it("D1: utkastet er innenfor takene og koherent; summen av kategoriene er nøyaktig totalen (ingen uallokert rest)", () => {
    const c = buildConstitution(manifest());
    const sum = EVOLUTION_COST_CATEGORIES.reduce((n, cat) => n + c.budget[CATEGORY_CAP_KEYS[cat]], 0);
    expect(sum).toBe(c.budget.max_evolution_cost_ore_per_month);
    for (const key of EXPECTED_KEYS as Array<keyof BudgetCaps>) expect(c.budget[key], key).toBeLessThanOrEqual(BUDGET_HARD_CEILINGS[key]);
  });

  it("D2: konservative startverdier: totalt 100 kr/mnd, eier-tid 4 t/uke (HF2 kap. 29), 15 min pr endring, 1 deploy/time", () => {
    const b = buildConstitution(manifest()).budget;
    expect(b.max_evolution_cost_ore_per_month).toBe(10_000);
    expect(b.owner_time_budget_minutes_per_week).toBe(240);
    expect(b.max_owner_minutes_per_autonomous_change).toBe(15);
    expect(b.max_deploys_per_hour).toBe(1);
    expect(b.max_deploys_per_day).toBe(3);
  });

  it("D3: manifestet bærer UTKAST-merknaden, draft-markøren i issued_by og er versjon 2 / skjemaversjon 2", () => {
    const m = manifest();
    expect(String(m["issued_by"])).toMatch(/^UNSIGNED-DRAFT/);
    expect(String(m["notes"])).toMatch(/UTKAST - eier MÅ vurdere/);
    expect(m["version"]).toBe(2);
    expect(m["schema_version"]).toBe(2);
  });

  it("D4: skjemaversjon 1 (det gamle 4-felts-formatet) er ikke lenger et gyldig manifest", () => {
    expect(code(() => buildConstitution({ ...manifest(), schema_version: 1 }))).toMatch(/^constitution_invalid:/);
  });
});
