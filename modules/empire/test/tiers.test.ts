import { createHash } from "node:crypto";
import { canonicalStringify } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_CLASSES,
  DATA_CLASSES,
  REGULATORY_FLAGS,
  RESOURCE_KINDS,
  TIERS,
  TIER_FLOOR_TABLE,
  TIER_POLICY_VERSION,
  TierInputError,
  TierInputsSchema,
  computeEffectiveTier,
  maxTier,
  tierPolicyDigest,
  tierRank,
  type TierInputs
} from "../src/index.ts";
import {
  GOLDEN_AUTHORITY_FLOOR,
  GOLDEN_DATA_CLASS_FLOOR,
  GOLDEN_REGULATORY_FLOOR,
  GOLDEN_RESOURCE_FLOOR,
  TIER_ORDER,
  deepFreeze,
  emptyInputs,
  inputs,
  maxOf,
  rank
} from "./support/tier-fixtures.ts";
import { Rng } from "./support/prng.ts";

/** Festet sammendrag av tierpolicyen (versjon 1). Endres kun ved en bevisst konstitusjonsendring (klasse D + revisjon). */
const PINNED_TIER_POLICY_DIGEST = "b9bf12d412f12f54331fe3bac5354a86a03c9bec0c372cfb254db8a485d28aa7";

/** Alle enkeltsignaler som (kategori, signal, forventet gulv) - fra den uavhengige fasiten. */
const SINGLE_SIGNALS: ReadonlyArray<{ label: string; build: () => TierInputs; expected: "T1" | "T2" | "T3" | "T4" }> = [
  ...Object.entries(GOLDEN_RESOURCE_FLOOR).map(([k, t]) => ({ label: `resource:${k}`, build: () => inputs({ resources: [k as never] }), expected: t })),
  ...Object.entries(GOLDEN_DATA_CLASS_FLOOR).map(([k, t]) => ({ label: `data_class:${k}`, build: () => inputs({ data_classes: [k as never] }), expected: t })),
  ...Object.entries(GOLDEN_REGULATORY_FLOOR).map(([k, t]) => ({ label: `regulatory:${k}`, build: () => inputs({ regulatory_flags: [k as never] }), expected: t })),
  ...Object.entries(GOLDEN_AUTHORITY_FLOOR).map(([k, t]) => ({ label: `authority:${k}`, build: () => inputs({ authority_class: k as never }), expected: t }))
];

describe("K1: tier-taksonomi og tabelldrevet gulv (data, ikke if-kjeder)", () => {
  it("T1-T4 er rangert i stigende rekkefølge", () => {
    expect([...TIERS]).toEqual(["T1", "T2", "T3", "T4"]);
    expect(TIERS.map(tierRank)).toEqual([1, 2, 3, 4]);
    expect(maxTier("T2", "T4", "T1")).toBe("T4");
    expect(maxTier("T3")).toBe("T3");
  });

  it("gulvtabellen er total: hvert signal i hver kategori har et gulv, og tabellen har ingen løse nøkler", () => {
    expect(Object.keys(TIER_FLOOR_TABLE.resources).sort()).toEqual([...RESOURCE_KINDS].sort());
    expect(Object.keys(TIER_FLOOR_TABLE.data_classes).sort()).toEqual([...DATA_CLASSES].sort());
    expect(Object.keys(TIER_FLOOR_TABLE.regulatory).sort()).toEqual([...REGULATORY_FLAGS].sort());
    expect(Object.keys(TIER_FLOOR_TABLE.authority).sort()).toEqual([...AUTHORITY_CLASSES].sort());
    for (const category of Object.values(TIER_FLOOR_TABLE)) {
      for (const tier of Object.values(category)) expect(TIERS).toContain(tier);
    }
  });

  it("tabellen stemmer med den uavhengige fasiten (hver rad)", () => {
    expect({ ...TIER_FLOOR_TABLE.resources }).toEqual(GOLDEN_RESOURCE_FLOOR);
    expect({ ...TIER_FLOOR_TABLE.data_classes }).toEqual(GOLDEN_DATA_CLASS_FLOOR);
    expect({ ...TIER_FLOOR_TABLE.regulatory }).toEqual(GOLDEN_REGULATORY_FLOOR);
    expect({ ...TIER_FLOOR_TABLE.authority }).toEqual(GOLDEN_AUTHORITY_FLOOR);
  });

  it("tabellen er dypfrosset: en kjøretidsmutasjon kaster og endrer ingenting", () => {
    const table = TIER_FLOOR_TABLE as unknown as { resources: Record<string, string>; authority: Record<string, string> };
    expect(Object.isFrozen(TIER_FLOOR_TABLE)).toBe(true);
    expect(Object.isFrozen(TIER_FLOOR_TABLE.resources)).toBe(true);
    expect(() => { table.resources["payment_write"] = "T1"; }).toThrow(TypeError);
    expect(() => { table.authority["D"] = "T1"; }).toThrow(TypeError);
    expect(computeEffectiveTier(inputs({ resources: ["payment_write"] })).effective_tier).toBe("T3");
  });

  it("tierpolicyen er festet: endring av taksonomi/kriterier krever en bevisst endring her (klasse D + revisjon)", () => {
    expect(TIER_POLICY_VERSION).toBe(1);
    expect(tierPolicyDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(tierPolicyDigest()).toBe(PINNED_TIER_POLICY_DIGEST);
    // Uavhengig gjenberegning fra fasiten (ikke fra koden): sammendraget er en ren funksjon av versjon + taksonomi + gulvene.
    const fromGolden = createHash("sha256")
      .update(
        `jarvis.empire.tier-policy.v1\n${canonicalStringify({
          version: 1,
          tiers: ["T1", "T2", "T3", "T4"],
          table: {
            resources: GOLDEN_RESOURCE_FLOOR,
            data_classes: GOLDEN_DATA_CLASS_FLOOR,
            authority: GOLDEN_AUTHORITY_FLOOR,
            regulatory: GOLDEN_REGULATORY_FLOOR
          }
        })}`,
        "utf8"
      )
      .digest("hex");
    expect(fromGolden).toBe(PINNED_TIER_POLICY_DIGEST);
  });

  it("ingen signal: laveste tier T1 uten gulvårsaker", () => {
    const result = computeEffectiveTier(emptyInputs());
    expect(result.effective_tier).toBe("T1");
    expect(result.floors).toEqual([]);
    expect(result.binding_floors).toEqual([]);
    expect(result.request).toEqual({ requested_tier: null, disposition: "none" });
  });

  it.each(SINGLE_SIGNALS.map((s) => [s.label, s] as const))("enkeltsignal %s gir fasitens gulv", (_label, signal) => {
    const result = computeEffectiveTier(signal.build());
    expect(result.effective_tier).toBe(signal.expected);
    if (signal.label === "authority:none") {
      // «ingen kapabiliteter» er fravær av signal: ingen gulvårsak, kun baseline T1.
      expect(result.floors).toEqual([]);
      return;
    }
    expect(result.floors).toHaveLength(1);
    expect(result.floors[0]?.tier).toBe(signal.expected);
    expect(result.binding_floors).toEqual(result.floors);
  });

  it("alle par av signaler (på tvers av og innen kategorier) gir MAKS av fasitens gulv", () => {
    let checked = 0;
    for (const a of SINGLE_SIGNALS) {
      for (const b of SINGLE_SIGNALS) {
        const merged: TierInputs = {
          resources: [...a.build().resources, ...b.build().resources],
          data_classes: [...a.build().data_classes, ...b.build().data_classes],
          authority_class: maxAuthority(a.build().authority_class, b.build().authority_class),
          regulatory_flags: [...a.build().regulatory_flags, ...b.build().regulatory_flags]
        };
        const expected = maxOf([a.expected, b.expected]);
        expect(computeEffectiveTier(merged).effective_tier, `${a.label} + ${b.label}`).toBe(expected);
        checked += 1;
      }
    }
    expect(checked).toBe(SINGLE_SIGNALS.length * SINGLE_SIGNALS.length);
  });

  it("flere signaler: gulvårsakene som binder er nøyaktig de som når effektiv tier, sortert deterministisk", () => {
    const result = computeEffectiveTier(
      inputs({
        resources: ["production_system", "payment_write", "business_app"],
        data_classes: ["customer_data", "legal_privileged"],
        authority_class: "D",
        regulatory_flags: ["health_regulated"]
      })
    );
    expect(result.effective_tier).toBe("T3");
    expect(result.floors.map((f) => `${f.source}:${f.signal}:${f.tier}`)).toEqual([
      "resource:payment_write:T3",
      "data_class:legal_privileged:T3",
      "authority:D:T3",
      "regulatory:health_regulated:T3",
      "resource:production_system:T2",
      "data_class:customer_data:T2",
      "resource:business_app:T1"
    ]);
    expect(result.binding_floors.map((f) => f.signal)).toEqual(["payment_write", "legal_privileged", "D", "health_regulated"]);
  });
});

describe("K1: bruker kan BE om en tier, aldri SETTE effektiv tier", () => {
  it("forespurt lavere enn gulv => gulv gjelder", () => {
    const result = computeEffectiveTier(inputs({ resources: ["payment_write"], requested_tier: "T1" }));
    expect(result.effective_tier).toBe("T3");
    expect(result.request).toEqual({ requested_tier: "T1", disposition: "below_floor_ignored" });
  });

  it("forespurt lik gulv => oppfylt; forespurt høyere => IKKE anvendt (krever endringsregel/klasse D)", () => {
    const equal = computeEffectiveTier(inputs({ resources: ["production_system"], requested_tier: "T2" }));
    expect(equal.effective_tier).toBe("T2");
    expect(equal.request.disposition).toBe("satisfied");
    const higher = computeEffectiveTier(inputs({ resources: ["production_system"], requested_tier: "T4" }));
    expect(higher.effective_tier).toBe("T2");
    expect(higher.request).toEqual({ requested_tier: "T4", disposition: "above_floor_not_applied" });
  });

  it("differensial: for hvert enkeltsignal og hver forespurt tier er effektiv tier lik resultatet UTEN forespørsel", () => {
    for (const signal of SINGLE_SIGNALS) {
      const baseline = computeEffectiveTier(signal.build());
      for (const requested of TIER_ORDER) {
        const withRequest = computeEffectiveTier({ ...signal.build(), requested_tier: requested });
        expect(withRequest.effective_tier, `${signal.label} request ${requested}`).toBe(baseline.effective_tier);
        expect(withRequest.floors).toEqual(baseline.floors);
      }
    }
  });
});

describe("K1: ren, deterministisk, monoton", () => {
  it("rekkefølge og duplikater påvirker ikke resultatet", () => {
    const a = computeEffectiveTier(
      inputs({ resources: ["production_system", "payment_write", "payment_write"], data_classes: ["customer_data", "internal", "customer_data"], authority_class: "C", regulatory_flags: ["health_regulated", "financial_regulated"] })
    );
    const b = computeEffectiveTier(
      inputs({ resources: ["payment_write", "production_system"], data_classes: ["internal", "customer_data"], authority_class: "C", regulatory_flags: ["financial_regulated", "health_regulated", "health_regulated"] })
    );
    expect(b).toEqual(a);
  });

  it("er ren: frosne innganger muteres ikke, og to kall gir samme resultat", () => {
    const frozen = deepFreeze(inputs({ resources: ["production_system"], data_classes: ["customer_data"], authority_class: "B", regulatory_flags: [] }));
    const first = computeEffectiveTier(frozen);
    const second = computeEffectiveTier(frozen);
    expect(second).toEqual(first);
    expect(frozen.resources).toEqual(["production_system"]);
  });

  it("resultatet er frosset (kan ikke endres av kalleren)", () => {
    const result = computeEffectiveTier(inputs({ resources: ["payment_write"] }));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.floors)).toBe(true);
    expect(() => { (result as { effective_tier: string }).effective_tier = "T1"; }).toThrow(TypeError);
  });

  it("egenskap (fast seed): mer kapabilitet/data/ressurser gir ALDRI lavere tier (monotoni)", () => {
    const rng = new Rng(20261126);
    const authorityOrder = ["none", "A", "B", "C", "D"] as const;
    for (let i = 0; i < 3000; i += 1) {
      const base: TierInputs = {
        resources: rng.subset(RESOURCE_KINDS, 0.2),
        data_classes: rng.subset(DATA_CLASSES, 0.2),
        authority_class: rng.pick(authorityOrder),
        regulatory_flags: rng.subset(REGULATORY_FLAGS, 0.15)
      };
      const more: TierInputs = {
        resources: [...new Set([...base.resources, ...rng.subset(RESOURCE_KINDS, 0.15)])],
        data_classes: [...new Set([...base.data_classes, ...rng.subset(DATA_CLASSES, 0.15)])],
        authority_class: maxAuthority(base.authority_class, rng.pick(authorityOrder)),
        regulatory_flags: [...new Set([...base.regulatory_flags, ...rng.subset(REGULATORY_FLAGS, 0.1)])]
      };
      const lower = computeEffectiveTier(base).effective_tier;
      const upper = computeEffectiveTier(more).effective_tier;
      expect(rank(upper), JSON.stringify({ base, more })).toBeGreaterThanOrEqual(rank(lower));
    }
  });

  it("egenskap (fast seed): effektiv tier = maks av fasitens enkeltgulv for tilfeldige sammensatte innganger", () => {
    const rng = new Rng(7);
    const authorityOrder = ["none", "A", "B", "C", "D"] as const;
    for (let i = 0; i < 3000; i += 1) {
      const sample: TierInputs = {
        resources: rng.subset(RESOURCE_KINDS, 0.25),
        data_classes: rng.subset(DATA_CLASSES, 0.25),
        authority_class: rng.pick(authorityOrder),
        regulatory_flags: rng.subset(REGULATORY_FLAGS, 0.2)
      };
      const expected = maxOf([
        "T1",
        ...sample.resources.map((r) => GOLDEN_RESOURCE_FLOOR[r] ?? "T4"),
        ...sample.data_classes.map((d) => GOLDEN_DATA_CLASS_FLOOR[d] ?? "T4"),
        ...sample.regulatory_flags.map((f) => GOLDEN_REGULATORY_FLOOR[f] ?? "T4"),
        GOLDEN_AUTHORITY_FLOOR[sample.authority_class] ?? "T4"
      ]);
      expect(computeEffectiveTier(sample).effective_tier, JSON.stringify(sample)).toBe(expected);
    }
  });
});

describe("K1: ugyldige innganger avvises (aldri en lavere tier for søppel)", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["ukjent ressurs", { ...emptyInputs(), resources: ["teleporter"] }],
    ["ukjent dataklasse", { ...emptyInputs(), data_classes: ["gossip"] }],
    ["ukjent regulatorisk flagg", { ...emptyInputs(), regulatory_flags: ["vibes"] }],
    ["ukjent authority-klasse", { ...emptyInputs(), authority_class: "E" }],
    ["manglende authority_class", { resources: [], data_classes: [], regulatory_flags: [] }],
    ["manglende resources", { data_classes: [], authority_class: "none", regulatory_flags: [] }],
    ["ekstra felt (.strict())", { ...emptyInputs(), tier: "T1" }],
    ["ukjent forespurt tier", { ...emptyInputs(), requested_tier: "T0" }],
    ["ikke-objekt", "T1"],
    ["null", null],
    ["resources er ikke en liste", { ...emptyInputs(), resources: "business_app" }],
    ["for mange elementer", { ...emptyInputs(), resources: Array.from({ length: 65 }, () => "business_app") }]
  ];

  it.each(cases.map((c) => [c[0], c[1]] as const))("%s => TierInputError", (_name, value) => {
    expect(() => computeEffectiveTier(value as TierInputs)).toThrow(TierInputError);
    expect(TierInputsSchema.safeParse(value).success).toBe(false);
  });
});

function maxAuthority(a: TierInputs["authority_class"], b: TierInputs["authority_class"]): TierInputs["authority_class"] {
  const order = ["none", "A", "B", "C", "D"] as const;
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}
