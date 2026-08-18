import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { AttentionBucket, AttentionQueueEntry, BusinessOpenLoop, OpenLoopPriority, OpenLoopType, SweepResult } from "./open-loop-types.ts";

/**
 * UA-3 next slice (D-53): automatisk open-loop-deteksjon. Gjenbruker
 * `withMemoryTransaction` uendret (samme RLS-primitiv som resten av
 * Business OS) - ingen ny sikkerhetsmodell.
 *
 * Deteksjon er REN, deterministisk SQL - INGEN AI Mesh-kall i dette sliceet
 * (§11 i byggeordren: modell brukes KUN der semantisk tvetydighet krever
 * det - ingen av de to reglene under (forfalt oppfoelging, stagnert
 * opportunity) er tvetydige). `detection_method`-kolonnen finnes for en
 * fremtidig AI-assistert regel, men er ubrukt her - se Q-25.
 *
 * Idempotens: hver regel skriver til `business_open_loops` via
 * ON CONFLICT (tenant_id, detection_key) - re-kjoering oppdaterer SAMME
 * rad, oppretter aldri en duplikat. Resolusjon: etter hver deteksjons-kjoering
 * blir EKSISTERENDE aapne loops av samme type, som IKKE lenger er i det
 * gjeldende beviste settet, automatisk markert resolved (vilkaaret er ikke
 * lenger sant) - "gjenaapning" av en tidligere resolved loop skjer ved aa
 * sette status/opened_at tilbake til "open" paa SAMME rad (aldri en ny rad
 * for samme detection_key) - historikken foer/etter ligger i audit_events.
 */
export class OpenLoopService {
  constructor(private readonly pool: pg.Pool) {}

  async detectOverdueFollowups(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const overdue = await client.query(
        `SELECT followup_id, company_id, contact_id, opportunity_id, lead_id, title, due_at, owner_person_id
         FROM business_followups WHERE tenant_id = $1 AND status = 'open' AND due_at < now()`,
        [tenantId]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of overdue.rows as Array<{
        followup_id: string; company_id: string | null; contact_id: string | null;
        opportunity_id: string | null; lead_id: string | null; title: string; due_at: string; owner_person_id: string | null;
      }>) {
        const detectionKey = `overdue_followup:${row.followup_id}`;
        currentKeys.push(detectionKey);
        const overdueDays = (Date.now() - new Date(row.due_at).getTime()) / 86_400_000;
        const priority: OpenLoopPriority = overdueDays > 3 ? "high" : "normal";
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: row.company_id, contact_id: row.contact_id, opportunity_id: row.opportunity_id,
          lead_id: row.lead_id, followup_id: row.followup_id, activity_id: null, ticket_id: null,
          loop_type: "overdue_followup", detection_key: detectionKey,
          reason: `Oppfoelging "${row.title}" er forfalt`, next_action: `Fullfoer eller avbryt oppfoelging ${row.followup_id}`,
          priority, owner_person_id: row.owner_person_id, due_at: row.due_at
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "overdue_followup", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /** Stagnert = ikke i terminal stage OG ingen aapen oppfoelging linket OG ikke oppdatert siste `staleDays`. */
  async detectStalledOpportunities(tenantId: string, memorySpace: MemorySpace, staleDays = 14): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const stalled = await client.query(
        `SELECT o.opportunity_id, o.company_id, o.contact_id, o.title, o.owner_person_id, o.updated_at
         FROM business_opportunities o
         WHERE o.tenant_id = $1 AND o.stage NOT IN ('won','lost')
           AND o.updated_at < now() - ($2 || ' days')::interval
           AND NOT EXISTS (
             SELECT 1 FROM business_followups f
             WHERE f.tenant_id = o.tenant_id AND f.opportunity_id = o.opportunity_id AND f.status = 'open'
           )`,
        [tenantId, staleDays]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of stalled.rows as Array<{
        opportunity_id: string; company_id: string | null; contact_id: string | null;
        title: string; owner_person_id: string | null; updated_at: string;
      }>) {
        const detectionKey = `stalled_opportunity:${row.opportunity_id}`;
        currentKeys.push(detectionKey);
        const staleFor = (Date.now() - new Date(row.updated_at).getTime()) / 86_400_000;
        const priority: OpenLoopPriority = staleFor > staleDays * 2 ? "high" : "normal";
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: row.company_id, contact_id: row.contact_id, opportunity_id: row.opportunity_id,
          lead_id: null, followup_id: null, activity_id: null, ticket_id: null,
          loop_type: "stalled_opportunity", detection_key: detectionKey,
          reason: `Opportunity "${row.title}" har ingen aapen oppfoelging og ingen oppdatering siste ${staleDays} dager`,
          next_action: `Sett neste handling/oppfoelging for opportunity ${row.opportunity_id}`,
          priority, owner_person_id: row.owner_person_id, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "stalled_opportunity", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * UA-3 Native Support Core (D-66) §17: en support-ticket "trenger svar" naar
   * siste hendelse er en kunde-melding (ingen agent-svar/intern-notat etter)
   * OG status IKKE er resolved/closed. Rent deterministisk - INGEN AI-tolkning
   * av om et svar faktisk "besvarer" meldingen (§13 i byggeordren: kun status/
   * hendelsesrekkefoelge, aldri semantisk innholdstolkning).
   */
  async detectSupportTicketsNeedingReply(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT t.ticket_id, t.company_id, t.contact_id, t.subject, t.priority, t.assignee_person_id
         FROM support_tickets t
         WHERE t.tenant_id = $1 AND t.status NOT IN ('resolved', 'closed')
           AND EXISTS (
             SELECT 1 FROM support_ticket_events e
             WHERE e.tenant_id = t.tenant_id AND e.ticket_id = t.ticket_id AND e.event_type = 'customer_message'
             ORDER BY e.occurred_at DESC LIMIT 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM support_ticket_events e
             WHERE e.tenant_id = t.tenant_id AND e.ticket_id = t.ticket_id AND e.event_type IN ('agent_reply', 'internal_note')
               AND e.occurred_at > COALESCE((
                 SELECT max(e2.occurred_at) FROM support_ticket_events e2
                 WHERE e2.tenant_id = t.tenant_id AND e2.ticket_id = t.ticket_id AND e2.event_type = 'customer_message'
               ), 'epoch'::timestamptz)
           )`,
        [tenantId]
      );
      return this.upsertSupportLoop(client, tenantId, memorySpace, rows.rows as SupportTicketRow[], "support_ticket_needs_reply", (row) => ({
        reason: `Ticket "${row.subject}" venter fortsatt paa svar til kunden`,
        next_action: `Svar ticket ${row.ticket_id}`,
        priority: row.priority === "urgent" || row.priority === "high" ? "high" : "normal"
      }));
    });
  }

  /** §18: forfalt naar `next_response_due_at`/`next_action_due_at` har passert og ticket ikke er resolved/closed. */
  async detectOverdueSupportTickets(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT ticket_id, company_id, contact_id, subject, priority, assignee_person_id,
                LEAST(COALESCE(next_response_due_at, next_action_due_at), COALESCE(next_action_due_at, next_response_due_at)) AS due_at
         FROM support_tickets
         WHERE tenant_id = $1 AND status NOT IN ('resolved', 'closed')
           AND (
             (next_response_due_at IS NOT NULL AND next_response_due_at < now())
             OR (next_action_due_at IS NOT NULL AND next_action_due_at < now())
           )`,
        [tenantId]
      );
      return this.upsertSupportLoop(
        client, tenantId, memorySpace, rows.rows as SupportTicketRow[], "support_ticket_overdue",
        (row) => ({ reason: `Ticket "${row.subject}" er forfalt`, next_action: `Foelg opp forfalt ticket ${row.ticket_id}`, priority: "high" })
      );
    });
  }

  /** §14: uassignert - ingen `assignee_person_id` satt, ticket fortsatt aktiv. */
  async detectUnassignedSupportTickets(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT ticket_id, company_id, contact_id, subject, priority, assignee_person_id
         FROM support_tickets WHERE tenant_id = $1 AND status NOT IN ('resolved', 'closed') AND assignee_person_id IS NULL`,
        [tenantId]
      );
      return this.upsertSupportLoop(
        client, tenantId, memorySpace, rows.rows as SupportTicketRow[], "support_ticket_unassigned",
        (row) => ({ reason: `Ticket "${row.subject}" har ingen ansvarlig`, next_action: `Tildel ticket ${row.ticket_id}`, priority: "normal" })
      );
    });
  }

  /** §5: `waiting_internal`-status er i seg selv en operasjonell "attention needed"-tilstand. */
  async detectSupportTicketsWaitingInternal(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT ticket_id, company_id, contact_id, subject, priority, assignee_person_id
         FROM support_tickets WHERE tenant_id = $1 AND status = 'waiting_internal'`,
        [tenantId]
      );
      return this.upsertSupportLoop(
        client, tenantId, memorySpace, rows.rows as SupportTicketRow[], "support_ticket_waiting_internal",
        (row) => ({ reason: `Ticket "${row.subject}" venter paa intern avklaring`, next_action: `Avklar ticket ${row.ticket_id} internt`, priority: "normal" })
      );
    });
  }

  private async upsertSupportLoop(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    rows: SupportTicketRow[],
    loopType: OpenLoopType,
    build: (row: SupportTicketRow) => { reason: string; next_action: string; priority: OpenLoopPriority }
  ): Promise<SweepResult> {
    let detected = 0;
    let updated = 0;
    const currentKeys: string[] = [];
    for (const row of rows) {
      const detectionKey = `${loopType}:${row.ticket_id}`;
      currentKeys.push(detectionKey);
      const built = build(row);
      const result = await upsertOpenLoop(client, {
        open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
        company_id: row.company_id, contact_id: row.contact_id, opportunity_id: null,
        lead_id: null, followup_id: null, activity_id: null, ticket_id: row.ticket_id,
        loop_type: loopType, detection_key: detectionKey, reason: built.reason, next_action: built.next_action,
        priority: built.priority, owner_person_id: row.assignee_person_id, due_at: null
      });
      if (result === "inserted") detected++; else updated++;
    }
    const autoResolved = await autoResolveStale(client, tenantId, loopType, currentKeys);
    return { detected, updated, auto_resolved: autoResolved };
  }

  /** Full sweep: alle deterministiske regler - trygt aa kalle gjentatte ganger (idempotent). */
  async runSweep(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    const results = [
      await this.detectOverdueFollowups(tenantId, memorySpace),
      await this.detectStalledOpportunities(tenantId, memorySpace),
      // UA-3 Native Support Core (D-66) §17: "Reuse existing OpenLoopService" -
      // support-reglene kjoeres som en del av DENNE samme sveipen, ingen ny
      // scheduler/kø. Krever `support_tickets`/`support_ticket_events`
      // (024_support.sql) - fravaer av tabellene ville feile hardt, IKKE stille
      // hoppes over, siden migrasjonen alltid kjoeres foer runtime starter.
      await this.detectSupportTicketsNeedingReply(tenantId, memorySpace),
      await this.detectOverdueSupportTickets(tenantId, memorySpace),
      await this.detectUnassignedSupportTickets(tenantId, memorySpace),
      await this.detectSupportTicketsWaitingInternal(tenantId, memorySpace)
    ];
    return results.reduce(
      (acc, r) => ({ detected: acc.detected + r.detected, updated: acc.updated + r.updated, auto_resolved: acc.auto_resolved + r.auto_resolved }),
      { detected: 0, updated: 0, auto_resolved: 0 }
    );
  }

  async listOpenLoops(tenantId: string, memorySpace: MemorySpace, status: "open" | "resolved" | "all" = "open"): Promise<BusinessOpenLoop[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        status === "all"
          ? `SELECT * FROM business_open_loops WHERE tenant_id = $1 ORDER BY priority DESC, due_at ASC NULLS LAST`
          : `SELECT * FROM business_open_loops WHERE tenant_id = $1 AND status = $2 ORDER BY priority DESC, due_at ASC NULLS LAST`,
        status === "all" ? [tenantId] : [tenantId, status]
      );
      return rows as BusinessOpenLoop[];
    });
  }

  async readOpenLoop(tenantId: string, memorySpace: MemorySpace, openLoopId: string): Promise<BusinessOpenLoop | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM business_open_loops WHERE tenant_id = $1 AND open_loop_id = $2`, [tenantId, openLoopId]);
      return (rows[0] as BusinessOpenLoop) ?? null;
    });
  }

  /** §16: sporrbar visning over persistert state - ren spoerring, ingen transient LLM-svar. */
  async attentionQueue(tenantId: string, memorySpace: MemorySpace): Promise<AttentionQueueEntry[]> {
    const loops = await this.listOpenLoops(tenantId, memorySpace, "open");
    const now = Date.now();
    return loops.map((loop) => {
      const overdue = loop.due_at !== null && new Date(loop.due_at).getTime() < now;
      const dueSoon = loop.due_at !== null && !overdue && new Date(loop.due_at).getTime() - now < 48 * 3_600_000;
      let bucket: AttentionBucket;
      if (loop.priority === "high" && overdue) bucket = "critical";
      else if (overdue) bucket = "overdue";
      else if (dueSoon) bucket = "due_soon";
      else bucket = "informational";
      return { bucket, loop };
    });
  }

  async resolveOpenLoop(tenantId: string, memorySpace: MemorySpace, openLoopId: string, resolutionReason: string): Promise<BusinessOpenLoop | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE business_open_loops SET status = 'resolved', resolved_at = now(), resolution_reason = $1, updated_at = now()
         WHERE tenant_id = $2 AND open_loop_id = $3 AND status = 'open' RETURNING *`,
        [resolutionReason, tenantId, openLoopId]
      );
      return (rows[0] as BusinessOpenLoop) ?? null;
    });
  }

  async deferOpenLoop(tenantId: string, memorySpace: MemorySpace, openLoopId: string, newDueAt: string): Promise<BusinessOpenLoop | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE business_open_loops SET due_at = $1, updated_at = now() WHERE tenant_id = $2 AND open_loop_id = $3 AND status = 'open' RETURNING *`,
        [newDueAt, tenantId, openLoopId]
      );
      return (rows[0] as BusinessOpenLoop) ?? null;
    });
  }

  async assignOpenLoop(tenantId: string, memorySpace: MemorySpace, openLoopId: string, ownerPersonId: string): Promise<BusinessOpenLoop | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE business_open_loops SET owner_person_id = $1, updated_at = now() WHERE tenant_id = $2 AND open_loop_id = $3 RETURNING *`,
        [ownerPersonId, tenantId, openLoopId]
      );
      return (rows[0] as BusinessOpenLoop) ?? null;
    });
  }

  async setNextAction(tenantId: string, memorySpace: MemorySpace, openLoopId: string, nextAction: string): Promise<BusinessOpenLoop | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE business_open_loops SET next_action = $1, updated_at = now() WHERE tenant_id = $2 AND open_loop_id = $3 RETURNING *`,
        [nextAction, tenantId, openLoopId]
      );
      return (rows[0] as BusinessOpenLoop) ?? null;
    });
  }
}

interface SupportTicketRow {
  ticket_id: string;
  company_id: string | null;
  contact_id: string | null;
  subject: string;
  priority: "low" | "normal" | "high" | "urgent";
  assignee_person_id: string | null;
}

interface UpsertOpenLoopInput {
  open_loop_id: string;
  tenant_id: string;
  memory_space: MemorySpace;
  company_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  lead_id: string | null;
  followup_id: string | null;
  activity_id: string | null;
  ticket_id: string | null;
  loop_type: string;
  detection_key: string;
  reason: string;
  next_action: string | null;
  priority: OpenLoopPriority;
  owner_person_id: string | null;
  due_at: string | null;
}

async function upsertOpenLoop(client: pg.PoolClient, input: UpsertOpenLoopInput): Promise<"inserted" | "updated"> {
  const { rows } = await client.query(
    `INSERT INTO business_open_loops
       (open_loop_id, tenant_id, memory_space_id, company_id, contact_id, opportunity_id, lead_id, followup_id, activity_id,
        ticket_id, loop_type, detection_key, reason, next_action, priority, owner_person_id, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (tenant_id, detection_key) DO UPDATE SET
       -- Gjenaapning (§9 i byggeordren): en tidligere resolved loop for SAMME vilkaar settes
       -- eksplisitt tilbake til 'open' med ny opened_at - historikken bevares i audit_events,
       -- ikke som en ny rad for samme detection_key.
       status = 'open', opened_at = CASE WHEN business_open_loops.status = 'resolved' THEN now() ELSE business_open_loops.opened_at END,
       resolved_at = CASE WHEN business_open_loops.status = 'resolved' THEN NULL ELSE business_open_loops.resolved_at END,
       resolution_reason = CASE WHEN business_open_loops.status = 'resolved' THEN NULL ELSE business_open_loops.resolution_reason END,
       reason = EXCLUDED.reason, priority = EXCLUDED.priority, due_at = EXCLUDED.due_at, updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      input.open_loop_id, input.tenant_id, input.memory_space, input.company_id, input.contact_id,
      input.opportunity_id, input.lead_id, input.followup_id, input.activity_id, input.ticket_id, input.loop_type,
      input.detection_key, input.reason, input.next_action, input.priority, input.owner_person_id, input.due_at
    ]
  );
  return (rows[0] as { inserted: boolean }).inserted ? "inserted" : "updated";
}

/** §9: en tidligere aapen loop hvis vilkaar IKKE lenger er sant (ikke i currentKeys) resolves automatisk. */
async function autoResolveStale(client: pg.PoolClient, tenantId: string, loopType: string, currentKeys: string[]): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE business_open_loops SET status = 'resolved', resolved_at = now(), resolution_reason = 'condition_no_longer_true', updated_at = now()
     WHERE tenant_id = $1 AND loop_type = $2 AND status = 'open' AND NOT (detection_key = ANY($3))`,
    [tenantId, loopType, currentKeys]
  );
  return rowCount ?? 0;
}
