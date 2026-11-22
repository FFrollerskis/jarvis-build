import { CAR_CRITICAL_ACTIONS, CAR_TOOL_ID } from "./car-critical.ts";
import { HOME_ASSISTANT_TOOL_ID, HOME_CRITICAL_ACTIONS } from "./home-critical.ts";

/**
 * WP-G2 (D-464, fiks-runde review A LOW-4): kan en eier-bundet autonomi-binding (D-160, `situation_autonomy_policies`) PEKE på denne verktøy-handlingen?
 *
 * De kritiske hjem-/bilhandlingene krever en ENHETSSIGNERT eier-økt (step-up, strengeste standard Q-55/D-468), og sveipens identitet (`api` + `auth_strength: active`) har aldri det: en binding til dem kan ALDRI lykkes
 * (hvert auto-ACT nektes med `step_up_required`, 0 kall mot utstyret, situasjonen eskaleres - bevist av review A). Det er trygt, men eieren kan tro at regelen virker. Derfor avvises slike bindinger allerede VED
 * BINDING (fail-closed, samme prinsipp som ukjent plassholder), ikke først ved kjøring. Autonom kjøring av kritiske fysiske handlinger er et eierspørsmål (Q-G2-1) og lempes ikke på her.
 * Ren funksjon: `null` = kan bindes, ellers en stabil årsakskode.
 */
export function autonomyBindingBlocker(toolId: string, action: string): string | null {
  if (toolId === HOME_ASSISTANT_TOOL_ID && HOME_CRITICAL_ACTIONS.includes(action)) return "step_up_required";
  if (toolId === CAR_TOOL_ID && CAR_CRITICAL_ACTIONS.includes(action)) return "step_up_required";
  return null;
}
