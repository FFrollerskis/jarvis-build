/**
 * Del 3 (JARVIS-013/043): minimumspipeline for klasse D, håndhevet i deterministisk kode i `ToolGateway.execute()`.
 *
 * En klasse D-handling er tilgjengelig KUN når hele kjeden finnes:
 *   1. fersk tilstandslesing (`preflight_action`) med målvalidering - eller, for en utgående melding uten forhåndseksisterende
 *      mål (`class_d_profile: "outbound_message"`), deterministisk mottaker-/innholdsvalidering i transporten;
 *   2. før-tilstand eller kompensasjonsplan (`rollback_procedure` - alltid ikke-tom);
 *   3. ekte idempotensreferanse (`idempotency_key` er PÅKREVD - aldri en stille default);
 *   4. etterbetingelse: `postcondition_predicate`, `postcondition_target_absent` (sletting) eller leverandørens bekreftede ID
 *      (`outbound_message`);
 *   5. umiddelbar out-of-band-varsling til eieren (`ClassDNotifier`) - uten en klar varsler er handlingen utilgjengelig;
 *   6. utførbar gjenoppretting/avstemming (`ToolGateway.reconcile()` + before_state/recovery i audit).
 *
 * En D-handling som ikke oppfyller kjeden er IKKE tilgjengelig (`class_d_pipeline_incomplete`) - den listes eksplisitt som
 * DEFERRED i `CLASS_D_DEFERRED_EXPECTATION` (pinnet av test), aldri stille utelatt.
 *
 * Kill-switch-handlinger er unntatt: de er sikkerhetsbrytere som alltid må kunne brukes (også mens varsler/leverandør er nede).
 */
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolResult } from "./gateway.ts";

export interface ClassDNotification {
  tenant_id: string;
  person_id: string;
  tool_id: string;
  action: string;
  outcome: "executed" | "unverified";
  external_id: string | null;
  idempotency_key: string;
  recovery: string;
  at: string;
}

export interface ClassDNotifier {
  /** Sjekkes FØR handlingen - en varsler som ikke er klar gjør klasse D utilgjengelig (fail-closed). */
  ready(): Promise<boolean> | boolean;
  notify(notification: ClassDNotification): Promise<void>;
}

export interface ClassDPipelineOptions {
  enforce: boolean;
  notifier?: ClassDNotifier;
}

/** Sikkerhetsbrytere: aldri blokkert av pipeline-kravene (de MÅ virke også når alt annet er nede). */
export const CLASS_D_EXEMPT_ACTIONS: ReadonlySet<string> = new Set([
  "owner_controls:activate_kill_switch",
  "owner_controls:deactivate_kill_switch",
  "executive:activate_kill_switch",
  "executive:deactivate_kill_switch",
  "executive:enable_finance_kill_switch",
  "executive:disable_finance_kill_switch",
  "finance:enable_kill_switch",
  "finance:disable_kill_switch"
]);

export function isClassDExempt(def: Pick<ToolDefinition, "tool_id" | "action">): boolean {
  return CLASS_D_EXEMPT_ACTIONS.has(`${def.tool_id}:${def.action}`);
}

export interface ClassDAssessment {
  complete: boolean;
  missing: string[];
}

/** Statisk vurdering av om en klasse D-definisjon har hele pipelinen. Rent og deterministisk - brukes av gatewayen og av testene. */
export function assessClassDPipeline(def: ToolDefinition): ClassDAssessment {
  const missing: string[] = [];
  if (def.rollback_procedure.trim().length === 0) missing.push("recovery_plan");
  if (def.class_d_profile === "outbound_message") {
    // Ingen forhåndseksisterende tilstand å lese; mottaker valideres deterministisk i transporten, leverandør-ID er etterbetingelsen.
    return { complete: missing.length === 0, missing };
  }
  if (!def.preflight_action) missing.push("fresh_state_read");
  else if (def.preflight_requires_target !== true && !def.preflight_target_check && def.allows_missing_preflight_target !== true) {
    missing.push("target_validation");
  }
  if (!def.postcondition_predicate && !def.postcondition_target_absent) missing.push("postcondition");
  return { complete: missing.length === 0, missing };
}

/** Matcher leverandørfeil som betyr «målet finnes ikke» (brukt for slette-etterbetingelser). */
export function isNotFoundError(message: string): boolean {
  return /not[_ -]?found|(?:^|[^0-9])404(?:[^0-9]|$)|no such/i.test(message);
}

/**
 * Standardvarsler: out-of-band via Telegram (`telegram.notify`, samme ToolGateway-styrte sendevei som resten av systemet).
 * `ready()` krever at bot-token OG eierens chat-id faktisk finnes - ellers er klasse D utilgjengelig (fail-closed).
 */
export function telegramClassDNotifier(deps: {
  execute(request: { identity: IdentityContext; tool_id: string; action: string; parameters: Record<string, JsonValue>; idempotency_key?: string }): Promise<ToolResult>;
  secrets: { get(ref: string): Promise<string | null> };
  identity: IdentityContext;
}): ClassDNotifier {
  return {
    async ready() {
      const [token, chat] = await Promise.all([deps.secrets.get("JARVIS_TELEGRAM_TOKEN"), deps.secrets.get("JARVIS_TELEGRAM_CHAT_ID")]);
      return Boolean(token) && Boolean(chat);
    },
    async notify(n) {
      const lines = [
        n.outcome === "executed" ? "Klasse D-handling utført" : "Klasse D-handling UTFØRT MEN IKKE VERIFISERT - sjekk manuelt",
        `Verktøy: ${n.tool_id}.${n.action}`,
        n.external_id ? `Ekstern ID: ${n.external_id}` : "Ekstern ID: (ingen)",
        `Referanse: ${n.idempotency_key}`,
        `Gjenoppretting: ${n.recovery}`
      ];
      const result = await deps.execute({
        identity: deps.identity, tool_id: "telegram", action: "notify",
        parameters: { message: lines.join("\n").slice(0, 3900) },
        idempotency_key: `class-d-notify:${n.idempotency_key}`
      });
      if (!result.ok) throw new Error(`notify_failed:${result.reason}`);
    }
  };
}
