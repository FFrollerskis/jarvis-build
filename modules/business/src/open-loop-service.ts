import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { canonicalStringify } from "@jarvis/contracts";
import type { AttentionQueueEntry, BusinessOpenLoop, LoopResolutionOutcome, OpenLoopPriority, OpenLoopType, SweepResult } from "./open-loop-types.ts";
import { MANUAL_RESOLUTION_OUTCOMES, classifyAttentionBucket, deterministicLoopConfidence } from "./open-loop-types.ts";
import { churnDetectionKey, churnNextAction, describeChurnRisk } from "./churn-rules.ts";
import { ChurnService } from "./churn-service.ts";
import {
  buildCalibrationReport, calibrationByType, computeLoopConfidence, corroboratesEachOther, loopFamily,
  type CalibrationObservation, type CalibrationReport, type LoopOutcome
} from "./confidence.ts";
import { DEFAULT_SUPPORT_SLA_HOURS, type SupportSlaPolicy } from "./support-sla.ts";

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
export interface OpenLoopServiceOptions {
  /**
   * WP-D2 (JARVIS-082): svarfrist («SLA») per prioritet for `support_ticket_overdue`. `undefined` = forslagene (`DEFAULT_SUPPORT_SLA_HOURS`, NEEDS_TOBIAS), `null` = AV (da gjelder kun
   * eksplisitte frister). Parses fra `JARVIS_SUPPORT_SLA_HOURS` av app-laget (`parseSupportSlaHours`).
   */
  supportSla?: SupportSlaPolicy | null;
}

export class OpenLoopService {
  private readonly supportSla: SupportSlaPolicy | null;

  constructor(private readonly pool: pg.Pool, options: OpenLoopServiceOptions = {}) {
    this.supportSla = options.supportSla === undefined ? { ...DEFAULT_SUPPORT_SLA_HOURS } : options.supportSla;
  }

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
          lead_id: row.lead_id, followup_id: row.followup_id, activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
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
           )
           -- WP-D2: en PLANLAGT neste handling (satt med business.set_next_action, frist i fremtiden) er nettopp det loopen ber om - da er den ikke stagnert.
           AND NOT (o.next_action IS NOT NULL AND o.next_action_due_at IS NOT NULL AND o.next_action_due_at > now())`,
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
          lead_id: null, followup_id: null, activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
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
             WHERE e.tenant_id = t.tenant_id AND e.ticket_id = t.ticket_id AND e.event_type = 'agent_reply'
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

  /**
   * §18: forfalt naar en frist har passert og ticket ikke er resolved/closed. Fristene er (1) eksplisitte `next_response_due_at`/`next_action_due_at` og, fra WP-D2 (JARVIS-082),
   * (2) en UTLEDET svarfrist: siste UBESVARTE kundemelding (`support_ticket_events`: ingen `agent_reply` etter den; et internt notat besvarer ikke kunden) + et vindu per prioritet
   * (`supportSla`, forslag: urgent 4 t, high 8 t, normal 24 t, low 72 t - NEEDS_TOBIAS). Regelen var tidligere et spøkelse: ingen produksjonskode satte noen frist, så den kunne aldri
   * slå ut. Den er nå koblet til faktiske support-data (ikke fjernet). Den tidligste gjeldende fristen blir loopens `due_at` (attention-bøtta «critical» krever en frist).
   * `waiting_customer` har ingen klokke (vi venter på kunden); uten kundemelding (manuell ticket) finnes ingen utledet frist. `supportSla: null` slår utledningen av.
   */
  async detectOverdueSupportTickets(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    const sla = this.supportSla;
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT t.ticket_id, t.company_id, t.contact_id, t.subject, t.priority, t.assignee_person_id,
                LEAST(COALESCE(t.next_response_due_at, t.next_action_due_at), COALESCE(t.next_action_due_at, t.next_response_due_at), sla.sla_due_at) AS due_at,
                (sla.sla_due_at IS NOT NULL AND sla.sla_due_at < now()) AS sla_breach
         FROM support_tickets t
         LEFT JOIN LATERAL (
           SELECT lm.occurred_at + make_interval(hours => CASE t.priority WHEN 'urgent' THEN $2::int WHEN 'high' THEN $3::int WHEN 'normal' THEN $4::int ELSE $5::int END) AS sla_due_at
             FROM (
               SELECT e.occurred_at FROM support_ticket_events e
                WHERE e.tenant_id = t.tenant_id AND e.ticket_id = t.ticket_id AND e.event_type = 'customer_message'
                ORDER BY e.occurred_at DESC LIMIT 1
             ) lm
            WHERE $6::boolean AND t.status <> 'waiting_customer'
              AND NOT EXISTS (
                SELECT 1 FROM support_ticket_events a
                 WHERE a.tenant_id = t.tenant_id AND a.ticket_id = t.ticket_id AND a.event_type = 'agent_reply' AND a.occurred_at > lm.occurred_at
              )
         ) sla ON true
         WHERE t.tenant_id = $1 AND t.status NOT IN ('resolved', 'closed')
           AND (
             (t.next_response_due_at IS NOT NULL AND t.next_response_due_at < now())
             OR (t.next_action_due_at IS NOT NULL AND t.next_action_due_at < now())
             OR (sla.sla_due_at IS NOT NULL AND sla.sla_due_at < now())
           )`,
        [tenantId, sla?.urgent ?? 1, sla?.high ?? 1, sla?.normal ?? 1, sla?.low ?? 1, sla !== null]
      );
      return this.upsertSupportLoop(
        client, tenantId, memorySpace, rows.rows as SupportTicketRow[], "support_ticket_overdue",
        (row) => ({
          reason: row.sla_breach && sla
            ? `Ticket "${row.subject}" har ikke fått svar innen svarfristen (${sla[row.priority]} t for ${row.priority} prioritet)`
            : `Ticket "${row.subject}" er forfalt`,
          next_action: `Foelg opp forfalt ticket ${row.ticket_id}`,
          priority: "high",
          due_at: row.due_at ? new Date(row.due_at).toISOString() : null
        })
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
    build: (row: SupportTicketRow) => { reason: string; next_action: string; priority: OpenLoopPriority; due_at?: string | null }
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
        lead_id: null, followup_id: null, activity_id: null, ticket_id: row.ticket_id, contract_id: null, campaign_id: null,
        loop_type: loopType, detection_key: detectionKey, reason: built.reason, next_action: built.next_action,
        priority: built.priority, owner_person_id: row.assignee_person_id, due_at: built.due_at ?? null
      });
      if (result === "inserted") detected++; else updated++;
    }
    const autoResolved = await autoResolveStale(client, tenantId, loopType, currentKeys);
    return { detected, updated, auto_resolved: autoResolved };
  }

  /**
   * UA-3 Native Jarvis Contracts Core (D-71): "Reuse OpenLoopService...
   * No second task/reminder engine" - fornyelsesfrist innen 30 dager for
   * kontrakter som fortsatt er i kraft (`active`/`expiring`). Ren
   * deterministisk dato-sammenligning, INGEN AI-tolkning.
   */
  async detectContractRenewalsDue(tenantId: string, memorySpace: MemorySpace, withinDays = 30): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT contract_id, company_id, contact_id, title, owner_person_id, renewal_date
         FROM contracts WHERE tenant_id = $1 AND status IN ('active','expiring')
           AND renewal_date IS NOT NULL AND renewal_date < now() + ($2 || ' days')::interval`,
        [tenantId, withinDays]
      );
      return this.upsertContractLoop(client, tenantId, memorySpace, rows.rows as ContractRow[], "contract_renewal_due", (row) => ({
        reason: `Kontrakt "${row.title}" fornyes snart`, next_action: `Vurder fornyelse av kontrakt ${row.contract_id}`,
        priority: "normal", due_at: row.renewal_date ?? row.termination_deadline ?? null
      }));
    });
  }

  /** §"termination/cancellation deadlines" i byggeordren: oppsigelsesfrist innen 30 dager, kontrakten fortsatt i kraft. */
  async detectContractTerminationDeadlines(tenantId: string, memorySpace: MemorySpace, withinDays = 30): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT contract_id, company_id, contact_id, title, owner_person_id, termination_deadline
         FROM contracts WHERE tenant_id = $1 AND status IN ('active','expiring')
           AND termination_deadline IS NOT NULL AND termination_deadline < now() + ($2 || ' days')::interval`,
        [tenantId, withinDays]
      );
      return this.upsertContractLoop(client, tenantId, memorySpace, rows.rows as ContractRow[], "contract_termination_deadline", (row) => ({
        reason: `Oppsigelsesfrist for kontrakt "${row.title}" nærmer seg`, next_action: `Beslutt oppsigelse/fornyelse av kontrakt ${row.contract_id}`,
        priority: "high", due_at: row.termination_deadline ?? row.renewal_date ?? null
      }));
    });
  }

  /** Åpen forpliktelse med frist innen 14 dager (eller allerede forfalt) - ett open loop per forpliktelse. */
  async detectContractObligationsDue(tenantId: string, memorySpace: MemorySpace, withinDays = 14): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT o.obligation_id, o.contract_id, o.description, o.due_at, o.owner_person_id, c.company_id, c.contact_id, c.title
         FROM contract_obligations o JOIN contracts c ON c.tenant_id = o.tenant_id AND c.contract_id = o.contract_id
         WHERE o.tenant_id = $1 AND o.status = 'open'
           AND o.due_at IS NOT NULL AND o.due_at < now() + ($2 || ' days')::interval`,
        [tenantId, withinDays]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows.rows as ContractObligationRow[]) {
        const detectionKey = `contract_obligation_due:${row.obligation_id}`;
        currentKeys.push(detectionKey);
        const overdue = row.due_at !== null && new Date(row.due_at).getTime() < Date.now();
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: row.company_id, contact_id: row.contact_id, opportunity_id: null,
          lead_id: null, followup_id: null, activity_id: null, ticket_id: null, contract_id: row.contract_id, campaign_id: null,
          loop_type: "contract_obligation_due", detection_key: detectionKey,
          reason: `Forpliktelse "${row.description}" under kontrakt "${row.title}" ${overdue ? "er forfalt" : "forfaller snart"}`,
          next_action: `Fullfør forpliktelse ${row.obligation_id}`, priority: overdue ? "high" : "normal",
          owner_person_id: row.owner_person_id, due_at: row.due_at
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "contract_obligation_due", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * Periodisk gjennomgang: en `active`/`expiring`-kontrakt som ikke har
   * blitt oppdatert (ny versjon/statusendring/frist-endring) på
   * `staleDays` dager - deterministisk stagnasjons-heuristikk, SAMME
   * prinsipp som `detectStalledOpportunities()`.
   */
  async detectContractsNeedingReview(tenantId: string, memorySpace: MemorySpace, staleDays = 180): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT contract_id, company_id, contact_id, title, owner_person_id, updated_at
         FROM contracts WHERE tenant_id = $1 AND status IN ('active','expiring')
           AND updated_at < now() - ($2 || ' days')::interval`,
        [tenantId, staleDays]
      );
      return this.upsertContractLoop(
        client, tenantId, memorySpace, rows.rows as ContractRow[], "contract_review_required",
        (row) => ({ reason: `Kontrakt "${row.title}" har ikke blitt gjennomgått på ${staleDays} dager`, next_action: `Gjennomgå kontrakt ${row.contract_id}`, priority: "normal", due_at: null })
      );
    });
  }

  private async upsertContractLoop(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    rows: ContractRow[],
    loopType: OpenLoopType,
    build: (row: ContractRow) => { reason: string; next_action: string; priority: OpenLoopPriority; due_at: string | null }
  ): Promise<SweepResult> {
    let detected = 0;
    let updated = 0;
    const currentKeys: string[] = [];
    for (const row of rows) {
      const detectionKey = `${loopType}:${row.contract_id}`;
      currentKeys.push(detectionKey);
      const built = build(row);
      const result = await upsertOpenLoop(client, {
        open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
        company_id: row.company_id, contact_id: row.contact_id, opportunity_id: null,
        lead_id: null, followup_id: null, activity_id: null, ticket_id: null, contract_id: row.contract_id, campaign_id: null,
        loop_type: loopType, detection_key: detectionKey, reason: built.reason, next_action: built.next_action,
        priority: built.priority, owner_person_id: row.owner_person_id, due_at: built.due_at
      });
      if (result === "inserted") detected++; else updated++;
    }
    const autoResolved = await autoResolveStale(client, tenantId, loopType, currentKeys);
    return { detected, updated, auto_resolved: autoResolved };
  }

  /**
   * UA-3 Native Jarvis Product Core (D-128): "Reuse OpenLoopService for
   * product-item triage - No second task/reminder engine" - et punkt i
   * `new` (aldri triagert) i `staleDays` dager er en stille glipp, ikke et
   * fravaer av produkt-arbeid. SAMME "stagnasjon"-heuristikk som
   * `detectContractsNeedingReview`.
   */
  async detectProductItemsNeedingTriage(tenantId: string, memorySpace: MemorySpace, staleDays = 7): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT item_id, company_id, contact_id, title, owner_person_id, created_at
         FROM product_items WHERE tenant_id = $1 AND status = 'new'
           AND created_at < now() - ($2 || ' days')::interval`,
        [tenantId, staleDays]
      );
      return this.upsertProductItemLoop(
        client, tenantId, memorySpace, rows.rows as ProductItemRow[], "product_item_needs_triage",
        (row) => ({ reason: `Produktpunkt "${row.title}" har ikke blitt triagert på ${staleDays} dager`, next_action: `Triager produktpunkt ${row.item_id}`, priority: "normal", due_at: null })
      );
    });
  }

  /**
   * En `high`/`critical`-prioritert punkt som IKKE er terminal (shipped/
   * declined/closed) og ikke har flyttet seg (`updated_at`) på `staleDays`
   * dager - en høyt prioritert sak som stagnerer er akkurat den typen
   * "open loop" masterplan-akseptansekriterium 3 skal fange automatisk.
   */
  async detectStalledHighPriorityProductItems(tenantId: string, memorySpace: MemorySpace, staleDays = 14): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT item_id, company_id, contact_id, title, owner_person_id, updated_at
         FROM product_items WHERE tenant_id = $1 AND priority IN ('high','critical')
           AND status NOT IN ('shipped','declined','closed')
           AND updated_at < now() - ($2 || ' days')::interval`,
        [tenantId, staleDays]
      );
      return this.upsertProductItemLoop(
        client, tenantId, memorySpace, rows.rows as ProductItemRow[], "product_item_high_priority_stalled",
        (row) => ({ reason: `Høyt prioritert produktpunkt "${row.title}" har stagnert i ${staleDays} dager`, next_action: `Følg opp produktpunkt ${row.item_id}`, priority: "high", due_at: null })
      );
    });
  }

  private async upsertProductItemLoop(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    rows: ProductItemRow[],
    loopType: OpenLoopType,
    build: (row: ProductItemRow) => { reason: string; next_action: string; priority: OpenLoopPriority; due_at: string | null }
  ): Promise<SweepResult> {
    let detected = 0;
    let updated = 0;
    const currentKeys: string[] = [];
    for (const row of rows) {
      const detectionKey = `${loopType}:${row.item_id}`;
      currentKeys.push(detectionKey);
      const built = build(row);
      const result = await upsertOpenLoop(client, {
        open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
        company_id: row.company_id, contact_id: row.contact_id, opportunity_id: null,
        lead_id: null, followup_id: null, activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
        product_item_id: row.item_id,
        loop_type: loopType, detection_key: detectionKey, reason: built.reason, next_action: built.next_action,
        priority: built.priority, owner_person_id: row.owner_person_id, due_at: built.due_at
      });
      if (result === "inserted") detected++; else updated++;
    }
    const autoResolved = await autoResolveStale(client, tenantId, loopType, currentKeys);
    return { detected, updated, auto_resolved: autoResolved };
  }

  /**
   * UA-3 Native Jarvis Operations Core (D-129): "Reuse OpenLoopService for
   * driftsoppgave-frister - No second task/reminder engine" - en
   * driftsoppgave med passert `due_at` som IKKE er terminal (done/
   * cancelled) er akkurat den typen "open loop" masterplan-
   * akseptansekriterium 3 skal fange automatisk. SAMME dag-basert
   * prioritets-heuristikk som `detectOverdueFollowups`.
   */
  async detectOverdueOperationsTasks(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT task_id, title, owner_person_id, due_at
         FROM operations_tasks WHERE tenant_id = $1 AND status NOT IN ('done','cancelled') AND due_at IS NOT NULL AND due_at < now()`,
        [tenantId]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows.rows as OperationsTaskRow[]) {
        const detectionKey = `operations_task_overdue:${row.task_id}`;
        currentKeys.push(detectionKey);
        const overdueDays = (Date.now() - new Date(row.due_at as string).getTime()) / 86_400_000;
        const priority: OpenLoopPriority = overdueDays > 3 ? "high" : "normal";
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          operations_task_id: row.task_id,
          loop_type: "operations_task_overdue", detection_key: detectionKey,
          reason: `Driftsoppgave "${row.title}" er forfalt`, next_action: `Fullfør eller avbryt driftsoppgave ${row.task_id}`,
          priority, owner_person_id: row.owner_person_id, due_at: row.due_at
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "operations_task_overdue", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * §13 "escalations": en driftsoppgave som har vært forfalt i mer enn
   * `escalationThresholdDays` dager UTEN å ha blitt eskalert
   * (`escalation_level = 0`) trenger et menneske/agent sin eksplisitte
   * `OperationsService.escalateTask`-handling. Deteksjonen overflater KUN
   * behovet - selve eskaleringen er en EGEN, sporbar handling (§ "Reuse
   * OpenLoopService, no second reminder/notification engine", samme
   * presedens som alle andre regler i denne filen). Auto-resolves neste
   * sveip når enten fristen ikke lenger er passert, oppgaven er
   * terminal, ELLER `escalation_level` har blitt inkrementert (ikke lenger
   * i WHERE-settet).
   */
  async detectOperationsTasksNeedingEscalation(tenantId: string, memorySpace: MemorySpace, escalationThresholdDays = 3): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `SELECT task_id, title, owner_person_id, due_at
         FROM operations_tasks
         WHERE tenant_id = $1 AND status NOT IN ('done','cancelled') AND escalation_level = 0
           AND due_at IS NOT NULL AND due_at < now() - ($2 || ' days')::interval`,
        [tenantId, escalationThresholdDays]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows.rows as OperationsTaskRow[]) {
        const detectionKey = `operations_task_escalation_needed:${row.task_id}`;
        currentKeys.push(detectionKey);
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          operations_task_id: row.task_id,
          loop_type: "operations_task_escalation_needed", detection_key: detectionKey,
          reason: `Driftsoppgave "${row.title}" har vært forfalt i over ${escalationThresholdDays} dager uten eskalering`,
          next_action: `Eskaler driftsoppgave ${row.task_id}`,
          priority: "high", owner_person_id: row.owner_person_id, due_at: row.due_at
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "operations_task_escalation_needed", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * WP-D2 (UA-3 «churn/product usage», migrasjon 090): koblede kundekontoer med forhøyet churn-risiko (middels/høy) blir en open loop `customer_churn_risk`. Regelen er
   * deterministisk og forklarbar (churn-rules.ts); `reason` lister signalene. Loopen er et FORSLAG/en opplysning til eieren (situasjonsbroen gir INFORM, SUGGEST kun ved
   * høy prioritet og confidence >= 0.75) og utløser ALDRI en handling selv - ACT kan kun komme fra en autonomi-policy EIEREN har bundet til domenet `retention`
   * (fravær av policy = ingen auto-ACT). Nøkkelen er KONTOEN (ikke selskapet): to produkter hos samme kunde vurderes hver for seg. Vurderingen beregnes på nytt her
   * (samme transaksjonsgrense som resten av sveipet) og loops hvis vilkår ikke lenger er sant lukkes automatisk.
   */
  async detectChurnRisk(tenantId: string, memorySpace: MemorySpace, options: { now?: Date } = {}): Promise<SweepResult> {
    const sweep = await new ChurnService(this.pool).assessTenant(tenantId, memorySpace, options);
    const atRisk = sweep.assessments.filter((a) => a.risk_level !== "low");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const a of atRisk) {
        const detectionKey = churnDetectionKey(a.account_ref); // digest, ikke referansen selv (PR #326 F2)
        currentKeys.push(detectionKey);
        const calc = { score: a.risk_score, level: a.risk_level, factors: a.signals };
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: a.company_id, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          loop_type: "customer_churn_risk", detection_key: detectionKey,
          reason: describeChurnRisk(calc), next_action: churnNextAction(calc),
          priority: a.risk_level === "high" ? "high" : "normal", owner_person_id: null, due_at: null,
          // WP-D2 (JARVIS-045): flere UAVHENGIGE signalfamilier (bruk, support, fakturering) som slår ut samtidig gir høyere sikkerhet.
          intrinsic_signals: Math.max(0, a.signal_families.length - 1)
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "customer_churn_risk", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * UA-4 Native Jarvis Growth Core (D-74): "Reuse OpenLoopService... No
   * second task/reminder engine" - deterministisk utgifts-avviksdeteksjon
   * for aktive kampanjer. En kampanjes SISTE registrerte utgiftsdag
   * sammenlignes mot det glidende 7-dagers-snittet FOR DEN SAMME kampanjen
   * (`AVG(...) OVER (... ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING)`) - REN
   * statistisk SQL, INGEN AI-tolkning av HVORFOR avviket skjedde (Q-26-
   * grensen: ingen inferert kausal påstand, kun et deterministisk faktum).
   * Terskel >50%/<50% av snittet, med et lite beløps-gulv (100 øre) for å
   * unngå støy fra ubetydelige beløp. Nøkkelen er kampanje-ID (ikke dato) -
   * samme "re-evaluer, oppdater SAMME rad til vilkåret ikke lenger er sant"-
   * mønster som `detectContractsNeedingReview`, IKKE en ny loop per dag.
   */
  async detectSpendAnomalies(tenantId: string, memorySpace: MemorySpace, deviationFactor = 1.5, minBaselineOre = 100): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const rows = await client.query(
        `WITH ranked AS (
           SELECT campaign_id, event_date, spend_amount_ore,
                  AVG(spend_amount_ore) OVER (
                    PARTITION BY campaign_id ORDER BY event_date
                    ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING
                  ) AS trailing_avg_ore,
                  ROW_NUMBER() OVER (PARTITION BY campaign_id ORDER BY event_date DESC) AS rn
           FROM marketing_spend_events WHERE tenant_id = $1
         )
         SELECT r.campaign_id, r.event_date, r.spend_amount_ore, r.trailing_avg_ore, c.name, c.owner_person_id
         FROM ranked r
         JOIN marketing_campaigns c ON c.tenant_id = $1 AND c.campaign_id = r.campaign_id
         WHERE r.rn = 1 AND c.status = 'active'
           AND r.trailing_avg_ore IS NOT NULL AND r.trailing_avg_ore >= $2
           AND (r.spend_amount_ore > r.trailing_avg_ore * $3 OR r.spend_amount_ore < r.trailing_avg_ore / $3)`,
        [tenantId, minBaselineOre, deviationFactor]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows.rows as SpendAnomalyRow[]) {
        const detectionKey = `marketing_spend_anomaly:${row.campaign_id}`;
        currentKeys.push(detectionKey);
        const direction = Number(row.spend_amount_ore) > Number(row.trailing_avg_ore) ? "over" : "under";
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: row.campaign_id,
          loop_type: "marketing_spend_anomaly", detection_key: detectionKey,
          reason: `Kampanje "${row.name}" sin utgift for ${row.event_date} (${formatMoney(row.spend_amount_ore, "NOK")}) er ${direction === "over" ? "vesentlig over" : "vesentlig under"} det glidende 7-dagers-snittet (${formatMoney(Math.round(Number(row.trailing_avg_ore)), "NOK")})`,
          next_action: `Gjennomgå utgiftsavvik for kampanje ${row.campaign_id}`, priority: direction === "over" ? "high" : "normal",
          owner_person_id: row.owner_person_id, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "marketing_spend_anomaly", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * UA-6 Finance & Spend Integrity Gateway (D-107) §"Reuse OpenLoopService
   * - no second task/reminder engine": deterministisk deteksjon direkte
   * mot `payment_intents` (REN SQL, IKKE en pakkeavhengighet -
   * `modules/business` kan ALDRI avhenge av `modules/finance`, samme
   * presedens som `detectSpendAnomalies()` mot `marketing_spend_events`).
   * To uavhengige, deterministiske betingelser (ALDRI AI-inferens - Q-26-
   * grensen): (1) en intensjon har ETT ELLER FLERE persisterte
   * `anomaly_flags` (satt av `FinanceService` ved opprettelse - manglende
   * vendor-/motkonto-referanse) OG er FORTSATT i en ikke-terminal tilstand
   * (draft/submitted/provider_acknowledged - en avviks-flagget intensjon
   * som ALLEREDE er oppgjort/kansellert/feilet trenger ingen ny open-loop);
   * (2) en intensjon er eksplisitt avstemt som `mismatched`
   * (`FinanceService.reconcilePaymentIntent(matched=false)`).
   */
  async detectPaymentAnomalies(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT payment_intent_id, purpose, vendor_name, amount_ore, currency, state, reconciliation_state, anomaly_flags, owner_person_id
         FROM payment_intents
         WHERE tenant_id = $1
           AND (
             (jsonb_array_length(anomaly_flags) > 0 AND (
               state IN ('draft','submitted','provider_acknowledged')
               -- D-392 (JARVIS-072): leverandørkonflikter på en allerede avsluttet intensjon (f.eks. sen TERMINATED mot settled) er ekte pengeavvik
               -- WP-F1 (JARVIS-072): det gjelder også avstemmingens egne funn (RECONCILE_*) og de øvrige pengeavvikene som kan stå igjen på en terminal intensjon
               -- (sen/motstridende leverandørhendelse, ukjent innsendingsutfall, refusjons-/capture-beløp som ikke stemmer, duplisert leverandøreffekt).
               -- Opprettelsesflagg (f.eks. manglende leverandørreferanse ved opprettelse) forblir uten loop på en avsluttet intensjon.
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(anomaly_flags) AS f(flag)
                  WHERE f.flag LIKE 'PROVIDER\\_%' OR f.flag LIKE 'RECONCILE\\_%'
                     OR f.flag IN ('WEBHOOK_STATE_CONFLICT', 'UNKNOWN_PROVIDER_OUTCOME', 'SUBMIT_OUTCOME_UNKNOWN', 'REFUND_AMOUNT_CONFLICT', 'CAPTURE_AMOUNT_CONFLICT', 'DUPLICATE_PROVIDER_EFFECT')
               )
             ))
             OR reconciliation_state = 'mismatched'
           )`,
        [tenantId]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows as Array<{
        payment_intent_id: string; purpose: string; vendor_name: string; amount_ore: string; currency: string;
        state: string; reconciliation_state: string; anomaly_flags: string[]; owner_person_id: string | null;
      }>) {
        const isMismatch = row.reconciliation_state === "mismatched";
        const loopType = isMismatch ? "payment_intent_reconciliation_mismatch" : "payment_intent_anomaly";
        const detectionKey = `${loopType}:${row.payment_intent_id}`;
        currentKeys.push(detectionKey);
        const reason = isMismatch
          ? `Betalingsintensjon "${row.purpose}" (${formatMoney(row.amount_ore, row.currency)} til ${row.vendor_name}) er avstemt som IKKE samsvarende med Fiken sin bokførte post`
          : `Betalingsintensjon "${row.purpose}" (${formatMoney(row.amount_ore, row.currency)} til ${row.vendor_name}) har uløste avvik: ${row.anomaly_flags.join(", ")}`;
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null, payment_intent_id: row.payment_intent_id,
          loop_type: loopType, detection_key: detectionKey, reason,
          next_action: isMismatch ? `Undersøk avstemmingsavvik for betalingsintensjon ${row.payment_intent_id}` : `Løs avvik før innsending for betalingsintensjon ${row.payment_intent_id}`,
          priority: isMismatch ? "high" : "normal", owner_person_id: row.owner_person_id, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolvedAnomaly = await autoResolveStale(client, tenantId, "payment_intent_anomaly", currentKeys.filter((k) => k.startsWith("payment_intent_anomaly:")));
      const autoResolvedMismatch = await autoResolveStale(client, tenantId, "payment_intent_reconciliation_mismatch", currentKeys.filter((k) => k.startsWith("payment_intent_reconciliation_mismatch:")));
      return { detected, updated, auto_resolved: autoResolvedAnomaly + autoResolvedMismatch };
    });
  }

  /**
   * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2, §10 i
   * byggeordren) §"Reuse OpenLoopService - no separate shadow task system":
   * fem deterministiske regler mot `finance_spend_records`/
   * `finance_recurring_commitments` - REN SQL, IKKE en pakkeavhengighet
   * (`modules/business` kan ALDRI avhenge av `modules/finance`, SAMME
   * presedens som `detectPaymentAnomalies()`/`detectSpendAnomalies()`
   * over). Selve avviksflaggene ER ALLEREDE beregnet deterministisk av
   * `SpendService.runAnomalyDetection()` (039-tabellenes `anomaly_flags`-
   * kolonner, jsonb) - disse fem metodene SURFACER dem KUN som open-loops,
   * de beregner INGENTING selv (samme rolle-deling som
   * `detectPaymentAnomalies()` mot `payment_intents.anomaly_flags`).
   */
  async detectUnexpectedSpend(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return this.surfaceSpendRecordAnomaly(tenantId, memorySpace, "UNEXPECTED_SPEND", "finance_spend_unexpected", "high",
      (row) => `Utgift på ${formatMoney(row.amount_ore, row.currency)} (${row.category}) skjedde etter at en tilknyttet forpliktelse ble satt på pause/kansellert`,
      (row) => `Gjennomgå uventet utgift ${row.spend_record_id}`);
  }

  async detectSpendAmountDeviation(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return this.surfaceSpendRecordAnomaly(tenantId, memorySpace, "AMOUNT_DEVIATION", "finance_spend_amount_deviation", "normal",
      (row) => `Utgift på ${formatMoney(row.amount_ore, row.currency)} (${row.category}) avviker fra tilknyttet forpliktelses forventede beløp utover toleransen`,
      (row) => `Undersøk beløpsavvik for utgift ${row.spend_record_id}`);
  }

  async detectSpendCorrectionConflicts(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return this.surfaceSpendRecordAnomaly(tenantId, memorySpace, "SOURCE_CORRECTION_CONFLICT", "finance_spend_correction_conflict", "high",
      (row) => `Kilden korrigerte utgift ${row.spend_record_id} (${row.category}) ETTER at posten allerede var avstemt - uløst konflikt, IKKE stille overskrevet`,
      (row) => `Løs kildekorreksjonskonflikt for utgift ${row.spend_record_id}`);
  }

  private async surfaceSpendRecordAnomaly(
    tenantId: string, memorySpace: MemorySpace, flag: string, loopType: OpenLoopType, priority: OpenLoopPriority,
    reason: (row: SpendRecordAnomalyRow) => string, nextAction: (row: SpendRecordAnomalyRow) => string
  ): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // `finance_spend_records` har BEVISST INGEN `owner_person_id`-kolonne
      // (039_finance_spend_integrity.sql - en observert utgiftspost speiler
      // en allerede-skjedd hendelse fra en delt kilde, ikke en eier-tilordnet
      // disposisjon som en forpliktelse/anskaffelse) - loopen opprettes derfor
      // UTEN eier (samme "ingen gjettet eier"-prinsipp som resten av Q-26-grensen).
      const { rows } = await client.query(
        `SELECT spend_record_id, campaign_id, amount_ore, currency, category
         FROM finance_spend_records WHERE tenant_id = $1 AND memory_space_id = $2 AND anomaly_flags @> $3::jsonb`,
        [tenantId, memorySpace, JSON.stringify([flag])]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows as SpendRecordAnomalyRow[]) {
        const detectionKey = `${loopType}:${row.spend_record_id}`;
        currentKeys.push(detectionKey);
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: row.campaign_id,
          finance_spend_record_id: row.spend_record_id, loop_type: loopType, detection_key: detectionKey,
          reason: reason(row), next_action: nextAction(row), priority, owner_person_id: null, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, loopType, currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  async detectMissingRecurringCharges(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return this.surfaceCommitmentAnomaly(tenantId, memorySpace, "MISSING_EXPECTED_SPEND", "finance_recurring_charge_missing", "high",
      (row) => `Forpliktelse "${row.description}" til ${row.vendor_name} (${formatMoney(row.expected_amount_ore, row.currency)}) har uteblitt lenger enn forventet belastningsvindu`,
      (row) => `Undersøk uteblitt belastning for forpliktelse ${row.commitment_id}`);
  }

  async detectDuplicateRecurringCharges(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return this.surfaceCommitmentAnomaly(tenantId, memorySpace, "DUPLICATE_RECURRING_CHARGE", "finance_recurring_charge_duplicate", "high",
      (row) => `Forpliktelse "${row.description}" til ${row.vendor_name} har flere koblede utgifter innenfor samme kadanse-periode - mulig dobbelbelastning`,
      (row) => `Undersøk mulig dobbelbelastning for forpliktelse ${row.commitment_id}`);
  }

  private async surfaceCommitmentAnomaly(
    tenantId: string, memorySpace: MemorySpace, flag: string, loopType: OpenLoopType, priority: OpenLoopPriority,
    reason: (row: CommitmentAnomalyRow) => string, nextAction: (row: CommitmentAnomalyRow) => string
  ): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT commitment_id, vendor_name, description, expected_amount_ore, currency, owner_person_id
         FROM finance_recurring_commitments WHERE tenant_id = $1 AND memory_space_id = $2 AND anomaly_flags @> $3::jsonb`,
        [tenantId, memorySpace, JSON.stringify([flag])]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows as CommitmentAnomalyRow[]) {
        const detectionKey = `${loopType}:${row.commitment_id}`;
        currentKeys.push(detectionKey);
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          finance_recurring_commitment_id: row.commitment_id, loop_type: loopType, detection_key: detectionKey,
          reason: reason(row), next_action: nextAction(row), priority, owner_person_id: row.owner_person_id, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, loopType, currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * UA-6 closeout (D-115): `finance_procurement_items.anomaly_flags`
   * (MISSING_EXPECTED_SPEND, satt av SpendService.runAnomalyDetection() siden
   * Slice 2) manglet en surfacing-regel - SAMME rolle-deling som
   * `surfaceCommitmentAnomaly()` (denne metoden beregner INGENTING selv, kun
   * overflater et allerede-satt avviksflagg).
   */
  async detectMissingProcurementFulfillment(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return this.surfaceProcurementAnomaly(tenantId, memorySpace, "MISSING_EXPECTED_SPEND", "finance_procurement_missing", "high",
      (row) => `Anskaffelse "${row.description}" fra ${row.vendor_name} (${formatMoney(row.expected_amount_ore, row.currency)}, forventet ${row.expected_date}) er uteblitt utover det forventede vinduet`,
      (row) => `Undersøk uteblitt anskaffelse ${row.procurement_item_id}`);
  }

  private async surfaceProcurementAnomaly(
    tenantId: string, memorySpace: MemorySpace, flag: string, loopType: OpenLoopType, priority: OpenLoopPriority,
    reason: (row: ProcurementAnomalyRow) => string, nextAction: (row: ProcurementAnomalyRow) => string
  ): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT procurement_item_id, vendor_name, description, expected_amount_ore, currency, expected_date, owner_person_id
         FROM finance_procurement_items WHERE tenant_id = $1 AND memory_space_id = $2 AND anomaly_flags @> $3::jsonb`,
        [tenantId, memorySpace, JSON.stringify([flag])]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows as ProcurementAnomalyRow[]) {
        const detectionKey = `${loopType}:${row.procurement_item_id}`;
        currentKeys.push(detectionKey);
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          finance_procurement_item_id: row.procurement_item_id, loop_type: loopType, detection_key: detectionKey,
          reason: reason(row), next_action: nextAction(row), priority, owner_person_id: row.owner_person_id, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, loopType, currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /** Full sweep: alle deterministiske regler - trygt aa kalle gjentatte ganger (idempotent). */
  /**
   * UA-6 Slice 5 (D-111, byggeordrens §16): en booket banktransaksjon med
   * persisterte `anomaly_flags` (satt deterministisk av BankingService -
   * unmatched debet/kredit, korreksjonskonflikt, stor debet, duplikat,
   * betalings-mismatch) overflates som ÉN `bank_transaction_unmatched`-
   * loop per transaksjon. REN SQL mot 042-tabellen - INGEN
   * pakkeavhengighet (samme presedens som detectPaymentAnomalies()).
   */
  async detectBankTransactionAnomalies(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT bank_transaction_id, direction, amount_ore, currency, counterparty_name, anomaly_flags
         FROM bank_transactions
         WHERE tenant_id = $1 AND jsonb_array_length(anomaly_flags) > 0`,
        [tenantId]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows as Array<{ bank_transaction_id: string; direction: string; amount_ore: string; currency: string; counterparty_name: string | null; anomaly_flags: string[] }>) {
        const detectionKey = `bank_transaction_unmatched:${row.bank_transaction_id}`;
        currentKeys.push(detectionKey);
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          loop_type: "bank_transaction_unmatched", detection_key: detectionKey,
          reason: `Banktransaksjon ${row.bank_transaction_id} (${row.direction === "debit" ? "utgående" : "inngående"} ${formatMoney(row.amount_ore, row.currency)}${row.counterparty_name ? ` - ${row.counterparty_name}` : ""}) har uløste bankavvik: ${row.anomaly_flags.join(", ")}`,
          next_action: `Undersøk og avstem banktransaksjon ${row.bank_transaction_id}`,
          priority: row.anomaly_flags.includes("UNEXPECTED_LARGE_DEBIT") ? "high" : "normal",
          owner_person_id: null, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "bank_transaction_unmatched", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * UA-6 Slice 5 (D-111): et banksamtykke i en tilstand som krever
   * MENNESKELIG handling (utløpt/tilbakekalt/avvist/venter-SCA) betyr
   * reelt tapt kontotilgang - overflates som `bank_consent_attention`.
   * SCA er alltid en brukerhandling (aldri automatiserbar), så loop-en
   * er nettopp «be Tobias handle», ikke en retry.
   */
  async detectBankConsentAttention(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT consent_id, bank_id, bank_name, state FROM bank_consents
         WHERE tenant_id = $1 AND state IN ('authorization_required', 'expired', 'revoked', 'rejected')`,
        [tenantId]
      );
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      for (const row of rows as Array<{ consent_id: string; bank_id: string; bank_name: string | null; state: string }>) {
        const detectionKey = `bank_consent_attention:${row.consent_id}`;
        currentKeys.push(detectionKey);
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          loop_type: "bank_consent_attention", detection_key: detectionKey,
          reason: `Banksamtykke ${row.consent_id} (${row.bank_name ?? row.bank_id}) er i tilstand '${row.state}' - kontotilgang krever brukerhandling (SCA hos banken)`,
          next_action: row.state === "authorization_required" ? `Fullfør bankautorisering for samtykke ${row.consent_id}` : `Opprett/reautoriser banksamtykke for ${row.bank_name ?? row.bank_id}`,
          priority: "high", owner_person_id: null, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "bank_consent_attention", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

  /**
   * UA-6 Slice 6 (D-112): en korttransaksjon ELLER et kort med uløste
   * deterministiske avviksflagg (satt av CardService - ALDRI AI-inferert,
   * Q-26) overflates som `card_anomaly_attention`. Selv-korrigerende via
   * SAMME upsert/autoResolveStale-mønster som bankreglene over.
   */
  async detectCardAnomalies(tenantId: string, memorySpace: MemorySpace): Promise<SweepResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let detected = 0;
      let updated = 0;
      const currentKeys: string[] = [];
      const { rows: txRows } = await client.query(
        `SELECT ct.card_transaction_id, ct.amount_ore, ct.currency, ct.merchant_name, ct.anomaly_flags, pc.name AS card_name
         FROM card_transactions ct JOIN provider_cards pc ON pc.card_id = ct.card_id AND pc.tenant_id = ct.tenant_id
         WHERE ct.tenant_id = $1 AND jsonb_array_length(ct.anomaly_flags) > 0`,
        [tenantId]
      );
      for (const row of txRows as Array<{ card_transaction_id: string; amount_ore: string; currency: string; merchant_name: string | null; anomaly_flags: string[]; card_name: string }>) {
        const detectionKey = `card_anomaly_attention:tx:${row.card_transaction_id}`;
        currentKeys.push(detectionKey);
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          loop_type: "card_anomaly_attention", detection_key: detectionKey,
          reason: `Korttransaksjon ${row.card_transaction_id} (${formatMoney(row.amount_ore, row.currency)}${row.merchant_name ? ` - ${row.merchant_name}` : ""}, kort «${row.card_name}») har uløste kortavvik: ${row.anomaly_flags.join(", ")}`,
          next_action: `Undersøk korttransaksjon ${row.card_transaction_id}`,
          priority: row.anomaly_flags.some((f) => f === "DUPLICATE_ECONOMIC_EFFECT" || f === "CARD_SPEND_AFTER_FREEZE" || f === "CARD_SPEND_AFTER_CLOSE") ? "high" : "normal",
          owner_person_id: null, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const { rows: cardRows } = await client.query(
        `SELECT card_id, name, anomaly_flags FROM provider_cards WHERE tenant_id = $1 AND jsonb_array_length(anomaly_flags) > 0`,
        [tenantId]
      );
      for (const row of cardRows as Array<{ card_id: string; name: string; anomaly_flags: string[] }>) {
        const detectionKey = `card_anomaly_attention:card:${row.card_id}`;
        currentKeys.push(detectionKey);
        const result = await upsertOpenLoop(client, {
          open_loop_id: `biz-ol-${randomUUID()}`, tenant_id: tenantId, memory_space: memorySpace,
          company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null,
          activity_id: null, ticket_id: null, contract_id: null, campaign_id: null,
          loop_type: "card_anomaly_attention", detection_key: detectionKey,
          reason: `Kort «${row.name}» (${row.card_id}) har uløste kortavvik: ${row.anomaly_flags.join(", ")}`,
          next_action: `Undersøk kort ${row.card_id}`,
          priority: "high", owner_person_id: null, due_at: null
        });
        if (result === "inserted") detected++; else updated++;
      }
      const autoResolved = await autoResolveStale(client, tenantId, "card_anomaly_attention", currentKeys);
      return { detected, updated, auto_resolved: autoResolved };
    });
  }

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
      await this.detectSupportTicketsWaitingInternal(tenantId, memorySpace),
      // UA-3 Native Jarvis Contracts Core (D-71): samme prinsipp - reglene
      // kjøres i DENNE sveipen, krever `contracts`/`contract_obligations`
      // (026_contracts.sql).
      await this.detectContractRenewalsDue(tenantId, memorySpace),
      await this.detectContractTerminationDeadlines(tenantId, memorySpace),
      await this.detectContractObligationsDue(tenantId, memorySpace),
      await this.detectContractsNeedingReview(tenantId, memorySpace),
      // UA-3 Native Jarvis Product Core (D-128): samme prinsipp - reglene
      // kjøres i DENNE sveipen, krever `product_items` (047_product.sql).
      await this.detectProductItemsNeedingTriage(tenantId, memorySpace),
      await this.detectStalledHighPriorityProductItems(tenantId, memorySpace),
      // UA-3 Native Jarvis Operations Core (D-129): samme prinsipp - reglene
      // kjøres i DENNE sveipen, krever `operations_tasks` (048_operations.sql).
      await this.detectOverdueOperationsTasks(tenantId, memorySpace),
      await this.detectOperationsTasksNeedingEscalation(tenantId, memorySpace),
      // WP-D2 (UA-3 «churn/product usage»): samme prinsipp - regelen kjøres i DENNE
      // sveipen, krever `product_usage_*`/`business_churn_assessments` (090). Uten
      // koblede kontoer er den en no-op (ingen produktbruk-kilde er på som standard).
      await this.detectChurnRisk(tenantId, memorySpace),
      // UA-4 Native Jarvis Growth Core (D-74): samme prinsipp - regelen
      // kjøres i DENNE sveipen, krever `marketing_campaigns`/
      // `marketing_spend_events` (027_growth.sql).
      await this.detectSpendAnomalies(tenantId, memorySpace),
      // UA-6 Finance & Spend Integrity Gateway (D-107): samme prinsipp -
      // regelen kjøres i DENNE sveipen, krever `payment_intents`
      // (038_finance.sql).
      await this.detectPaymentAnomalies(tenantId, memorySpace),
      // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2):
      // samme prinsipp - reglene kjøres i DENNE sveipen, krever
      // `finance_spend_records`/`finance_recurring_commitments`
      // (039_finance_spend_integrity.sql). SpendService sin egen
      // `runFullSweep()` (synk/matching/deteksjon) kjøres FØR denne
      // sveipen (egen DailyScheduler-jobb, tidligere klokkeslett - se
      // apps/api/src/main.ts) slik at flaggene disse fem reglene SURFACER
      // allerede er ferske når DENNE sveipen kjører.
      await this.detectUnexpectedSpend(tenantId, memorySpace),
      await this.detectSpendAmountDeviation(tenantId, memorySpace),
      await this.detectMissingRecurringCharges(tenantId, memorySpace),
      await this.detectDuplicateRecurringCharges(tenantId, memorySpace),
      await this.detectSpendCorrectionConflicts(tenantId, memorySpace),
      // UA-6 closeout (D-115): finance_procurement_items sitt
      // MISSING_EXPECTED_SPEND-flagg (SpendService.runAnomalyDetection(),
      // Slice 2) manglet en surfacing-regel - samme sveip-rekkefølge-
      // begrunnelse som forpliktelses-reglene over.
      await this.detectMissingProcurementFulfillment(tenantId, memorySpace),
      // UA-6 Slice 5 (D-111): samme prinsipp - reglene kjøres i DENNE
      // sveipen, krever `bank_transactions`/`bank_consents`
      // (042_neonomics.sql). Selve flaggene er allerede beregnet
      // deterministisk av BankingService sine sveip.
      await this.detectBankTransactionAnomalies(tenantId, memorySpace),
      await this.detectBankConsentAttention(tenantId, memorySpace),
      await this.detectCardAnomalies(tenantId, memorySpace)
    ];
    // WP-D2 (JARVIS-045): confidence fra flere signaler skrives SIST, etter at alle detektorene har (re)skrevet basisverdien. Feiler den, feiler sveipet synlig (deteksjonene er allerede
    // committet) - aldri en stille manglende justering.
    await this.refineConfidence(tenantId, memorySpace);
    return results.reduce(
      (acc, r) => ({ detected: acc.detected + r.detected, updated: acc.updated + r.updated, auto_resolved: acc.auto_resolved + r.auto_resolved }),
      { detected: 0, updated: 0, auto_resolved: 0 }
    );
  }

  async listOpenLoops(tenantId: string, memorySpace: MemorySpace, status: "open" | "resolved" | "all" = "open"): Promise<BusinessOpenLoop[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        status === "all"
          ? `SELECT * FROM business_open_loops WHERE tenant_id = $1 ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, due_at ASC NULLS LAST`
          : `SELECT * FROM business_open_loops WHERE tenant_id = $1 AND status = $2 ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, due_at ASC NULLS LAST`,
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
    // D-121: bucket-regelen er flyttet UENDRET til `classifyAttentionBucket()`
    // (open-loop-types.ts) slik at den kanal-bevisste tverr-kanal-visningen
    // deler NOEYAKTIG samme regel - ingen ny/parallell prioriteringsmodell.
    return loops.map((loop) => ({ bucket: classifyAttentionBucket(loop.priority, loop.due_at, now), loop }));
  }

  /**
   * Lukker en loop manuelt. WP-D2 (JARVIS-045): valgfritt `outcome` (`acted` = du handlet på den, `dismissed` = irrelevant) gjør lukkingen til kalibreringsgrunnlag; uten utfall er
   * loopen umerket (teller verken som treff eller bom). Ugyldig utfall avvises FØR noe skrives.
   */
  async resolveOpenLoop(
    tenantId: string, memorySpace: MemorySpace, openLoopId: string, resolutionReason: string, outcome?: Extract<LoopResolutionOutcome, "acted" | "dismissed">
  ): Promise<BusinessOpenLoop | null> {
    if (outcome !== undefined && !(MANUAL_RESOLUTION_OUTCOMES as readonly string[]).includes(outcome)) throw new Error(`open_loop_outcome_invalid: ${String(outcome)}`);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE business_open_loops SET status = 'resolved', resolved_at = now(), resolution_reason = $1, resolution_outcome = $4, updated_at = now()
         WHERE tenant_id = $2 AND open_loop_id = $3 AND status = 'open' RETURNING *`,
        [resolutionReason, tenantId, openLoopId, outcome ?? null]
      );
      return (rows[0] as BusinessOpenLoop) ?? null;
    });
  }

  /**
   * WP-D2 (JARVIS-045): kalibreringsrapport - forutsagt confidence mot faktisk utfall, samlet og per loop-type (treffrate, gap, Brier, pålitelighetsbøtter). Ren lesing. Kun loops
   * åpnet de siste `sinceDays` dagene (standard 365). Umerkede utfall (`condition_cleared`, lukket uten utfall) og åpne loops telles separat - aldri som treff eller bom.
   */
  async calibrationReport(tenantId: string, memorySpace: MemorySpace, options: { sinceDays?: number } = {}): Promise<CalibrationReport> {
    const sinceDays = Math.min(Math.max(Math.trunc(options.sinceDays ?? 365), 7), 1095);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // Levende rader (åpnet i vinduet) + tidligere MERKEDE lukkinger av loops som siden er gjenåpnet (closure_history, vindu på lukketidspunktet): uten det ville «avvist, men vilkåret
      // holdt» forsvunnet fra kalibreringen ved gjenåpning (survivorship).
      const { rows } = await client.query(
        `SELECT loop_type, confidence::float8 AS confidence, status, resolution_outcome
           FROM business_open_loops WHERE tenant_id = $1 AND opened_at > now() - make_interval(days => $2)
         UNION ALL
         SELECT l.loop_type, (h.e->>'confidence')::float8, 'resolved', h.e->>'outcome'
           FROM business_open_loops l CROSS JOIN LATERAL jsonb_array_elements(l.closure_history) AS h(e)
          WHERE l.tenant_id = $1 AND (h.e->>'closed_at')::timestamptz > now() - make_interval(days => $2)`,
        [tenantId, sinceDays]
      );
      const observations = (rows as Array<{ loop_type: string; confidence: number | null; status: string; resolution_outcome: LoopResolutionOutcome | null }>).map((r): CalibrationObservation => ({
        loop_type: r.loop_type,
        confidence: r.confidence,
        outcome: (r.status === "open" ? "open" : r.resolution_outcome ?? "unlabelled") as LoopOutcome
      }));
      return buildCalibrationReport(observations);
    });
  }

  /**
   * WP-D2 (JARVIS-045): skriver `confidence` for ALLE åpne deterministiske loops fra flere signaler (se confidence.ts): persistens, forfallsstørrelse, uavhengig bekreftelse fra andre
   * domener hos samme kunde, regelens egne signalfamilier og - når nok merkede utfall finnes - observert treffrate for loop-typen. Detektorene skriver fortsatt basisverdien ved
   * hver (re)deteksjon; denne passeringen (kjørt sist i `runSweep`) legger evidensen oppå. Idempotent: returnerer antall loops som faktisk ble endret (andre kjøring = 0).
   */
  async refineConfidence(tenantId: string, memorySpace: MemorySpace): Promise<number> {
    const calibration = calibrationByType(await this.calibrationReport(tenantId, memorySpace));
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT open_loop_id, loop_type, company_id, confidence::float8 AS confidence, confidence_basis,
                EXTRACT(EPOCH FROM (now() - opened_at)) / 86400 AS persisted_days,
                CASE WHEN due_at IS NOT NULL AND due_at < now() THEN EXTRACT(EPOCH FROM (now() - due_at)) / 86400 END AS overdue_days
           FROM business_open_loops WHERE tenant_id = $1 AND status = 'open' AND detection_method = 'deterministic'`,
        [tenantId]
      );
      const loops = rows as Array<{
        open_loop_id: string; loop_type: string; company_id: string | null; confidence: number | null; confidence_basis: Record<string, unknown> | null;
        persisted_days: string | number; overdue_days: string | number | null;
      }>;
      // Hvilke domenefamilier har åpne loops hos hver kunde? (distinkte familier - to loops i samme domene bekrefter ikke hverandre)
      const familiesByCompany = new Map<string, Set<string>>();
      for (const l of loops) {
        if (l.company_id === null) continue;
        const set = familiesByCompany.get(l.company_id) ?? new Set<string>();
        set.add(loopFamily(l.loop_type));
        familiesByCompany.set(l.company_id, set);
      }
      let changed = 0;
      for (const l of loops) {
        const own = loopFamily(l.loop_type);
        const corroborating = l.company_id === null ? 0 : [...(familiesByCompany.get(l.company_id) ?? [])].filter((f) => corroboratesEachOther(own, f)).length;
        const intrinsic = Number((l.confidence_basis as { intrinsic_signals?: unknown } | null)?.intrinsic_signals ?? 0);
        const result = computeLoopConfidence({
          loop_type: l.loop_type,
          persisted_days: Number(l.persisted_days),
          overdue_days: l.overdue_days === null ? null : Number(l.overdue_days),
          corroborating_domains: corroborating,
          intrinsic_signals: Number.isFinite(intrinsic) ? intrinsic : 0,
          calibration: calibration.get(l.loop_type) ?? null
        });
        const sameBasis = l.confidence_basis !== null && canonicalStringify(l.confidence_basis as never) === canonicalStringify(result.basis as never);
        if (l.confidence !== null && Math.abs(l.confidence - result.confidence) < 0.0001 && sameBasis) continue;
        await client.query(
          `UPDATE business_open_loops SET confidence = $1, confidence_basis = $2::jsonb WHERE tenant_id = $3 AND open_loop_id = $4 AND status = 'open'`,
          [result.confidence, JSON.stringify(result.basis), tenantId, l.open_loop_id]
        );
        changed += 1;
      }
      return changed;
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
  /** WP-D2 (JARVIS-082): tidligste gjeldende frist og om den utledede svarfristen er brutt (kun satt av `detectOverdueSupportTickets`). */
  due_at?: string | Date | null;
  sla_breach?: boolean;
}

interface ContractRow {
  contract_id: string;
  company_id: string | null;
  contact_id: string | null;
  title: string;
  owner_person_id: string | null;
  renewal_date?: string | null;
  termination_deadline?: string | null;
  updated_at?: string;
}

/** UA-3 Native Jarvis Product Core (D-128). */
interface ProductItemRow {
  item_id: string;
  company_id: string | null;
  contact_id: string | null;
  title: string;
  owner_person_id: string | null;
  created_at?: string;
  updated_at?: string;
}

/** UA-3 Native Jarvis Operations Core (D-129). */
interface OperationsTaskRow {
  task_id: string;
  title: string;
  owner_person_id: string | null;
  due_at: string | null;
}

interface ContractObligationRow {
  obligation_id: string;
  contract_id: string;
  description: string;
  due_at: string | null;
  owner_person_id: string | null;
  company_id: string | null;
  contact_id: string | null;
  title: string;
}

interface SpendAnomalyRow {
  campaign_id: string;
  event_date: string;
  spend_amount_ore: string;
  trailing_avg_ore: string;
  name: string;
  owner_person_id: string | null;
}

/** UA-6 Finance & Spend Integrity Gateway Slice 2 (039_finance_spend_integrity.sql). */
interface SpendRecordAnomalyRow {
  spend_record_id: string;
  campaign_id: string | null;
  amount_ore: string;
  currency: string;
  category: string;
}

interface CommitmentAnomalyRow {
  commitment_id: string;
  vendor_name: string;
  description: string;
  expected_amount_ore: string;
  currency: string;
  owner_person_id: string | null;
}

/** UA-6 closeout (D-115, 044_finance_procurement_openloop.sql). */
interface ProcurementAnomalyRow {
  procurement_item_id: string;
  vendor_name: string;
  description: string;
  expected_amount_ore: string;
  currency: string;
  expected_date: string;
  owner_person_id: string | null;
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
  contract_id: string | null;
  campaign_id: string | null;
  /** UA-6 Finance & Spend Integrity Gateway (D-107): peker til `payment_intents`, null/utelatt for ikke-finans-loops. Valgfri (default null) for aa unngaa aa roere de 6 eksisterende kallstedene. */
  payment_intent_id?: string | null;
  /** UA-6 Finance & Spend Integrity Gateway Slice 2: peker til `finance_spend_records`/`finance_recurring_commitments`, null/utelatt for ikke-utgifts-loops. */
  finance_spend_record_id?: string | null;
  finance_recurring_commitment_id?: string | null;
  /** UA-6 closeout (D-115): peker til `finance_procurement_items`, null/utelatt for ikke-anskaffelses-loops. */
  finance_procurement_item_id?: string | null;
  /** UA-3 Native Jarvis Product Core (D-128): peker til `product_items`, null/utelatt for ikke-produkt-loops. */
  product_item_id?: string | null;
  /** UA-3 Native Jarvis Operations Core (D-129): peker til `operations_tasks`, null/utelatt for ikke-driftsoppgave-loops. */
  operations_task_id?: string | null;
  loop_type: string;
  detection_key: string;
  reason: string;
  next_action: string | null;
  priority: OpenLoopPriority;
  owner_person_id: string | null;
  due_at: string | null;
  /** WP-D2 (JARVIS-045): ekstra uavhengige signalfamilier regelen selv fant (0/utelatt = én). Lagres i `confidence_basis` og leses av `refineConfidence`. */
  intrinsic_signals?: number;
}

/** En lukket loop gjenåpnes av neste deteksjon: auto-lukket (vilkåret forsvant) umiddelbart, ellers først etter 7-dagers-undertrykkelsen (D-396). Eksakt komplement av status-CASE under (også ved manglende resolved_at). */
const REOPENS_SQL = `(business_open_loops.status = 'resolved' AND NOT COALESCE(business_open_loops.resolution_reason IS DISTINCT FROM 'condition_no_longer_true' AND business_open_loops.resolved_at > now() - interval '7 days', false))`;
/** Maks antall tidligere merkede lukkinger (utfall + confidence ved lukking) som beholdes per loop - de nyeste. */
const CLOSURE_HISTORY_MAX = 100;

async function upsertOpenLoop(client: pg.PoolClient, input: UpsertOpenLoopInput): Promise<"inserted" | "updated"> {
  const { rows } = await client.query(
    `INSERT INTO business_open_loops
       (open_loop_id, tenant_id, memory_space_id, company_id, contact_id, opportunity_id, lead_id, followup_id, activity_id,
        ticket_id, contract_id, campaign_id, payment_intent_id, finance_spend_record_id, finance_recurring_commitment_id,
        finance_procurement_item_id, product_item_id, operations_task_id, loop_type, detection_key, reason, next_action, priority, owner_person_id, due_at,
        detection_method, confidence, confidence_basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, 'deterministic', $26, $27::jsonb)
     ON CONFLICT (tenant_id, detection_key) DO UPDATE SET
       -- Gjenaapning (§9 i byggeordren): en tidligere resolved loop for SAMME vilkaar settes
       -- eksplisitt tilbake til 'open' med ny opened_at - historikken bevares i audit_events,
       -- ikke som en ny rad for samme detection_key.
       -- D-396 (JARVIS-082): en loop eieren/operatøren selv har lukket (resolution_reason <> 'condition_no_longer_true') gjenåpnes IKKE av det
       -- neste sveipet - da var «lukk» umulig. Undertrykkelsen varer 7 dager; er vilkåret fortsatt sant etter det, gjenåpnes den (uendret §9).
       -- Auto-løste loops (vilkåret forsvant) gjenåpnes umiddelbart når vilkåret kommer tilbake.
       status = CASE WHEN business_open_loops.status = 'resolved'
                      AND business_open_loops.resolution_reason IS DISTINCT FROM 'condition_no_longer_true'
                      AND business_open_loops.resolved_at > now() - interval '7 days'
                     THEN 'resolved' ELSE 'open' END,
       opened_at = CASE WHEN business_open_loops.status = 'resolved' AND NOT (business_open_loops.resolution_reason IS DISTINCT FROM 'condition_no_longer_true'
                                                                               OR business_open_loops.resolved_at <= now() - interval '7 days')
                        THEN business_open_loops.opened_at
                        WHEN business_open_loops.status = 'resolved' THEN now() ELSE business_open_loops.opened_at END,
       resolved_at = CASE WHEN business_open_loops.status = 'resolved'
                           AND (business_open_loops.resolution_reason IS NOT DISTINCT FROM 'condition_no_longer_true'
                                OR business_open_loops.resolved_at <= now() - interval '7 days')
                          THEN NULL ELSE business_open_loops.resolved_at END,
       resolution_reason = CASE WHEN business_open_loops.status = 'resolved'
                                 AND (business_open_loops.resolution_reason IS NOT DISTINCT FROM 'condition_no_longer_true'
                                      OR business_open_loops.resolved_at <= now() - interval '7 days')
                                THEN NULL ELSE business_open_loops.resolution_reason END,
       -- WP-D2 (091): et utfall hører til lukkingen - gjenåpning nullstiller det sammen med grunnen.
       resolution_outcome = CASE WHEN business_open_loops.status = 'resolved'
                                  AND (business_open_loops.resolution_reason IS NOT DISTINCT FROM 'condition_no_longer_true'
                                       OR business_open_loops.resolved_at <= now() - interval '7 days')
                                 THEN NULL ELSE business_open_loops.resolution_outcome END,
       -- WP-D2 (091, JARVIS-045): et MERKET utfall (acted/dismissed) forsvinner ikke når samme vilkår gjenåpner loopen - da ville kun lukkinger som faktisk løste saken overlevd
       -- som kalibreringsgrunnlag (survivorship: «avvist, men vilkåret holder» ble usynlig og treffraten overvurdert). Utfallet og confidence ved lukking flyttes til closure_history.
       closure_history = CASE WHEN ${REOPENS_SQL} AND business_open_loops.resolution_outcome IN ('acted', 'dismissed') AND business_open_loops.confidence IS NOT NULL
                              THEN (SELECT COALESCE(jsonb_agg(x.e ORDER BY x.ord), '[]'::jsonb)
                                      FROM (SELECT t.e, t.ord
                                              FROM jsonb_array_elements(business_open_loops.closure_history || jsonb_build_array(jsonb_build_object(
                                                     'outcome', business_open_loops.resolution_outcome, 'confidence', business_open_loops.confidence, 'closed_at', business_open_loops.resolved_at
                                                   ))) WITH ORDINALITY AS t(e, ord)
                                             ORDER BY t.ord DESC LIMIT ${CLOSURE_HISTORY_MAX}) x)
                              ELSE business_open_loops.closure_history END,
       -- WP-D2 (091): detektoren skriver KUN grunnverdien ved ny/gjenåpnet loop. En vanlig re-deteksjon nullstiller ikke lenger confidence til grunnverdien (en enkeltdetektor kjørt utenom
       -- runSweep ville ellers løftet en kalibrert/nedjustert verdi tilbake til 0.9 til neste fulle sveip), og en loop som holdes lukket (7-dagers-undertrykkelsen) beholder verdien den ble
       -- lukket med. refineConfidence er eneste skriver ellers; churn-loopens signalfamilie-tall (hint) flettes inn i forklaringen uten å slette resten.
       confidence = CASE WHEN ${REOPENS_SQL} OR business_open_loops.confidence IS NULL THEN EXCLUDED.confidence ELSE business_open_loops.confidence END,
       confidence_basis = CASE WHEN ${REOPENS_SQL} THEN EXCLUDED.confidence_basis
                               WHEN EXCLUDED.confidence_basis IS NULL THEN business_open_loops.confidence_basis
                               ELSE COALESCE(business_open_loops.confidence_basis, '{}'::jsonb) || EXCLUDED.confidence_basis END,
       reason = EXCLUDED.reason, priority = EXCLUDED.priority, due_at = EXCLUDED.due_at, updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      input.open_loop_id, input.tenant_id, input.memory_space, input.company_id, input.contact_id,
      input.opportunity_id, input.lead_id, input.followup_id, input.activity_id, input.ticket_id, input.contract_id, input.campaign_id,
      input.payment_intent_id ?? null, input.finance_spend_record_id ?? null, input.finance_recurring_commitment_id ?? null,
      input.finance_procurement_item_id ?? null, input.product_item_id ?? null, input.operations_task_id ?? null,
      input.loop_type, input.detection_key, input.reason, input.next_action, input.priority, input.owner_person_id, input.due_at,
      deterministicLoopConfidence(input.loop_type),
      input.intrinsic_signals !== undefined ? JSON.stringify({ intrinsic_signals: Math.max(0, Math.trunc(input.intrinsic_signals)) }) : null
    ]
  );
  return (rows[0] as { inserted: boolean }).inserted ? "inserted" : "updated";
}

/** §9: en tidligere aapen loop hvis vilkaar IKKE lenger er sant (ikke i currentKeys) resolves automatisk. */
async function autoResolveStale(client: pg.PoolClient, tenantId: string, loopType: string, currentKeys: string[]): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE business_open_loops SET status = 'resolved', resolved_at = now(), resolution_reason = 'condition_no_longer_true', resolution_outcome = 'condition_cleared', updated_at = now()
     WHERE tenant_id = $1 AND loop_type = $2 AND status = 'open' AND NOT (detection_key = ANY($3))`,
    [tenantId, loopType, currentKeys]
  );
  return rowCount ?? 0;
}

/**
 * D-396 (JARVIS-082): beløp lagres i øre (bigint kommer som streng fra pg), men begrunnelser lest av mennesker skal si kroner -
 * «50000 NOK» for 500 kr var en tusen-gangers misvisning. Eksakt heltallsaritmetikk (ingen flyttall).
 */
export function formatMoney(amountOre: string | number | bigint | null | undefined, currency?: string): string {
  if (amountOre === null || amountOre === undefined) return currency ? `ukjent beløp ${currency}` : "ukjent beløp";
  let ore: bigint;
  try {
    ore = BigInt(typeof amountOre === "number" ? Math.round(amountOre) : amountOre);
  } catch {
    return currency ? `ukjent beløp ${currency}` : "ukjent beløp";
  }
  const negative = ore < 0n;
  const abs = negative ? -ore : ore;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole},${frac}${currency ? ` ${currency}` : ""}`;
}
