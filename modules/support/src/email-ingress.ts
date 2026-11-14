import { randomUUID } from "node:crypto";
import { correlationFields, type IdentityContext, type JsonValue, type MemorySpace, type RunCorrelation } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { extractCounterpartEmails, extractEmailAddress, type BusinessService } from "@jarvis/business";
import type { SupportService } from "./service.ts";
import type { EntityResolutionState, SupportTicket, SupportTicketEvent } from "./types.ts";

/**
 * UA-3 Native Support Core (D-66) §7: Gmail-ingress via den EKSISTERENDE
 * `GmailTransport` (ToolGateway) - INGEN egen Gmail-klient bygges her.
 * Provider-nøytralt konsept (§6): Gmail-melding -> normalisert
 * `IngestMessageInput` -> `SupportService.ingestMessage()`. Deterministisk
 * routing (§7): en melding blir KUN en ticket hvis den (a) er adressert til
 * en KONFIGURERT support-innboks-adresse, ELLER (b) hoerer til en tråd som
 * ALLEREDE er en ticket - AI er ALDRI eneste port.
 */

export interface GmailIngressStats {
  scanned: number;
  ingested: number;
  ignored_not_support: number;
  unmatched: number;
  ambiguous: number;
  error?: string;
}

interface GmailMessage {
  id?: string;
  thread?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  at?: string;
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 120);
}

export class SupportEmailService {
  constructor(
    private readonly gateway: ToolGateway,
    private readonly business: BusinessService,
    private readonly support: SupportService,
    // D-340: JARVIS_GOOGLE_ACCOUNT="" (tom, men til stede i .env) skal falle til defaulten - se D-340 i DECISIONS_AND_ASSUMPTIONS.md.
    private readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] || "post@tsworkflow.com",
    private readonly supportInboxEmails: string[] = (process.env["JARVIS_SUPPORT_INBOX_EMAILS"] ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  ) {}

  /**
   * §9 i byggeordren: EKSAKT samme MATCHED/UNMATCHED/AMBIGUOUS-mønster som
   * `BusinessEventSyncService` (D-57) - gjenbruker `findContactsByEmail`
   * direkte, ALDRI en egen/duplisert entitetsresolver.
   */
  private async resolveEntity(
    tenantId: string,
    memorySpace: MemorySpace,
    candidateEmails: string[]
  ): Promise<{ state: EntityResolutionState; contact_id: string | null; company_id: string | null }> {
    let firstMatch: { contact_id: string; company_id: string | null } | null = null;
    const distinctCompanyIds = new Set<string | null>();
    for (const email of candidateEmails) {
      const contacts = await this.business.findContactsByEmail(tenantId, memorySpace, email);
      if (contacts.length > 1) return { state: "ambiguous", contact_id: null, company_id: null };
      if (contacts.length === 1) {
        const contact = contacts[0]!;
        firstMatch ??= { contact_id: contact.contact_id, company_id: contact.company_id };
        distinctCompanyIds.add(contact.company_id);
      }
    }
    if (!firstMatch) return { state: "unmatched", contact_id: null, company_id: null };
    if (distinctCompanyIds.size > 1) return { state: "ambiguous", contact_id: null, company_id: null };
    return { state: "matched", contact_id: firstMatch.contact_id, company_id: firstMatch.company_id };
  }

  private isSupportMessage(message: GmailMessage): boolean {
    if (this.supportInboxEmails.length === 0) return false;
    const addresses = [message.to, message.cc]
      .filter((h): h is string => Boolean(h))
      .flatMap((h) => h.split(","))
      .map(extractEmailAddress)
      .filter((a): a is string => a !== null);
    return addresses.some((a) => this.supportInboxEmails.includes(a));
  }

  /**
   * §7/§8: leser Gmail via ToolGateway (SAMME trusted vei som daily brief/
   * business-event-sync), normaliserer og delegerer til `ingestMessage()`.
   * Ikke-support-e-post (§7: "not every arbitrary email becomes a support
   * ticket") ignoreres deterministisk - INGEN ticket opprettes.
   */
  async ingestFromGmail(
    tenantId: string,
    memorySpace: MemorySpace,
    identity: IdentityContext,
    opts: { max?: number; query?: string; correlation?: Partial<RunCorrelation> } = {}
  ): Promise<GmailIngressStats> {
    const stats: GmailIngressStats = { scanned: 0, ingested: 0, ignored_not_support: 0, unmatched: 0, ambiguous: 0 };
    const result = await this.gateway.execute({
      identity, tool_id: "email", action: "list_messages",
      parameters: { max: opts.max ?? 25, ...(opts.query ? { query: opts.query } : {}) },
      // WP-K (JARVIS-054): `person_id: "system"`-kallet bærer jobb-/spor-ID videre til revisjon og policy-journal (tom når kallet ikke kommer fra en planlagt kjøring).
      ...correlationFields(opts.correlation)
    });
    if (!result.ok) throw new Error(result.reason);
    const messages = ((result.data as { messages?: JsonValue[] } | undefined)?.messages ?? []) as GmailMessage[];
    for (const message of messages) {
      stats.scanned++;
      if (!message.id || !message.thread) continue;
      const alreadyTicket = await this.support.hasTicketForThread(tenantId, memorySpace, "gmail", this.accountEmail, message.thread);
      if (!alreadyTicket && !this.isSupportMessage(message)) {
        stats.ignored_not_support++;
        continue;
      }
      const counterparts = extractCounterpartEmails(message, this.accountEmail);
      const resolution = await this.resolveEntity(tenantId, memorySpace, counterparts);
      if (resolution.state === "ambiguous") stats.ambiguous++;
      if (resolution.state === "unmatched") stats.unmatched++;
      const fromAddress = extractEmailAddress(message.from);
      const isFromCustomer = fromAddress !== null && fromAddress !== this.accountEmail.trim().toLowerCase();
      await this.support.ingestMessage(tenantId, memorySpace, {
        channel: "email", source_type: "gmail", source_instance_id: this.accountEmail,
        source_thread_id: message.thread, source_message_id: message.id,
        canonical_uri: `https://mail.google.com/mail/u/0/#all/${message.id}`,
        subject: message.subject || "(uten emne)", summary: `E-post: ${message.subject || "(uten emne)"}`,
        is_from_customer: isFromCustomer,
        ...(resolution.company_id !== null ? { company_id: resolution.company_id } : {}),
        ...(resolution.contact_id !== null ? { contact_id: resolution.contact_id } : {}),
        entity_resolution: resolution.state,
        ...(message.at !== undefined ? { occurred_at: message.at } : {})
      });
      stats.ingested++;
    }
    return stats;
  }

  /**
   * §16 i byggeordren: kunde-svar går GJENNOM `ToolGateway`/Policy Gateway
   * (`tool_id:"email", action:"send"`, allerede klasse D med signert
   * godkjenning - SAMME policy som ALL annen utgående e-post, ingen ny
   * unntaksvei innføres her). INGEN SMTP implementeres. Idempotent (§16:
   * "use idempotency") via kallerens `idempotency_key`, gjenbruker den
   * SAMME `ingestMessage()`-mekanismen som ingress (§8) for å registrere
   * svaret som ETT ticket-event, uansett om selve utsendelsen lyktes eller
   * feilet (evidens bevares alltid - aldri stille tapt ved en send-feil).
   */
  async reply(
    tenantId: string,
    memorySpace: MemorySpace,
    identity: IdentityContext,
    ticketId: string,
    input: { to: string; subject: string; body: string; idempotency_key: string },
    approval?: unknown
  ): Promise<{ sent: boolean; error?: string; ticket: SupportTicket | null; event: SupportTicketEvent }> {
    const ticket = await this.support.getTicket(tenantId, memorySpace, ticketId);
    if (!ticket) throw new Error("support_ticket_not_found");
    // D-396 (JARVIS-046): idempotent svar - er et VELLYKKET `reply:<idempotency_key>` allerede registrert, sendes INTET på nytt (gateway kalles
    // ikke). Mislykkede forsøk lagres under en unik nøkkel (`reply-failed:...`) slik at samme idempotency_key kan prøves på nytt etter en feil.
    const replySourceInstance = ticket.source_instance_id ?? this.accountEmail;
    const prior = await this.support.findEventBySourceMessage(
      tenantId, memorySpace, ticket.source_type, replySourceInstance, `reply:${input.idempotency_key}`
    );
    if (prior) return { sent: true, ticket: await this.support.getTicket(tenantId, memorySpace, ticketId), event: prior };
    let sent = false;
    let error: string | undefined;
    try {
      // SECURITY FIX #2 (D-68): `identity` er nå DEN OPPRINNELIGE kalleren sin
      // EKTE identitet (aldri fabrikkert) - `email.send` (klasse D) evaluerer
      // derfor den REELLE authority-modusen. En eier forblir sovereign uendret;
      // en delegat forblir delegat og MÅ ha en gyldig `approval` for NETTOPP
      // denne `send`-handlingen (samme godkjenning som ev. fulgte med selve
      // `support.reply`-kallet - IKKE en ny/parallell godkjenningsmekanisme).
      const result = await this.gateway.execute({
        identity, tool_id: "email", action: "send",
        parameters: { to: input.to, subject: input.subject, body: input.body },
        ...(approval !== undefined ? { approval } : {})
      });
      sent = result.ok;
      if (!result.ok) error = result.reason;
    } catch (err) {
      error = sanitizeError(err);
    }
    const ingestResult = await this.support.ingestMessage(tenantId, memorySpace, {
      channel: ticket.channel, source_type: ticket.source_type,
      source_instance_id: ticket.source_instance_id ?? this.accountEmail,
      source_thread_id: ticket.source_thread_id ?? ticket.ticket_id,
      source_message_id: sent ? `reply:${input.idempotency_key}` : `reply-failed:${input.idempotency_key}:${randomUUID()}`,
      subject: ticket.subject, summary: sent ? `Svar sendt til ${input.to}` : `Svar-forsoek feilet: ${error ?? "ukjent feil"}`,
      is_from_customer: false, entity_resolution: ticket.entity_resolution,
      ...(sent ? {} : { outbound_outcome: "failed_send" as const }),
      ...(ticket.company_id !== null ? { company_id: ticket.company_id } : {}),
      ...(ticket.contact_id !== null ? { contact_id: ticket.contact_id } : {})
    });
    return { sent, ...(error !== undefined ? { error } : {}), ticket: ingestResult.ticket, event: ingestResult.event };
  }
}
