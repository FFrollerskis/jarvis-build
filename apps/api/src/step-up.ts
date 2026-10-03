// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { IdentityContext } from "@jarvis/contracts";

/**
 * Del 3 (JARVIS-024/037): step-up for eierens kontrollflate. Følsomme kontrollhandlinger (credential-skriving, tilbakekall/gjenoppretting,
 * frys, enhetstilbakekall, deaktivering av kill switch) krever et grant bevist med enhetens signatur (`auth_strength === "signed"`)
 * fra en kanal der eieren selv sitter foran en innrullert enhet - ALDRI tale, Telegram, meldingsplattformer eller system.
 * Sikkerhetsbrytere som STOPPER ting (aktivere kill switch, pause) er bevisst unntatt: de skal alltid kunne brukes raskt.
 */
const STEP_UP_CHANNELS: ReadonlySet<string> = new Set(["web", "desktop", "api", "mobile"]);

/** Handlinger som ALDRI krever step-up: de reduserer risiko og må virke selv under stress/redusert autentisering. */
export const STEP_UP_EXEMPT_ACTIONS: ReadonlySet<string> = new Set([
  "activate_kill_switch", "enable_finance_kill_switch", "pause_domain", "freeze_connector", "test_connector", "resolve_situation"
]);

export function stepUpDenial(identity: Pick<IdentityContext, "auth_strength" | "channel">, action: string): string | undefined {
  if (STEP_UP_EXEMPT_ACTIONS.has(action)) return undefined;
  if (identity.auth_strength !== "signed") return "step_up_required:signed_device_session";
  if (!STEP_UP_CHANNELS.has(identity.channel)) return `step_up_required:channel_${identity.channel}_not_allowed`;
  return undefined;
}
