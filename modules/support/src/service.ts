import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { recordActivityInTransaction } from "@jarvis/business";
import { assertValidTicketTransition, isTerminalTicketStatus, reopenTargetStatus } from "./state-machine.ts";
import type {
  CreateTicketInput,
  IngestMessageInput,
  IngestMessageResult,
  SupportTicket,
  SupportTicketEvent,
  TicketPriority,
  TicketStatus
} from "./types.ts";

/**
 * Arkitekt-review MERGE BLOCKER (Q-33/D-130, PR #79): mirrors
 * `OperationsCrossScopeReferenceError` i `modules/operations/src/service.ts`
 * (D-129) - SAMME feilklasse/mønster, egen navngiving per domene. Postgres
 * sin FK-sjekk kjører med forhøyet privilegium og omgår RLS, saa en enkel FK
 * paa `company_id`/`contact_id` er ALDRI en tenant/space-autorisasjonsgrense
 * - se `assertCompanyContactInScope()` under.
 */
export class SupportCrossScopeReferenceError extends Error {
  constructor(
    public readonly field: string,
    public readonly id: string
  ) {
    super(`support_cross_scope_reference:${field}:${id}`);
    this.name = "SupportCrossScopeReferenceError";
  }
}

/** Kastes naar BÅDE company_id OG contact_id er oppgitt, men kontakten faktisk tilhoerer en ANNEN company. */
export class SupportContactCompanyMismatchError extends Error {
  constructor(
    public readonly contactId: string,
    public readonly companyId: string
  ) {
    super(`support_contact_company_mismatch:${contactId}:${companyId}`);
    this.name = "SupportContactCompanyMismatchError";
  }
}

export interface SearchTicketsFilter {
  status?: TicketStatus;
  priority?: TicketPriority;
  assignee_person_id?: string;
  company_id?: string;
  contact_id?: string;
  /** Fritekst-substring mot `subject` - deterministisk `ILIKE`, ingen semantisk søk (§26 i byggeordren). */
  subject_contains?: string;
  ticket_number?: number;
  limit?: number;
}

/**
 * UA-3 Native Support Core (D-66): kjerne-domenetjeneste for ticket-
 * lifecycle/events. Gjenbruker `withMemoryTransaction` (SAMME RLS-primitiv
 * som resten av Business OS) - ingen ny sikkerhetsmodell. Provider-nøytral:
 * ingen Gmail-spesifikk logikk her - se `email-ingress.ts` for normalisering.
 */
export class SupportService {
  /**
   * UA-3 AC1 (D-73/Q-25 fiks, oppdatert D-130): tidslinje-speilingen kaller
   * `recordActivityInTransaction()` DIREKTE med den allerede-åpne
   * `client`en fra egen `withMemoryTransaction` (se
   * `recordTicketTimelineActivity()` under) - `@jarvis/business` sin egen
   * `BusinessService`-klasse (med sin EGEN, frakoblede transaksjon) trengs
   * derfor ikke lenger konstrueres her. `@jarvis/business` forblir en
   * deklarert `package.json`-avhengighet av `@jarvis/support` (ingen
   * sirkulær avhengighet - `@jarvis/business` avhenger ALDRI av
   * `@jarvis/support`) - kun for `recordActivityInTransaction()`.
   */
  constructor(private readonly pool: pg.Pool) {}

  async createTicket(tenantId: string, memorySpace: MemorySpace, input: CreateTicketInput): Promise<SupportTicket> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // Q-33/D-130: verifiser FØR INSERT - et caller-oppgitt company_id/
      // contact_id fra en ANNEN tenant/space skal aldri kunne knyttes seg
      // til en ticket (Postgres sin FK-sjekk alene omgår RLS).
      await this.assertCompanyContactInScope(client, tenantId, memorySpace, input.company_id, input.contact_id);
      const ticket = await insertTicket(client, tenantId, memorySpace, input);
      await insertEvent(client, tenantId, memorySpace, {
        ticket_id: ticket.ticket_id,
        event_type: "ticket_created",
        summary: input.initial_summary ?? `Ticket opprettet: ${input.subject}`,
        actor_person_id: input.actor_person_id ?? null,
        source_type: input.source_type ?? null,
        source_instance_id: input.source_instance_id ?? null,
        source_message_id: input.source_message_id ?? null,
        canonical_uri: input.canonical_uri ?? null,
        metadata: {},
        occurred_at: input.occurred_at ?? null
      });
      // Arkitekt-review MERGE BLOCKER (D-130, PR #79): tidslinje-speilingen
      // skjer NAA INNE i SAMME transaksjon som selve ticket-raden (se
      // recordTicketTimelineActivity() sin kommentar under) - IKKE lenger et
      // eget, frakoblet post-commit-kall. Feiler business_activities-
      // skrivingen, ruller HELE transaksjonen (inkl. ticket-raden) tilbake.
      await this.recordTicketTimelineActivity(
        client, tenantId, memorySpace, ticket, "external_event",
        input.initial_summary ?? `Ticket opprettet: ${input.subject}`, "created", input.occurred_at ?? null
      );
      return ticket;
    });
  }

  async getTicket(tenantId: string, memorySpace: MemorySpace, ticketId: string): Promise<SupportTicket | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM support_tickets WHERE tenant_id = $1 AND ticket_id = $2`, [tenantId, ticketId]);
      return (rows[0] as SupportTicket) ?? null;
    });
  }

  async listTickets(tenantId: string, memorySpace: MemorySpace, status: TicketStatus | "all" = "open"): Promise<SupportTicket[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM support_tickets WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])
          : await client.query(`SELECT * FROM support_tickets WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC`, [tenantId, status]);
      return rows as SupportTicket[];
    });
  }

  /** §26: deterministisk filter/søk - ingen LLM nødvendig for et strukturert oppslag. */
  async searchTickets(tenantId: string, memorySpace: MemorySpace, filter: SearchTicketsFilter): Promise<SupportTicket[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const clauses = ["tenant_id = $1"];
      const params: unknown[] = [tenantId];
      const push = (clause: string, value: unknown) => {
        params.push(value);
        clauses.push(clause.replace("$N", `$${params.length}`));
      };
      if (filter.status !== undefined) push("status = $N", filter.status);
      if (filter.priority !== undefined) push("priority = $N", filter.priority);
      if (filter.assignee_person_id !== undefined) push("assignee_person_id = $N", filter.assignee_person_id);
      if (filter.company_id !== undefined) push("company_id = $N", filter.company_id);
      if (filter.contact_id !== undefined) push("contact_id = $N", filter.contact_id);
      if (filter.ticket_number !== undefined) push("ticket_number = $N", filter.ticket_number);
      if (filter.subject_contains !== undefined) push("subject ILIKE $N", `%${filter.subject_contains}%`);
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
      const { rows } = await client.query(
        `SELECT * FROM support_tickets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
        params
      );
      return rows as SupportTicket[];
    });
  }

  /** §5: statsovergang håndheves deterministisk (state-machine.ts) - ugyldig overgang kaster, endrer INGENTING. */
  async setStatus(
    tenantId: string,
    memorySpace: MemorySpace,
    ticketId: string,
    status: TicketStatus,
    actorPersonId?: string
  ): Promise<SupportTicket | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, ticketId);
      if (!current) return null;
      assertValidTicketTransition(current.status, status);
      const resolvedAtClause = status === "resolved" ? ", resolved_at = now()" : current.status === "resolved" ? ", resolved_at = NULL" : "";
      const closedAtClause = status === "closed" ? ", closed_at = now()" : current.status === "closed" ? ", closed_at = NULL" : "";
      const { rows } = await client.query(
        `UPDATE support_tickets SET status = $1, updated_at = now()${resolvedAtClause}${closedAtClause}
         WHERE tenant_id = $2 AND ticket_id = $3 RETURNING *`,
        [status, tenantId, ticketId]
      );
      const updated = rows[0] as SupportTicket;
      const eventType = status === "resolved" ? "resolved" : status === "closed" ? "closed" : isTerminalTicketStatus(current.status) && !isTerminalTicketStatus(status) ? "reopened" : "status_changed";
      await insertEvent(client, tenantId, memorySpace, {
        ticket_id: ticketId, event_type: eventType, summary: `Status endret: ${current.status} -> ${status}`,
        actor_person_id: actorPersonId ?? null, source_type: null, source_instance_id: null, source_message_id: null,
        canonical_uri: null, metadata: { from: current.status, to: status }, occurred_at: null
      });
      // UA-3 AC1: statusovergangen er ALLEREDE gyldig-håndhevet over
      // (state-machine.ts). D-130-fiksen: denne tidslinje-speilingen skjer
      // NAA i SAMME transaksjon som selve UPDATE-en - RENT additiv, men
      // ALDRI lenger en andre, frakoblet kilde-til-sannhet for overgangen.
      await this.recordTicketTimelineActivity(
        client, tenantId, memorySpace, updated, "status_change",
        `Status endret: ${current.status} -> ${status}`, `status:${status}`
      );
      return updated;
    });
  }

  async setPriority(tenantId: string, memorySpace: MemorySpace, ticketId: string, priority: TicketPriority, actorPersonId?: string): Promise<SupportTicket | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, ticketId);
      if (!current) return null;
      const { rows } = await client.query(
        `UPDATE support_tickets SET priority = $1, updated_at = now() WHERE tenant_id = $2 AND ticket_id = $3 RETURNING *`,
        [priority, tenantId, ticketId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        ticket_id: ticketId, event_type: "priority_changed", summary: `Prioritet endret: ${current.priority} -> ${priority}`,
        actor_person_id: actorPersonId ?? null, source_type: null, source_instance_id: null, source_message_id: null,
        canonical_uri: null, metadata: { from: current.priority, to: priority }, occurred_at: null
      });
      return rows[0] as SupportTicket;
    });
  }

  /** §14: gjenbruker eksisterende person-/identitetsarkitektur - ingen ny bruker-/team-modell bygges her. */
  async assignTicket(tenantId: string, memorySpace: MemorySpace, ticketId: string, assigneePersonId: string | null, actorPersonId?: string): Promise<SupportTicket | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, ticketId);
      if (!current) return null;
      const { rows } = await client.query(
        `UPDATE support_tickets SET assignee_person_id = $1, updated_at = now() WHERE tenant_id = $2 AND ticket_id = $3 RETURNING *`,
        [assigneePersonId, tenantId, ticketId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        ticket_id: ticketId, event_type: assigneePersonId ? "assigned" : "unassigned",
        summary: assigneePersonId ? `Tildelt ${assigneePersonId}` : "Tildeling fjernet",
        actor_person_id: actorPersonId ?? null, source_type: null, source_instance_id: null, source_message_id: null,
        canonical_uri: null, metadata: { from: current.assignee_person_id, to: assigneePersonId }, occurred_at: null
      });
      return rows[0] as SupportTicket;
    });
  }

  /** §15: internt notat - ALDRI kunde-synlig, ALDRI trigger utgående e-post (se transport.ts: ingen ToolGateway-kall her). */
  async addInternalNote(tenantId: string, memorySpace: MemorySpace, ticketId: string, note: string, actorPersonId?: string): Promise<SupportTicketEvent> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, ticketId);
      if (!current) throw new Error("support_ticket_not_found");
      const result = await insertEvent(client, tenantId, memorySpace, {
        ticket_id: ticketId, event_type: "internal_note", summary: note, actor_person_id: actorPersonId ?? null,
        source_type: null, source_instance_id: null, source_message_id: null, canonical_uri: null, metadata: {}, occurred_at: null
      });
      return result.event;
    });
  }

  async setNextResponseDue(tenantId: string, memorySpace: MemorySpace, ticketId: string, dueAt: string | null): Promise<SupportTicket | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE support_tickets SET next_response_due_at = $1, updated_at = now() WHERE tenant_id = $2 AND ticket_id = $3 RETURNING *`,
        [dueAt, tenantId, ticketId]
      );
      if (rows[0]) {
        await insertEvent(client, tenantId, memorySpace, {
          ticket_id: ticketId, event_type: "deadline_changed", summary: `Neste-svar-frist satt til ${dueAt ?? "(fjernet)"}`,
          actor_person_id: null, source_type: null, source_instance_id: null, source_message_id: null,
          canonical_uri: null, metadata: { field: "next_response_due_at", to: dueAt }, occurred_at: null
        });
      }
      return (rows[0] as SupportTicket) ?? null;
    });
  }

  /** §7 i byggeordren: brukt av ingress-routing for å avgjøre om en fortsettelse av en KJENT tråd allerede er en ticket (deterministisk, ikke gjettet). */
  async hasTicketForThread(tenantId: string, memorySpace: MemorySpace, sourceType: string, sourceInstanceId: string, threadId: string): Promise<boolean> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM support_tickets WHERE tenant_id = $1 AND source_type = $2 AND source_instance_id = $3 AND source_thread_id = $4`,
        [tenantId, sourceType, sourceInstanceId, threadId]
      );
      return rows.length > 0;
    });
  }

  async listEvents(tenantId: string, memorySpace: MemorySpace, ticketId: string): Promise<SupportTicketEvent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM support_ticket_events WHERE tenant_id = $1 AND ticket_id = $2 ORDER BY occurred_at ASC`,
        [tenantId, ticketId]
      );
      return rows as SupportTicketEvent[];
    });
  }

  /**
   * §8/§16 i byggeordren: kanal-nøytral idempotent ingestion. Samme
   * `source_thread_id` -> SAMME ticket (opprettes ved første melding, ellers
   * gjenbrukt); samme `source_message_id` -> ETT event (repeated worker-
   * levering gir INGEN duplikat, `ON CONFLICT DO NOTHING`-mønster). En
   * kunde-melding på en resolved/closed ticket reåpner den DETERMINISTISK
   * (§16 - ikke en LLM-vurdering av om reåpning er riktig).
   */
  async ingestMessage(tenantId: string, memorySpace: MemorySpace, input: IngestMessageInput): Promise<IngestMessageResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let ticket: SupportTicket | undefined;
      let ticketCreated = false;
      if (input.source_thread_id) {
        const existing = await client.query(
          `SELECT * FROM support_tickets WHERE tenant_id = $1 AND source_type = $2 AND source_instance_id = $3 AND source_thread_id = $4`,
          [tenantId, input.source_type, input.source_instance_id, input.source_thread_id]
        );
        ticket = existing.rows[0] as SupportTicket | undefined;
      }
      let reopened = false;
      if (!ticket) {
        // Q-33/D-130: samme vakt som createTicket() - kun relevant paa
        // FØRSTE melding i en tråd (der en ny ticket faktisk opprettes med
        // et caller-oppgitt company_id/contact_id).
        await this.assertCompanyContactInScope(client, tenantId, memorySpace, input.company_id, input.contact_id);
        ticket = await insertTicket(client, tenantId, memorySpace, {
          subject: input.subject, channel: input.channel, source_type: input.source_type,
          source_instance_id: input.source_instance_id, source_thread_id: input.source_thread_id,
          source_message_id: input.source_message_id, entity_resolution: input.entity_resolution,
          ...(input.canonical_uri !== undefined ? { canonical_uri: input.canonical_uri } : {}),
          ...(input.company_id !== undefined ? { company_id: input.company_id } : {}),
          ...(input.contact_id !== undefined ? { contact_id: input.contact_id } : {})
        });
        ticketCreated = true;
        await insertEvent(client, tenantId, memorySpace, {
          ticket_id: ticket.ticket_id, event_type: "ticket_created", summary: `Ticket opprettet fra ${input.channel}: ${input.subject}`,
          actor_person_id: null, source_type: input.source_type, source_instance_id: input.source_instance_id,
          source_message_id: null, canonical_uri: input.canonical_uri ?? null, metadata: {}, occurred_at: input.occurred_at ?? null
        });
      } else if (input.is_from_customer && isTerminalTicketStatus(ticket.status) && !(await this.messageAlreadyIngested(client, tenantId, input))) {
        // D-396 (JARVIS-046): en re-levering av en ALLEREDE innlest melding skal aldri gjenåpne en løst ticket (idempotens: samme
        // `source_message_id` = ingen tilstandsendring). Sjekken skjer FØR reåpningen; selve event-insert under er fortsatt idempotent.
        const target = reopenTargetStatus();
        assertValidTicketTransition(ticket.status, target);
        const { rows } = await client.query(
          `UPDATE support_tickets SET status = $1, resolved_at = NULL, closed_at = NULL, updated_at = now() WHERE tenant_id = $2 AND ticket_id = $3 RETURNING *`,
          [target, tenantId, ticket.ticket_id]
        );
        ticket = rows[0] as SupportTicket;
        reopened = true;
        await insertEvent(client, tenantId, memorySpace, {
          ticket_id: ticket.ticket_id, event_type: "reopened", summary: "Ticket gjenåpnet av ny kundemelding",
          actor_person_id: null, source_type: null, source_instance_id: null, source_message_id: null,
          canonical_uri: null, metadata: {}, occurred_at: null
        });
      }
      const eventResult = await insertEvent(
        client, tenantId, memorySpace,
        {
          ticket_id: ticket.ticket_id, event_type: input.is_from_customer ? "customer_message" : input.outbound_outcome === "failed_send" ? "internal_note" : "agent_reply",
          summary: input.summary, actor_person_id: null, source_type: input.source_type,
          source_instance_id: input.source_instance_id, source_message_id: input.source_message_id,
          canonical_uri: input.canonical_uri ?? null, metadata: {}, occurred_at: input.occurred_at ?? null
        },
        true
      );
      // UA-3 AC1 / D-130: samme SAMME-transaksjon tidslinje-speiling som
      // createTicket()/setStatus() - `ticket_created`/`reopened` kan begge
      // trigges her (kanal-nøytral ingress), ALDRI dupliserte innsatte hvis
      // worker-leveringen gjentas (§8: `source_thread_id`-oppslaget over gjør
      // denne grenen idempotent - `ticket_created`/`reopened` blir kun
      // `true` FØRSTE gang). Feiler business_activities-skrivingen, ruller
      // HELE transaksjonen (ticket/event inkludert) tilbake.
      if (ticketCreated) {
        await this.recordTicketTimelineActivity(
          client, tenantId, memorySpace, ticket, "external_event",
          `Ticket opprettet fra ${input.channel}: ${input.subject}`, "created", input.occurred_at ?? null
        );
      }
      if (reopened) {
        await this.recordTicketTimelineActivity(
          client, tenantId, memorySpace, ticket, "status_change",
          "Status endret: ticket gjenåpnet av ny kundemelding", `status:${ticket.status}`
        );
      }
      return { ticket, event: eventResult.event, ticket_created: ticketCreated, event_created: eventResult.created, reopened };
    });
  }

  /** D-396 (JARVIS-046): slå opp et allerede registrert event via leverandørens meldings-identitet (brukes for idempotent svar). */
  async findEventBySourceMessage(
    tenantId: string, memorySpace: MemorySpace, sourceType: string, sourceInstanceId: string, sourceMessageId: string
  ): Promise<SupportTicketEvent | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM support_ticket_events WHERE tenant_id = $1 AND source_type = $2 AND source_instance_id = $3 AND source_message_id = $4 LIMIT 1`,
        [tenantId, sourceType, sourceInstanceId, sourceMessageId]
      );
      return (rows[0] as SupportTicketEvent) ?? null;
    });
  }

  private async messageAlreadyIngested(client: pg.PoolClient, tenantId: string, input: IngestMessageInput): Promise<boolean> {
    if (!input.source_message_id) return false;
    const { rows } = await client.query(
      `SELECT 1 FROM support_ticket_events
        WHERE tenant_id = $1 AND source_type = $2 AND source_instance_id = $3 AND source_message_id = $4 LIMIT 1`,
      [tenantId, input.source_type, input.source_instance_id, input.source_message_id]
    );
    return rows.length > 0;
  }

  private async readForUpdate(client: pg.PoolClient, tenantId: string, ticketId: string): Promise<SupportTicket | null> {
    const { rows } = await client.query(`SELECT * FROM support_tickets WHERE tenant_id = $1 AND ticket_id = $2`, [tenantId, ticketId]);
    return (rows[0] as SupportTicket) ?? null;
  }

  /**
   * UA-3 akseptansekriterium 1 ("Hva skjer med kunde X?"): speiler ticket-
   * lifecycle-hendelser inn i `business_activities`.
   *
   * Arkitekt-review MERGE BLOCKER (D-130, PR #79): kaller NAA
   * `recordActivityInTransaction()` DIREKTE med den ALLEREDE ÅPNE `client`
   * fra kallerens `withMemoryTransaction`-blokk - IKKE lenger
   * `this.business.recordActivity()` (som åpner sin EGEN, frakoblede
   * transaksjon). Dette gjør skrivingen ATOMISK med selve ticket-raden:
   * feiler denne INSERT-en, ruller HELE den omsluttende transaksjonen
   * (ticket/event inkludert) tilbake - se `modules/memory/src/spaces.ts`
   * sin `withMemoryTransaction()` for ROLLBACK-håndteringen. En ticket UTEN
   * `company_id`/`contact_id` har ingenting å feste seg til på tidslinjen -
   * hoppes BEVISST over her (ALDRI en oppdiktet plassholder-kobling, se
   * D-64/§9: "never silently link the wrong company"). `external_id` er en
   * stabil, deterministisk nøkkel per LOGISK hendelse (`{ticket_id}:created`
   * / `{ticket_id}:status:{status}`) - `recordActivityInTransaction()` sin
   * EKSISTERENDE `ON CONFLICT (tenant_id, source_type, source_instance_id,
   * external_id)`-idempotens hindrer derfor en duplikat rad ved en gjentatt/
   * retried kilde-hendelse (§22), UTEN at denne funksjonen selv trenger noen
   * egen dedup-logikk. `canonical_uri` peker TILBAKE til selve ticketen -
   * ALDRI en kopi av meldingsinnhold (019_business.sql: "Peker til
   * Knowledge/kilde - ALDRI kopi av full innhold").
   */
  private async recordTicketTimelineActivity(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    ticket: Pick<SupportTicket, "ticket_id" | "company_id" | "contact_id">,
    activityType: "external_event" | "status_change",
    summary: string,
    externalIdSuffix: string,
    occurredAt?: string | null
  ): Promise<void> {
    if (!ticket.company_id && !ticket.contact_id) return;
    await recordActivityInTransaction(client, tenantId, memorySpace, {
      activity_type: activityType,
      summary,
      ...(ticket.company_id ? { company_id: ticket.company_id } : {}),
      ...(ticket.contact_id ? { contact_id: ticket.contact_id } : {}),
      source_type: "support_ticket",
      source_instance_id: "native",
      external_id: `${ticket.ticket_id}:${externalIdSuffix}`,
      canonical_uri: `jarvis:support_ticket:${ticket.ticket_id}`,
      ...(occurredAt ? { occurred_at: occurredAt } : {})
    });
  }

  /**
   * Arkitekt-review MERGE BLOCKER (Q-33/D-130, PR #79): mirrors
   * `OperationsService.assertCompanyContactInScope()` i
   * `modules/operations/src/service.ts` (D-129) - SAMME mønster/håndheving,
   * kun flyttet til Support. `business_companies.company_id`/
   * `business_contacts.contact_id` er GLOBALE primærnøkler (ingen sammensatt
   * `(tenant_id, memory_space_id, id)`-nøkkel der - bevisst unngått en bred,
   * urelatert Business OS-skjemaendring, se D-129). Denne
   * tjenestelags-vakten er derfor den ENESTE håndhevingen for disse to
   * relasjonene fra Support: begge maa eksistere i EGEN tenant+memory_space,
   * og dersom BEGGE er oppgitt maa kontakten faktisk tilhøre den oppgitte
   * company-en. Kalles FØR enhver INSERT/UPDATE som setter company_id/
   * contact_id, INNE i samme åpne transaksjon (client) - avslag etterlater
   * derfor INGEN rad noe sted.
   */
  private async assertCompanyContactInScope(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    companyId: string | undefined,
    contactId: string | undefined
  ): Promise<void> {
    if (companyId !== undefined) {
      const { rows } = await client.query(
        `SELECT 1 FROM business_companies WHERE tenant_id = $1 AND memory_space_id = $2 AND company_id = $3`,
        [tenantId, memorySpace, companyId]
      );
      if (rows.length === 0) throw new SupportCrossScopeReferenceError("company_id", companyId);
    }
    if (contactId !== undefined) {
      const { rows } = await client.query(
        `SELECT company_id FROM business_contacts WHERE tenant_id = $1 AND memory_space_id = $2 AND contact_id = $3`,
        [tenantId, memorySpace, contactId]
      );
      if (rows.length === 0) throw new SupportCrossScopeReferenceError("contact_id", contactId);
      if (companyId !== undefined) {
        const contactCompanyId = (rows[0] as { company_id: string | null }).company_id;
        if (contactCompanyId !== companyId) throw new SupportContactCompanyMismatchError(contactId, companyId);
      }
    }
  }
}

interface InsertTicketInput {
  subject: string;
  company_id?: string;
  contact_id?: string;
  priority?: TicketPriority;
  channel?: string;
  source_type?: string;
  source_instance_id?: string;
  source_thread_id?: string;
  source_message_id?: string;
  canonical_uri?: string;
  entity_resolution?: string;
  assignee_person_id?: string;
}

async function insertTicket(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: InsertTicketInput): Promise<SupportTicket> {
  const ticket_id = `sup-tk-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO support_tickets
       (ticket_id, tenant_id, memory_space_id, company_id, contact_id, subject, priority, assignee_person_id, channel,
        source_type, source_instance_id, source_thread_id, source_message_id, canonical_uri, entity_resolution)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [
      ticket_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null, input.subject,
      input.priority ?? "normal", input.assignee_person_id ?? null, input.channel ?? "manual",
      input.source_type ?? "native", input.source_instance_id ?? null, input.source_thread_id ?? null,
      input.source_message_id ?? null, input.canonical_uri ?? null, input.entity_resolution ?? "unmatched"
    ]
  );
  return rows[0] as SupportTicket;
}

interface InsertEventInput {
  ticket_id: string;
  event_type: string;
  summary: string;
  actor_person_id: string | null;
  source_type: string | null;
  source_instance_id: string | null;
  source_message_id: string | null;
  canonical_uri: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string | null;
}

/**
 * §8: idempotent event-insert. `onConflictIgnore=true` (brukes av
 * `ingestMessage`, hvor gjentatt worker-levering av SAMME melding er
 * forventet) returnerer den EKSISTERENDE raden uendret i stedet for å kaste -
 * `created=false` skiller de to tilfellene for kalleren (§8: "repeated worker
 * delivery -> no duplicate event", aldri en stille feil).
 */
async function insertEvent(
  client: pg.PoolClient,
  tenantId: string,
  memorySpace: MemorySpace,
  input: InsertEventInput,
  onConflictIgnore = false
): Promise<{ event: SupportTicketEvent; created: boolean }> {
  const event_id = `sup-ev-${randomUUID()}`;
  const conflictClause = onConflictIgnore
    ? "ON CONFLICT (tenant_id, source_type, source_instance_id, source_message_id) DO UPDATE SET summary = support_ticket_events.summary"
    : "";
  const { rows } = await client.query(
    `INSERT INTO support_ticket_events
       (event_id, tenant_id, memory_space_id, ticket_id, event_type, summary, actor_person_id,
        source_type, source_instance_id, source_message_id, canonical_uri, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, now()))
     ${conflictClause}
     RETURNING *, (xmax = 0) AS inserted`,
    [
      event_id, tenantId, memorySpace, input.ticket_id, input.event_type, input.summary, input.actor_person_id,
      input.source_type, input.source_instance_id, input.source_message_id, input.canonical_uri,
      JSON.stringify(input.metadata), input.occurred_at
    ]
  );
  const row = rows[0] as SupportTicketEvent & { inserted: boolean };
  return { event: row, created: row.inserted };
}
