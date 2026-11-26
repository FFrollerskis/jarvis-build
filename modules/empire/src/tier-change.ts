import { z } from "zod";
import {
  TierInputError,
  TierInputsSchema,
  TierSchema,
  computeEffectiveTier,
  tierRank,
  type Tier,
  type TierFloor,
  type TierInputs
} from "./tiers.ts";

/**
 * K2 (WP-MCE0, T01/E04): endringsregler for en lagret entity-tier. Resultatet er en BESLUTNING SOM DATA - funksjonen skriver aldri, kaller aldri
 * Policy Gateway og godkjenner aldri noe selv. Selve klasse D-godkjenningen (signert godkjenningsobjekt, step-up) er Policy Gateway/MCE1; denne
 * funksjonen forteller bare HVA som kreves.
 *
 * Reglene (planens §04, D-MC-27):
 *  - Gulvet (`computeEffectiveTier` over dagens inventar) er absolutt: en nedgradering kan aldri gå under det, ikke engang med klasse D.
 *  - ENHVER brukerforespurt endring (opp eller ned) krever klasse D, auditeres og bumper `tier_epoch` (som ugyldiggjør alle grants med entiteten).
 *  - Er nåværende tier LAVERE enn gulvet (kapabilitet er lagt til uten reklassifisering) er reklassifisering OPP automatisk og obligatorisk: den krever
 *    ikke klasse D (ingen kan nekte å heve en tier til sitt eget gulv), og en forespørsel kan ikke stoppe den.
 *  - Nåværende tier som ligger OVER gulvet (kapabilitet er fjernet) senkes aldri av seg selv: kun en klasse D-nedgradering gjør det.
 */

export const TIER_CHANGE_OUTCOMES = ["no_change", "forced_reclassification", "requires_class_d", "denied_below_floor"] as const;
export type TierChangeOutcome = (typeof TIER_CHANGE_OUTCOMES)[number];

export type TierChangeReason =
  | "no_change"
  | "floor_raised_by_capability"
  | "request_superseded_by_forced_reclassification"
  | "tier_upgrade_requires_class_d"
  | "tier_downgrade_requires_class_d"
  | "below_mandatory_floor";

export interface TierChangeEvidence {
  /** Dagens inventar for entiteten (ressurser, dataklasser, authority, regulatoriske flagg). `requested_tier` her ignoreres. */
  readonly inputs: TierInputs;
}

export interface TierChangeDecision {
  readonly outcome: TierChangeOutcome;
  /** Lagret tier før endringen. */
  readonly from: Tier;
  /** Tier etter endringen hvis den anvendes (lik `from` ved `no_change`/`denied_below_floor`). */
  readonly to: Tier;
  /** Gulvet (maks av policy-gulv) beslutningen er tatt mot. */
  readonly floor: Tier;
  readonly direction: "none" | "up" | "down";
  /** Hva brukeren ba om, eller `null`. */
  readonly requested: Tier | null;
  /** Kun brukerforespurte endringer. Aldri for den automatiske, obligatoriske reklassifiseringen. */
  readonly requires_class_d: boolean;
  /** Systemet gjør endringen selv (kun ved obligatorisk reklassifisering opp). */
  readonly automatic: boolean;
  readonly mandatory: boolean;
  /** Anvendelse av endringen MÅ bumpe `tier_epoch` (og dermed ugyldiggjøre alle Empire-grants som inneholder entiteten). */
  readonly bump_tier_epoch: boolean;
  readonly invalidates_grants: boolean;
  /** Endringen (og et avslått forsøk på å gå under gulvet) skal i revisjonsloggen. */
  readonly audit_required: boolean;
  readonly reasons: readonly TierChangeReason[];
  /** Gulvårsakene som binder (forklarbarhet i revisjon/UI). */
  readonly binding_floors: readonly TierFloor[];
}

const EvidenceSchema = z.object({ inputs: TierInputsSchema }).strict();

function direction(from: Tier, to: Tier): "none" | "up" | "down" {
  const diff = tierRank(to) - tierRank(from);
  return diff === 0 ? "none" : diff > 0 ? "up" : "down";
}

export function evaluateTierChange(current: Tier, requested: Tier | undefined, evidence: TierChangeEvidence): TierChangeDecision {
  const from = parseTierArg(current);
  const asked = requested === undefined ? undefined : parseTierArg(requested);
  const parsedEvidence = EvidenceSchema.safeParse(evidence);
  if (!parsedEvidence.success) {
    throw new TierInputError("invalid_tier_change_evidence", parsedEvidence.error.issues.map((i) => `${i.path.join(".") || "(root)"}:${i.code}`));
  }
  const computation = computeEffectiveTier(parsedEvidence.data.inputs);
  const floor = computation.effective_tier;

  let outcome: TierChangeOutcome;
  let to: Tier;
  let reasons: TierChangeReason[];
  if (tierRank(from) < tierRank(floor)) {
    // Kapabilitet har løftet gulvet over det som er lagret: obligatorisk, automatisk reklassifisering OPP. En forespørsel kan ikke stoppe den.
    outcome = "forced_reclassification";
    to = floor;
    reasons = ["floor_raised_by_capability"];
    if (asked !== undefined) reasons.push("request_superseded_by_forced_reclassification");
  } else if (asked === undefined || asked === from) {
    outcome = "no_change";
    to = from;
    reasons = ["no_change"];
  } else if (tierRank(asked) < tierRank(floor)) {
    // Å gå under det aktive gulvet er aldri tillatt - heller ikke med klasse D.
    outcome = "denied_below_floor";
    to = from;
    reasons = ["below_mandatory_floor"];
  } else {
    outcome = "requires_class_d";
    to = asked;
    reasons = [tierRank(asked) > tierRank(from) ? "tier_upgrade_requires_class_d" : "tier_downgrade_requires_class_d"];
  }

  const changes = to !== from;
  return Object.freeze({
    outcome,
    from,
    to,
    floor,
    direction: direction(from, to),
    requested: asked ?? null,
    requires_class_d: outcome === "requires_class_d",
    automatic: outcome === "forced_reclassification",
    mandatory: outcome === "forced_reclassification",
    bump_tier_epoch: changes,
    invalidates_grants: changes,
    audit_required: changes || outcome === "denied_below_floor",
    reasons: Object.freeze(reasons),
    binding_floors: computation.binding_floors
  });
}

function parseTierArg(value: unknown): Tier {
  const parsed = TierSchema.safeParse(value);
  if (!parsed.success) throw new TierInputError("invalid_tier");
  return parsed.data;
}
