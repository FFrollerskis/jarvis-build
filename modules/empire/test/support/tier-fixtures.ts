import type { Tier, TierInputs } from "../../src/index.ts";

/**
 * Uavhengig fasit (golden) for gulvtabellen: skrevet ut her, IKKE avledet av `TIER_FLOOR_TABLE`.
 * En endring av tabellen i koden uten en bevisst endring her (og i den festede sammendragsverdien) feiler testene -
 * tierpolicyen er en del av sikkerhetskonstitusjonen (endring = klasse D + revisjon).
 */
export const GOLDEN_RESOURCE_FLOOR: Readonly<Record<string, Tier>> = {
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
};

export const GOLDEN_DATA_CLASS_FLOOR: Readonly<Record<string, Tier>> = {
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
};

export const GOLDEN_REGULATORY_FLOOR: Readonly<Record<string, Tier>> = {
  financial_regulated: "T3",
  health_regulated: "T3",
  special_category_personal_data: "T3",
  classified_or_public_sector: "T3",
  critical_infrastructure: "T3",
  regulated_other: "T3"
};

export const GOLDEN_AUTHORITY_FLOOR: Readonly<Record<string, Tier>> = {
  none: "T1",
  A: "T1",
  B: "T1",
  C: "T2",
  D: "T3"
};

export const TIER_ORDER: readonly Tier[] = ["T1", "T2", "T3", "T4"];

export function rank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

export function maxOf(tiers: readonly Tier[]): Tier {
  return tiers.reduce<Tier>((acc, t) => (rank(t) > rank(acc) ? t : acc), "T1");
}

/** Tomme innganger (laveste mulige inventar). */
export function emptyInputs(): TierInputs {
  return { resources: [], data_classes: [], authority_class: "none", regulatory_flags: [] };
}

export function inputs(partial: Partial<TierInputs> = {}): TierInputs {
  return { ...emptyInputs(), ...partial };
}

/** Rekursiv frysing: en funksjon som muterer innganger kaster i strict mode. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
