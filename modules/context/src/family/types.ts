import type { IdentityContext } from "@jarvis/contracts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin) P1c: typer for FAMILIE-/DELT-ROM-AUTORITETEN. Se `126_family_circle.sql` for det fulle designresonnementet og `service.ts` for reglene.
 * KJERNEN: helse og lokasjon er KUN synlig for personen selv; en annen person ser ingenting uten en deling personen SELV har gitt (databasen avviser alt annet). «På vegne av» krever prinsipalens egen delegasjon.
 */
export const FAMILY_ROLES = ["owner", "adult", "child", "guest"] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];
export const INVITABLE_ROLES = ["adult", "child", "guest"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Lukket liste over hva ett medlem kan dele med et annet. `health_summary` er KUN et aggregat (skritt i dag, søvn siste natt) - aldri puls, vekt, HRV eller råverdier. */
export const SHARE_CATEGORIES = ["location", "health_summary"] as const;
export type FamilyShareCategory = (typeof SHARE_CATEGORIES)[number];

/** Lukket liste over hva en delegat kan gjøre på vegne av en annen: ingen penger, helse, kommunikasjon eller klasse D. */
export const DELEGABLE_SCOPES = ["shared_lists", "shared_calendar"] as const;
export type FamilyDelegationScope = (typeof DELEGABLE_SCOPES)[number];

export const FAMILY_ERROR_CODES = [
  "shared_space_required", "circle_space_missing", "circle_not_dedicated", "not_a_member", "owner_required", "role_not_allowed", "not_found", "already_member", "invitee_not_enrolled", "invitation_pending",
  "invitation_not_pending", "invitation_expired", "not_the_invitee", "data_tenant_not_member", "owner_cannot_leave", "cannot_remove_owner", "share_required", "share_not_allowed", "self_target", "delegation_required",
  "delegation_not_allowed", "invalid_input", "reader_unavailable"
] as const;
export type FamilyErrorCode = (typeof FAMILY_ERROR_CODES)[number];

export class FamilyError extends Error {
  constructor(readonly code: FamilyErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "FamilyError";
  }
}

/** Det autorisasjonen faktisk trenger fra den verifiserte identiteten (kommer fra grantet - aldri fra en kropp). */
export type FamilyActor = Pick<IdentityContext, "tenant_id" | "person_id" | "memory_space_id" | "session_id" | "device_id" | "channel" | "auth_strength">;

export interface FamilyMember {
  tenant_id: string; person_id: string; role: FamilyRole; status: "active" | "left" | "removed"; data_tenant_id: string; added_by_person_id: string; invitation_id: string | null;
  joined_at: string; ended_at: string | null;
}

export interface FamilyInvitation {
  invitation_id: string; tenant_id: string; invitee_person_id: string; role: InvitableRole; invited_by_person_id: string; status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  created_at: string; expires_at: string; decided_at: string | null; decided_by_person_id: string | null;
}

export interface FamilyShare {
  share_id: string; tenant_id: string; subject_person_id: string; viewer_person_id: string; category: FamilyShareCategory; granted_at: string; expires_at: string | null; revoked_at: string | null;
  last_used_at: string | null; use_count: number;
}

export interface FamilyDelegation {
  delegation_id: string; tenant_id: string; principal_person_id: string; agent_person_id: string; scope: FamilyDelegationScope; granted_at: string; expires_at: string; revoked_at: string | null;
}

export interface FamilyList { list_id: string; name: string; created_by_person_id: string; on_behalf_of_person_id: string | null; created_at: string; archived_at: string | null }
export interface FamilyListItem {
  item_id: string; list_id: string; body: string; done: boolean; added_by_person_id: string; on_behalf_of_person_id: string | null; done_by_person_id: string | null; created_at: string; done_at: string | null;
}
export interface FamilyEvent {
  event_id: string; title: string; starts_at: string; ends_at: string; all_day: boolean; created_by_person_id: string; on_behalf_of_person_id: string | null; created_at: string; cancelled_at: string | null;
}

/** Hvem handlet, og for hvem (proveniens). `on_behalf_of` er satt KUN etter at en gyldig delegasjon er bevist. */
export interface ActingAs {
  actor_person_id: string;
  on_behalf_of_person_id: string | null;
  delegation_id: string | null;
}

/**
 * Det en seer får se av et annet medlems data - MINIMALT og avledet (aldri koordinater, aldri rå helsemålinger). Lokasjon: navnet på sonen subjektet er i NÅ (subjektets egen sone), ellers `null`.
 * Helse: to aggregater. Begge bærer `observed_at` slik at seeren ser hvor ferskt det er; `null` = ingen data (ikke «0»).
 */
export interface SharedLocationView { category: "location"; zone_name: string | null; observed_at: string | null }
export interface SharedHealthView { category: "health_summary"; steps_today: number | null; sleep_minutes_last_night: number | null; observed_at: string | null }
export type SharedView = SharedLocationView | SharedHealthView;

/**
 * Lesere som gir det avledede innholdet fra subjektets EGEN datatenant (`data_tenant_id`). Injiseres av komposisjonsroten (apps/api: LocationService/HealthService) - denne pakken kjenner ikke lokasjons-/helsemodulene
 * (ingen sirkulær pakkeavhengighet) og kan aldri kalle dem uten en bevist deling. En leser SKAL returnere kun det avledede, aldri råpunkter.
 */
export interface SharedDataReaders {
  currentPlace(subjectDataTenantId: string, subjectPersonId: string): Promise<{ zone_name: string | null; observed_at: string | null } | null>;
  healthSummary(subjectDataTenantId: string, subjectPersonId: string): Promise<{ steps_today: number | null; sleep_minutes_last_night: number | null; observed_at: string | null } | null>;
}
