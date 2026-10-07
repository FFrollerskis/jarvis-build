import type { EvChangeClass } from "../constitution.ts";

/**
 * EV-17 (Evolution Masterplan v1.2 kap. 24): Credential & Identity Self-Maintenance - klassifisering og beslutning (rene funksjoner). Hemmelige
 * VERDIER inngår aldri her: kun referanser og metadata. Fornyelse av kortlevde runtime-tokens innen eksisterende scope kan være H1/E0; nye
 * rot-credentials, OAuth-samtykke, leverandørkontoer, KYC og juridiske vilkår er alltid menneskelig/ekstern port; scope-/nettverks-/rot-endringer er E2.
 * DEFERRED: faktisk overvåking av utløp/OAuth-feil og nød-tilbakekalling uavhengig av Core (EV-20).
 */
export type CredentialKind = "short_lived_token" | "oauth" | "api_key" | "root";

export interface CredentialState {
  ref: string;
  kind: CredentialKind;
  expires_at: string | null;
  last_refresh_ok: boolean | null;
  scopes_granted: readonly string[];
  scopes_required: readonly string[];
  revoked: boolean;
}

export type CredentialHealth = "ok" | "expiring_soon" | "expired" | "refresh_failing" | "scope_shortfall" | "revoked";

export interface CredentialAssessment {
  ref: string;
  health: CredentialHealth;
  /** Handling Jarvis selv kan ta (H1) - kun innen eksisterende scope og kun for kortlevde tokens. */
  auto_action: "refresh_in_scope" | "none";
  /** Alt annet går til eier/ekstern. */
  needs: "none" | "owner_alert" | "human_external_gate";
  reasons: string[];
}

export function assessCredential(c: CredentialState, now: Date, soonHours = 24): CredentialAssessment {
  const reasons: string[] = [];
  if (c.revoked) return { ref: c.ref, health: "revoked", auto_action: "none", needs: "owner_alert", reasons: ["revoked"] };
  const missing = c.scopes_required.filter((s) => !c.scopes_granted.includes(s));
  if (missing.length > 0) return { ref: c.ref, health: "scope_shortfall", auto_action: "none", needs: "human_external_gate", reasons: [`missing_scopes:${missing.join(",")}`] };
  const exp = c.expires_at === null ? null : new Date(c.expires_at).getTime();
  const expired = exp !== null && exp <= now.getTime();
  const soon = exp !== null && !expired && exp - now.getTime() <= soonHours * 3_600_000;
  const refreshable = c.kind === "short_lived_token" || c.kind === "oauth";
  if (c.last_refresh_ok === false) return { ref: c.ref, health: "refresh_failing", auto_action: "none", needs: c.kind === "oauth" ? "human_external_gate" : "owner_alert", reasons: ["refresh_failed"] };
  if (expired) return { ref: c.ref, health: "expired", auto_action: refreshable && c.kind === "short_lived_token" ? "refresh_in_scope" : "none", needs: refreshable && c.kind === "short_lived_token" ? "none" : "owner_alert", reasons };
  if (soon) return { ref: c.ref, health: "expiring_soon", auto_action: refreshable && c.kind === "short_lived_token" ? "refresh_in_scope" : "none", needs: c.kind === "short_lived_token" ? "none" : "owner_alert", reasons };
  return { ref: c.ref, health: "ok", auto_action: "none", needs: "none", reasons };
}

export type CredentialChange = "refresh_in_scope" | "scope_change" | "network_change" | "new_root_credential" | "oauth_consent" | "new_provider_account" | "kyc" | "legal_terms";

export interface CredentialChangeVerdict {
  change_class: EvChangeClass;
  /** `human_external`: aldri automatisk, uavhengig av E-klasse. */
  gate: "auto_h1" | "owner_e2" | "human_external";
}

export function classifyCredentialChange(change: CredentialChange): CredentialChangeVerdict {
  switch (change) {
    case "refresh_in_scope": return { change_class: "E0", gate: "auto_h1" };
    case "scope_change":
    case "network_change": return { change_class: "E2", gate: "owner_e2" };
    case "new_root_credential": return { change_class: "E2", gate: "human_external" };
    case "oauth_consent":
    case "new_provider_account":
    case "kyc":
    case "legal_terms": return { change_class: "E2", gate: "human_external" };
  }
}

/** Referanse-mønster: kun `credential_ref`-navn (store bokstaver/understrek) kan nå en agent/LLM-kontekst - aldri en verdi. */
const CREDENTIAL_REF = /^[A-Z][A-Z0-9_]{2,80}$/;
export function isCredentialRef(value: string): boolean {
  return CREDENTIAL_REF.test(value);
}
