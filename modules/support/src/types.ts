/**
 * UA-3 Native Jarvis Support Core (D-66). Jarvis EIER selv ticket-
 * domenemodellen (JARVIS_CANONICAL, D-64) - ZERO leverandør-spesifikke felter
 * her (§6 i byggeordren: kun generiske `source_*`-pekere). "Smallest complete"
 * (§4): kun det som faktisk kreves for lifecycle/entitetskobling/kanal-
 * nøytralitet - ingen enterprise-helpdesk-kompleksitet uten reelt behov.
 */

export type TicketStatus = "open" | "pending" | "waiting_customer" | "waiting_internal" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketChannel = "email" | "manual" | "other";
export type EntityResolutionState = "matched" | "unmatched" | "ambiguous";

export type TicketEventType =
  | "ticket_created"
  | "customer_message"
  | "agent_reply"
  | "internal_note"
  | "status_changed"
  | "priority_changed"
  | "assigned"
  | "unassigned"
  | "resolved"
  | "closed"
  | "reopened"
  | "deadline_changed";

export interface SupportTicket {
  ticket_id: string;
  ticket_number: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee_person_id: string | null;
  channel: TicketChannel;
  source_type: string;
  source_instance_id: string | null;
  source_thread_id: string | null;
  source_message_id: string | null;
  canonical_uri: string | null;
  entity_resolution: EntityResolutionState;
  next_response_due_at: string | null;
  next_action_due_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportTicketEvent {
  event_id: string;
  tenant_id: string;
  memory_space_id: string;
  ticket_id: string;
  event_type: TicketEventType;
  summary: string;
  actor_person_id: string | null;
  source_type: string | null;
  source_instance_id: string | null;
  source_message_id: string | null;
  canonical_uri: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export interface CreateTicketInput {
  subject: string;
  company_id?: string;
  contact_id?: string;
  priority?: TicketPriority;
  channel?: TicketChannel;
  source_type?: string;
  source_instance_id?: string;
  source_thread_id?: string;
  source_message_id?: string;
  canonical_uri?: string;
  entity_resolution?: EntityResolutionState;
  assignee_person_id?: string;
  initial_summary?: string;
  actor_person_id?: string;
  occurred_at?: string;
}

/** §7/§8 i byggeordren: normalisert, leverandør-nøytral ingress-melding - bygges av gmail-ingress.ts fra en ekte GmailTransport-melding. */
export interface IngestMessageInput {
  channel: TicketChannel;
  source_type: string;
  source_instance_id: string;
  /** Tråd-/samtale-identitet fra provideren - SAMME tråd => SAMME logiske ticket (§8). */
  source_thread_id: string;
  /** Enkelt-melding-identitet fra provideren - SAMME melding => ETT logisk event (§8). */
  source_message_id: string;
  canonical_uri?: string;
  subject: string;
  /** Kort, allerede strukturert sammendrag (ALDRI full meldingstekst - §11 pointer-not-payload). */
  summary: string;
  is_from_customer: boolean;
  company_id?: string;
  contact_id?: string;
  entity_resolution: EntityResolutionState;
  occurred_at?: string;
  /**
   * D-396 (JARVIS-046): `failed_send` registrerer et mislykket utgående svar-forsøk som `internal_note` (evidens), ALDRI som
   * `agent_reply` - ellers ville et svar som aldri nådde kunden telle som besvart i "trenger svar"-deteksjonen.
   */
  outbound_outcome?: "failed_send";
  /**
   * WP-P3 K3 (JARVIS-104, Q-63 pkt 8): INTERN id til et EKSISTERENDE ticket. Satt => `ingestMessage` leser raden på (tenant_id, ticket_id) under RLS/rom, kaster `support_ticket_not_found` hvis den mangler
   * og OPPRETTER ALDRI et ticket (tråd-oppslaget hoppes over). Brukes av `SupportEmailService.reply()` så et svar på et MANUELT ticket (ingen kildeinstans/-tråd) havner på DENNE ticketen.
   * Feltet settes KUN av betrodd intern kode - aldri fra verktøyets `parameters` (`transport.ts` `ingest_message` leser det ikke; skjemaet i `integrations.ts` er strengt).
   */
  ticket_id?: string;
}

export interface IngestMessageResult {
  ticket: SupportTicket;
  event: SupportTicketEvent;
  ticket_created: boolean;
  event_created: boolean;
  reopened: boolean;
}
