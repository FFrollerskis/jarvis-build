import type { FamilyDelegationScope, FamilyRole, FamilyShareCategory } from "./types.ts";

/**
 * WP-G2 P1c: rolle -> tillatte handlinger. ÉN ren, deterministisk tabell (ingen modell, ingen konfigurasjon, ingen database) som både tjenesten og testene bruker. Strengeste standard: det som ikke står her er forbudt,
 * og `guest` har ingenting. Roller gir ALDRI tilgang til andres helse/lokasjon (det avgjøres av en deling personen selv har gitt, `family_shares`) - `owner` har ingen bakdør.
 */
export type FamilyAction =
  | "circle:invite" | "circle:remove" | "circle:view_roster"
  | "lists:read" | "lists:create" | "lists:add_item" | "lists:complete"
  | "events:read" | "events:create" | "events:cancel"
  | "share:grant" | "share:view_location" | "share:view_health"
  | "delegation:grant" | "delegation:act";

const OWNER: ReadonlySet<FamilyAction> = new Set<FamilyAction>([
  "circle:invite", "circle:remove", "circle:view_roster", "lists:read", "lists:create", "lists:add_item", "lists:complete", "events:read", "events:create", "events:cancel", "share:grant", "share:view_location",
  "share:view_health", "delegation:grant", "delegation:act"
]);
const ADULT: ReadonlySet<FamilyAction> = new Set<FamilyAction>([
  "circle:view_roster", "lists:read", "lists:create", "lists:add_item", "lists:complete", "events:read", "events:create", "events:cancel", "share:grant", "share:view_location", "share:view_health",
  "delegation:grant", "delegation:act"
]);
const CHILD: ReadonlySet<FamilyAction> = new Set<FamilyAction>([
  "circle:view_roster", "lists:read", "lists:add_item", "lists:complete", "events:read", "share:grant", "share:view_location"
]);

export const FAMILY_ROLE_ACTIONS: Readonly<Record<FamilyRole, ReadonlySet<FamilyAction>>> = { owner: OWNER, adult: ADULT, child: CHILD, guest: new Set<FamilyAction>() };

export function familyCan(role: FamilyRole, action: FamilyAction): boolean {
  return FAMILY_ROLE_ACTIONS[role].has(action);
}

/** Hvilken seer-rolle som i det hele tatt KAN få en deling av en kategori (selv om subjektet vil dele): helse kun mellom voksne; lokasjon også til barn; aldri gjest. */
export function roleMayViewCategory(role: FamilyRole, category: FamilyShareCategory): boolean {
  return familyCan(role, category === "location" ? "share:view_location" : "share:view_health");
}

/** Kan en rolle være AGENT (handle på vegne av) i et scope? Kun voksne/eier, og kun i de lukkede scopene. */
export function roleMayActFor(role: FamilyRole, scope: FamilyDelegationScope): boolean {
  return (scope === "shared_lists" || scope === "shared_calendar") && familyCan(role, "delegation:act");
}

/** Kan en rolle utføre handlingen som det scopet dekker (listene: legge til; kalenderen: opprette)? En delegat kan aldri overskride det rollen selv ville fått lov til. */
export function scopeAction(scope: FamilyDelegationScope): FamilyAction {
  return scope === "shared_lists" ? "lists:add_item" : "events:create";
}
