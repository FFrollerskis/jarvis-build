// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { IdentityContext } from "@jarvis/contracts";
import { ownerStepUpDenial } from "@jarvis/tool-gateway";

/**
 * Del 3 (JARVIS-024/037): step-up for eierens kontrollflate. Følsomme kontrollhandlinger (credential-skriving, tilbakekall/gjenoppretting,
 * frys, enhetstilbakekall, deaktivering av kill switch) krever et grant bevist med enhetens signatur (`auth_strength === "signed"`)
 * fra en kanal der eieren selv sitter foran en innrullert enhet - ALDRI tale, Telegram, meldingsplattformer eller system.
 * Sikkerhetsbrytere som STOPPER ting (aktivere kill switch, pause) er bevisst unntatt: de skal alltid kunne brukes raskt.
 * WP-F1 (D-453): selve regelen (signert enhet + eier-kanal) bor nå i `@jarvis/tool-gateway` (`ownerStepUpDenial`) og er den SAMME som gatewayen håndhever for
 * pengehandlinger (`ToolDefinition.step_up_required`) - her ligger kun unntaksmengden for brytere som stopper ting.
 */

/** Handlinger som ALDRI krever step-up: de reduserer risiko og må virke selv under stress/redusert autentisering. */
export const STEP_UP_EXEMPT_ACTIONS: ReadonlySet<string> = new Set([
  "activate_kill_switch", "enable_finance_kill_switch", "pause_domain", "freeze_connector", "test_connector", "resolve_situation"
]);

export function stepUpDenial(identity: Pick<IdentityContext, "auth_strength" | "channel">, action: string): string | undefined {
  if (STEP_UP_EXEMPT_ACTIONS.has(action)) return undefined;
  return ownerStepUpDenial(identity);
}
