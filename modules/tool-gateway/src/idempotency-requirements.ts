import { isSelfRecoveryAction } from "@jarvis/policy";
import { isClassDExempt } from "./class-d-pipeline.ts";
import type { IdempotencyMode, ToolDefinition } from "./gateway.ts";
import { inferEffect, isJarvisCoreNamespace } from "./tool-manifest.ts";

/**
 * WP-T1 K4 (JARVIS-102, Q-65 pkt 1): DEN DETERMINISTISKE LISTEN over hvilke handlinger som SKAL kreve en idempotensnøkkel (`ToolDefinition.idempotency`), med begrunnelse per regel.
 *
 * Reglene leser kun det definisjonen selv sier (`tool_id`, `action`, `capability_class`, `idempotent_external`) pluss effekten manifestet utleder (`inferEffect`) - ingen skjult tilstand, ingen modell.
 * Første treffende regel gjelder:
 *   R0  nødbryter / selvgjenoppretting      -> optional  (må virke uten nøkkel: aldri blokkert av et krav)
 *   R1  ren lesing (klasse A eller effekt read) -> none  (ingen sideeffekt å beskytte; klasse A har ingen ledger)
 *   R2  klasse D                           -> required  (kjeden krever en ekte idempotensreferanse: `class_d_idempotency_key_required`)
 *   R3  penger (effekt pay)                -> required  (dobbeltbetaling kan ikke trekkes tilbake)
 *   R4  utsendelse (effekt send)           -> required  (en dobbel melding/e-post/SMS/varsel kan ikke trekkes tilbake)
 *   R5  sletting (effekt delete)           -> required  (en gjentatt sletting kan ramme noe annet enn det som var ment, og beviset for hva som skjedde må være entydig)
 *   R6  ekstern skriving/styring som IKKE er idempotent hos leverandøren (`idempotent_external: false`) -> required  (en retry gir duplikat: ny hendelse, nytt issue, ny fil)
 *   R7  alt annet skrivende                -> optional  (a: leverandøren er selv idempotent for handlingen; b: Jarvis-eid intern tilstand der domenetjenesten har egen idempotens/avstemming)
 * `none` brukes kun for lesing. En definisjon som selv setter `idempotency` beholder sin verdi (eksplisitt stilling slår listen).
 *
 * Listen er festet av en fixture (`apps/api/test/fixtures/wpt1-idempotency-decisions.json`) og en vakttest: en NY skrivehandling (eller en endret regel/definisjon) endrer den utledede listen og feller testen
 * til fixturen er regenerert og endringen er forklart. Enforcement (`JARVIS_TOOL_REQUEST_DIGEST=enforce`) og observasjon (`observe`) skjer i `ToolGateway.execute()`; med modus `off` er feltet uten virkning.
 */
export type IdempotencyRuleId =
  | "R0_safety_switch" | "R1_read" | "R2_class_d" | "R3_money" | "R4_outbound" | "R5_delete" | "R6_external_not_idempotent" | "R7a_external_idempotent" | "R7b_internal_state";

export interface IdempotencyDecision {
  mode: IdempotencyMode;
  rule: IdempotencyRuleId;
  /** Begrunnelsen (norsk) som også står i runbooken. */
  reason: string;
}

export const IDEMPOTENCY_RULE_REASONS: Readonly<Record<IdempotencyRuleId, string>> = {
  R0_safety_switch: "nødbryter/selvgjenoppretting: må virke også når alt annet er nede og kan aldri blokkeres av et nøkkelkrav",
  R1_read: "ren lesing: ingen sideeffekt å beskytte, og klasse A har ingen ledger",
  R2_class_d: "klasse D: kjeden krever en ekte idempotensreferanse (class_d_idempotency_key_required)",
  R3_money: "penger: en dobbel betaling/refusjon/generering kan ikke trekkes tilbake",
  R4_outbound: "utsendelse: en dobbel melding, e-post, SMS eller varsel kan ikke trekkes tilbake",
  R5_delete: "sletting: en gjentatt sletting kan ramme noe annet enn det som var ment, og beviset for hva som skjedde må være entydig",
  R6_external_not_idempotent: "skriving/styring mot en ekstern leverandør som ikke er idempotent av natur: en retry gir et duplikat (ny hendelse, nytt issue, ny fil)",
  R7a_external_idempotent: "ekstern handling der leverandøren selv er idempotent (samme kall gir samme tilstand): nøkkel brukes når den oppgis, kreves ikke",
  R7b_internal_state: "Jarvis-eid intern tilstand: domenetjenesten har egen idempotens og avstemming; nøkkel brukes når den oppgis, kreves ikke"
};

const decision = (mode: IdempotencyMode, rule: IdempotencyRuleId): IdempotencyDecision => ({ mode, rule, reason: IDEMPOTENCY_RULE_REASONS[rule] });

/** Regelen for én handling (ren og deterministisk). */
export function decideIdempotency(def: Pick<ToolDefinition, "tool_id" | "action" | "capability_class" | "idempotent_external">): IdempotencyDecision {
  if (isClassDExempt(def) || isSelfRecoveryAction(def.tool_id, def.action)) return decision("optional", "R0_safety_switch");
  const effect = inferEffect(def.tool_id, def.action);
  if (def.capability_class === "A" || effect === "read") return decision("none", "R1_read");
  if (def.capability_class === "D") return decision("required", "R2_class_d");
  if (effect === "pay") return decision("required", "R3_money");
  if (effect === "send") return decision("required", "R4_outbound");
  if (effect === "delete") return decision("required", "R5_delete");
  const external = !isJarvisCoreNamespace(def.tool_id);
  if (external && !def.idempotent_external) return decision("required", "R6_external_not_idempotent");
  return external ? decision("optional", "R7a_external_idempotent") : decision("optional", "R7b_internal_state");
}

/**
 * Toppnivåfelt (per `tool_id.action`) som bærer en hemmelighet og derfor ikke skal avtrykkes i `request_digest` (usaltet hash: en lav-entropi-verdi kunne gjettes). Konsekvens (dokumentert i runbooken): en
 * endring KUN i dette feltet under samme nøkkel gir ikke `idempotency_key_reuse_mismatch`. En vakttest feller et nytt felt med hemmelighetsaktig navn som ikke står her eller i godkjenningslisten.
 */
export const DIGEST_EXCLUDED_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  "owner_controls.set_connector_credential": ["value"],
  "vercel.upsert_env": ["value"]
};

/** Navn som ser ut som en hemmelighet (vakttesten sjekker alle registrerte skjemaer mot dette). */
export const SECRET_LIKE_PARAMETER_NAME = /(secret|password|passcode|api_?key|^token$|_token$|^value$)/i;

/**
 * Felt med hemmelighetsaktig navn som bevisst IKKE er en hemmelighet (med begrunnelse). `drive.list_files.page_token` er en sidemarkør for en lesing (klasse A, ingen ledger, ingen digest).
 */
export const SECRET_NAME_NOT_A_SECRET: Readonly<Record<string, string>> = {
  "drive.list_files.page_token": "sidemarkør for en lesing (klasse A: ingen ledger og ingen digest)"
};

/**
 * Setter `idempotency` (og `digest_exclude_parameters`) på hver definisjon som ikke selv har tatt stilling. Returnerer KOPIER (definisjonene som ble gitt inn endres aldri). Kalles én gang, ved
 * komposisjonsroten (`firstWaveTools`), slik at ALLE produksjonsdefinisjoner bærer en eksplisitt verdi; definisjoner som bygges direkte (enhetstester) forblir uten felt = som før WP-T1.
 */
export function applyIdempotencyDecisions(defs: readonly ToolDefinition[]): ToolDefinition[] {
  return defs.map((def) => {
    const excluded = def.digest_exclude_parameters ?? DIGEST_EXCLUDED_PARAMETERS[`${def.tool_id}.${def.action}`];
    return {
      ...def,
      idempotency: def.idempotency ?? decideIdempotency(def).mode,
      ...(excluded !== undefined ? { digest_exclude_parameters: excluded } : {})
    };
  });
}
