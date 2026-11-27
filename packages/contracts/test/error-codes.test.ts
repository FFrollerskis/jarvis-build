import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  ERROR_CODE_DEFS,
  ERROR_CODE_FORMAT,
  ERROR_NAMESPACES,
  ErrorCodeDefSchema,
  errorCodeForLegacy,
  errorCodeInfo,
  isErrorCode,
  type ErrorCodeDef
} from "../src/error-codes.ts";
import { resolveGuardMode } from "../src/program/mode.ts";

/**
 * WP-DX0 (HF6 §25.3, H6-DX10): feilkode-registeret. Registeret er KONTRAKT og mapping - det endrer ingen atferd (ingen produksjonskode importerer det ennå, og ingen årsaksstreng er
 * omdøpt). Testen har tre deler:
 *   A. register-lint (alltid streng): ingen duplikate koder, format, eier/alvor/retryability på hver kode, planens eksempler er dekket, navn er stabile (pinnet snapshot kan bare vokse);
 *   B. hjelpefunksjonene (oppslag fra gammel årsaksstreng til stabil kode);
 *   C. drift mot koden (modusstyrt, `report` som standard): hver mapping peker på en streng som fortsatt står i kilden, og hver streng i de lukkede årsakskatalogene har en kode.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** §25.3: de elleve navneromradene (ikke ti), i plan-rekkefølge. */
const EXPECTED_NAMESPACES = ["AUTH_TENANT", "SECRET_IDENTITY", "MODEL_ROUTING", "TOOL_CONNECTOR", "DB_DATA", "WORKER_INFRA", "MEMORY_RETRIEVAL_EXPERT", "LEARNING_EVAL", "VOICE_DEVICE_UI", "FINANCE_SIDE_EFFECT", "SECURITY"];

/** Hvert eksempel i §25.3 -> koden som dekker det. */
const PLAN_EXAMPLES: Record<string, string[]> = {
  AUTH_TENANT: ["AUTH_TENANT.MEMBERSHIP_MISMATCH", "AUTH_TENANT.WRONG_ORG", "AUTH_TENANT.DEVICE_REVOKED", "AUTH_TENANT.POLICY_DENY", "AUTH_TENANT.STALE_GRANT"],
  SECRET_IDENTITY: ["SECRET_IDENTITY.TOKEN_EXPIRED", "SECRET_IDENTITY.VAULT_LOOKUP_FAILED", "SECRET_IDENTITY.PROVIDER_VERIFICATION_FAILED", "SECRET_IDENTITY.MISSING_SCOPE"],
  MODEL_ROUTING: ["MODEL_ROUTING.PROVIDER_TIMEOUT", "MODEL_ROUTING.MALFORMED_OUTPUT", "MODEL_ROUTING.TOOL_SELECTION_FAILED", "MODEL_ROUTING.CONTEXT_OVERFLOW", "MODEL_ROUTING.QUALITY_REGRESSION"],
  TOOL_CONNECTOR: ["TOOL_CONNECTOR.API_CLIENT_ERROR", "TOOL_CONNECTOR.API_SERVER_ERROR", "TOOL_CONNECTOR.RATE_LIMITED", "TOOL_CONNECTOR.SCHEMA_DRIFT", "TOOL_CONNECTOR.IDEMPOTENCY_REPLAY", "TOOL_CONNECTOR.WRONG_TARGET_READBACK"],
  DB_DATA: ["DB_DATA.RLS_DENY", "DB_DATA.MIGRATION_MISMATCH", "DB_DATA.STALE_DATA", "DB_DATA.DUPLICATE_DATA", "DB_DATA.CORRUPT_DATA", "DB_DATA.CONSTRAINT_VIOLATION", "DB_DATA.DEADLOCK"],
  WORKER_INFRA: ["WORKER_INFRA.CRASH_LOOP", "WORKER_INFRA.OOM", "WORKER_INFRA.DISK_FULL", "WORKER_INFRA.QUEUE_LEASE_LOST", "WORKER_INFRA.HOST_UNREACHABLE", "WORKER_INFRA.NETWORK_FAILURE", "WORKER_INFRA.DNS_FAILURE", "WORKER_INFRA.TUNNEL_DOWN"],
  MEMORY_RETRIEVAL_EXPERT: ["MEMORY_RETRIEVAL_EXPERT.MISSING_SOURCE", "MEMORY_RETRIEVAL_EXPERT.STALE_PACK", "MEMORY_RETRIEVAL_EXPERT.EXPERT_RECALLED", "MEMORY_RETRIEVAL_EXPERT.RETRIEVAL_CONTAMINATION"],
  LEARNING_EVAL: ["LEARNING_EVAL.BAD_CANDIDATE", "LEARNING_EVAL.HOLDOUT_REGRESSION", "LEARNING_EVAL.POISONED_EVIDENCE", "LEARNING_EVAL.SKILL_DRIFT", "LEARNING_EVAL.EVAL_LEAKAGE"],
  VOICE_DEVICE_UI: ["VOICE_DEVICE_UI.STT_FAILURE", "VOICE_DEVICE_UI.TTS_FAILURE", "VOICE_DEVICE_UI.APNS_FAILURE", "VOICE_DEVICE_UI.DEVICE_STATE_INVALID", "VOICE_DEVICE_UI.CALL_PROVIDER_FAILURE", "VOICE_DEVICE_UI.CLIENT_MISMATCH"],
  FINANCE_SIDE_EFFECT: ["FINANCE_SIDE_EFFECT.RECONCILIATION_MISMATCH", "FINANCE_SIDE_EFFECT.DUPLICATE_INTENT", "FINANCE_SIDE_EFFECT.RECIPIENT_MISMATCH", "FINANCE_SIDE_EFFECT.PROVIDER_STATE_AMBIGUOUS"],
  SECURITY: ["SECURITY.PROMPT_INJECTION", "SECURITY.EXFILTRATION_ATTEMPT", "SECURITY.TAMPER_DETECTED", "SECURITY.CROSS_TENANT_ESCAPE", "SECURITY.SUSPICIOUS_SELF_CHANGE"]
};

/**
 * Stabilitets-snapshot: koder som er utgitt kan aldri fjernes eller flytte namespace (omdøping = ny kode + `deprecated` på den gamle). Snapshotet kan bare VOKSE (en bevisst endring her når nye koder er utgitt);
 * nye koder i registeret uten å røre denne listen er lov. Generert fra registeret ved første utgivelse.
 */
const PINNED: ReadonlyArray<readonly [string, string]> = [
  ["AUTH_TENANT.MEMBERSHIP_MISMATCH", "AUTH_TENANT"], ["AUTH_TENANT.WRONG_ORG", "AUTH_TENANT"], ["AUTH_TENANT.DEVICE_REVOKED", "AUTH_TENANT"], ["AUTH_TENANT.DEVICE_UNKNOWN", "AUTH_TENANT"],
  ["AUTH_TENANT.POLICY_DENY", "AUTH_TENANT"], ["AUTH_TENANT.STALE_GRANT", "AUTH_TENANT"], ["AUTH_TENANT.INVALID_IDENTITY_CONTEXT", "AUTH_TENANT"], ["AUTH_TENANT.AUTH_STRENGTH_INSUFFICIENT", "AUTH_TENANT"],
  ["AUTH_TENANT.NO_MANDATE", "AUTH_TENANT"], ["AUTH_TENANT.KILL_SWITCH_ACTIVE", "AUTH_TENANT"], ["AUTH_TENANT.APPROVAL_MISSING", "AUTH_TENANT"], ["AUTH_TENANT.APPROVAL_MALFORMED", "AUTH_TENANT"],
  ["AUTH_TENANT.APPROVAL_EXPIRED", "AUTH_TENANT"], ["AUTH_TENANT.APPROVAL_NOT_YET_VALID", "AUTH_TENANT"], ["AUTH_TENANT.APPROVAL_BINDING_MISMATCH", "AUTH_TENANT"], ["AUTH_TENANT.APPROVAL_REPLAYED", "AUTH_TENANT"],
  ["AUTH_TENANT.APPROVER_NOT_AUTHORIZED", "AUTH_TENANT"], ["SECRET_IDENTITY.TOKEN_EXPIRED", "SECRET_IDENTITY"], ["SECRET_IDENTITY.VAULT_LOOKUP_FAILED", "SECRET_IDENTITY"], ["SECRET_IDENTITY.PROVIDER_VERIFICATION_FAILED", "SECRET_IDENTITY"],
  ["SECRET_IDENTITY.MISSING_SCOPE", "SECRET_IDENTITY"], ["SECRET_IDENTITY.SIGNATURE_INVALID", "SECRET_IDENTITY"], ["MODEL_ROUTING.PROVIDER_TIMEOUT", "MODEL_ROUTING"], ["MODEL_ROUTING.MALFORMED_OUTPUT", "MODEL_ROUTING"],
  ["MODEL_ROUTING.TOOL_SELECTION_FAILED", "MODEL_ROUTING"], ["MODEL_ROUTING.CONTEXT_OVERFLOW", "MODEL_ROUTING"], ["MODEL_ROUTING.QUALITY_REGRESSION", "MODEL_ROUTING"], ["TOOL_CONNECTOR.API_CLIENT_ERROR", "TOOL_CONNECTOR"],
  ["TOOL_CONNECTOR.API_SERVER_ERROR", "TOOL_CONNECTOR"], ["TOOL_CONNECTOR.RATE_LIMITED", "TOOL_CONNECTOR"], ["TOOL_CONNECTOR.SCHEMA_DRIFT", "TOOL_CONNECTOR"], ["TOOL_CONNECTOR.IDEMPOTENCY_REPLAY", "TOOL_CONNECTOR"],
  ["TOOL_CONNECTOR.WRONG_TARGET_READBACK", "TOOL_CONNECTOR"], ["TOOL_CONNECTOR.INVALID_TOOL_CALL", "TOOL_CONNECTOR"], ["TOOL_CONNECTOR.CONNECTOR_FROZEN", "TOOL_CONNECTOR"], ["DB_DATA.RLS_DENY", "DB_DATA"],
  ["DB_DATA.MIGRATION_MISMATCH", "DB_DATA"], ["DB_DATA.MIGRATION_SET_INVALID", "DB_DATA"], ["DB_DATA.MIGRATION_CREDENTIALS_MISSING", "DB_DATA"], ["DB_DATA.STALE_DATA", "DB_DATA"], ["DB_DATA.DUPLICATE_DATA", "DB_DATA"],
  ["DB_DATA.CORRUPT_DATA", "DB_DATA"], ["DB_DATA.CONSTRAINT_VIOLATION", "DB_DATA"], ["DB_DATA.DEADLOCK", "DB_DATA"], ["DB_DATA.NONCE_STORE_ERROR", "DB_DATA"], ["DB_DATA.TRUTH_REGIME_INVALID_INPUT", "DB_DATA"],
  ["DB_DATA.TRUTH_BASIS_REQUIRED", "DB_DATA"], ["WORKER_INFRA.CRASH_LOOP", "WORKER_INFRA"], ["WORKER_INFRA.OOM", "WORKER_INFRA"], ["WORKER_INFRA.DISK_FULL", "WORKER_INFRA"], ["WORKER_INFRA.QUEUE_LEASE_LOST", "WORKER_INFRA"],
  ["WORKER_INFRA.HOST_UNREACHABLE", "WORKER_INFRA"], ["WORKER_INFRA.NETWORK_FAILURE", "WORKER_INFRA"], ["WORKER_INFRA.DNS_FAILURE", "WORKER_INFRA"], ["WORKER_INFRA.TUNNEL_DOWN", "WORKER_INFRA"],
  ["WORKER_INFRA.INFRA_MODE_PAUSED", "WORKER_INFRA"], ["WORKER_INFRA.INFRA_DEGRADED_BLOCKS_CLASS_D", "WORKER_INFRA"], ["WORKER_INFRA.INFRA_MODE_UNAVAILABLE", "WORKER_INFRA"], ["WORKER_INFRA.STATE_UNKNOWN", "WORKER_INFRA"],
  ["WORKER_INFRA.OBSERVABILITY_MISSING", "WORKER_INFRA"], ["WORKER_INFRA.INCIDENT_OPEN", "WORKER_INFRA"], ["WORKER_INFRA.SLO_BREACHED", "WORKER_INFRA"], ["MEMORY_RETRIEVAL_EXPERT.MISSING_SOURCE", "MEMORY_RETRIEVAL_EXPERT"],
  ["MEMORY_RETRIEVAL_EXPERT.STALE_PACK", "MEMORY_RETRIEVAL_EXPERT"], ["MEMORY_RETRIEVAL_EXPERT.EXPERT_RECALLED", "MEMORY_RETRIEVAL_EXPERT"], ["MEMORY_RETRIEVAL_EXPERT.RETRIEVAL_CONTAMINATION", "MEMORY_RETRIEVAL_EXPERT"],
  ["LEARNING_EVAL.BAD_CANDIDATE", "LEARNING_EVAL"], ["LEARNING_EVAL.HOLDOUT_REGRESSION", "LEARNING_EVAL"], ["LEARNING_EVAL.POISONED_EVIDENCE", "LEARNING_EVAL"], ["LEARNING_EVAL.SKILL_DRIFT", "LEARNING_EVAL"],
  ["LEARNING_EVAL.EVAL_LEAKAGE", "LEARNING_EVAL"], ["VOICE_DEVICE_UI.STT_FAILURE", "VOICE_DEVICE_UI"], ["VOICE_DEVICE_UI.TTS_FAILURE", "VOICE_DEVICE_UI"], ["VOICE_DEVICE_UI.APNS_FAILURE", "VOICE_DEVICE_UI"],
  ["VOICE_DEVICE_UI.DEVICE_STATE_INVALID", "VOICE_DEVICE_UI"], ["VOICE_DEVICE_UI.CALL_PROVIDER_FAILURE", "VOICE_DEVICE_UI"], ["VOICE_DEVICE_UI.CLIENT_MISMATCH", "VOICE_DEVICE_UI"],
  ["FINANCE_SIDE_EFFECT.RECONCILIATION_MISMATCH", "FINANCE_SIDE_EFFECT"], ["FINANCE_SIDE_EFFECT.DUPLICATE_INTENT", "FINANCE_SIDE_EFFECT"], ["FINANCE_SIDE_EFFECT.RECIPIENT_MISMATCH", "FINANCE_SIDE_EFFECT"],
  ["FINANCE_SIDE_EFFECT.PROVIDER_STATE_AMBIGUOUS", "FINANCE_SIDE_EFFECT"], ["SECURITY.PROMPT_INJECTION", "SECURITY"], ["SECURITY.EXFILTRATION_ATTEMPT", "SECURITY"], ["SECURITY.TAMPER_DETECTED", "SECURITY"],
  ["SECURITY.CROSS_TENANT_ESCAPE", "SECURITY"], ["SECURITY.SUSPICIOUS_SELF_CHANGE", "SECURITY"], ["SECURITY.CONSTITUTION_NOT_VERIFIED", "SECURITY"], ["SECURITY.CONSTITUTION_INVALID", "SECURITY"],
  ["SECURITY.TRUTH_REGIME_MODEL_ESCALATION", "SECURITY"]
];

describe("A. register-lint (alltid streng)", () => {
  it("§25.3 har ELLEVE navnerom og de er nøyaktig registerets namespaces, i plan-rekkefølge", () => {
    expect([...ERROR_NAMESPACES]).toEqual(EXPECTED_NAMESPACES);
    expect(ERROR_NAMESPACES.length).toBe(11);
  });

  it("hver kodedefinisjon er gyldig etter det strenge skjemaet (eier, alvor, retryability, beskrivelse)", () => {
    for (const def of ERROR_CODE_DEFS) {
      const parsed = ErrorCodeDefSchema.safeParse(def);
      expect(parsed.success, `${def.code}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues[0])}`).toBe(true);
    }
  });

  it("koden har formatet NAMESPACE.NAVN og prefikset er definisjonens namespace", () => {
    for (const def of ERROR_CODE_DEFS) {
      expect(ERROR_CODE_FORMAT.test(def.code), def.code).toBe(true);
      expect(def.code.split(".")[0], def.code).toBe(def.namespace);
    }
  });

  it("formatet avviser alt som ikke er NAMESPACE.NAVN med store bokstaver, tall og enkle understreker", () => {
    const bad = ["", "AUTH_TENANT", "auth_tenant.x", "AUTH_TENANT.x", "Auth_Tenant.NAME", "AUTH_TENANT.NAME.EXTRA", "AUTH__TENANT.NAME", "_AUTH.NAME", "AUTH_.NAME", "AUTH.NAME_", "AUTH.1NAME", "1AUTH.NAME", "AUTH TENANT.NAME", "AUTH.NAME\n", ".NAME", "AUTH.", "AUTH-TENANT.NAME"];
    for (const code of bad) expect(ERROR_CODE_FORMAT.test(code), JSON.stringify(code)).toBe(false);
    for (const code of ["A.B", "AUTH_TENANT.MEMBERSHIP_MISMATCH", "A1.B2_C3"]) expect(ERROR_CODE_FORMAT.test(code), code).toBe(true);
  });

  it("ingen duplikate koder (hverken ordrett eller etter store/små bokstaver)", () => {
    const codes = ERROR_CODE_DEFS.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(codes.map((c) => c.toLowerCase())).size).toBe(codes.length);
  });

  it("ingen duplikate legacy-nøkler: (kilde som emitterer strengen, streng slik den lagres) peker på nøyaktig én kode", () => {
    const seen = new Map<string, string>();
    for (const def of ERROR_CODE_DEFS) {
      for (const l of def.legacy) {
        const key = `${l.source}\u0000${l.reason}`;
        expect(seen.get(key), `${def.code} <- ${l.source}:${l.reason} (allerede ${seen.get(key)})`).toBeUndefined();
        seen.set(key, def.code);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(40);
  });

  it("hvert namespace har minst tre koder, og hvert plan-eksempel har en kode (§25.3 Eksempler)", () => {
    for (const ns of ERROR_NAMESPACES) {
      expect(ERROR_CODE_DEFS.filter((d) => d.namespace === ns).length, ns).toBeGreaterThanOrEqual(3);
      for (const code of PLAN_EXAMPLES[ns] ?? []) expect(ERROR_CODES[code as keyof typeof ERROR_CODES], code).toBeDefined();
    }
    expect(Object.values(PLAN_EXAMPLES).flat().length).toBe(59);
  });

  it("stabile navn: hver pinnet kode finnes fortsatt med samme namespace (snapshotet kan bare vokse)", () => {
    expect(PINNED.length).toBeGreaterThanOrEqual(85);
    expect(new Set(PINNED.map(([c]) => c)).size).toBe(PINNED.length);
    for (const [code, ns] of PINNED) {
      const def = (ERROR_CODES as Record<string, ErrorCodeDef | undefined>)[code];
      expect(def, `${code} er fjernet eller omdøpt (bruk ny kode + deprecated)`).toBeDefined();
      expect(def?.namespace, code).toBe(ns);
    }
  });

  it("en utfaset kode peker på en eksisterende erstatter; en aktiv kode har ingen erstatter", () => {
    for (const def of ERROR_CODE_DEFS) {
      if (def.status === "deprecated") {
        expect(def.replaced_by, def.code).not.toBeNull();
        expect(ERROR_CODES[def.replaced_by as keyof typeof ERROR_CODES], `${def.code} -> ${def.replaced_by}`).toBeDefined();
        expect(def.replaced_by).not.toBe(def.code);
      } else {
        expect(def.replaced_by, def.code).toBeNull();
      }
    }
  });

  it("retryability følger semantikken: en kode som krever tilbakelesing/ukjent utfall er aldri blind retry; sikkerhetskoder retries aldri blindt", () => {
    for (const def of ERROR_CODE_DEFS.filter((d) => d.namespace === "SECURITY")) {
      expect(["never", "retry_after_fix"], def.code).toContain(def.retryability);
      expect(["high", "critical"], def.code).toContain(def.severity);
    }
    expect(ERROR_CODES["FINANCE_SIDE_EFFECT.PROVIDER_STATE_AMBIGUOUS"].severity).toBe("critical");
    expect(ERROR_CODES["FINANCE_SIDE_EFFECT.RECIPIENT_MISMATCH"].severity).toBe("critical");
    expect(ERROR_CODES["DB_DATA.MIGRATION_MISMATCH"].severity).toBe("critical");
    expect(ERROR_CODES["FINANCE_SIDE_EFFECT.PROVIDER_STATE_AMBIGUOUS"].retryability).toBe("readback_first");
    expect(ERROR_CODES["TOOL_CONNECTOR.WRONG_TARGET_READBACK"].retryability).toBe("readback_first");
    expect(ERROR_CODES["TOOL_CONNECTOR.RATE_LIMITED"].retryability).toBe("retry_with_backoff");
    expect(ERROR_CODES["AUTH_TENANT.POLICY_DENY"].retryability).toBe("never");
  });

  /**
   * Fiks 1 (M6, M64): gjentakbarheten for HVER kode er festet. Tidligere sa to koder («for en mutasjon er utfallet UKJENT inntil det er lest tilbake») at utfallet var ukjent, men hadde
   * `retry_with_backoff`, og en flipp av replay-koden til retry overlevde i report-modus. N = never, F = retry_after_fix, B = retry_with_backoff, R = readback_first. En ny kode må legges
   * til her (bevisst); en endret gjentakbarhet er en kontraktendring.
   */
  const PINNED_RETRYABILITY: Record<string, "N" | "F" | "B" | "R"> = Object.fromEntries([
  ["AUTH_TENANT.MEMBERSHIP_MISMATCH", "N"], ["AUTH_TENANT.WRONG_ORG", "N"], ["AUTH_TENANT.DEVICE_REVOKED", "N"], ["AUTH_TENANT.DEVICE_UNKNOWN", "N"], ["AUTH_TENANT.POLICY_DENY", "N"],
  ["AUTH_TENANT.STALE_GRANT", "F"], ["AUTH_TENANT.INVALID_IDENTITY_CONTEXT", "N"], ["AUTH_TENANT.AUTH_STRENGTH_INSUFFICIENT", "F"], ["AUTH_TENANT.NO_MANDATE", "F"],
  ["AUTH_TENANT.KILL_SWITCH_ACTIVE", "F"], ["AUTH_TENANT.APPROVAL_MISSING", "F"], ["AUTH_TENANT.APPROVAL_MALFORMED", "F"], ["AUTH_TENANT.APPROVAL_EXPIRED", "F"],
  ["AUTH_TENANT.APPROVAL_NOT_YET_VALID", "F"], ["AUTH_TENANT.APPROVAL_BINDING_MISMATCH", "N"], ["AUTH_TENANT.APPROVAL_REPLAYED", "N"], ["AUTH_TENANT.APPROVER_NOT_AUTHORIZED", "N"],
  ["SECRET_IDENTITY.TOKEN_EXPIRED", "F"], ["SECRET_IDENTITY.VAULT_LOOKUP_FAILED", "B"], ["SECRET_IDENTITY.PROVIDER_VERIFICATION_FAILED", "N"], ["SECRET_IDENTITY.MISSING_SCOPE", "F"],
  ["SECRET_IDENTITY.SIGNATURE_INVALID", "N"], ["MODEL_ROUTING.PROVIDER_TIMEOUT", "B"], ["MODEL_ROUTING.MALFORMED_OUTPUT", "B"], ["MODEL_ROUTING.TOOL_SELECTION_FAILED", "F"],
  ["MODEL_ROUTING.CONTEXT_OVERFLOW", "F"], ["MODEL_ROUTING.QUALITY_REGRESSION", "F"], ["TOOL_CONNECTOR.API_CLIENT_ERROR", "F"], ["TOOL_CONNECTOR.API_SERVER_ERROR", "R"],
  ["TOOL_CONNECTOR.RATE_LIMITED", "B"], ["TOOL_CONNECTOR.SCHEMA_DRIFT", "F"], ["TOOL_CONNECTOR.IDEMPOTENCY_REPLAY", "R"], ["TOOL_CONNECTOR.WRONG_TARGET_READBACK", "R"],
  ["TOOL_CONNECTOR.INVALID_TOOL_CALL", "N"], ["TOOL_CONNECTOR.CONNECTOR_FROZEN", "F"], ["DB_DATA.RLS_DENY", "N"], ["DB_DATA.MIGRATION_MISMATCH", "F"], ["DB_DATA.MIGRATION_SET_INVALID", "F"],
  ["DB_DATA.MIGRATION_CREDENTIALS_MISSING", "F"], ["DB_DATA.STALE_DATA", "F"], ["DB_DATA.DUPLICATE_DATA", "R"], ["DB_DATA.CORRUPT_DATA", "N"], ["DB_DATA.CONSTRAINT_VIOLATION", "N"],
  ["DB_DATA.DEADLOCK", "B"], ["DB_DATA.NONCE_STORE_ERROR", "B"], ["DB_DATA.TRUTH_REGIME_INVALID_INPUT", "N"], ["DB_DATA.TRUTH_BASIS_REQUIRED", "F"], ["WORKER_INFRA.CRASH_LOOP", "F"],
  ["WORKER_INFRA.OOM", "F"], ["WORKER_INFRA.DISK_FULL", "F"], ["WORKER_INFRA.QUEUE_LEASE_LOST", "B"], ["WORKER_INFRA.HOST_UNREACHABLE", "B"], ["WORKER_INFRA.NETWORK_FAILURE", "R"],
  ["WORKER_INFRA.DNS_FAILURE", "B"], ["WORKER_INFRA.TUNNEL_DOWN", "B"], ["WORKER_INFRA.INFRA_MODE_PAUSED", "F"], ["WORKER_INFRA.INFRA_DEGRADED_BLOCKS_CLASS_D", "F"],
  ["WORKER_INFRA.INFRA_MODE_UNAVAILABLE", "B"], ["WORKER_INFRA.STATE_UNKNOWN", "B"], ["WORKER_INFRA.OBSERVABILITY_MISSING", "F"], ["WORKER_INFRA.INCIDENT_OPEN", "F"],
  ["WORKER_INFRA.SLO_BREACHED", "F"], ["MEMORY_RETRIEVAL_EXPERT.MISSING_SOURCE", "F"], ["MEMORY_RETRIEVAL_EXPERT.STALE_PACK", "F"], ["MEMORY_RETRIEVAL_EXPERT.EXPERT_RECALLED", "N"],
  ["MEMORY_RETRIEVAL_EXPERT.RETRIEVAL_CONTAMINATION", "N"], ["LEARNING_EVAL.BAD_CANDIDATE", "N"], ["LEARNING_EVAL.HOLDOUT_REGRESSION", "N"], ["LEARNING_EVAL.POISONED_EVIDENCE", "N"],
  ["LEARNING_EVAL.SKILL_DRIFT", "F"], ["LEARNING_EVAL.EVAL_LEAKAGE", "N"], ["VOICE_DEVICE_UI.STT_FAILURE", "B"], ["VOICE_DEVICE_UI.TTS_FAILURE", "B"], ["VOICE_DEVICE_UI.APNS_FAILURE", "B"],
  ["VOICE_DEVICE_UI.DEVICE_STATE_INVALID", "F"], ["VOICE_DEVICE_UI.CALL_PROVIDER_FAILURE", "R"], ["VOICE_DEVICE_UI.CLIENT_MISMATCH", "F"], ["FINANCE_SIDE_EFFECT.RECONCILIATION_MISMATCH", "F"],
  ["FINANCE_SIDE_EFFECT.DUPLICATE_INTENT", "N"], ["FINANCE_SIDE_EFFECT.RECIPIENT_MISMATCH", "N"], ["FINANCE_SIDE_EFFECT.PROVIDER_STATE_AMBIGUOUS", "R"], ["SECURITY.PROMPT_INJECTION", "N"],
  ["SECURITY.EXFILTRATION_ATTEMPT", "N"], ["SECURITY.TAMPER_DETECTED", "N"], ["SECURITY.CROSS_TENANT_ESCAPE", "N"], ["SECURITY.SUSPICIOUS_SELF_CHANGE", "N"],
  ["SECURITY.CONSTITUTION_NOT_VERIFIED", "F"], ["SECURITY.CONSTITUTION_INVALID", "F"], ["SECURITY.TRUTH_REGIME_MODEL_ESCALATION", "N"]
  ]) as Record<string, "N" | "F" | "B" | "R">;
  const SHORT = { never: "N", retry_after_fix: "F", retry_with_backoff: "B", readback_first: "R" } as const;

  it("gjentakbarheten er festet for ALLE koder: ingen kode er lagt til, fjernet eller endret uten at tabellen er endret (M64: replay-koden flippet til retry overlevde)", () => {
    expect(Object.keys(PINNED_RETRYABILITY).sort()).toEqual(ERROR_CODE_DEFS.map((d) => d.code).sort());
    for (const def of ERROR_CODE_DEFS) expect(SHORT[def.retryability], def.code).toBe(PINNED_RETRYABILITY[def.code]);
    expect(SHORT[ERROR_CODES["AUTH_TENANT.APPROVAL_REPLAYED"].retryability]).toBe("N");
  });

  it("M6: en beskrivelse som sier at utfallet er UKJENT eller må leses tilbake krever readback_first (aldri blind retry) - for alle koder", () => {
    const READBACK_MARKERS = /\bUKJENT\b|\b(?:lest|les|lese)\s+tilbake\b|\bles\s+status\b|ALDRI blind retry/;
    const marked = ERROR_CODE_DEFS.filter((d) => READBACK_MARKERS.test(d.description));
    expect(marked.length).toBeGreaterThanOrEqual(4);
    for (const def of marked) expect(def.retryability, `${def.code}: «${def.description}»`).toBe("readback_first");
    expect(ERROR_CODES["TOOL_CONNECTOR.API_SERVER_ERROR"].retryability).toBe("readback_first");
    expect(ERROR_CODES["WORKER_INFRA.NETWORK_FAILURE"].retryability).toBe("readback_first");
    // Linten fanger det den skal: den gamle formuleringen på en retry-kode ville vært rød.
    expect(READBACK_MARKERS.test("for en mutasjon er utfallet UKJENT inntil det er lest tilbake")).toBe(true);
    expect(READBACK_MARKERS.test("Forbindelsen feilet; prøv igjen etter utsettelse")).toBe(false);
  });

  it("definisjonen av readback_first i kilden sier ALDRI blind retry, og ingen kode med retry_with_backoff nevner ukjent utfall", () => {
    for (const def of ERROR_CODE_DEFS.filter((d) => d.retryability === "retry_with_backoff")) expect(def.description, def.code).not.toMatch(/UKJENT|lest tilbake/);
    expect(readFileSync(resolve(ROOT, "packages/contracts/src/error-codes.ts"), "utf8")).toContain("ALDRI blind retry");
  });

  it("registeret er frosset (en importerende modul kan ikke mutere det)", () => {
    expect(Object.isFrozen(ERROR_CODE_DEFS)).toBe(true);
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(ERROR_CODE_DEFS[0])).toBe(true);
    expect(Object.isFrozen(ERROR_CODE_DEFS[0]?.legacy)).toBe(true);
    expect(Object.isFrozen(ERROR_NAMESPACES)).toBe(true);
  });

  it("det strenge skjemaet avviser: ukjent felt, feil prefiks, ukjent alvor/retryability, tom eier, ugyldig eier-id, relative/absolutte kildestier", () => {
    const good: ErrorCodeDef = { ...(ERROR_CODES["SECURITY.TAMPER_DETECTED"] as ErrorCodeDef), legacy: [] };
    expect(ErrorCodeDefSchema.safeParse(good).success).toBe(true);
    const bad = (patch: Record<string, unknown>) => ErrorCodeDefSchema.safeParse({ ...good, ...patch }).success;
    expect(bad({ extra: 1 })).toBe(false);
    expect(bad({ code: "AUTH_TENANT.TAMPER_DETECTED" })).toBe(false);
    expect(bad({ code: "security.tamper_detected" })).toBe(false);
    expect(bad({ severity: "fatal" })).toBe(false);
    expect(bad({ retryability: "maybe" })).toBe(false);
    expect(bad({ owner: "" })).toBe(false);
    expect(bad({ owner: "Core Policy" })).toBe(false);
    expect(bad({ description: "kort" })).toBe(false);
    expect(bad({ status: "deprecated", replaced_by: null })).toBe(false);
    expect(bad({ status: "active", replaced_by: "SECURITY.PROMPT_INJECTION" })).toBe(false);
    expect(bad({ legacy: [{ source: "/etc/passwd", reason: "x_y" }] })).toBe(false);
    expect(bad({ legacy: [{ source: "../x.ts", reason: "x_y" }] })).toBe(false);
    expect(bad({ legacy: [{ source: "modules/policy/src/policy-gateway.ts", reason: "" }] })).toBe(false);
    expect(bad({ legacy: [{ source: "modules/policy/src/policy-gateway.ts", reason: "class_d_x", defined_in: "modules/policy/src/approval-verifier.ts" }] })).toBe(false);
    expect(bad({ legacy: [{ source: "modules/policy/src/policy-gateway.ts", reason: "class_d_x", defined_as: "x" }] })).toBe(false);
    expect(bad({ legacy: [{ source: "modules/policy/src/policy-gateway.ts", reason: "class_d_x", defined_in: "/abs/x.ts", defined_as: "x" }] })).toBe(false);
    expect(bad({ legacy: [{ source: "modules/policy/src/policy-gateway.ts", reason: "class_d_x", defined_in: "modules/policy/src/approval-verifier.ts", defined_as: "x" }] })).toBe(true);
  });
});

describe("B. oppslag fra gammel årsaksstreng til stabil kode (ingen atferdsendring: kun tabell)", () => {
  it("kjente strenger gir sin kode, nøkkelen er (kilde, streng slik den lagres)", () => {
    expect(errorCodeForLegacy("modules/policy/src/policy-gateway.ts", "kill_switch_active")).toBe("AUTH_TENANT.KILL_SWITCH_ACTIVE");
    expect(errorCodeForLegacy("modules/policy/src/policy-gateway.ts", "class_d_missing_approval")).toBe("AUTH_TENANT.APPROVAL_MISSING");
    expect(errorCodeForLegacy("modules/policy/src/policy-gateway.ts", "class_d_tenant_mismatch")).toBe("AUTH_TENANT.WRONG_ORG");
    expect(errorCodeForLegacy("modules/self-modification/src/constitution.ts", "constitution_rollback")).toBe("SECURITY.TAMPER_DETECTED");
    expect(errorCodeForLegacy("modules/core/src/db/migrator.ts", "migration_checksum_mismatch")).toBe("DB_DATA.MIGRATION_MISMATCH");
  });

  it("ukjent kilde eller streng gir null (aldri en gjetning), og samme streng i en annen kilde er en annen nøkkel", () => {
    expect(errorCodeForLegacy("modules/policy/src/policy-gateway.ts", "no_such_reason")).toBeNull();
    expect(errorCodeForLegacy("modules/unknown/src/x.ts", "kill_switch_active")).toBeNull();
    expect(errorCodeForLegacy("modules/self-modification/src/evolution/release-gate.ts", "kill_switch_active")).toBe("AUTH_TENANT.KILL_SWITCH_ACTIVE");
    expect(errorCodeForLegacy("", "")).toBeNull();
  });

  it("isErrorCode godtar kun registrerte koder (ikke små bokstaver, ikke prototype-nøkler, ikke ikke-strenger)", () => {
    expect(isErrorCode("SECURITY.PROMPT_INJECTION")).toBe(true);
    expect(isErrorCode("security.prompt_injection")).toBe(false);
    expect(isErrorCode("SECURITY.NOPE")).toBe(false);
    expect(isErrorCode("constructor")).toBe(false);
    expect(isErrorCode("__proto__")).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });

  it("errorCodeInfo gir definisjonen; oppslag av en prototype-nøkkel er ikke en kode", () => {
    expect(errorCodeInfo("SECURITY.TAMPER_DETECTED").namespace).toBe("SECURITY");
    expect(() => errorCodeInfo("constructor" as never)).toThrow();
  });
});

describe("C. drift mot koden (modusstyrt: report som standard, enforce feiler)", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "config/program/manifest.json"), "utf8")) as { guard: { mode: unknown } };
  const resolved = resolveGuardMode(manifest.guard.mode, process.env["PROGRAM_INDEX_MODE"]);
  const readSource = (rel: string): string | null => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null);

  /** Katalogene: hvor årsaksstrengene lages, og hvordan de plukkes ut av kilden. Kun de LUKKEDE katalogene (alt annet er `DEFERRED`, se runbooken). */
  const CATALOGS: Array<{ id: string; source: string; emitter: string; extract: (text: string) => string[] }> = [
    {
      id: "policy-gateway DENY-årsaker",
      source: "modules/policy/src/policy-gateway.ts",
      emitter: "modules/policy/src/policy-gateway.ts",
      extract: (t) => [...t.matchAll(/this\.finish\(request,\s*"DENY",\s*"([a-z_]+)"\)/g)].map((m) => m[1] as string).concat([...t.matchAll(/reason:\s*"(class_d_[a-z_]+)"/g)].map((m) => m[1] as string))
    },
    {
      id: "godkjenningsverifisering (lagres som class_d_<årsak>)",
      source: "modules/policy/src/approval-verifier.ts",
      emitter: "modules/policy/src/policy-gateway.ts",
      extract: (t) => [...t.matchAll(/valid:\s*false,\s*reason:\s*"([a-z_]+)"/g)].map((m) => `class_d_${m[1] as string}`)
    },
    {
      id: "infra-modus-port",
      source: "modules/policy/src/infra-execution-gate.ts",
      emitter: "modules/policy/src/policy-gateway.ts",
      extract: (t) => [...t.matchAll(/return\s+"(infra_[a-z_]+)"/g)].map((m) => m[1] as string)
    },
    {
      id: "konstitusjon",
      source: "modules/self-modification/src/constitution.ts",
      emitter: "modules/self-modification/src/constitution.ts",
      extract: (t) => [...t.matchAll(/\|\s*"(constitution_[a-z_]+)"/g)].map((m) => m[1] as string)
    },
    {
      id: "sannhetsregime",
      source: "modules/incidents/src/truth.ts",
      emitter: "modules/incidents/src/truth.ts",
      extract: (t) => [...t.matchAll(/new TruthRegimeError\("(truth_[a-z_]+)"\)/g)].map((m) => m[1] as string)
    },
    {
      id: "change freeze",
      source: "modules/self-modification/src/evolution/release-gate.ts",
      emitter: "modules/self-modification/src/evolution/release-gate.ts",
      extract: (t) => {
        const start = t.indexOf("export function changeFreeze");
        const end = t.indexOf("export interface ReleaseRequest");
        return [...t.slice(start, end).matchAll(/reasons\.push\("([a-z_]+)"\)/g)].map((m) => m[1] as string);
      }
    },
    {
      id: "migrator",
      source: "modules/core/src/db/migrator.ts",
      emitter: "modules/core/src/db/migrator.ts",
      extract: (t) => [...new Set([...t.matchAll(/`?(migration_[a-z_]+)[:`]/g)].map((m) => m[1] as string))]
    }
  ];

  /** ALLOW-årsaker er ikke feil og har ingen kode. */
  const NOT_ERRORS = new Set(["class_a_read", "class_b_reversible_internal", "class_c_sovereign_authority", "class_c_within_mandate", "class_d_sovereign_authority", "class_d_valid_signed_approval", "class_d_valid_signed_approval_pending_commit"]);

  /** Ren drift-sjekk (kilden injiseres) så selve vakten kan selvtestes: den må FINNE drift, ellers er rapporten verdiløs. */
  function driftFindings(defs: readonly ErrorCodeDef[], read: (rel: string) => string | null): string[] {
    const out: string[] = [];
    for (const def of defs) {
      for (const l of def.legacy) {
        const where = l.defined_in ?? l.source;
        const literal = l.defined_as ?? l.reason;
        const text = read(where);
        if (text === null) out.push(`${def.code}: kildefilen finnes ikke: ${where}`);
        else if (!new RegExp(`["'\`]${literal}["'\`:]`).test(text)) out.push(`${def.code}: «${literal}» står ikke lenger i ${where}`);
      }
    }
    for (const c of CATALOGS) {
      const text = read(c.source);
      if (text === null) {
        out.push(`katalogen «${c.id}»: kildefilen finnes ikke: ${c.source}`);
        continue;
      }
      const reasons = c.extract(text);
      if (reasons.length === 0) out.push(`katalogen «${c.id}»: ingen årsaker funnet (utdatert uttrekk?)`);
      for (const r of new Set(reasons)) {
        if (NOT_ERRORS.has(r)) continue;
        if (!defs.some((d) => d.legacy.some((l) => l.source === c.emitter && l.reason === r))) out.push(`katalogen «${c.id}»: «${r}» har ingen feilkode (legg til i src/error-codes.ts)`);
      }
    }
    return out;
  }

  it(`kodedrift (${resolved.mode}-modus): mappingene er i takt med kilden og alle lukkede kataloger er dekket`, () => {
    const f = driftFindings(ERROR_CODE_DEFS, readSource);
    if (resolved.mode === "enforce") expect(f).toEqual([]);
    else if (f.length > 0) console.info(`[PROGRAM_INDEX_MODE=report] feilkode-drift: ${f.length} funn\n  ${f.join("\n  ")}`);
    expect(Array.isArray(f)).toBe(true);
  });

  it("uttrekkene er ikke vakuøse: hver katalog gir minst én årsak mot dagens kilde (ellers er vakten blind)", () => {
    for (const c of CATALOGS) {
      const text = readSource(c.source);
      expect(text, c.source).not.toBeNull();
      expect(c.extract(text as string).length, c.id).toBeGreaterThan(0);
    }
  });

  it("selvtest: vakten FINNER en streng uten kode, en mapping uten kilde-treff og en manglende kilde", () => {
    // (a) fjern én mapping -> strengen står igjen i katalogen uten kode
    const dropped = ERROR_CODE_DEFS.map((d) => (d.code === "AUTH_TENANT.KILL_SWITCH_ACTIVE" ? { ...d, legacy: d.legacy.filter((l) => l.source !== "modules/policy/src/policy-gateway.ts") } : d));
    expect(driftFindings(dropped, readSource).some((x) => x.includes("«kill_switch_active» har ingen feilkode"))).toBe(true);
    // (b) kilden mangler strengen -> mappingen er foreldet
    const stripped = (rel: string): string | null => (readSource(rel) as string).replaceAll("kill_switch_active", "ks_active");
    expect(driftFindings(ERROR_CODE_DEFS, stripped).some((x) => x.includes("«kill_switch_active» står ikke lenger i modules/policy/src/policy-gateway.ts"))).toBe(true);
    // (c) manglende kildefil
    expect(driftFindings(ERROR_CODE_DEFS, () => null).length).toBeGreaterThan(5);
    // (d) en ny årsak i kilden uten kode
    const withNew = (rel: string): string | null => {
      const t = readSource(rel);
      return rel === "modules/policy/src/policy-gateway.ts" && t !== null ? `${t}\nthis.finish(request, "DENY", "brand_new_reason")` : t;
    };
    expect(driftFindings(ERROR_CODE_DEFS, withNew).some((x) => x.includes("«brand_new_reason» har ingen feilkode"))).toBe(true);
    // (e) ALLOW-årsaker flagges ikke
    expect(driftFindings(ERROR_CODE_DEFS, readSource).some((x) => x.includes("class_a_read"))).toBe(false);
  });
});
