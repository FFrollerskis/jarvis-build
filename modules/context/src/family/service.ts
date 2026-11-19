import { randomUUID } from "node:crypto";
import type pg from "pg";
import { DeviceService, SessionGrantService, withTenantTransaction, writeAudit } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { familyCan, roleMayActFor, roleMayViewCategory, scopeAction, type FamilyAction } from "./permissions.ts";
import {
  DELEGABLE_SCOPES, FamilyError, INVITABLE_ROLES, SHARE_CATEGORIES,
  type ActingAs, type FamilyActor, type FamilyDelegation, type FamilyDelegationScope, type FamilyErrorCode, type FamilyEvent, type FamilyInvitation, type FamilyList, type FamilyListItem, type FamilyMember,
  type FamilyRole, type FamilyShare, type FamilyShareCategory, type InvitableRole, type SharedDataReaders, type SharedView
} from "./types.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin) P1c: FAMILIE-/DELT-ROM-AUTORITET. Se `126_family_circle.sql`/`127_family_shared_content.sql`.
 *
 * REVISJON AV DET SOM FANTES: identitetsmodellen (`IdentityService.resolveIdentity`) gir enhver person med medlemskap og innrullert enhet tilgang til HVERT rom i tenanten (Q-15/D-130: ingen per-person-ACL). Denne tjenesten endrer
 * ikke det og røres ikke av samtykkekontrollene (JARVIS-084 bygges ikke); den legger et autoritetslag oppå for det ENE som er sensitivt mellom personer: hva ett medlem kan se av et annets helse og lokasjon, og hvem som kan handle på vegne av hvem.
 *
 * REGLENE (håndhevet i kode OG i databasen - se migrasjonens CHECK/triggere):
 *  1. All kjøring skjer med en verifisert identitet fra grantet i rommet `shared` (ellers `shared_space_required`): et grant for et annet rom kan ikke brukes til familieoperasjoner.
 *  2. Helse og lokasjon er KUN synlig for personen selv. En annen ser det bare via en deling subjektet SELV har gitt (`share_required` ellers); seer-rollen sjekkes også ved LESING (ikke bare ved opprettelsen),
 *     delingen kan utløpe og tilbakekalles av begge parter, og det som leveres er avledet og minimalt (sonenavn, to aggregater) - aldri koordinater eller råmålinger. Eieren har INGEN bakdør.
 *  3. «På vegne av» krever en aktiv, ikke-utløpt delegasjon som prinsipalen selv har gitt, i et lukket scope uten penger/helse/kommunikasjon/klasse D, og agentens rolle må selv ha lov til handlingen.
 *  4. Medlemskap: kun den suverene eieren inviterer og fjerner; kun den inviterte selv kan akseptere (egen autoritet); en rolle endres aldri på et aktivt medlem; ikke-eier-medlemmer kan KUN legges til i en dedikert sirkel-tenant
 *     (kun `shared`-rommet) - ellers ville tenant-medlemskapet gitt dem tilgang til eierens øvrige rom (`circle_not_dedicated`).
 *  5. Fjerning/forlating tilbakekaller ALLE delinger og delegasjoner som involverer personen i samme transaksjon, OG personens enheter i sirkel-tenanten (nøkkelen tilbakekalles permanent, utestående grants med den) - ellers ville
 *     identitetsnivået (medlemskap + innrullert enhet, Q-15) fortsatt gitt tilgang til sirkelens `shared`-rom (review B LOW-5). `person_tenants`-raden blir stående (historikk-FK-er), men er ubrukelig uten en gyldig enhet.
 * Tekst i lister/hendelser er ubetrodd data. Hver endring revideres (`audit_events`), og avslag på deling revideres også.
 */
export interface FamilyServiceOptions {
  /** Injiserbar klokke (tester). Alle utløp og tidsstempler følger den, så databasens CHECK-er og tjenestens sjekker bruker samme tid. */
  now?: () => Date;
  /** Lesere for det avledede innholdet i en delt kategori (se `SharedDataReaders`). Uten leser svarer `readShared` `reader_unavailable` (aldri en tom «ingen data»). */
  readers?: SharedDataReaders;
}

type Client = pg.PoolClient;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const member = (r: Record<string, unknown>): FamilyMember => ({
  tenant_id: r["tenant_id"] as string, person_id: r["person_id"] as string, role: r["role"] as FamilyRole, status: r["status"] as FamilyMember["status"], data_tenant_id: r["data_tenant_id"] as string,
  added_by_person_id: r["added_by_person_id"] as string, invitation_id: (r["invitation_id"] as string | null) ?? null, joined_at: iso(r["joined_at"]), ended_at: isoOrNull(r["ended_at"])
});
const invitation = (r: Record<string, unknown>): FamilyInvitation => ({
  invitation_id: r["invitation_id"] as string, tenant_id: r["tenant_id"] as string, invitee_person_id: r["invitee_person_id"] as string, role: r["role"] as InvitableRole,
  invited_by_person_id: r["invited_by_person_id"] as string, status: r["status"] as FamilyInvitation["status"], created_at: iso(r["created_at"]), expires_at: iso(r["expires_at"]),
  decided_at: isoOrNull(r["decided_at"]), decided_by_person_id: (r["decided_by_person_id"] as string | null) ?? null
});
const share = (r: Record<string, unknown>): FamilyShare => ({
  share_id: r["share_id"] as string, tenant_id: r["tenant_id"] as string, subject_person_id: r["subject_person_id"] as string, viewer_person_id: r["viewer_person_id"] as string,
  category: r["category"] as FamilyShareCategory, granted_at: iso(r["granted_at"]), expires_at: isoOrNull(r["expires_at"]), revoked_at: isoOrNull(r["revoked_at"]), last_used_at: isoOrNull(r["last_used_at"]),
  use_count: Number(r["use_count"])
});
const delegation = (r: Record<string, unknown>): FamilyDelegation => ({
  delegation_id: r["delegation_id"] as string, tenant_id: r["tenant_id"] as string, principal_person_id: r["principal_person_id"] as string, agent_person_id: r["agent_person_id"] as string,
  scope: r["scope"] as FamilyDelegationScope, granted_at: iso(r["granted_at"]), expires_at: iso(r["expires_at"]), revoked_at: isoOrNull(r["revoked_at"])
});

const list = (r: Record<string, unknown>): FamilyList => ({
  list_id: r["list_id"] as string, name: r["name"] as string, created_by_person_id: r["created_by_person_id"] as string, on_behalf_of_person_id: (r["on_behalf_of_person_id"] as string | null) ?? null,
  created_at: iso(r["created_at"]), archived_at: isoOrNull(r["archived_at"])
});

function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

/**
 * Et avslag som SKAL revideres. En kastet feil inne i en transaksjon ruller også audit-raden tilbake; derfor returneres avslaget som verdi, transaksjonen COMMITTES (audit-raden består), og først DERETTER kastes feilen (`txDenying`).
 */
const DENIED = Symbol("family_denied");
interface Denied { readonly [DENIED]: true; readonly error: FamilyError }
const deny = (code: FamilyErrorCode, detail?: string): Denied => ({ [DENIED]: true, error: new FamilyError(code, detail) });
const isDenied = (v: unknown): v is Denied => typeof v === "object" && v !== null && DENIED in v;

export class FamilyService {
  private readonly now: () => Date;
  private readonly readers: SharedDataReaders | undefined;
  /** Kanoniske tilbakekallingsprimitiver (samme som eierkontrollenes `revokeDevice`): kun `...On(client, ...)`-formene brukes, på familietjenestens egen transaksjon. */
  private readonly devices: DeviceService;
  private readonly grants: SessionGrantService;

  constructor(private readonly pool: pg.Pool, options: FamilyServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.readers = options.readers;
    this.devices = new DeviceService(pool);
    this.grants = new SessionGrantService(pool);
  }

  private async tx<T>(actor: FamilyActor, fn: (client: Client) => Promise<T>): Promise<T> {
    if (actor.memory_space_id !== "shared") throw new FamilyError("shared_space_required");
    return withMemoryTransaction(this.pool, actor.tenant_id, ["shared"], fn);
  }

  /** Som `tx`, men en returnert `Denied` COMMITTES først (revisjonsraden består) og kastes deretter. */
  private async txDenying<T>(actor: FamilyActor, fn: (client: Client) => Promise<T | Denied>): Promise<T> {
    const out = await this.tx<T | Denied>(actor, fn);
    if (isDenied(out)) throw out.error;
    return out;
  }

  private audit(client: Client, actor: FamilyActor, type: string, payload: Record<string, unknown>, reason?: string): Promise<void> {
    return writeAudit(client, { tenant_id: actor.tenant_id, person_id: actor.person_id, session_id: actor.session_id, device_id: actor.device_id }, {
      type, decision: reason === undefined ? "ALLOW" : "DENY", ...(reason !== undefined ? { reason } : {}), payload: { ...payload, channel: actor.channel }
    }) as Promise<void>;
  }

  private async activeMember(client: Client, tenantId: string, personId: string): Promise<FamilyMember | null> {
    const { rows } = await client.query(`SELECT * FROM family_members WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'`, [tenantId, personId]);
    return rows[0] ? member(rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Er personen medlem av tenanten? Leses under TENANTENS EGEN RLS-kontekst (`person_tenants` er tenant-skopet, så sirkelens transaksjon ser ikke en annen tenants medlemskap) i en egen, kort transaksjon. `family_members.data_tenant_id`
   * har bevisst ingen FK (tenant-kryssende FK er forbudt, JARVIS-076), så DETTE er kontrollen som holder «datatenanten er en tenant personen faktisk tilhører» - ved skriving og ved hver lesing av en delt kategori.
   */
  private async isEnrolled(personId: string, tenantId: string): Promise<boolean> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM person_tenants WHERE person_id = $1 AND tenant_id = $2`, [personId, tenantId]);
      return rows.length > 0;
    });
  }

  /** Datatenanten personen peker på (standard: sirkelen selv). Formatet valideres og medlemskapet VERIFISERES (`isEnrolled`) FØR noe skrives. */
  private async verifiedDataTenant(actor: FamilyActor, requested: string | undefined): Promise<string> {
    const dataTenant = requested ?? actor.tenant_id;
    if (!ID.test(dataTenant)) throw new FamilyError("invalid_input", "data_tenant_id");
    if (!(await this.isEnrolled(actor.person_id, dataTenant))) throw new FamilyError("data_tenant_not_member");
    return dataTenant;
  }

  /** Ikke-eier-medlemmer kan KUN knyttes til en dedikert sirkel-tenant (kun `shared`-rommet): tenant-medlemskap gir tilgang til ALLE tenantens rom (Q-15), så en blandet tenant ville eksponert eierens øvrige rom. Fail closed. */
  private async requireDedicated(client: Client, tenantId: string): Promise<void> {
    const { rows } = await client.query(`SELECT space FROM memory_spaces WHERE tenant_id = $1`, [tenantId]);
    const names = (rows as Array<{ space: string }>).map((r) => r.space);
    if (names.length === 0 || names.some((s) => s !== "shared")) throw new FamilyError("circle_not_dedicated");
  }

  private async requireMember(client: Client, actor: FamilyActor): Promise<FamilyMember> {
    const m = await this.activeMember(client, actor.tenant_id, actor.person_id);
    if (!m) throw new FamilyError("not_a_member");
    return m;
  }

  private async requireCan(client: Client, actor: FamilyActor, action: FamilyAction): Promise<FamilyMember> {
    const m = await this.requireMember(client, actor);
    if (!familyCan(m.role, action)) throw new FamilyError("role_not_allowed", action);
    return m;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Sirkel og medlemmer
  // -------------------------------------------------------------------------------------------------------------------

  /** Er sirkel-tenanten dedikert (kun `shared`-rommet)? Ellers kan ikke ikke-eier-medlemmer legges til (tenant-medlemskap ville gitt dem eierens øvrige rom, Q-15). */
  async topology(actor: FamilyActor): Promise<{ spaces: string[]; dedicated: boolean; has_shared_space: boolean }> {
    return this.tx(actor, async (client) => {
      const { rows } = await client.query(`SELECT space FROM memory_spaces WHERE tenant_id = $1 ORDER BY space`, [actor.tenant_id]);
      // (Se `requireDedicated`: samme vilkår som invitasjon/aksept håndhever.)
      const spaces = (rows as Array<{ space: string }>).map((r) => r.space);
      return { spaces, dedicated: spaces.length > 0 && spaces.every((s) => s === "shared"), has_shared_space: spaces.includes("shared") };
    });
  }

  /** Oppretter eierens medlemskap (idempotent). KUN den suverene eieren (`ownerPersonId`, fra eierkonfigurasjonen - aldri fra en kropp) kan gjøre det. */
  async bootstrapOwner(actor: FamilyActor, ownerPersonId: string, options: { data_tenant_id?: string } = {}): Promise<FamilyMember> {
    if (actor.person_id !== ownerPersonId) throw new FamilyError("owner_required");
    const dataTenant = await this.verifiedDataTenant(actor, options.data_tenant_id);
    return this.tx(actor, async (client) => {
      const space = await client.query(`SELECT 1 FROM memory_spaces WHERE tenant_id = $1 AND space = 'shared'`, [actor.tenant_id]);
      if (!space.rows[0]) throw new FamilyError("circle_space_missing");
      const existing = await client.query(`SELECT * FROM family_members WHERE tenant_id = $1 AND person_id = $2`, [actor.tenant_id, actor.person_id]);
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (row && row["status"] === "active" && row["role"] === "owner") return member(row);
      if (row) throw new FamilyError("already_member"); // et eksisterende ikke-eier-medlemskap blir aldri stille til eier
      try {
        const { rows } = await client.query(
          `INSERT INTO family_members (tenant_id, person_id, role, data_tenant_id, added_by_person_id, joined_at, updated_at) VALUES ($1, $2, 'owner', $4, $2, $3, $3) RETURNING *`,
          [actor.tenant_id, actor.person_id, this.now().toISOString(), dataTenant]
        );
        await this.audit(client, actor, "family.owner_bootstrapped", { person_id: actor.person_id, data_tenant_is_circle: dataTenant === actor.tenant_id });
        return member(rows[0] as Record<string, unknown>);
      } catch (err) {
        if (pgCode(err) === "23505") throw new FamilyError("already_member");
        throw err;
      }
    });
  }

  async getCircle(actor: FamilyActor): Promise<{ my_role: FamilyRole; members: Array<Pick<FamilyMember, "person_id" | "role" | "joined_at">> }> {
    return this.tx(actor, async (client) => {
      const me = await this.requireCan(client, actor, "circle:view_roster");
      const { rows } = await client.query(`SELECT person_id, role, joined_at FROM family_members WHERE tenant_id = $1 AND status = 'active' ORDER BY joined_at, person_id`, [actor.tenant_id]);
      // Rosteret viser KUN person-id, rolle og tidspunkt - aldri data_tenant_id (hvor et medlems data bor er ikke andres sak).
      return { my_role: me.role, members: (rows as Array<Record<string, unknown>>).map((r) => ({ person_id: r["person_id"] as string, role: r["role"] as FamilyRole, joined_at: iso(r["joined_at"]) })) };
    });
  }

  async invite(actor: FamilyActor, input: { invitee_person_id: string; role: InvitableRole; ttl_hours?: number }): Promise<FamilyInvitation> {
    if (!ID.test(input.invitee_person_id) || !(INVITABLE_ROLES as readonly string[]).includes(input.role)) throw new FamilyError("invalid_input");
    const ttl = input.ttl_hours ?? 72;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 720) throw new FamilyError("invalid_input", "ttl_hours");
    return this.tx(actor, async (client) => {
      const me = await this.requireCan(client, actor, "circle:invite");
      if (me.role !== "owner") throw new FamilyError("owner_required");
      if (input.invitee_person_id === actor.person_id) throw new FamilyError("self_target");
      await this.requireDedicated(client, actor.tenant_id);
      if (await this.activeMember(client, actor.tenant_id, input.invitee_person_id)) throw new FamilyError("already_member");
      const enrolled = await client.query(`SELECT 1 FROM person_tenants WHERE person_id = $1 AND tenant_id = $2`, [input.invitee_person_id, actor.tenant_id]);
      if (!enrolled.rows[0]) throw new FamilyError("invitee_not_enrolled");
      const now = this.now();
      // En utløpt, men fortsatt «pending» invitasjon markeres utløpt først: ellers ville den blokkert en ny invitasjon via «én pending per person»-indeksen for alltid.
      await client.query(`UPDATE family_invitations SET status = 'expired', decided_at = $3 WHERE tenant_id = $1 AND invitee_person_id = $2 AND status = 'pending' AND expires_at <= $3`, [actor.tenant_id, input.invitee_person_id, now.toISOString()]);
      try {
        const { rows } = await client.query(
          `INSERT INTO family_invitations (invitation_id, tenant_id, invitee_person_id, role, invited_by_person_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [`fam-inv-${randomUUID()}`, actor.tenant_id, input.invitee_person_id, input.role, actor.person_id, now.toISOString(), new Date(now.getTime() + ttl * HOUR).toISOString()]
        );
        await this.audit(client, actor, "family.invited", { invitee_person_id: input.invitee_person_id, role: input.role });
        return invitation(rows[0] as Record<string, unknown>);
      } catch (err) {
        if (pgCode(err) === "23505") throw new FamilyError("invitation_pending");
        throw err;
      }
    });
  }

  /** Invitasjoner: eieren ser alle; en annen person ser KUN sine egne. */
  async listInvitations(actor: FamilyActor): Promise<FamilyInvitation[]> {
    return this.tx(actor, async (client) => {
      const me = await this.activeMember(client, actor.tenant_id, actor.person_id);
      const ownerView = me?.role === "owner";
      const { rows } = await client.query(
        ownerView ? `SELECT * FROM family_invitations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100` : `SELECT * FROM family_invitations WHERE tenant_id = $1 AND invitee_person_id = $2 ORDER BY created_at DESC LIMIT 100`,
        ownerView ? [actor.tenant_id] : [actor.tenant_id, actor.person_id]
      );
      return (rows as Array<Record<string, unknown>>).map(invitation);
    });
  }

  private async loadInvitation(client: Client, tenantId: string, id: string): Promise<FamilyInvitation> {
    const { rows } = await client.query(`SELECT * FROM family_invitations WHERE tenant_id = $1 AND invitation_id = $2 FOR UPDATE`, [tenantId, id]);
    if (!rows[0]) throw new FamilyError("not_found");
    return invitation(rows[0] as Record<string, unknown>);
  }

  async revokeInvitation(actor: FamilyActor, invitationId: string): Promise<FamilyInvitation> {
    return this.tx(actor, async (client) => {
      const me = await this.requireMember(client, actor);
      if (me.role !== "owner") throw new FamilyError("owner_required");
      const inv = await this.loadInvitation(client, actor.tenant_id, invitationId);
      if (inv.status !== "pending") throw new FamilyError("invitation_not_pending");
      const { rows } = await client.query(`UPDATE family_invitations SET status = 'revoked', decided_at = $3, decided_by_person_id = $4 WHERE tenant_id = $1 AND invitation_id = $2 RETURNING *`, [actor.tenant_id, invitationId, this.now().toISOString(), actor.person_id]);
      await this.audit(client, actor, "family.invitation_revoked", { invitation_id: invitationId });
      return invitation(rows[0] as Record<string, unknown>);
    });
  }

  /** Den inviterte selv (egen autoritet) aksepterer. `data_tenant_id` = tenanten der personens EGNE data bor (standard: sirkel-tenanten); personen må være medlem der. */
  async acceptInvitation(actor: FamilyActor, invitationId: string, options: { data_tenant_id?: string } = {}): Promise<FamilyMember> {
    const dataTenant = await this.verifiedDataTenant(actor, options.data_tenant_id);
    return this.txDenying<FamilyMember>(actor, async (client) => {
      const inv = await this.loadInvitation(client, actor.tenant_id, invitationId);
      if (inv.invitee_person_id !== actor.person_id) throw new FamilyError("not_the_invitee");
      if (inv.status !== "pending") throw new FamilyError("invitation_not_pending");
      const now = this.now();
      if (Date.parse(inv.expires_at) <= now.getTime()) {
        // Utløpet MARKERES og committes (avslaget returneres som verdi og kastes etter commit), så invitasjonen ikke blir stående som «pending».
        await client.query(`UPDATE family_invitations SET status = 'expired', decided_at = $3 WHERE tenant_id = $1 AND invitation_id = $2`, [actor.tenant_id, invitationId, now.toISOString()]);
        return deny("invitation_expired");
      }
      await this.requireDedicated(client, actor.tenant_id); // sjekkes på nytt ved aksept: rom kan ha kommet til etter invitasjonen
      const existing = await client.query(`SELECT status FROM family_members WHERE tenant_id = $1 AND person_id = $2`, [actor.tenant_id, actor.person_id]);
      let row: Record<string, unknown>;
      if (existing.rows[0]) {
        if ((existing.rows[0] as { status: string }).status === "active") throw new FamilyError("already_member");
        // Et tidligere medlem (forlot/fjernet) blir medlem igjen under den NYE invitasjonens rolle; gamle delinger/delegasjoner er tilbakekalt og gjenåpnes aldri.
        const updated = await client.query(
          `UPDATE family_members SET role = $3, status = 'active', ended_at = NULL, data_tenant_id = $4, invitation_id = $5, joined_at = $6, updated_at = $6 WHERE tenant_id = $1 AND person_id = $2 RETURNING *`,
          [actor.tenant_id, actor.person_id, inv.role, dataTenant, invitationId, now.toISOString()]
        );
        row = updated.rows[0] as Record<string, unknown>;
      } else {
        const inserted = await client.query(
          `INSERT INTO family_members (tenant_id, person_id, role, data_tenant_id, added_by_person_id, invitation_id, joined_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
          [actor.tenant_id, actor.person_id, inv.role, dataTenant, inv.invited_by_person_id, invitationId, now.toISOString()]
        );
        row = inserted.rows[0] as Record<string, unknown>;
      }
      await client.query(`UPDATE family_invitations SET status = 'accepted', decided_at = $3, decided_by_person_id = $4 WHERE tenant_id = $1 AND invitation_id = $2`, [actor.tenant_id, invitationId, now.toISOString(), actor.person_id]);
      await this.audit(client, actor, "family.invitation_accepted", { invitation_id: invitationId, role: inv.role, data_tenant_is_circle: dataTenant === actor.tenant_id });
      return member(row);
    });
  }

  async declineInvitation(actor: FamilyActor, invitationId: string): Promise<FamilyInvitation> {
    return this.tx(actor, async (client) => {
      const inv = await this.loadInvitation(client, actor.tenant_id, invitationId);
      if (inv.invitee_person_id !== actor.person_id) throw new FamilyError("not_the_invitee");
      if (inv.status !== "pending") throw new FamilyError("invitation_not_pending");
      const { rows } = await client.query(`UPDATE family_invitations SET status = 'declined', decided_at = $3, decided_by_person_id = $4 WHERE tenant_id = $1 AND invitation_id = $2 RETURNING *`, [actor.tenant_id, invitationId, this.now().toISOString(), actor.person_id]);
      await this.audit(client, actor, "family.invitation_declined", { invitation_id: invitationId });
      return invitation(rows[0] as Record<string, unknown>);
    });
  }

  private async endMembership(client: Client, actor: FamilyActor, personId: string, status: "left" | "removed"): Promise<{ devices_revoked: number; grants_revoked: number }> {
    const now = this.now().toISOString();
    const { rowCount } = await client.query(`UPDATE family_members SET status = $3, ended_at = $4, updated_at = $4 WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'`, [actor.tenant_id, personId, status, now]);
    if (rowCount !== 1) throw new FamilyError("not_found");
    // ALLE delinger og delegasjoner som involverer personen tilbakekalles i samme transaksjon (aldri en dinglende tilgang til et tidligere medlem).
    await client.query(`UPDATE family_shares SET revoked_at = $3, revoked_by_person_id = $4 WHERE tenant_id = $1 AND revoked_at IS NULL AND (subject_person_id = $2 OR viewer_person_id = $2)`, [actor.tenant_id, personId, now, actor.person_id]);
    await client.query(`UPDATE family_delegations SET revoked_at = $3, revoked_by_person_id = $4 WHERE tenant_id = $1 AND revoked_at IS NULL AND (principal_person_id = $2 OR agent_person_id = $2)`, [actor.tenant_id, personId, now, actor.person_id]);
    // IDENTITETSNIVÅ (review B LOW-5): familieautoriteten alene stenger ikke et medlem ute - identitetsmodellen gir enhver person med medlemskap OG en innrullert enhet tilgang til HVERT rom i tenanten (Q-15), og sirkelen er en
    // dedikert tenant (kun `shared`). Personens enheter i DENNE tenanten tilbakekalles derfor permanent (samme primitiv som eierens `revokeDevice`: nøkkelen kan ikke autorisere på nytt eller rulles inn igjen her) og utestående
    // grants med dem. Enheter i personens ANDRE tenanter (egne data) røres ikke: RLS avgrenser `devices` til sirkel-tenanten. Å ta et tidligere medlem inn igjen krever en ny innrulling med en NY enhetsnøkkel.
    const owned = await client.query(`SELECT device_id FROM devices WHERE tenant_id = $1 AND person_id = $2 AND revoked_at IS NULL ORDER BY device_id`, [actor.tenant_id, personId]);
    let grantsRevoked = 0;
    for (const row of owned.rows as Array<{ device_id: string }>) {
      await this.devices.revokeDeviceKeyOn(client, { tenant_id: actor.tenant_id, device_id: row.device_id }, `family_member_${status}`);
      grantsRevoked += await this.grants.revokeForDeviceOn(client, actor.tenant_id, row.device_id, this.now().getTime());
    }
    return { devices_revoked: owned.rows.length, grants_revoked: grantsRevoked };
  }

  async removeMember(actor: FamilyActor, personId: string): Promise<void> {
    return this.tx(actor, async (client) => {
      const me = await this.requireCan(client, actor, "circle:remove");
      if (me.role !== "owner") throw new FamilyError("owner_required");
      const target = await this.activeMember(client, actor.tenant_id, personId);
      if (!target) throw new FamilyError("not_found");
      if (target.role === "owner") throw new FamilyError("cannot_remove_owner");
      const cut = await this.endMembership(client, actor, personId, "removed");
      await this.audit(client, actor, "family.member_removed", { person_id: personId, ...cut });
    });
  }

  async leave(actor: FamilyActor): Promise<void> {
    return this.tx(actor, async (client) => {
      const me = await this.requireMember(client, actor);
      if (me.role === "owner") throw new FamilyError("owner_cannot_leave");
      const cut = await this.endMembership(client, actor, actor.person_id, "left");
      await this.audit(client, actor, "family.member_left", { person_id: actor.person_id, ...cut });
    });
  }

  /** Medlemmet SELV peker på tenanten der egne helse-/lokasjonsdata bor. Kun en tenant personen faktisk tilhører (verifisert); ingen kan sette den for en annen person. */
  async setDataTenant(actor: FamilyActor, dataTenantId: string): Promise<FamilyMember> {
    const dataTenant = await this.verifiedDataTenant(actor, dataTenantId);
    return this.tx(actor, async (client) => {
      await this.requireMember(client, actor);
      const { rows } = await client.query(
        `UPDATE family_members SET data_tenant_id = $3, updated_at = $4 WHERE tenant_id = $1 AND person_id = $2 AND status = 'active' RETURNING *`,
        [actor.tenant_id, actor.person_id, dataTenant, this.now().toISOString()]
      );
      await this.audit(client, actor, "family.data_tenant_set", { data_tenant_is_circle: dataTenant === actor.tenant_id });
      return member(rows[0] as Record<string, unknown>);
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Deling av helse/lokasjon (kun subjektet gir; kun seeren leser; begge kan tilbakekalle)
  // -------------------------------------------------------------------------------------------------------------------

  /** Subjektet (= den innloggede personen, ALDRI en annen) deler EN kategori med EN annen person. Idempotent: en aktiv deling returneres uendret. */
  async grantShare(actor: FamilyActor, input: { viewer_person_id: string; category: FamilyShareCategory; ttl_days?: number }): Promise<FamilyShare> {
    if (!ID.test(input.viewer_person_id) || !(SHARE_CATEGORIES as readonly string[]).includes(input.category)) throw new FamilyError("invalid_input");
    const ttlDays = input.ttl_days;
    if (ttlDays !== undefined && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365)) throw new FamilyError("invalid_input", "ttl_days");
    return this.tx(actor, async (client) => {
      const me = await this.requireCan(client, actor, "share:grant");
      // Strengeste standard: et barn deler aldri helse (verken eget eller andres) uten foresattes samtykke, som ikke er løst (åpent eierspørsmål) - kun lokasjon.
      if (input.category === "health_summary" && !familyCan(me.role, "share:grant_health")) throw new FamilyError("share_not_allowed", `${me.role}:grant:${input.category}`);
      if (input.viewer_person_id === actor.person_id) throw new FamilyError("self_target");
      const viewer = await this.activeMember(client, actor.tenant_id, input.viewer_person_id);
      if (!viewer) throw new FamilyError("not_found");
      if (!roleMayViewCategory(viewer.role, input.category)) throw new FamilyError("share_not_allowed", `${viewer.role}:${input.category}`);
      const now = this.now();
      const existing = await client.query(`SELECT * FROM family_shares WHERE tenant_id = $1 AND subject_person_id = $2 AND viewer_person_id = $3 AND category = $4 AND revoked_at IS NULL`, [actor.tenant_id, actor.person_id, input.viewer_person_id, input.category]);
      if (existing.rows[0]) {
        const row = share(existing.rows[0] as Record<string, unknown>);
        if (row.expires_at === null || Date.parse(row.expires_at) > now.getTime()) return row;
        // En utløpt, ikke-tilbakekalt deling erstattes: den gamle lukkes (samtykket er ikke lenger gyldig) og en ny rad opprettes under.
        await client.query(`UPDATE family_shares SET revoked_at = $2, revoked_by_person_id = $3 WHERE share_id = $1`, [row.share_id, now.toISOString(), actor.person_id]);
      }
      // `ON CONFLICT DO NOTHING` (delvis unik indeks: ÉN aktiv deling per subjekt/seer/kategori): to samtidige kall med samme innhold ga før en rå pg-feil (23505 -> 500) hos taperen i stedet for en idempotent retur (review B LOW-6).
      const { rows } = await client.query(
        `INSERT INTO family_shares (share_id, tenant_id, subject_person_id, viewer_person_id, category, granted_by_person_id, granted_at, expires_at) VALUES ($1, $2, $3, $4, $5, $3, $6, $7)
         ON CONFLICT (tenant_id, subject_person_id, viewer_person_id, category) WHERE revoked_at IS NULL DO NOTHING RETURNING *`,
        [`fam-shr-${randomUUID()}`, actor.tenant_id, actor.person_id, input.viewer_person_id, input.category, now.toISOString(), ttlDays === undefined ? null : new Date(now.getTime() + ttlDays * DAY).toISOString()]
      );
      if (!rows[0]) {
        // Vinneren av kappløpet har allerede committet (ON CONFLICT ventet på den): returner dens aktive rad uendret og IKKE skriv en ny revisjonsrad (vinneren reviderte).
        const winner = await client.query(`SELECT * FROM family_shares WHERE tenant_id = $1 AND subject_person_id = $2 AND viewer_person_id = $3 AND category = $4 AND revoked_at IS NULL`, [actor.tenant_id, actor.person_id, input.viewer_person_id, input.category]);
        if (!winner.rows[0]) throw new Error("family_share_conflict_unresolved"); // aldri i praksis: vinneren ble tilbakekalt mellom to setninger
        return share(winner.rows[0] as Record<string, unknown>);
      }
      await this.audit(client, actor, "family.share_granted", { viewer_person_id: input.viewer_person_id, category: input.category, expires: ttlDays ?? null });
      return share(rows[0] as Record<string, unknown>);
    });
  }

  /** Subjektet eller seeren tilbakekaller. Idempotent. En annen person (heller ikke eieren) kan ikke. */
  async revokeShare(actor: FamilyActor, shareId: string): Promise<FamilyShare> {
    return this.tx(actor, async (client) => {
      const { rows } = await client.query(`SELECT * FROM family_shares WHERE tenant_id = $1 AND share_id = $2 FOR UPDATE`, [actor.tenant_id, shareId]);
      const row = rows[0] as Record<string, unknown> | undefined;
      // Alle andre får «finnes ikke» (ingen informasjon om andres delinger).
      if (!row || (row["subject_person_id"] !== actor.person_id && row["viewer_person_id"] !== actor.person_id)) throw new FamilyError("not_found");
      if (row["revoked_at"] !== null) return share(row);
      const updated = await client.query(`UPDATE family_shares SET revoked_at = $3, revoked_by_person_id = $4 WHERE tenant_id = $1 AND share_id = $2 RETURNING *`, [actor.tenant_id, shareId, this.now().toISOString(), actor.person_id]);
      await this.audit(client, actor, "family.share_revoked", { share_id: shareId });
      return share(updated.rows[0] as Record<string, unknown>);
    });
  }

  /** Mine delinger: de jeg har gitt og de jeg har mottatt - aldri andres. */
  async listShares(actor: FamilyActor): Promise<{ granted: FamilyShare[]; received: FamilyShare[] }> {
    return this.tx(actor, async (client) => {
      await this.requireMember(client, actor);
      const nowIso = this.now().toISOString();
      const granted = await client.query(`SELECT * FROM family_shares WHERE tenant_id = $1 AND subject_person_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3) ORDER BY granted_at DESC`, [actor.tenant_id, actor.person_id, nowIso]);
      const received = await client.query(`SELECT * FROM family_shares WHERE tenant_id = $1 AND viewer_person_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3) ORDER BY granted_at DESC`, [actor.tenant_id, actor.person_id, nowIso]);
      return { granted: (granted.rows as Array<Record<string, unknown>>).map(share), received: (received.rows as Array<Record<string, unknown>>).map(share) };
    });
  }

  /**
   * Leser et annet medlems delte kategori (eller ens EGEN uten deling). Kjeden: begge er aktive medlemmer -> seer-rollen kan se kategorien (sjekkes OGSÅ nå) -> en aktiv, ikke-utløpt deling fra subjektet finnes -> den injiserte leseren henter
   * det avledede fra subjektets EGEN datatenant -> bruken registreres (`last_used_at`/`use_count`) og revideres. Alle avslag gir samme `share_required` (ingen informasjon om hvorfor, eller om subjektet har data) og revideres som avslag.
   */
  async readShared(actor: FamilyActor, subjectPersonId: string, category: FamilyShareCategory): Promise<SharedView> {
    if (!ID.test(subjectPersonId) || !(SHARE_CATEGORIES as readonly string[]).includes(category)) throw new FamilyError("invalid_input");
    const readers = this.readers;
    if (!readers) throw new FamilyError("reader_unavailable");
    // Alle avslag gir samme `share_required` (ingen informasjon om hvorfor) OG revideres: avslaget COMMITTES (revisjonsraden består) før feilen kastes.
    const subject = await this.txDenying<FamilyMember>(actor, async (client) => {
      const refuse = async (reason: string): Promise<Denied> => {
        await this.audit(client, actor, "family.share_denied", { subject_person_id: subjectPersonId, category }, reason);
        return deny("share_required");
      };
      const viewer = await this.activeMember(client, actor.tenant_id, actor.person_id);
      if (!viewer) return refuse("viewer_not_member");
      const target = await this.activeMember(client, actor.tenant_id, subjectPersonId);
      if (!target) return refuse("subject_not_member");
      if (subjectPersonId === actor.person_id) return target; // eget medlem: alltid lov
      if (!roleMayViewCategory(viewer.role, category)) return refuse("role_may_not_view");
      // Forsvar i dybden (review B INFO-1): et barns/gjests helse deles aldri (se `grantShare`). En slik delingsrad kan kun finnes hvis den ble satt inn UTENOM tjenesten (DB-CHECK-en sikrer bare at subjektet er giveren) - og leveres likevel aldri.
      if (category === "health_summary" && !familyCan(target.role, "share:grant_health")) return refuse("subject_role_may_not_share");
      const now = this.now();
      const { rows } = await client.query(
        `SELECT share_id FROM family_shares WHERE tenant_id = $1 AND subject_person_id = $2 AND viewer_person_id = $3 AND category = $4 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $5)`,
        [actor.tenant_id, subjectPersonId, actor.person_id, category, now.toISOString()]
      );
      if (!rows[0]) return refuse("no_active_share");
      await client.query(`UPDATE family_shares SET last_used_at = $2, use_count = use_count + 1 WHERE share_id = $1`, [(rows[0] as { share_id: string }).share_id, now.toISOString()]);
      await this.audit(client, actor, "family.share_used", { subject_person_id: subjectPersonId, category });
      return target;
    });
    // Datatenanten har ingen FK (se migrasjon 126): personen må FORTSATT være medlem der ved hver lesing, ellers fail closed (samme svar og revisjon som andre avslag).
    const dataTenant = subject.data_tenant_id;
    if (!(await this.isEnrolled(subject.person_id, dataTenant))) {
      await this.tx(actor, (client) => this.audit(client, actor, "family.share_denied", { subject_person_id: subjectPersonId, category }, "data_tenant_membership_lost"));
      throw new FamilyError("share_required");
    }
    if (category === "location") {
      const place = await readers.currentPlace(dataTenant, subjectPersonId);
      return { category: "location", zone_name: place?.zone_name ?? null, observed_at: place?.observed_at ?? null };
    }
    const health = await readers.healthSummary(dataTenant, subjectPersonId);
    return { category: "health_summary", steps_today: health?.steps_today ?? null, sleep_minutes_last_night: health?.sleep_minutes_last_night ?? null, observed_at: health?.observed_at ?? null };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // «På vegne av» (delegasjon)
  // -------------------------------------------------------------------------------------------------------------------

  /** Prinsipalen (= den innloggede personen) gir EN annen person rett til å gjøre ett lukket scope i sitt navn. Utløp er påkrevd (standard 30 dager, maks 90). */
  async grantDelegation(actor: FamilyActor, input: { agent_person_id: string; scope: FamilyDelegationScope; ttl_days?: number }): Promise<FamilyDelegation> {
    if (!ID.test(input.agent_person_id) || !(DELEGABLE_SCOPES as readonly string[]).includes(input.scope)) throw new FamilyError("invalid_input");
    const ttlDays = input.ttl_days ?? 30;
    if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 90) throw new FamilyError("invalid_input", "ttl_days");
    return this.tx(actor, async (client) => {
      await this.requireCan(client, actor, "delegation:grant");
      if (input.agent_person_id === actor.person_id) throw new FamilyError("self_target");
      const agent = await this.activeMember(client, actor.tenant_id, input.agent_person_id);
      if (!agent) throw new FamilyError("not_found");
      if (!roleMayActFor(agent.role, input.scope)) throw new FamilyError("delegation_not_allowed", `${agent.role}:${input.scope}`);
      const now = this.now();
      const existing = await client.query(`SELECT * FROM family_delegations WHERE tenant_id = $1 AND principal_person_id = $2 AND agent_person_id = $3 AND scope = $4 AND revoked_at IS NULL`, [actor.tenant_id, actor.person_id, input.agent_person_id, input.scope]);
      if (existing.rows[0]) {
        const row = delegation(existing.rows[0] as Record<string, unknown>);
        if (Date.parse(row.expires_at) > now.getTime()) return row;
        await client.query(`UPDATE family_delegations SET revoked_at = $2, revoked_by_person_id = $3 WHERE delegation_id = $1`, [row.delegation_id, now.toISOString(), actor.person_id]);
      }
      // Samme kappløpsvern som `grantShare` (delvis unik indeks: ÉN aktiv delegasjon per prinsipal/agent/scope).
      const { rows } = await client.query(
        `INSERT INTO family_delegations (delegation_id, tenant_id, principal_person_id, agent_person_id, scope, granted_by_person_id, granted_at, expires_at) VALUES ($1, $2, $3, $4, $5, $3, $6, $7)
         ON CONFLICT (tenant_id, principal_person_id, agent_person_id, scope) WHERE revoked_at IS NULL DO NOTHING RETURNING *`,
        [`fam-del-${randomUUID()}`, actor.tenant_id, actor.person_id, input.agent_person_id, input.scope, now.toISOString(), new Date(now.getTime() + ttlDays * DAY).toISOString()]
      );
      if (!rows[0]) {
        const winner = await client.query(`SELECT * FROM family_delegations WHERE tenant_id = $1 AND principal_person_id = $2 AND agent_person_id = $3 AND scope = $4 AND revoked_at IS NULL`, [actor.tenant_id, actor.person_id, input.agent_person_id, input.scope]);
        if (!winner.rows[0]) throw new Error("family_delegation_conflict_unresolved");
        return delegation(winner.rows[0] as Record<string, unknown>);
      }
      await this.audit(client, actor, "family.delegation_granted", { agent_person_id: input.agent_person_id, scope: input.scope, ttl_days: ttlDays });
      return delegation(rows[0] as Record<string, unknown>);
    });
  }

  /** Prinsipalen eller agenten tilbakekaller. Idempotent. Andre får «finnes ikke». */
  async revokeDelegation(actor: FamilyActor, delegationId: string): Promise<FamilyDelegation> {
    return this.tx(actor, async (client) => {
      const { rows } = await client.query(`SELECT * FROM family_delegations WHERE tenant_id = $1 AND delegation_id = $2 FOR UPDATE`, [actor.tenant_id, delegationId]);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row || (row["principal_person_id"] !== actor.person_id && row["agent_person_id"] !== actor.person_id)) throw new FamilyError("not_found");
      if (row["revoked_at"] !== null) return delegation(row);
      const updated = await client.query(`UPDATE family_delegations SET revoked_at = $3, revoked_by_person_id = $4 WHERE tenant_id = $1 AND delegation_id = $2 RETURNING *`, [actor.tenant_id, delegationId, this.now().toISOString(), actor.person_id]);
      await this.audit(client, actor, "family.delegation_revoked", { delegation_id: delegationId });
      return delegation(updated.rows[0] as Record<string, unknown>);
    });
  }

  async listDelegations(actor: FamilyActor): Promise<{ granted: FamilyDelegation[]; received: FamilyDelegation[] }> {
    return this.tx(actor, async (client) => {
      await this.requireMember(client, actor);
      const nowIso = this.now().toISOString();
      const g = await client.query(`SELECT * FROM family_delegations WHERE tenant_id = $1 AND principal_person_id = $2 AND revoked_at IS NULL AND expires_at > $3 ORDER BY granted_at DESC`, [actor.tenant_id, actor.person_id, nowIso]);
      const r = await client.query(`SELECT * FROM family_delegations WHERE tenant_id = $1 AND agent_person_id = $2 AND revoked_at IS NULL AND expires_at > $3 ORDER BY granted_at DESC`, [actor.tenant_id, actor.person_id, nowIso]);
      return { granted: (g.rows as Array<Record<string, unknown>>).map(delegation), received: (r.rows as Array<Record<string, unknown>>).map(delegation) };
    });
  }

  /** Beviser «på vegne av»: agentens rolle har lov til handlingen scopet dekker, og en aktiv, ikke-utløpt delegasjon fra prinsipalen finnes. Uten bevis: `delegation_required` (aldri en stille handling i eget navn). */
  private async proveActingAs(client: Client, actor: FamilyActor, agent: FamilyMember, onBehalfOf: string | undefined, scope: FamilyDelegationScope): Promise<ActingAs | Denied> {
    if (onBehalfOf === undefined) return { actor_person_id: actor.person_id, on_behalf_of_person_id: null, delegation_id: null };
    if (!ID.test(onBehalfOf)) throw new FamilyError("invalid_input", "on_behalf_of");
    if (onBehalfOf === actor.person_id) throw new FamilyError("self_target");
    // Avslag her er sikkerhetsrelevante («noen prøvde å handle i en annens navn uten fullmakt») og COMMITTES med revisjonsrad (se `txDenying`).
    const refuse = async (reason: string): Promise<Denied> => {
      await this.audit(client, actor, "family.delegation_denied", { principal_person_id: onBehalfOf, scope }, reason);
      return deny("delegation_required");
    };
    if (!roleMayActFor(agent.role, scope) || !familyCan(agent.role, scopeAction(scope))) return refuse("agent_role_may_not_act");
    const principal = await this.activeMember(client, actor.tenant_id, onBehalfOf);
    if (!principal) return refuse("principal_not_member");
    const { rows } = await client.query(
      `SELECT delegation_id FROM family_delegations WHERE tenant_id = $1 AND principal_person_id = $2 AND agent_person_id = $3 AND scope = $4 AND revoked_at IS NULL AND expires_at > $5`,
      [actor.tenant_id, onBehalfOf, actor.person_id, scope, this.now().toISOString()]
    );
    if (!rows[0]) return refuse("no_active_delegation");
    return { actor_person_id: actor.person_id, on_behalf_of_person_id: onBehalfOf, delegation_id: (rows[0] as { delegation_id: string }).delegation_id };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Delte lister og delt kalender (sirkelens eget innhold)
  // -------------------------------------------------------------------------------------------------------------------

  async createList(actor: FamilyActor, input: { name: string; on_behalf_of?: string }): Promise<FamilyList> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length < 1 || name.length > 120) throw new FamilyError("invalid_input", "name");
    return this.txDenying<FamilyList>(actor, async (client) => {
      const me = await this.requireCan(client, actor, "lists:create");
      const acting = await this.proveActingAs(client, actor, me, input.on_behalf_of, "shared_lists");
      if (isDenied(acting)) return acting;
      const { rows } = await client.query(
        `INSERT INTO family_lists (list_id, tenant_id, name, created_by_person_id, on_behalf_of_person_id, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [`fam-lst-${randomUUID()}`, actor.tenant_id, name, acting.actor_person_id, acting.on_behalf_of_person_id, this.now().toISOString()]
      );
      await this.audit(client, actor, "family.list_created", { on_behalf_of: acting.on_behalf_of_person_id, delegation_id: acting.delegation_id });
      return list(rows[0] as Record<string, unknown>);
    });
  }

  async listLists(actor: FamilyActor): Promise<FamilyList[]> {
    return this.tx(actor, async (client) => {
      await this.requireCan(client, actor, "lists:read");
      const { rows } = await client.query(`SELECT list_id, name, created_by_person_id, on_behalf_of_person_id, created_at, archived_at FROM family_lists WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 200`, [actor.tenant_id]);
      return (rows as Array<Record<string, unknown>>).map(list);
    });
  }

  async addListItem(actor: FamilyActor, listId: string, input: { body: string; on_behalf_of?: string }): Promise<FamilyListItem> {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (body.length < 1 || body.length > 500 || !ID.test(listId)) throw new FamilyError("invalid_input");
    return this.txDenying<FamilyListItem>(actor, async (client) => {
      const me = await this.requireCan(client, actor, "lists:add_item");
      const acting = await this.proveActingAs(client, actor, me, input.on_behalf_of, "shared_lists");
      if (isDenied(acting)) return acting;
      const target = await client.query(`SELECT 1 FROM family_lists WHERE tenant_id = $1 AND list_id = $2 AND archived_at IS NULL`, [actor.tenant_id, listId]);
      if (!target.rows[0]) throw new FamilyError("not_found");
      const { rows } = await client.query(
        `INSERT INTO family_list_items (item_id, tenant_id, list_id, body, added_by_person_id, on_behalf_of_person_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [`fam-itm-${randomUUID()}`, actor.tenant_id, listId, body, acting.actor_person_id, acting.on_behalf_of_person_id, this.now().toISOString()]
      );
      await this.audit(client, actor, "family.list_item_added", { on_behalf_of: acting.on_behalf_of_person_id, delegation_id: acting.delegation_id });
      return this.itemRow(rows[0] as Record<string, unknown>);
    });
  }

  private itemRow(r: Record<string, unknown>): FamilyListItem {
    return { item_id: r["item_id"] as string, list_id: r["list_id"] as string, body: r["body"] as string, done: r["done"] as boolean, added_by_person_id: r["added_by_person_id"] as string, on_behalf_of_person_id: (r["on_behalf_of_person_id"] as string | null) ?? null, done_by_person_id: (r["done_by_person_id"] as string | null) ?? null, created_at: iso(r["created_at"]), done_at: isoOrNull(r["done_at"]) };
  }

  async listItems(actor: FamilyActor, listId: string): Promise<FamilyListItem[]> {
    if (!ID.test(listId)) throw new FamilyError("invalid_input");
    return this.tx(actor, async (client) => {
      await this.requireCan(client, actor, "lists:read");
      const { rows } = await client.query(`SELECT * FROM family_list_items WHERE tenant_id = $1 AND list_id = $2 ORDER BY created_at LIMIT 500`, [actor.tenant_id, listId]);
      return (rows as Array<Record<string, unknown>>).map((r) => this.itemRow(r));
    });
  }

  async setItemDone(actor: FamilyActor, itemId: string, done: boolean): Promise<FamilyListItem> {
    if (!ID.test(itemId) || typeof done !== "boolean") throw new FamilyError("invalid_input");
    return this.tx(actor, async (client) => {
      await this.requireCan(client, actor, "lists:complete");
      const now = this.now().toISOString();
      const { rows } = await client.query(
        `UPDATE family_list_items SET done = $3, done_at = $4, done_by_person_id = $5 WHERE tenant_id = $1 AND item_id = $2 RETURNING *`,
        [actor.tenant_id, itemId, done, done ? now : null, done ? actor.person_id : null]
      );
      if (!rows[0]) throw new FamilyError("not_found");
      // «Hver endring revideres» (review B LOW-7): en avhuking/gjenåpning ble før endret uten revisjonsrad. Aldri innholdet (teksten) - kun id og tilstand.
      await this.audit(client, actor, "family.list_item_done_set", { item_id: itemId, done });
      return this.itemRow(rows[0] as Record<string, unknown>);
    });
  }

  private eventRow(r: Record<string, unknown>): FamilyEvent {
    return { event_id: r["event_id"] as string, title: r["title"] as string, starts_at: iso(r["starts_at"]), ends_at: iso(r["ends_at"]), all_day: r["all_day"] as boolean, created_by_person_id: r["created_by_person_id"] as string, on_behalf_of_person_id: (r["on_behalf_of_person_id"] as string | null) ?? null, created_at: iso(r["created_at"]), cancelled_at: isoOrNull(r["cancelled_at"]) };
  }

  async createEvent(actor: FamilyActor, input: { title: string; starts_at: string; ends_at: string; all_day?: boolean; on_behalf_of?: string }): Promise<FamilyEvent> {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const starts = Date.parse(input.starts_at);
    const ends = Date.parse(input.ends_at);
    if (title.length < 1 || title.length > 200 || !Number.isFinite(starts) || !Number.isFinite(ends) || ends < starts) throw new FamilyError("invalid_input");
    return this.txDenying<FamilyEvent>(actor, async (client) => {
      const me = await this.requireCan(client, actor, "events:create");
      const acting = await this.proveActingAs(client, actor, me, input.on_behalf_of, "shared_calendar");
      if (isDenied(acting)) return acting;
      const { rows } = await client.query(
        `INSERT INTO family_events (event_id, tenant_id, title, starts_at, ends_at, all_day, created_by_person_id, on_behalf_of_person_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [`fam-evt-${randomUUID()}`, actor.tenant_id, title, new Date(starts).toISOString(), new Date(ends).toISOString(), input.all_day === true, acting.actor_person_id, acting.on_behalf_of_person_id, this.now().toISOString()]
      );
      await this.audit(client, actor, "family.event_created", { on_behalf_of: acting.on_behalf_of_person_id, delegation_id: acting.delegation_id });
      return this.eventRow(rows[0] as Record<string, unknown>);
    });
  }

  async listEvents(actor: FamilyActor, window: { from: string; to: string }): Promise<FamilyEvent[]> {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 366 * DAY) throw new FamilyError("invalid_input");
    return this.tx(actor, async (client) => {
      await this.requireCan(client, actor, "events:read");
      const { rows } = await client.query(
        `SELECT * FROM family_events WHERE tenant_id = $1 AND cancelled_at IS NULL AND starts_at <= $3 AND ends_at >= $2 ORDER BY starts_at LIMIT 500`,
        [actor.tenant_id, new Date(from).toISOString(), new Date(to).toISOString()]
      );
      return (rows as Array<Record<string, unknown>>).map((r) => this.eventRow(r));
    });
  }

  async cancelEvent(actor: FamilyActor, eventId: string): Promise<FamilyEvent> {
    if (!ID.test(eventId)) throw new FamilyError("invalid_input");
    return this.tx(actor, async (client) => {
      await this.requireCan(client, actor, "events:cancel");
      const { rows } = await client.query(
        `UPDATE family_events SET cancelled_at = $3, cancelled_by_person_id = $4 WHERE tenant_id = $1 AND event_id = $2 AND cancelled_at IS NULL RETURNING *`,
        [actor.tenant_id, eventId, this.now().toISOString(), actor.person_id]
      );
      if (!rows[0]) throw new FamilyError("not_found");
      await this.audit(client, actor, "family.event_cancelled", { event_id: eventId });
      return this.eventRow(rows[0] as Record<string, unknown>);
    });
  }
}
