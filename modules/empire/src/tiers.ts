import { createHash } from "node:crypto";
import { CapabilityClassSchema, canonicalStringify, type CapabilityClass, type JsonValue } from "@jarvis/contracts";
import { z } from "zod";

/**
 * K1 (WP-MCE0, E03): Entity Security Tier T1-T4 som en REN, deterministisk gulvalgebra.
 *
 * Effektiv tier = MAKS av gulv utledet fra (a) ressurser, (b) dataklasser, (c) authority-nivå (capability-klasse A-D) og (d) regulatoriske flagg.
 * Brukeren kan BE om en tier (`requested_tier`), men forespørselen er aldri en inngang til selve utregningen: den rapporteres kun (`request`).
 * Å faktisk endre en lagret tier er `evaluateTierChange` (tier-change.ts): enhver endring/nedgradering krever klasse D.
 *
 * Gulvene er DATA (`TIER_FLOOR_TABLE`), ikke if-kjeder: en tabell som er dypfrosset, total over alle signaler (typesjekket + testet) og festet med et
 * sammendrag (`tierPolicyDigest`). Tierpolicyen er en del av sikkerhetskonstitusjonen: endring av taksonomi/kriterier = klasse D + revisjon, og feiler
 * derfor en festet test til noen endrer den bevisst.
 *
 * Signalene (ressurs/dataklasse/regulatorisk) og authority-mappingen følger beskrivelsen av T1-T4 i planen; de konkrete navnene og kategoriseringen er en
 * FORESLÅTT standard (se D-forslaget i runbooken) som MC-laget (HF3) kan utvide gjennom en bevisst, revidert endring - aldri ved kjøring.
 */

export const TIERS = ["T1", "T2", "T3", "T4"] as const;
export type Tier = (typeof TIERS)[number];
export const TierSchema = z.enum(TIERS);

/** Feil ved ugyldige innganger til tier-funksjonene. Aldri en stille lavere tier for søppel. */
export class TierInputError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "TierInputError";
    this.issues = issues;
  }
}

const TIER_RANK: Readonly<Record<Tier, 1 | 2 | 3 | 4>> = Object.freeze({ T1: 1, T2: 2, T3: 3, T4: 4 });

/** 1 (T1) .. 4 (T4). Ukjent verdi kaster (aldri 0/NaN som kunne sammenlignes som «lavest»). */
export function tierRank(tier: Tier): 1 | 2 | 3 | 4 {
  const rank = Object.prototype.hasOwnProperty.call(TIER_RANK, tier) ? TIER_RANK[tier] : undefined;
  if (rank === undefined) throw new TierInputError("unknown_tier");
  return rank;
}

export function maxTier(first: Tier, ...rest: readonly Tier[]): Tier {
  let best = first;
  for (const tier of rest) if (tierRank(tier) > tierRank(best)) best = tier;
  tierRank(best);
  return best;
}

/** Ressurser entiteten har tilkoblet/aktivert. Navn etter RISIKOKARAKTER, ikke leverandør (en postkasse eller et repo er `business_app`). */
export const RESOURCE_KINDS = [
  "business_app",
  "production_system",
  "financial_read",
  "payment_write",
  "payroll_system",
  "security_admin",
  "authority_plane",
  "security_constitution",
  "root_cloud_ownership",
  "recovery_root",
  "ownership_control"
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const ResourceKindSchema = z.enum(RESOURCE_KINDS);

export const DATA_CLASSES = [
  "public",
  "internal",
  "customer_data",
  "employee_data",
  "confidential_ip",
  "financial_reporting",
  "legal_privileged",
  "regulated_data",
  "high_sensitivity",
  "payroll_data",
  "security_critical"
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const DataClassSchema = z.enum(DATA_CLASSES);

export const REGULATORY_FLAGS = [
  "financial_regulated",
  "health_regulated",
  "special_category_personal_data",
  "classified_or_public_sector",
  "critical_infrastructure",
  "regulated_other"
] as const;
export type RegulatoryFlag = (typeof REGULATORY_FLAGS)[number];
export const RegulatoryFlagSchema = z.enum(REGULATORY_FLAGS);

/** Høyeste capability-klasse (A-D, SECURITY_MODEL §3) entiteten har aktivert, eller `none` uten kapabiliteter. */
export const AUTHORITY_CLASSES = ["none", "A", "B", "C", "D"] as const;
export type AuthorityClass = (typeof AUTHORITY_CLASSES)[number];
export const AuthorityClassSchema = z.union([z.literal("none"), CapabilityClassSchema]);

// Kompileringstidsvern: en ny capability-klasse i kontrakten (f.eks. «E») uten et bevisst gulv her gir typefeil.
type MissingAuthorityClass = Exclude<CapabilityClass, AuthorityClass>;
const authorityClassesCoverContract: MissingAuthorityClass extends never ? true : never = true;
void authorityClassesCoverContract;

export interface TierFloorTable {
  readonly resources: Readonly<Record<ResourceKind, Tier>>;
  readonly data_classes: Readonly<Record<DataClass, Tier>>;
  readonly authority: Readonly<Record<AuthorityClass, Tier>>;
  readonly regulatory: Readonly<Record<RegulatoryFlag, Tier>>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const TIER_POLICY_VERSION = 1;

/**
 * GULVTABELLEN (data). T1 er baseline (laveste tier). T2: kunde-/ansattdata, produksjonssystemer, konfidensiell IP, finansiell rapportering/lesing.
 * T3: bank-/betalingsskriving, lønn, juridisk privilegert materiale, regulert/høysensitiv data, sikkerhetsadministrasjon. T4: Authority Plane,
 * sikkerhetskonstitusjon, rot-/sky-eierskap, gjenopprettingsrøtter, eierskaps-/kontrollendringer.
 * Authority-gulv: A/B (lesing, reversible interne handlinger) = T1, C (eksterne handlinger innen mandat) = T2, D (betaling, kontrakt, sletting, publisering, lås,
 * alarm, tilgangsendring) = T3. Klasse alene gir aldri T4: T4 kommer kun fra de kritiske ressursene/dataklassene.
 */
export const TIER_FLOOR_TABLE: TierFloorTable = deepFreeze({
  resources: {
    business_app: "T1",
    production_system: "T2",
    financial_read: "T2",
    payment_write: "T3",
    payroll_system: "T3",
    security_admin: "T3",
    authority_plane: "T4",
    security_constitution: "T4",
    root_cloud_ownership: "T4",
    recovery_root: "T4",
    ownership_control: "T4"
  },
  data_classes: {
    public: "T1",
    internal: "T1",
    customer_data: "T2",
    employee_data: "T2",
    confidential_ip: "T2",
    financial_reporting: "T2",
    legal_privileged: "T3",
    regulated_data: "T3",
    high_sensitivity: "T3",
    payroll_data: "T3",
    security_critical: "T4"
  },
  authority: {
    none: "T1",
    A: "T1",
    B: "T1",
    C: "T2",
    D: "T3"
  },
  regulatory: {
    financial_regulated: "T3",
    health_regulated: "T3",
    special_category_personal_data: "T3",
    classified_or_public_sector: "T3",
    critical_infrastructure: "T3",
    regulated_other: "T3"
  }
} satisfies TierFloorTable);

/** SHA-256 (hex) over kanonisk JSON av policyversjon + taksonomi + gulvtabell. Festes i en test; en endring er en konstitusjonsendring. */
export function tierPolicyDigest(): string {
  const payload: JsonValue = {
    version: TIER_POLICY_VERSION,
    tiers: [...TIERS],
    table: TIER_FLOOR_TABLE as unknown as JsonValue
  };
  return createHash("sha256").update(`jarvis.empire.tier-policy.v1\n${canonicalStringify(payload)}`, "utf8").digest("hex");
}

/** Øvre grense per liste: signalmengdene er endelige (færre enn 12), så en lengre liste er søppel/DoS, ikke inventar. */
export const MAX_TIER_SIGNALS = 64;

export const TierInputsSchema = z
  .object({
    resources: z.array(ResourceKindSchema).max(MAX_TIER_SIGNALS),
    data_classes: z.array(DataClassSchema).max(MAX_TIER_SIGNALS),
    authority_class: AuthorityClassSchema,
    regulatory_flags: z.array(RegulatoryFlagSchema).max(MAX_TIER_SIGNALS),
    /** En FORESPØRSEL. Setter aldri effektiv tier (se filhodet). */
    requested_tier: TierSchema.optional()
  })
  .strict();
export type TierInputs = z.infer<typeof TierInputsSchema>;

export function parseTier(value: unknown): Tier {
  const parsed = TierSchema.safeParse(value);
  if (!parsed.success) throw new TierInputError("invalid_tier");
  return parsed.data;
}

export function parseTierInputs(value: unknown): TierInputs {
  const parsed = TierInputsSchema.safeParse(value);
  if (!parsed.success) {
    throw new TierInputError("invalid_tier_inputs", parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}:${i.code}`));
  }
  return parsed.data;
}

export type FloorSource = "resource" | "data_class" | "authority" | "regulatory";
const SOURCE_ORDER: Readonly<Record<FloorSource, number>> = Object.freeze({ resource: 0, data_class: 1, authority: 2, regulatory: 3 });

export interface TierFloor {
  readonly source: FloorSource;
  readonly signal: string;
  readonly tier: Tier;
}

export type TierRequestDisposition = "none" | "satisfied" | "below_floor_ignored" | "above_floor_not_applied";

export interface TierComputation {
  /** MAKS av alle gulv (T1 når det ikke finnes signaler). Aldri påvirket av `requested_tier`. */
  readonly effective_tier: Tier;
  /** Alle bidragende gulv, sortert deterministisk (høyest tier først, deretter kilde, deretter signal). */
  readonly floors: readonly TierFloor[];
  /** Gulvene som faktisk når effektiv tier («hvorfor er den ikke lavere»). */
  readonly binding_floors: readonly TierFloor[];
  readonly request: { readonly requested_tier: Tier | null; readonly disposition: TierRequestDisposition };
}

function compareFloors(a: TierFloor, b: TierFloor): number {
  const byTier = tierRank(b.tier) - tierRank(a.tier);
  if (byTier !== 0) return byTier;
  const bySource = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  if (bySource !== 0) return bySource;
  return a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0;
}

function collectFloors(inputs: TierInputs): TierFloor[] {
  const floors: TierFloor[] = [];
  for (const signal of new Set(inputs.resources)) floors.push({ source: "resource", signal, tier: TIER_FLOOR_TABLE.resources[signal] });
  for (const signal of new Set(inputs.data_classes)) floors.push({ source: "data_class", signal, tier: TIER_FLOOR_TABLE.data_classes[signal] });
  if (inputs.authority_class !== "none") {
    floors.push({ source: "authority", signal: inputs.authority_class, tier: TIER_FLOOR_TABLE.authority[inputs.authority_class] });
  }
  for (const signal of new Set(inputs.regulatory_flags)) floors.push({ source: "regulatory", signal, tier: TIER_FLOOR_TABLE.regulatory[signal] });
  return floors.sort(compareFloors);
}

function dispositionOf(requested: Tier | undefined, effective: Tier): TierRequestDisposition {
  if (requested === undefined) return "none";
  const diff = tierRank(requested) - tierRank(effective);
  if (diff === 0) return "satisfied";
  return diff < 0 ? "below_floor_ignored" : "above_floor_not_applied";
}

/**
 * K1: effektiv tier = MAKS av gulv. Ren og deterministisk (rekkefølge og duplikater i inngangene spiller ingen rolle), monoton (flere signaler
 * gir aldri lavere tier) og total over signalene (ukjente signaler avvises med `TierInputError` i stedet for å gi et lavere gulv).
 */
export function computeEffectiveTier(input: TierInputs): TierComputation {
  const inputs = parseTierInputs(input);
  const floors = collectFloors(inputs);
  let effective: Tier = "T1";
  for (const floor of floors) effective = maxTier(effective, floor.tier);
  const binding = floors.filter((floor) => floor.tier === effective);
  const result: TierComputation = {
    effective_tier: effective,
    floors: Object.freeze(floors.map((f) => Object.freeze(f))),
    binding_floors: Object.freeze(binding),
    request: Object.freeze({ requested_tier: inputs.requested_tier ?? null, disposition: dispositionOf(inputs.requested_tier, effective) })
  };
  return Object.freeze(result);
}
