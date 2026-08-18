import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
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
  constructor(private readonly pool: pg.Pool) {}

  async createTicket(tenantId: string, memorySpace: MemorySpace, input: CreateTicketInput): Promise<SupportTicket> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
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
      } else if (input.is_from_customer && isTerminalTicketStatus(ticket.status)) {
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
          ticket_id: ticket.ticket_id, event_type: input.is_from_customer ? "customer_message" : "agent_reply",
          summary: input.summary, actor_person_id: null, source_type: input.source_type,
          source_instance_id: input.source_instance_id, source_message_id: input.source_message_id,
          canonical_uri: input.canonical_uri ?? null, metadata: {}, occurred_at: input.occurred_at ?? null
        },
        true
      );
      return { ticket, event: eventResult.event, ticket_created: ticketCreated, event_created: eventResult.created, reopened };
    });
  }

  private async readForUpdate(client: pg.PoolClient, tenantId: string, ticketId: string): Promise<SupportTicket | null> {
    const { rows } = await client.query(`SELECT * FROM support_tickets WHERE tenant_id = $1 AND ticket_id = $2`, [tenantId, ticketId]);
    return (rows[0] as SupportTicket) ?? null;
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
