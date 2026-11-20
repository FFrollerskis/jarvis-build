/**
 * WP-G4 (D-466) fiks-runde, A-HIGH-1: EN delt, deterministisk og FAIL-CLOSED regel for hvilke handlinger eierens autonomi-binding (og dermed autonom ACT) aldri kan peke på: FYSISKE/kritiske handlinger.
 *
 * Bakgrunn: den autonome sveipe-identiteten (eier, api/active) har ikke en enhetssignert økt. G2s `critical_*`-handlinger nektes derfor av step-up, men de GAMLE klasse D-verktøyene `home-assistant.lock_set`/`alarm_set`
 * (registrert så lenge `JARVIS_PERSONAL_HOME_CRITICAL` er AV) har verken step-up, eier-krav eller mål-allowlist: en binding `home -> lock_set` ble utført autonomt og kunne låse opp døren. G4 gjør `suggest` i domenet `home`
 * nåbart (lekkasje, alarm, åpen port), så regelen må stå i koden - ikke i en antakelse om hvilke verktøy som er registrert.
 *
 * ALLOWLIST-tankegang: i de fysiske navnerommene (`home-assistant`, `car`) er KUN eksplisitt kjente LESE-handlinger (`PHYSICAL_NAMESPACE_READ_ACTIONS`) bindbare. Alt annet - `lock_set`, `alarm_set`, `light_set`, `climate_set`, `critical_*`, bilhandlinger
 * og enhver ukjent/ny handling - regnes som fysisk/kritisk og nektes. En ny handling i disse navnerommene er altså nektet til noen BEVISST har lagt den på lese-listen (aldri omvendt).
 *
 * Regelen håndheves (1) ved bind-tid i `SituationEngine.setAutonomyPolicy()`, (2) ved kjøring i `autoActPending()` og `actOn()` FØR pause, lås og claim (en binding som finnes fra før denne regelen nektes også), og (3) leses av simuleringen.
 * Den er ren (ingen I/O) og uavhengig av verktøyregisteret. Andre navnerom (e-post, GitHub, docker m.fl.) er uendret eierens D-160-valg: se runbook (en klasse D uten `step_up_required` er bindbar der).
 */
export const PHYSICAL_NAMESPACES: ReadonlySet<string> = new Set(["home-assistant", "car"]);

/** Eksplisitt kjente LESE-handlinger i de fysiske navnerommene. Alt som ikke står her er fysisk/kritisk (fail-closed). */
export const PHYSICAL_NAMESPACE_READ_ACTIONS: ReadonlySet<string> = new Set([
  "home-assistant:list_states",
  "home-assistant:read_state",
  "home-assistant:read_state_detail",
  "home-assistant:read_states_detail",
  "home-assistant:read_critical_state",
  "car:read_vehicle_state"
]);

export type AutonomyBlockCode = "physical_action_not_bindable";

export interface AutonomyActionBlock {
  code: AutonomyBlockCode;
  tool_id: string;
  action: string;
}

/** Stabil feilkode (samme tekst i bind-feil, ACT-feil og simulering). */
export const PHYSICAL_ACTION_ERROR_PREFIX = "situation_autonomy_action_forbidden";

/** `null` = bindbar; ellers hvorfor ikke. Ren og deterministisk. Ugyldig inndata (ikke-tekst) er ALLTID nektet. */
export function autonomyActionBlocker(toolId: unknown, action: unknown): AutonomyActionBlock | null {
  if (typeof toolId !== "string" || typeof action !== "string" || toolId.length === 0 || action.length === 0) {
    return { code: "physical_action_not_bindable", tool_id: String(toolId), action: String(action) };
  }
  if (!PHYSICAL_NAMESPACES.has(toolId)) return null;
  return PHYSICAL_NAMESPACE_READ_ACTIONS.has(`${toolId}:${action}`) ? null : { code: "physical_action_not_bindable", tool_id: toolId, action };
}

/** Feil som kastes ved bind-tid og ved kjøring (stabil årsakskode i meldingen). */
export class SituationActActionForbiddenError extends Error {
  constructor(public readonly toolId: string, public readonly action: string, public readonly code: AutonomyBlockCode = "physical_action_not_bindable") {
    super(`${PHYSICAL_ACTION_ERROR_PREFIX}:${code}:${toolId}.${action}`);
    this.name = "SituationActActionForbiddenError";
  }
}
