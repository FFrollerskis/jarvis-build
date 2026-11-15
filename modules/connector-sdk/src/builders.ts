import type { CapabilityClass, TrustLevel } from "@jarvis/contracts";
import { kindOfEffect, type ActionEffect, type ActionSpec, type IdempotencyRequirement, type Postcondition, type RollbackMethod } from "./manifest.ts";

/**
 * WP-I (D-472): små byggere for håndskrevne manifester, så en handlingsrad blir én lesbar linje i stedet for 40. Alle FAKTA er eksplisitte parametre (risikoklasse, effekt, rate limit, tidsavbrudd,
 * idempotens, rollback ...); byggerne fyller KUN inn det som er sant for enhver ren lese-handling (ingen bivirkning å reversere). Resultatet er vanlige `ActionSpec`-objekter som valideres og
 * drift-sjekkes mot registeret som alle andre - en byggerfeil kan ikke skjule seg.
 */

export interface ReadActionOptions {
  rate: number;
  timeout: number;
  /** Påkrevde parametre (fra inndataskjemaet). */
  required?: readonly string[];
  /** Identitetsfelt i skjemaet (tenant/person/space). */
  identity_fields?: readonly string[];
  /** Standard: `untrusted` (innhold fra leverandøren). */
  trust?: TrustLevel;
  step_up?: boolean;
  owner_only?: boolean;
}

export function readAction(key: string, o: ReadActionOptions): ActionSpec {
  return {
    key, kind: "read", effect: "read",
    authority: { risk_class: "A", step_up_required: o.step_up === true, owner_only: o.owner_only === true },
    reversibility: { reversible: true, rollback_method: "none", rollback_procedure: "ingen (lesing)", compensating_action: null, destructive: false, evidence: { before_state: false, postcondition: "none" } },
    idempotency: { requirement: "none", provider_idempotent: true },
    trust: { output: o.trust ?? "untrusted" },
    limits: { rate_limit_per_minute: o.rate },
    operations: { timeout_ms: o.timeout },
    data: { input_required: [...(o.required ?? [])].sort(), identity_fields: [...(o.identity_fields ?? [])] }
  };
}

export interface MutationOptions {
  effect: Exclude<ActionEffect, "read">;
  risk: Exclude<CapabilityClass, "A">;
  rate: number;
  timeout: number;
  idempotency: Exclude<IdempotencyRequirement, "none">;
  provider_idempotent: boolean;
  reversible: boolean;
  rollback_method: RollbackMethod;
  /** Fritekst: hvordan handlingen reverseres (eller at den ikke kan det). */
  rollback_procedure: string;
  compensating_action?: string | null;
  /** Standard: slik registeret utleder den (sletting, eller skriving som ikke kan reverseres). */
  destructive?: boolean;
  before_state: boolean;
  postcondition: Postcondition;
  /** Kun klasse D: kjedens tilstand (standard `complete`). */
  class_d_chain?: { status: "complete" | "deferred" | "exempt"; missing?: readonly string[] };
  required?: readonly string[];
  identity_fields?: readonly string[];
  trust?: TrustLevel;
  step_up?: boolean;
  owner_only?: boolean;
  risk_exception?: string;
}

export function mutationAction(key: string, o: MutationOptions): ActionSpec {
  const destructive = o.destructive ?? (o.effect === "delete" || !o.reversible);
  const chain = o.risk === "D" ? { class_d_chain: { status: o.class_d_chain?.status ?? "complete", missing: [...(o.class_d_chain?.missing ?? [])] } } : {};
  return {
    key, kind: kindOfEffect(o.effect), effect: o.effect,
    authority: { risk_class: o.risk, step_up_required: o.step_up === true, owner_only: o.owner_only === true, ...(o.risk_exception !== undefined ? { risk_exception: o.risk_exception } : {}) },
    reversibility: {
      reversible: o.reversible,
      rollback_method: o.rollback_method,
      rollback_procedure: o.rollback_procedure,
      compensating_action: o.compensating_action ?? null,
      destructive,
      evidence: { before_state: o.before_state, postcondition: o.postcondition },
      ...chain
    },
    idempotency: { requirement: o.idempotency, provider_idempotent: o.provider_idempotent },
    trust: { output: o.trust ?? "internal" },
    limits: { rate_limit_per_minute: o.rate },
    operations: { timeout_ms: o.timeout },
    data: { input_required: [...(o.required ?? [])].sort(), identity_fields: [...(o.identity_fields ?? [])] }
  };
}

/** Strengeste utdata-klasse over handlingene (untrusted > internal > trusted). */
export function strictestTrust(actions: readonly ActionSpec[]): TrustLevel {
  const order = { trusted: 0, internal: 1, untrusted: 2 } as const;
  return actions.map((a) => a.trust.output).reduce<TrustLevel>((acc, t) => (order[t] > order[acc] ? t : acc), "trusted");
}

export const maxTimeoutMs = (actions: readonly ActionSpec[]): number => Math.max(...actions.map((a) => a.operations.timeout_ms));
export const scopesOf = (...labels: readonly string[]): string[] => [...new Set(labels)].sort();
