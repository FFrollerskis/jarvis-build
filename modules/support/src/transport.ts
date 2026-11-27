import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolGateway, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { BusinessService } from "@jarvis/business";
import type { SupportService } from "./service.ts";
import { SupportEmailService } from "./email-ingress.ts";
import type { TicketPriority, TicketStatus } from "./types.ts";

/**
 * UA-3 Native Support Core (D-66) §19: provider-nøytralt `support.*`-
 * namespace. Samme arkitektur-begrensning som `BusinessTransport` (D-49) for
 * de fleste handlinger: `tenant_id`/`memory_space` MÅ komme via de zod-
 * validerte `parameters`, bygget av TRUSTED kallerlag. `reply` er unntaket
 * som TRENGER en ekte `IdentityContext` (for å kalle `email.send` via
 * `ToolGateway`/Policy Gateway igjen) - SECURITY FIX #2 (D-68): løst ved å
 * VIDEREFORMIDLE `ToolInvocationContext.identity` (DEN OPPRINNELIGE kalleren
 * sin EKTE identitet, gitt av `ToolGateway.execute()` selv) UENDRET til det
 * nøstede kallet - ALDRI ved å fabrikkere/eskalere en "system"- eller
 * eier-identitet lokalt (HOST FIX #1 sin `JARVIS_OWNER_PERSON_ID`-
 * konstruksjon var en reell rettighetseskalering: enhver kaller med et
 * gyldig `support.reply`-mandat ville fått `email.send` UBETINGET utført
 * MED eier-authority, uansett hvem den faktiske kalleren var - fjernet).
 * `emailService` bygges LAT (samme mønster som
 * `BusinessTransport.requireEventSync()`) - `business`/`gateway` er
 * valgfrie kun for tester som ikke trenger `reply`/`ingest_message`.
 */
export class SupportTransport implements ToolTransport {
  private emailService?: SupportEmailService;

  constructor(
    private readonly service: SupportService,
    private readonly business?: BusinessService,
    private readonly gateway?: ToolGateway
  ) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

    switch (action) {
      case "create_ticket": {
        const row = await this.service.createTicket(tenantId, memorySpace, {
          subject: requireString(parameters, "subject"),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["priority"] !== undefined ? { priority: parameters["priority"] as TicketPriority } : {}),
          ...(parameters["assignee_person_id"] !== undefined ? { assignee_person_id: String(parameters["assignee_person_id"]) } : {})
        });
        return { external_id: row.ticket_id, data: row as unknown as JsonValue };
      }
      case "get_ticket": {
        const row = await this.service.getTicket(tenantId, memorySpace, requireString(parameters, "ticket_id"));
        return { ...(row ? { external_id: row.ticket_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_tickets": {
        const status = (parameters["status"] !== undefined ? String(parameters["status"]) : "open") as TicketStatus | "all";
        const rows = await this.service.listTickets(tenantId, memorySpace, status);
        return { data: rows as unknown as JsonValue };
      }
      case "search_tickets": {
        const rows = await this.service.searchTickets(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as TicketStatus } : {}),
          ...(parameters["priority"] !== undefined ? { priority: parameters["priority"] as TicketPriority } : {}),
          ...(parameters["assignee_person_id"] !== undefined ? { assignee_person_id: String(parameters["assignee_person_id"]) } : {}),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {}),
          ...(parameters["subject_contains"] !== undefined ? { subject_contains: String(parameters["subject_contains"]) } : {}),
          ...(parameters["ticket_number"] !== undefined ? { ticket_number: Number(parameters["ticket_number"]) } : {}),
          ...(parameters["limit"] !== undefined ? { limit: Number(parameters["limit"]) } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "update_ticket": {
        let row = await this.service.getTicket(tenantId, memorySpace, requireString(parameters, "ticket_id"));
        if (row && parameters["status"] !== undefined) {
          row = await this.service.setStatus(tenantId, memorySpace, row.ticket_id, parameters["status"] as TicketStatus, actorId(parameters));
        }
        if (row && parameters["priority"] !== undefined) {
          row = await this.service.setPriority(tenantId, memorySpace, row.ticket_id, parameters["priority"] as TicketPriority, actorId(parameters));
        }
        return { ...(row ? { external_id: row.ticket_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_status": {
        const row = await this.service.setStatus(
          tenantId, memorySpace, requireString(parameters, "ticket_id"), requireString(parameters, "status") as TicketStatus, actorId(parameters)
        );
        return { ...(row ? { external_id: row.ticket_id } : {}), data: row as unknown as JsonValue };
      }
      case "set_priority": {
        const row = await this.service.setPriority(
          tenantId, memorySpace, requireString(parameters, "ticket_id"), requireString(parameters, "priority") as TicketPriority, actorId(parameters)
        );
        return { ...(row ? { external_id: row.ticket_id } : {}), data: row as unknown as JsonValue };
      }
      case "assign_ticket": {
        const assignee = parameters["assignee_person_id"] !== undefined ? String(parameters["assignee_person_id"]) : null;
        const row = await this.service.assignTicket(tenantId, memorySpace, requireString(parameters, "ticket_id"), assignee, actorId(parameters));
        return { ...(row ? { external_id: row.ticket_id } : {}), data: row as unknown as JsonValue };
      }
      case "add_internal_note": {
        const event = await this.service.addInternalNote(
          tenantId, memorySpace, requireString(parameters, "ticket_id"), requireString(parameters, "note"), actorId(parameters)
        );
        return { external_id: event.event_id, data: event as unknown as JsonValue };
      }
      case "list_events": {
        const rows = await this.service.listEvents(tenantId, memorySpace, requireString(parameters, "ticket_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "reply": {
        // SECURITY FIX #2 (D-68): `context.identity` er DEN OPPRINNELIGE
        // kalleren sin EKTE identitet, gitt av `ToolGateway.execute()` selv
        // (§ security fix #2 i byggeordren) - ALDRI en fabrikkert "system"-
        // eller eier-identitet (HOST FIX #1 sin `JARVIS_OWNER_PERSON_ID`-
        // konstruksjon ga UBETINGET eier-authority til `email.send` for
        // ENHVER kaller med et gyldig `support.reply`-mandat - en reell
        // rettighetseskalering, fjernet). `resolveAuthorityMode()` evaluerer
        // nå den REELLE identiteten: en eier forblir sovereign uendret; en
        // delegat forblir delegat og MÅ selv levere en gyldig signert
        // godkjenning for `email.send` (klasse D) - `context.approval`
        // videreformidles UENDRET, ALDRI en ny/parallell godkjenningsvei.
        const result = await this.requireEmailService().reply(
          tenantId, memorySpace, context.identity, requireString(parameters, "ticket_id"),
          {
            to: requireString(parameters, "to"), subject: requireString(parameters, "subject"), body: requireString(parameters, "body"),
            idempotency_key: requireString(parameters, "idempotency_key")
          },
          context.approval
        );
        // D-396 (JARVIS-046): et svar som IKKE ble sendt er en FEIL for kalleren (evidens er allerede lagret som internal_note) - aldri ok med ekstern id.
        if (!result.sent) throw new Error(`support_reply_not_sent: ${result.error ?? "ukjent feil"}`);
        return { external_id: result.event.event_id, data: result as unknown as JsonValue };
      }
      case "ingest_message": {
        // WP-P3 K3: `ticket_id` (internt felt på `IngestMessageInput`) leses BEVISST ikke fra `parameters` - modellflaten kan aldri flytte en melding til et vilkårlig ticket (test: wpp3-104-manual-ticket-reply).
        const result = await this.service.ingestMessage(tenantId, memorySpace, {
          channel: (parameters["channel"] !== undefined ? String(parameters["channel"]) : "email") as never,
          source_type: requireString(parameters, "source_type"),
          source_instance_id: requireString(parameters, "source_instance_id"),
          source_thread_id: requireString(parameters, "source_thread_id"),
          source_message_id: requireString(parameters, "source_message_id"),
          subject: requireString(parameters, "subject"),
          summary: requireString(parameters, "summary"),
          is_from_customer: Boolean(parameters["is_from_customer"]),
          entity_resolution: (parameters["entity_resolution"] !== undefined ? String(parameters["entity_resolution"]) : "unmatched") as never,
          ...(parameters["canonical_uri"] !== undefined ? { canonical_uri: String(parameters["canonical_uri"]) } : {}),
          ...(parameters["company_id"] !== undefined ? { company_id: String(parameters["company_id"]) } : {}),
          ...(parameters["contact_id"] !== undefined ? { contact_id: String(parameters["contact_id"]) } : {})
        });
        return { external_id: result.ticket.ticket_id, data: result as unknown as JsonValue };
      }
      default:
        throw new Error(`support_action_not_implemented:${action}`);
    }
  }

  private requireEmailService(): SupportEmailService {
    if (!this.business || !this.gateway) throw new Error("support_email_service_not_configured");
    this.emailService ??= new SupportEmailService(this.gateway, this.business, this.service);
    return this.emailService;
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`support_missing_parameter:${key}`);
  }
  return value;
}

function actorId(parameters: Record<string, JsonValue>): string | undefined {
  return parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;
}
