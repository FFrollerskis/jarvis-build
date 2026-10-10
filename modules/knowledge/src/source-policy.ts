import { KNOWLEDGE_SENSITIVITIES, KNOWLEDGE_TRUST_LEVELS, type KnowledgeSensitivity, type KnowledgeTrustLevel } from "./sensitivity.ts";

/**
 * WP-D1 (UA-2): hva en KILDE selv bestemmer om sine dokumenter (kommer fra `JARVIS_KNOWLEDGE_SOURCES`). Alt er valgfritt og har en fail-closed standard:
 *  - `default_sensitivity` er GULVET for sensitivitetsmerket: strengeste av dette og klassifiseringen av teksten gjelder (standard `sensitive`: privat som standard, aldri `normal` ved en feil).
 *    Kun en eksplisitt `normal` (f.eks. et offentlig dokumentasjons-repo) lar rene dokumenter stå som `normal`; teksten kan fortsatt løfte dem.
 *  - `max_sensitivity` er TAKET: et dokument som (etter gulv + klassifisering) er strengere enn taket indekseres IKKE (og et som allerede er indeksert tombstones). Slik kan eieren holde f.eks.
 *    helse-/økonomi-/hemmelighetsdokumenter helt utenfor kunnskapsbasen fra en kilde (`max_sensitivity: "sensitive"`). Utelatt = ingen grense (alt indekseres, `special` holdes tilbake fra skymodeller).
 *  - `trust` er tilliten til innholdet i treff: `untrusted` (standard) eller `internal` (eierens egne notater). Aldri `trusted` - dokumentinnhold er aldri instruks.
 */
export interface KnowledgeSourcePolicy {
  default_sensitivity?: KnowledgeSensitivity | undefined;
  max_sensitivity?: KnowledgeSensitivity | undefined;
  trust?: KnowledgeTrustLevel | undefined;
}

export interface ResolvedSourcePolicy {
  floor: KnowledgeSensitivity;
  ceiling: KnowledgeSensitivity | undefined;
  trust: KnowledgeTrustLevel;
}

export class InvalidSourcePolicyError extends Error {
  constructor(readonly reason: string) {
    super(`invalid_source_policy:${reason}`);
    this.name = "InvalidSourcePolicyError";
  }
}

const RANK: Readonly<Record<KnowledgeSensitivity, number>> = { normal: 0, sensitive: 1, special: 2 };

/** Validerer og fyller inn standarder. Kaster ved ukjente verdier eller et gulv som ligger over taket (da kunne ingenting indekseres - nesten alltid en feil i konfigurasjonen). */
export function resolveSourcePolicy(policy: KnowledgeSourcePolicy = {}): ResolvedSourcePolicy {
  const floor = policy.default_sensitivity ?? "sensitive";
  if (!(KNOWLEDGE_SENSITIVITIES as readonly string[]).includes(floor)) throw new InvalidSourcePolicyError("default_sensitivity_unknown");
  const ceiling = policy.max_sensitivity;
  if (ceiling !== undefined && !(KNOWLEDGE_SENSITIVITIES as readonly string[]).includes(ceiling)) throw new InvalidSourcePolicyError("max_sensitivity_unknown");
  if (ceiling !== undefined && RANK[floor] > RANK[ceiling]) throw new InvalidSourcePolicyError("default_sensitivity_above_max_sensitivity");
  const trust = policy.trust ?? "untrusted";
  if (!(KNOWLEDGE_TRUST_LEVELS as readonly string[]).includes(trust)) throw new InvalidSourcePolicyError("trust_unknown");
  return { floor, ceiling, trust };
}

/** Er et dokument med denne sensitiviteten strengere enn kildens tak? (Uten tak: aldri.) */
export function exceedsCeiling(sensitivity: KnowledgeSensitivity, ceiling: KnowledgeSensitivity | undefined): boolean {
  return ceiling !== undefined && RANK[sensitivity] > RANK[ceiling];
}
