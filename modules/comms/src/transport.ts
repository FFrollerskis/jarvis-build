import { z } from "zod";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import { COMMS_CHANNELS, PROVIDERS_FOR_CHANNEL, isValidAccountRef, normalizeRecipient, optOutHash, recipientHint, type CommsProvider } from "./channels.ts";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import {
  CONTACTS_LINK_SOURCE, ContactsCreateSchema, ContactsDeleteSchema, ContactsGetSchema, ContactsListSchema, ContactsSearchSchema, ContactsSyncSchema, ContactsUnlinkSchema, ContactsUpdateSchema, type ContactView, type GoogleContacts
} from "./contacts.ts";
import { parseCallParams, parseDeleteParams, parseEditParams, parseReactParams, parseSendParams, type FunnelContext, type OutboundFunnel, type ParseResult } from "./funnel.ts";
import { MEETING_TEXT_MAX_CHARS, type MeetingService } from "./meetings.ts";
import type { VendorReads } from "./reads.ts";
import { validateLiftReason, type CommsStore } from "./store.ts";

/**
 * WP-G1 (D-463): `comms.*`-transporten - tynn limer mellom ToolGateway og `OutboundFunnel`/`CommsStore`. Ingen policy her (den bor i funnelen); transporten bygger KUN den tiltrodde konteksten av `context.identity`
 * (tenant/space/person/sesjon kommer ALDRI fra `parameters` - D-119-hardening-prinsippet: «ingen parameter = ingen forfalskningsflate») og sender hver handling videre.
 *
 * Mutasjoner (send/edit/delete/react) kalles av gatewayen med den LØSTE leverandør-credentialen (`credential_ref_resolver`); lesing og administrasjon bruker den interne sentinel-credentialen.
 */
const ALLOWED_SPACES: readonly MemorySpace[] = ["personal", "business", "project", "shared"];

const ListInbound = z.object({ channel: z.enum(COMMS_CHANNELS).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const ListOutbound = z.object({ status: z.enum(["denied", "requested", "sent", "outcome_unknown", "failed"]).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const ListOptOuts = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict();
const Authorize = z.object({
  channel: z.enum(COMMS_CHANNELS), account_ref: z.string().min(1).max(200), provider: z.enum(["slack", "discord", "meta_whatsapp", "twilio", "telnyx", "ms_graph", "meta_messenger", "meta_instagram"]),
  display_name: z.string().min(1).max(120).optional()
}).strict();
const Revoke = z.object({ account_id: z.string().min(8).max(80) }).strict();
/** `account_ref` er valgfri og kun et hint (A-M7): en avmelding er tenant-bred. Oppgis den, MÅ den være `*` eller en gyldig kontoreferanse for kanalen - en skrivefeil gir en tydelig feil, aldri en stille no-op. */
export const RecordOptOutSchema = z.object({
  channel: z.enum(COMMS_CHANNELS), account_ref: z.string().min(1).max(200).optional(), recipient: z.string().min(1).max(300), source: z.enum(["owner_recorded", "recipient_request"]).optional()
}).strict();

/**
 * K5 (JARVIS-112 f2): eierens angre av en FEILREGISTRERT STOP. `reason` er obligatorisk (3-200 tegn, én linje, uten hemmeligheter - `validateLiftReason`). Samme strenge skjema brukes av preflight/readback (`check_opt_out_target`):
 * gatewayen kaller den med handlingens egne parametre.
 */
export const LiftOwnerOptOutSchema = z.object({ opt_out_id: z.string().min(8).max(80), reason: z.string().min(3).max(200) }).strict();

/** Leverandør-lesing (P1c): strenge, eksakte former - id-er valideres mot leverandørens format FØR noe kall (ingen sti-/spørringsinjeksjon). */
const AccountRef = z.string().min(1).max(200);
export const ReadThreadSchema = z.object({ channel: z.literal("slack"), account_ref: AccountRef, channel_id: z.string().regex(/^[CDG][A-Z0-9]{8,14}$/), thread_ts: z.string().regex(/^\d{10}\.\d{6}$/), limit: z.number().int().min(1).max(50).optional() }).strict();
export const ListUsersSchema = z.object({ channel: z.literal("slack"), account_ref: AccountRef, limit: z.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(300).optional() }).strict();
export const GetMessageSchema = z.object({ channel: z.literal("discord"), account_ref: AccountRef, channel_id: z.string().regex(/^\d{17,20}$/), message_id: z.string().regex(/^\d{17,20}$/) }).strict();
export const ListTemplatesSchema = z.object({ channel: z.literal("whatsapp"), account_ref: AccountRef, waba_id: z.string().regex(/^\d{5,20}$/), limit: z.number().int().min(1).max(100).optional() }).strict();
export const ReadMessageSchema = z.object({ channel: z.literal("sms"), account_ref: AccountRef, message_sid: z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/) }).strict();

/** Møtetranskripsjon (P2g): strenge former; selve teksten behandles i minnet og lagres aldri. `attest_legal_basis` MÅ være `true` (eierens eksplisitte attest, D-122). */
export const MeetingIngestTextSchema = z.object({
  format: z.enum(["txt", "vtt", "srt", "json"]), text: z.string().min(1).max(MEETING_TEXT_MAX_CHARS), title: z.string().min(1).max(200).optional(),
  attest_legal_basis: z.literal(true), legal_basis_note: z.string().min(1).max(300).optional()
}).strict();
export const MeetingListSchema = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict();
export const MeetingRefSchema = z.object({ meeting_id: z.string().min(8).max(80) }).strict();
export const MeetingCommitmentsSchema = z.object({ meeting_id: z.string().min(8).max(80).optional(), status: z.enum(["proposed", "accepted", "dismissed"]).optional(), limit: z.number().int().min(1).max(200).optional() }).strict();
export const MeetingDecideSchema = z.object({ commitment_id: z.string().min(8).max(80), decision: z.enum(["accept", "dismiss"]), due_at: z.string().datetime().optional() }).strict();
export const MeetingConfirmSchema = z.object({ meeting_id: z.string().min(8).max(80), participant_ref: z.string().min(1).max(80), identity_id: z.string().min(8).max(100) }).strict();

/** Conversation Graph-flaten kontakt-verktøyene trenger (lenking, oppløsning og reversibel unlink/restore). */
export type ContactsGraph = Pick<ConversationGraphService, "linkExclusiveIdentifiers" | "revokeLinksBySource" | "restoreLinksBySource">;

export class CommsTransport implements ToolTransport {
  constructor(private readonly deps: { funnel: OutboundFunnel; store: CommsStore; reads?: VendorReads; contacts?: { api: GoogleContacts; graph: ContactsGraph }; meetings?: MeetingService }) {}

  /** Leverandør-lesing går KUN mot en konto eieren har autorisert, og kun når kontoens leverandør faktisk er den handlingen gjelder (aldri en Telnyx-nøkkel mot Twilio-API-et). */
  private async requireAccount(ctx: FunnelContext, channel: "slack" | "discord" | "whatsapp" | "sms", accountRef: string, provider: CommsProvider): Promise<void> {
    const account = await this.deps.store.findActiveAccount(ctx.tenantId, ctx.space, channel, accountRef);
    if (account === null) throw new Error("comms_account_not_authorized");
    if (account.provider !== provider) throw new Error("comms_read_not_supported_by_provider");
  }

  private contacts(): { api: GoogleContacts; graph: ContactsGraph } {
    if (this.deps.contacts === undefined) throw new Error("comms_contacts_not_enabled");
    return this.deps.contacts;
  }

  /**
   * Lenker en kontakt til en identitet i Conversation Graph (P2e): eksakt E.164/e-post, `match_method: contact_sync`, confidence 0.9, proveniens (kilde + Google-ressursnavn).
   *
   * FIKS B-H1: kontakten lenkes KUN når (a) alle identifikatorene er nye, eller (b) alle eksisterende treff peker på ÉN identitet som ingen ANNEN kontakt (annen ressursnavn i `external_id`) allerede har lenket seg til. Ellers HOPPES
   * kontakten OVER (`conflict_with`): å feste en annen persons identifikatorer til en fremmed identitet (delt sentralbord-/fasttelefon eller delt e-post) er en stille sammenslåing av to personer, som verken kan oppdages eller angres
   * uten reversibel unlink. Eieren løser en konflikt eksplisitt (merge/split i Conversation Graph, eller `contacts_unlink`).
   *
   * FIKS B-H1 rest (delta-review B): oppløsning, eierkontroll og skriving skjer ATOMISK i grafen (`linkExclusiveIdentifiers`: én transaksjon bak en advisory-lås per tenant og rom). Før lå de utenfor skrivingen og uten lås: to
   * samtidige `contacts_sync` (to sider, en delt telefon) kryss-lenket i 7 av 8 forsøk. Returnerer antall lenkede identifikatorer.
   */
  private async linkContact(ctx: FunnelContext, view: ContactView): Promise<{ linked: number; conflict_with: string[] | null }> {
    const { graph } = this.contacts();
    const identifiers: Array<{ channel: "phone" | "email"; identifier: string }> = [
      ...view.phones.map((identifier) => ({ channel: "phone" as const, identifier })), ...view.emails.map((identifier) => ({ channel: "email" as const, identifier }))
    ];
    const result = await graph.linkExclusiveIdentifiers(ctx.tenantId, ctx.space, {
      identifiers, source: { source_type: CONTACTS_LINK_SOURCE, external_id: view.resource_name }, confidence: 0.9, match_method: "contact_sync", created_by_person_id: ctx.actor.person_id,
      ...(view.display_name !== null ? { display_name: view.display_name } : {})
    });
    return result.status === "linked" ? { linked: result.linked, conflict_with: null } : { linked: 0, conflict_with: result.with };
  }

  private meetings(): MeetingService {
    if (this.deps.meetings === undefined) throw new Error("comms_meetings_not_enabled");
    return this.deps.meetings;
  }

  private reads(): VendorReads {
    if (this.deps.reads === undefined) throw new Error("comms_vendor_reads_not_enabled");
    return this.deps.reads;
  }

  private ctxOf(context: ToolInvocationContext): FunnelContext {
    const identity = context?.identity;
    if (!identity) throw new Error("comms_missing_invocation_context");
    const space = identity.memory_space_id as MemorySpace;
    if (!ALLOWED_SPACES.includes(space)) throw new Error("comms_space_not_allowed");
    return {
      tenantId: identity.tenant_id, space,
      actor: { person_id: identity.person_id, session_id: identity.session_id, ...(context.task_id !== undefined ? { task_id: context.task_id } : {}) },
      source: "tool"
    };
  }

  private parsed(result: ParseResult) {
    if (!result.ok) throw new Error(`comms_invalid_parameters:${result.code}`.slice(0, 80));
    return result.value;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string, context: ToolInvocationContext): Promise<{ external_id?: string; data?: JsonValue }> {
    const ctx = this.ctxOf(context);
    const { funnel, store } = this.deps;
    switch (action) {
      // Tørrkjøring OG ToolGateway-preflight: ren lesing av tilstand + policy. Returnerer ALLTID en evaluering (også ved avslag) - validatoren i verktøydefinisjonen avgjør.
      case "evaluate_send":
        return { data: funnel.summarize(await funnel.evaluate(ctx, this.parsed(parseSendParams(parameters)))) };
      case "send": {
        const r = await funnel.send(ctx, this.parsed(parseSendParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      case "edit_message": {
        const r = await funnel.execute(ctx, this.parsed(parseEditParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      case "add_reaction": {
        const r = await funnel.execute(ctx, this.parsed(parseReactParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      // `check_message_target` = fersk lesing for sletting (preflight OG readback). `data: null` = meldingen finnes ikke (etterbetingelsen for sletting).
      // A-M6: med `text` er det preflighten for en REDIGERING (policyen for redigeringen vurderes mot den nye teksten); uten er det sletting. Begge leser målet ferskt hos leverandøren.
      case "check_message_target":
        return { data: await funnel.checkTarget(ctx, this.parsed(parameters["text"] !== undefined ? parseEditParams(parameters) : parseDeleteParams(parameters)), credential) };
      case "delete_message": {
        const r = await funnel.execute(ctx, this.parsed(parseDeleteParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      // Utgående samtale (P3h): tørrkjøring = ToolGateway-preflight, start = klasse D. Samme trakt som sending (`kind: "call"`): policy -> journal -> adapter (Twilio med inline TwiML).
      case "evaluate_call":
        return { data: funnel.summarize(await funnel.evaluate(ctx, this.parsed(parseCallParams(parameters)))) };
      case "start_call": {
        const r = await funnel.execute(ctx, this.parsed(parseCallParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      // Møtetranskripsjon (P2g): tekst inn -> hash, deltakere, FORESLÅTTE forpliktelser. Ingen transkripsjonstekst lagres; ingen modell; eieren godtar hver forpliktelse for seg.
      case "meeting_ingest_text": {
        const r = await this.meetings().ingestText(ctx, MeetingIngestTextSchema.parse(parameters));
        return { external_id: r.meeting_id, data: r as unknown as JsonValue };
      }
      case "meeting_list":
        return { data: { meetings: await this.meetings().list(ctx, MeetingListSchema.parse(parameters).limit) } as unknown as JsonValue };
      // Preflight/readback for sletting (B-M3): KUN `{exists, meeting_id}` - aldri tittel/deltakere, som ellers havner i ledger og audit. `null` = finnes ikke (etterbetingelsen).
      case "meeting_check_target": {
        const meetingId = MeetingRefSchema.parse(parameters).meeting_id;
        return { data: (await this.meetings().exists(ctx, meetingId)) ? { exists: true, meeting_id: meetingId } : null };
      }
      // Egen lesehandling for det FULLE møtet (tittel, deltakere): ubetrodd data, kun for eieren.
      case "meeting_get":
        return { data: await this.meetings().get(ctx, MeetingRefSchema.parse(parameters).meeting_id) };
      case "meeting_commitments": {
        const p = MeetingCommitmentsSchema.parse(parameters);
        return { data: { commitments: await this.meetings().commitments(ctx, p) } as unknown as JsonValue };
      }
      case "meeting_decide_commitment":
        return { data: (await this.meetings().decide(ctx, MeetingDecideSchema.parse(parameters))) as unknown as JsonValue };
      case "meeting_confirm_participant":
        return { data: (await this.meetings().confirmParticipant(ctx, MeetingConfirmSchema.parse(parameters))) as unknown as JsonValue };
      case "meeting_delete": {
        const p = MeetingRefSchema.parse(parameters);
        const r = await this.meetings().deleteMeeting(ctx, p.meeting_id);
        return { external_id: p.meeting_id, data: r };
      }
      // Google Contacts (P2e): full kapabilitet for eieren. Lesing er ubetrodd data; skriving er klasse C/D (se tools.ts); `contacts_sync` lenker kontakter til identiteter.
      case "contacts_list": {
        const p = ContactsListSchema.parse(parameters);
        return { data: (await this.contacts().api.list(credential, p.page_size ?? 50, p.page_token)) as unknown as JsonValue };
      }
      case "contacts_search": {
        const p = ContactsSearchSchema.parse(parameters);
        return { data: { contacts: await this.contacts().api.search(credential, p.query, p.page_size ?? 10) } as unknown as JsonValue };
      }
      case "contacts_get": {
        const p = ContactsGetSchema.parse(parameters);
        return { data: { contact: await this.contacts().api.get(credential, p.resource_name) } as unknown as JsonValue };
      }
      // Fersk lesing for sletting (preflight OG readback): `null` = finnes ikke.
      case "contacts_check_target": {
        const p = ContactsGetSchema.parse(parameters);
        const view = await this.contacts().api.get(credential, p.resource_name);
        return { data: view === null ? null : { exists: true, resource_name: view.resource_name, etag: view.etag } };
      }
      case "contacts_create": {
        const view = await this.contacts().api.create(credential, ContactsCreateSchema.parse(parameters));
        return { external_id: view.resource_name, data: { contact: view } as unknown as JsonValue };
      }
      case "contacts_update": {
        const view = await this.contacts().api.update(credential, ContactsUpdateSchema.parse(parameters));
        return { external_id: view.resource_name, data: { contact: view } as unknown as JsonValue };
      }
      case "contacts_delete": {
        const p = ContactsDeleteSchema.parse(parameters);
        await this.contacts().api.delete(credential, p.resource_name);
        return { external_id: p.resource_name, data: { deleted: true } };
      }
      case "contacts_sync": {
        const p = ContactsSyncSchema.parse(parameters);
        const page = await this.contacts().api.list(credential, p.page_size ?? 50, p.page_token);
        let linked = 0;
        let withoutIdentifier = 0;
        let failed = 0;
        const conflicts: Array<{ resource_name: string; with: string[] }> = [];
        let conflictCount = 0;
        for (const view of page.contacts) {
          if (view.phones.length === 0 && view.emails.length === 0) { withoutIdentifier += 1; continue; }
          try {
            const outcome = await this.linkContact(ctx, view);
            if (outcome.conflict_with !== null) {
              conflictCount += 1;
              if (conflicts.length < 20) conflicts.push({ resource_name: view.resource_name, with: outcome.conflict_with.slice(0, 5) });
              continue;
            }
            linked += outcome.linked;
          } catch {
            failed += 1; // aldri feilteksten (kan sitere identifikatoren)
          }
        }
        // Konflikter rapporteres med ressursnavn (ugjennomsiktige id-er, aldri telefon/e-post): eieren løser dem eksplisitt. UTEN lagret forslag (DEFERRED): neste synk finner dem på nytt.
        return {
          data: { scanned: page.contacts.length, linked_identifiers: linked, contacts_without_identifier: withoutIdentifier, contacts_failed: failed, contacts_conflict: conflictCount, conflicts, next_page_token: page.next_page_token }
        };
      }
      // B-H1: reversibel unlink (tilbakekall) av lenkene en kontakt har satt, og angre (`restore`). Sletter aldri en rad/identitet; rører ingenting hos Google.
      case "contacts_unlink": {
        const p = ContactsUnlinkSchema.parse(parameters);
        const source = { source_type: CONTACTS_LINK_SOURCE, external_id: p.resource_name };
        const { graph } = this.contacts();
        if (p.restore === true) {
          const r = await graph.restoreLinksBySource(ctx.tenantId, ctx.space, source);
          return { external_id: p.resource_name, data: { restored: r.restored.length, skipped: r.skipped } };
        }
        return { external_id: p.resource_name, data: { revoked: (await graph.revokeLinksBySource(ctx.tenantId, ctx.space, source)).length } };
      }
      // Leverandør-lesing (P1c): rene lesinger, ubetrodd data, ingen journal.
      case "read_thread": {
        const p = ReadThreadSchema.parse(parameters);
        await this.requireAccount(ctx, "slack", p.account_ref, "slack");
        return { data: { messages: await this.reads().slackThread(credential, p.channel_id, p.thread_ts, p.limit ?? 20) } as unknown as JsonValue };
      }
      case "list_users": {
        const p = ListUsersSchema.parse(parameters);
        await this.requireAccount(ctx, "slack", p.account_ref, "slack");
        return { data: (await this.reads().slackUsers(credential, p.limit ?? 50, p.cursor)) as unknown as JsonValue };
      }
      case "get_message": {
        const p = GetMessageSchema.parse(parameters);
        await this.requireAccount(ctx, "discord", p.account_ref, "discord");
        return { data: { message: await this.reads().discordMessage(credential, p.channel_id, p.message_id) } as unknown as JsonValue };
      }
      case "list_templates": {
        const p = ListTemplatesSchema.parse(parameters);
        await this.requireAccount(ctx, "whatsapp", p.account_ref, "meta_whatsapp");
        return { data: { templates: await this.reads().whatsappTemplates(credential, p.waba_id, p.limit ?? 50) } as unknown as JsonValue };
      }
      case "read_message": {
        const p = ReadMessageSchema.parse(parameters);
        await this.requireAccount(ctx, "sms", p.account_ref, "twilio");
        return { data: (await this.reads().twilioMessage(credential, p.message_sid)) as unknown as JsonValue };
      }
      case "list_inbound": {
        const p = ListInbound.parse(parameters);
        const rows = await store.listInbound(ctx.tenantId, ctx.space, { ...(p.channel !== undefined ? { channel: p.channel } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) });
        return { data: rows as unknown as JsonValue };
      }
      case "list_outbound": {
        const p = ListOutbound.parse(parameters);
        const rows = await store.listJournal(ctx.tenantId, ctx.space, { ...(p.status !== undefined ? { status: p.status } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) });
        return { data: rows as unknown as JsonValue };
      }
      case "list_opt_outs": {
        const p = ListOptOuts.parse(parameters);
        return { data: (await store.listOptOuts(ctx.tenantId, ctx.space, p.limit)) as unknown as JsonValue };
      }
      case "list_accounts":
        z.object({}).strict().parse(parameters);
        return { data: (await store.listAccounts(ctx.tenantId, ctx.space)) as unknown as JsonValue };
      case "authorize_account": {
        const p = Authorize.parse(parameters);
        if (!(PROVIDERS_FOR_CHANNEL[p.channel] as readonly CommsProvider[]).includes(p.provider)) throw new Error("comms_provider_not_valid_for_channel");
        const r = await store.authorizeAccount(ctx.tenantId, ctx.space, { channel: p.channel, account_ref: p.account_ref, provider: p.provider, ...(p.display_name !== undefined ? { display_name: p.display_name } : {}), source: "tool" }, ctx.actor);
        return { external_id: r.account.account_id, data: { account: r.account, created: r.created } as unknown as JsonValue };
      }
      case "revoke_account": {
        const p = Revoke.parse(parameters);
        return { data: { revoked: await store.revokeAccount(ctx.tenantId, ctx.space, p.account_id) } };
      }
      case "record_opt_out": {
        const p = RecordOptOutSchema.parse(parameters);
        if (p.account_ref !== undefined && p.account_ref !== "*" && !isValidAccountRef(p.channel, p.account_ref)) throw new Error("comms_invalid_parameters:account_ref_invalid");
        const normalized = normalizeRecipient(p.channel, p.recipient);
        if (!normalized.ok) throw new Error(`comms_invalid_parameters:${normalized.code}`);
        // Tenant-bred (A-M3): gjelder alle våre kontoer, alle rom og alle kanaler som deler identifikator (telefon = SMS + WhatsApp + samtale), uansett hvilken `account_ref` som ble oppgitt.
        const r = await store.recordOptOut(ctx.tenantId, ctx.space, {
          channel: p.channel, recipient_hash: optOutHash(ctx.tenantId, p.channel, normalized.value), recipient_hint: recipientHint(p.channel, normalized.value),
          source: p.source ?? "owner_recorded", recorded_by: ctx.actor.person_id, session_id: ctx.actor.session_id, ...(ctx.actor.task_id !== undefined ? { task_id: ctx.actor.task_id } : {})
        });
        return { external_id: r.opt_out_id, data: { opt_out_id: r.opt_out_id, created: r.created, scope: "tenant" } };
      }
      // K5: fersk, MINIMAL lesing av en AKTIV avmelding (preflight og readback for `lift_owner_opt_out`). `data: null` = finnes ikke eller er allerede opphevet (etterbetingelsen).
      case "check_opt_out_target": {
        const p = LiftOwnerOptOutSchema.parse(parameters);
        if (validateLiftReason(p.reason) === null) throw new Error("comms_invalid_parameters:lift_reason_invalid");
        return { data: (await store.findOptOutTarget(ctx.tenantId, p.opt_out_id)) as unknown as JsonValue };
      }
      // K5: eierens angre. Kun en `owner_recorded`-rad (store + databasetrigger); begrunnelse og hvem/sesjon lagres på raden; opphever kun DEN raden (mottakeren kan fortsatt være avmeldt via en annen aktiv rad).
      case "lift_owner_opt_out": {
        const p = LiftOwnerOptOutSchema.parse(parameters);
        const r = await store.liftOwnerOptOut(ctx.tenantId, p, ctx.actor);
        return { external_id: p.opt_out_id, data: { opt_out_id: p.opt_out_id, lifted: r.lifted, channel: r.channel, recipient_hint: r.recipient_hint, still_opted_out: r.still_opted_out } };
      }
      default:
        throw new Error(`comms_action_not_implemented:${action}`);
    }
  }
}
