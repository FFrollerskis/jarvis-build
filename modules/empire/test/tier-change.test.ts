import { describe, expect, it } from "vitest";
import { TIERS, TierInputError, evaluateTierChange, type Tier, type TierInputs } from "../src/index.ts";
import { deepFreeze, emptyInputs, inputs, rank } from "./support/tier-fixtures.ts";

/** Innganger som gir nøyaktig gulvet `tier` (uavhengig fasit: se tier-fixtures). */
const INPUTS_FOR_FLOOR: Readonly<Record<Tier, TierInputs>> = {
  T1: emptyInputs(),
  T2: inputs({ resources: ["production_system"] }),
  T3: inputs({ resources: ["payment_write"] }),
  T4: inputs({ resources: ["authority_plane"] })
};

function decide(current: Tier, requested: Tier | undefined, floor: Tier) {
  return evaluateTierChange(current, requested, { inputs: INPUTS_FOR_FLOOR[floor] });
}

describe("K2: endringsregler for tier (beslutning som data, aldri sideeffekt)", () => {
  it("ingen forespørsel og nåværende >= gulv: ingen endring, ingen klasse D, ingen epokebump", () => {
    const d = decide("T2", undefined, "T2");
    expect(d.outcome).toBe("no_change");
    expect(d.from).toBe("T2");
    expect(d.to).toBe("T2");
    expect(d.direction).toBe("none");
    expect(d.requires_class_d).toBe(false);
    expect(d.bump_tier_epoch).toBe(false);
    expect(d.invalidates_grants).toBe(false);
    expect(d.automatic).toBe(false);
    expect(d.reasons).toEqual(["no_change"]);
  });

  it("forespurt lik nåværende: ingen endring", () => {
    const d = decide("T3", "T3", "T2");
    expect(d.outcome).toBe("no_change");
    expect(d.requires_class_d).toBe(false);
    expect(d.to).toBe("T3");
  });

  it("nedgradering innenfor gulvet krever klasse D (resultatet er data + begrunnelse), og ugyldiggjør grants når den anvendes", () => {
    const d = decide("T3", "T2", "T2");
    expect(d.outcome).toBe("requires_class_d");
    expect(d.direction).toBe("down");
    expect(d.requires_class_d).toBe(true);
    expect(d.from).toBe("T3");
    expect(d.to).toBe("T2");
    expect(d.automatic).toBe(false);
    expect(d.mandatory).toBe(false);
    expect(d.bump_tier_epoch).toBe(true);
    expect(d.invalidates_grants).toBe(true);
    expect(d.audit_required).toBe(true);
    expect(d.reasons).toEqual(["tier_downgrade_requires_class_d"]);
  });

  it("nedgradering KAN ikke omgå gulvet: forespurt under gulvet avslås (ikke engang klasse D kan godkjenne den)", () => {
    const d = decide("T3", "T1", "T2");
    expect(d.outcome).toBe("denied_below_floor");
    expect(d.to).toBe("T3");
    expect(d.floor).toBe("T2");
    expect(d.requires_class_d).toBe(false);
    expect(d.bump_tier_epoch).toBe(false);
    expect(d.invalidates_grants).toBe(false);
    expect(d.audit_required).toBe(true);
    expect(d.reasons).toEqual(["below_mandatory_floor"]);
    expect(d.binding_floors.map((f) => f.signal)).toEqual(["production_system"]);
  });

  it("frivillig oppgradering (forespurt høyere enn nåværende) krever også klasse D", () => {
    const d = decide("T1", "T3", "T1");
    expect(d.outcome).toBe("requires_class_d");
    expect(d.direction).toBe("up");
    expect(d.requires_class_d).toBe(true);
    expect(d.to).toBe("T3");
    expect(d.bump_tier_epoch).toBe(true);
    expect(d.reasons).toEqual(["tier_upgrade_requires_class_d"]);
  });

  it("reklassifisering OPP ved kapabilitetsøkning er automatisk og obligatorisk (nåværende < gulv), uten klasse D", () => {
    const d = decide("T1", undefined, "T3");
    expect(d.outcome).toBe("forced_reclassification");
    expect(d.direction).toBe("up");
    expect(d.from).toBe("T1");
    expect(d.to).toBe("T3");
    expect(d.automatic).toBe(true);
    expect(d.mandatory).toBe(true);
    expect(d.requires_class_d).toBe(false);
    expect(d.bump_tier_epoch).toBe(true);
    expect(d.invalidates_grants).toBe(true);
    expect(d.audit_required).toBe(true);
    expect(d.reasons).toEqual(["floor_raised_by_capability"]);
    expect(d.binding_floors.map((f) => f.signal)).toEqual(["payment_write"]);
  });

  it("en forespørsel kan ikke stoppe den obligatoriske reklassifiseringen (lik, lavere eller høyere enn nåværende)", () => {
    for (const requested of [undefined, "T1", "T2", "T3", "T4"] as const) {
      const d = decide("T1", requested, "T3");
      expect(d.outcome, `requested ${String(requested)}`).toBe("forced_reclassification");
      expect(d.to).toBe("T3");
      expect(d.requires_class_d).toBe(false);
      if (requested !== undefined) expect(d.reasons).toContain("request_superseded_by_forced_reclassification");
    }
  });

  it("kapabilitet som løfter gulvet (fra ekte innganger): T1 -> T3 når betalingsskriving legges til", () => {
    const before = evaluateTierChange("T1", undefined, { inputs: inputs({ resources: ["business_app"] }) });
    expect(before.outcome).toBe("no_change");
    const after = evaluateTierChange("T1", undefined, { inputs: inputs({ resources: ["business_app", "payment_write"] }) });
    expect(after.outcome).toBe("forced_reclassification");
    expect(after.to).toBe("T3");
  });

  it("uttømmende 4x4x4: invariantene holder for alle kombinasjoner av nåværende, forespurt og gulv", () => {
    let combos = 0;
    for (const current of TIERS) {
      for (const floor of TIERS) {
        for (const requested of [undefined, ...TIERS] as const) {
          const d = decide(current, requested, floor);
          const label = `current=${current} requested=${String(requested)} floor=${floor}`;
          combos += 1;
          // I1: resultatet er aldri under gulvet.
          expect(rank(d.to), label).toBeGreaterThanOrEqual(rank(floor));
          expect(d.floor, label).toBe(floor);
          // I2: et av de fire utfallene, med konsistente flagg.
          if (d.outcome === "forced_reclassification") {
            expect(rank(current), label).toBeLessThan(rank(floor));
            expect(d.to, label).toBe(floor);
            expect(d.requires_class_d, label).toBe(false);
            expect(d.automatic && d.mandatory, label).toBe(true);
          } else {
            expect(rank(current), label).toBeGreaterThanOrEqual(rank(floor));
            expect(d.automatic, label).toBe(false);
            expect(d.mandatory, label).toBe(false);
          }
          // I3: enhver brukerforespurt endring (ikke tvunget) krever klasse D; avslag og ingen-endring gjør ikke.
          if (d.outcome === "requires_class_d") {
            expect(d.requires_class_d, label).toBe(true);
            expect(requested, label).not.toBe(current);
            expect(d.to, label).toBe(requested);
          } else {
            expect(d.requires_class_d, label).toBe(false);
          }
          // I4: epokebump og grant-ugyldiggjøring følger faktisk tier-endring, og bare da.
          const changes = d.to !== d.from;
          expect(d.bump_tier_epoch, label).toBe(changes);
          expect(d.invalidates_grants, label).toBe(changes);
          expect(d.audit_required, label).toBe(changes || d.outcome === "denied_below_floor");
          // I5: avslag lar nåværende tier stå.
          if (d.outcome === "denied_below_floor") {
            expect(d.to, label).toBe(current);
            expect(rank(requested as Tier), label).toBeLessThan(rank(floor));
          }
          // I6: retning er konsistent med from/to.
          expect(d.direction, label).toBe(rank(d.to) > rank(d.from) ? "up" : rank(d.to) < rank(d.from) ? "down" : "none");
        }
      }
    }
    expect(combos).toBe(4 * 4 * 5);
  });

  it("er ren: frosne innganger, frosset beslutning, samme svar ved gjentatt kall", () => {
    const evidence = deepFreeze({ inputs: inputs({ resources: ["production_system"] }) });
    const first = evaluateTierChange("T3", "T2", evidence);
    const second = evaluateTierChange("T3", "T2", evidence);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reasons)).toBe(true);
    expect(() => { (first as { requires_class_d: boolean }).requires_class_d = false; }).toThrow(TypeError);
  });

  it("evidence.inputs.requested_tier påvirker ikke beslutningen (kun parameteren `requested` teller)", () => {
    const withEmbedded = evaluateTierChange("T3", undefined, { inputs: { ...inputs({ resources: ["production_system"] }), requested_tier: "T1" } });
    expect(withEmbedded.outcome).toBe("no_change");
    expect(withEmbedded.requested).toBeNull();
  });

  it("ugyldige innganger avvises, aldri en stille beslutning", () => {
    expect(() => evaluateTierChange("T0" as Tier, undefined, { inputs: emptyInputs() })).toThrow(TierInputError);
    expect(() => evaluateTierChange("T1", "T9" as Tier, { inputs: emptyInputs() })).toThrow(TierInputError);
    expect(() => evaluateTierChange("T1", undefined, { inputs: { resources: ["nope"] } as unknown as TierInputs })).toThrow(TierInputError);
    expect(() => evaluateTierChange("T1", undefined, undefined as never)).toThrow(TierInputError);
    expect(() => evaluateTierChange("T1", undefined, { inputs: emptyInputs(), extra: true } as never)).toThrow(TierInputError);
  });
});
