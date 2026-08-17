import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type {
  BusinessActivity,
  BusinessCompany,
  BusinessContact,
  BusinessFollowup,
  BusinessLead,
  BusinessMetrics,
  BusinessOpportunity,
  CustomerTimelineEntry,
  FollowupStatus,
  OpportunityStage
} from "./types.ts";

export interface CreateCompanyInput {
  name: string;
  domain?: string;
  status?: BusinessCompany["status"];
  source?: string;
  owner_person_id?: string;
}

export interface CreateContactInput {
  name: string;
  company_id?: string;
  email?: string;
  phone?: string;
  title?: string;
  source?: string;
  owner_person_id?: string;
}

export interface CreateLeadInput {
  title: string;
  company_id?: string;
  contact_id?: string;
  status?: BusinessLead["status"];
  source?: string;
  /** Idempotent ingestion (§22): samme (source_type, source_instance_id, external_id) -> samme rad. */
  source_type?: string;
  source_instance_id?: string;
  external_id?: string;
  owner_person_id?: string;
}

export interface CreateOpportunityInput {
  title: string;
  company_id?: string;
  contact_id?: string;
  lead_id?: string;
  stage?: OpportunityStage;
  value_ore?: number;
  currency?: string;
  expected_close_date?: string;
  owner_person_id?: string;
}

export interface RecordActivityInput {
  activity_type: BusinessActivity["activity_type"];
  summary: string;
  company_id?: string;
  contact_id?: string;
  opportunity_id?: string;
  lead_id?: string;
  source_type?: string;
  source_instance_id?: string;
  external_id?: string;
  canonical_uri?: string;
  owner_person_id?: string;
  occurred_at?: string;
}

export interface CreateFollowupInput {
  title: string;
  company_id?: string;
  contact_id?: string;
  opportunity_id?: string;
  lead_id?: string;
  activity_id?: string;
  reason?: string;
  next_action?: string;
  due_at: string;
  priority?: BusinessFollowup["priority"];
  owner_person_id?: string;
  /** Idempotent oppfoelging-opprettelse (§22): dupliserte agent-kjøringer gir aldri doble oppgaver. */
  idempotency_key?: string;
}

/**
 * UA-3 P0: kjerne-domenetjeneste for Business Graph. Gjenbruker
 * `withMemoryTransaction` (samme RLS-kontekst-primitiv som Memory/Knowledge/
 * Erasure) - ingen ny sikkerhetsmodell. Alle skrivinger scopes til
 * identity.tenant_id/memory_space via kalleren (se transport.ts).
 */
export class BusinessService {
  constructor(private readonly pool: pg.Pool) {}

  async createCompany(tenantId: string, memorySpace: MemorySpace, input: CreateCompanyInput): Promise<BusinessCompany> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const company_id = `biz-co-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO business_companies (company_id, tenant_id, memory_space_id, name, domain, status, source, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          company_id, tenantId, memorySpace, input.name, input.domain ?? null,
          input.status ?? "prospect", input.source ?? null, input.owner_person_id ?? null
        ]
      );
      return rows[0] as BusinessCompany;
    });
  }

  async createContact(tenantId: string, memorySpace: MemorySpace, input: CreateContactInput): Promise<BusinessContact> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const contact_id = `biz-ct-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO business_contacts (contact_id, tenant_id, memory_space_id, company_id, name, email, phone, title, source, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          contact_id, tenantId, memorySpace, input.company_id ?? null, input.name,
          input.email ?? null, input.phone ?? null, input.title ?? null,
          input.source ?? null, input.owner_person_id ?? null
        ]
      );
      return rows[0] as BusinessContact;
    });
  }

  /** Idempotent naar source_type/source_instance_id/external_id oppgis (§22): re-kjøring returnerer eksisterende rad. */
  async createLead(tenantId: string, memorySpace: MemorySpace, input: CreateLeadInput): Promise<BusinessLead> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const lead_id = `biz-ld-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO business_leads (lead_id, tenant_id, memory_space_id, company_id, contact_id, title, status, source, source_type, source_instance_id, external_id, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, source_type, source_instance_id, external_id) DO UPDATE SET title = business_leads.title
         RETURNING *`,
        [
          lead_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null,
          input.title, input.status ?? "new", input.source ?? null,
          input.source_type ?? null, input.source_instance_id ?? null, input.external_id ?? null,
          input.owner_person_id ?? null
        ]
      );
      return rows[0] as BusinessLead;
    });
  }

  async updateLeadStatus(tenantId: string, memorySpace: MemorySpace, leadId: string, status: BusinessLead["status"]): Promise<BusinessLead | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE business_leads SET status = $1, updated_at = now() WHERE tenant_id = $2 AND lead_id = $3 RETURNING *`,
        [status, tenantId, leadId]
      );
      return (rows[0] as BusinessLead) ?? null;
    });
  }

  async createOpportunity(tenantId: string, memorySpace: MemorySpace, input: CreateOpportunityInput): Promise<BusinessOpportunity> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const opportunity_id = `biz-op-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO business_opportunities (opportunity_id, tenant_id, memory_space_id, company_id, contact_id, lead_id, title, stage, value_ore, currency, expected_close_date, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          opportunity_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null,
          input.lead_id ?? null, input.title, input.stage ?? "new", input.value_ore ?? null,
          input.currency ?? "NOK", input.expected_close_date ?? null, input.owner_person_id ?? null
        ]
      );
      return rows[0] as BusinessOpportunity;
    });
  }

  async updateOpportunityStage(
    tenantId: string,
    memorySpace: MemorySpace,
    opportunityId: string,
    stage: OpportunityStage
  ): Promise<BusinessOpportunity | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE business_opportunities SET stage = $1, updated_at = now() WHERE tenant_id = $2 AND opportunity_id = $3 RETURNING *`,
        [stage, tenantId, opportunityId]
      );
      return (rows[0] as BusinessOpportunity) ?? null;
    });
  }

  /** Idempotent naar source_type/source_instance_id/external_id oppgis (§22/§9 i BO-en): trygg re-prosessering av kilde-hendelser. */
  async recordActivity(tenantId: string, memorySpace: MemorySpace, input: RecordActivityInput): Promise<BusinessActivity> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const activity_id = `biz-ac-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO business_activities (activity_id, tenant_id, memory_space_id, company_id, contact_id, opportunity_id, lead_id, activity_type, summary, source_type, source_instance_id, external_id, canonical_uri, owner_person_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, now()))
         ON CONFLICT (tenant_id, source_type, source_instance_id, external_id) DO UPDATE SET summary = business_activities.summary
         RETURNING *`,
        [
          activity_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null,
          input.opportunity_id ?? null, input.lead_id ?? null, input.activity_type, input.summary,
          input.source_type ?? null, input.source_instance_id ?? null, input.external_id ?? null,
          input.canonical_uri ?? null, input.owner_person_id ?? null, input.occurred_at ?? null
        ]
      );
      return rows[0] as BusinessActivity;
    });
  }

  /**
   * §9 i UA-3 business-event-linkage-byggeordren: deterministisk kontakt-
   * gjenkjenning via e-postadresse - PRIMÆR nøkkel for Gmail/Calendar-
   * hendelseslenking (aldri en LLM-gjetning). Case-insensitiv (samme
   * `lower(email)`-indeks som `021_business_contact_email_lookup.sql`).
   * Returnerer ALLE treff - kalleren avgjør selv om >1 betyr tvetydig
   * (§9: "never silently link the wrong company" - fail safe, ikke gjett).
   */
  async findContactsByEmail(tenantId: string, memorySpace: MemorySpace, email: string): Promise<BusinessContact[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM business_contacts WHERE tenant_id = $1 AND lower(email) = lower($2)`,
        [tenantId, email]
      );
      return rows as BusinessContact[];
    });
  }

  /** "Hva skjer med kunde X?" (akseptansekriterium 1): komplett, kilde-forankret tidslinje for ett selskap. */
  async companyTimeline(tenantId: string, memorySpace: MemorySpace, companyId: string): Promise<CustomerTimelineEntry[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT activity_id, activity_type, summary, canonical_uri, occurred_at
         FROM business_activities WHERE tenant_id = $1 AND company_id = $2
         ORDER BY occurred_at DESC`,
        [tenantId, companyId]
      );
      return rows as CustomerTimelineEntry[];
    });
  }

  /**
   * HOST FIX #1 (D-58): TIDLIGERE en ikke-atomisk SELECT-så-INSERT (SELECT
   * finner ingenting -> INSERT) - to samtidige kall med SAMME
   * `idempotency_key` kunne begge passere SELECT-sjekken FØR noen av dem
   * hadde committet sin INSERT (klassisk TOCTOU-race), og den andre INSERT-en
   * feilet da med `business_followups_tenant_id_idempotency_key_key`
   * unique-constraint-brudd i stedet for å returnere den EKSISTERENDE raden
   * (funnet av en genuin CI-race, ikke host-relatert - se D-58). Fikset til
   * SAMME atomiske `ON CONFLICT ... DO UPDATE ... RETURNING *`-mønster som
   * `createLead()`/`recordActivity()` allerede bruker for sine egne
   * nullable idempotens-nøkler - Postgres behandler NULL <> NULL i unique
   * constraints, så fravær av `idempotency_key` fortsatt ALDRI trigger en
   * konflikt (hver kall uten nøkkel forblir en ny rad, uendret oppførsel).
   */
  async createFollowup(tenantId: string, memorySpace: MemorySpace, input: CreateFollowupInput): Promise<BusinessFollowup> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const followup_id = `biz-fu-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO business_followups (followup_id, tenant_id, memory_space_id, company_id, contact_id, opportunity_id, lead_id, activity_id, title, reason, next_action, due_at, priority, owner_person_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET title = business_followups.title
         RETURNING *`,
        [
          followup_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null,
          input.opportunity_id ?? null, input.lead_id ?? null, input.activity_id ?? null,
          input.title, input.reason ?? null, input.next_action ?? null, input.due_at,
          input.priority ?? "normal", input.owner_person_id ?? null, input.idempotency_key ?? null
        ]
      );
      return rows[0] as BusinessFollowup;
    });
  }

  async completeFollowup(tenantId: string, memorySpace: MemorySpace, followupId: string): Promise<BusinessFollowup | null> {
    return this.setFollowupStatus(tenantId, memorySpace, followupId, "completed");
  }

  async cancelFollowup(tenantId: string, memorySpace: MemorySpace, followupId: string): Promise<BusinessFollowup | null> {
    return this.setFollowupStatus(tenantId, memorySpace, followupId, "cancelled");
  }

  private async setFollowupStatus(
    tenantId: string,
    memorySpace: MemorySpace,
    followupId: string,
    status: Exclude<FollowupStatus, "open">
  ): Promise<BusinessFollowup | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const timestampColumn = status === "completed" ? "completed_at" : "cancelled_at";
      const { rows } = await client.query(
        `UPDATE business_followups SET status = $1, ${timestampColumn} = now(), updated_at = now()
         WHERE tenant_id = $2 AND followup_id = $3 AND status = 'open' RETURNING *`,
        [status, tenantId, followupId]
      );
      return (rows[0] as BusinessFollowup) ?? null;
    });
  }

  /** Hvem trenger oppfoelging / forfalt arbeid (§9 i BO-en) - fra strukturert state, ikke fri-form LLM-minne. */
  async overdueFollowups(tenantId: string, memorySpace: MemorySpace, asOf: string = new Date().toISOString()): Promise<BusinessFollowup[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM business_followups WHERE tenant_id = $1 AND status = 'open' AND due_at < $2 ORDER BY due_at ASC`,
        [tenantId, asOf]
      );
      return rows as BusinessFollowup[];
    });
  }

  /** §19: grunnleggende drifts-metrikker avledet fra autoritativ state - ikke et eget BI-lag. */
  async metrics(tenantId: string, memorySpace: MemorySpace): Promise<BusinessMetrics> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // Sekvensielle spørringer, IKKE Promise.all() - en enkelt pg.PoolClient betjener ÉN
      // forespørsel om gangen over samme tilkobling; samtidige .query()-kall på SAMME client er
      // deprecated i node-postgres (fjernes i pg@9) og skal aldri brukes, selv om det tilfeldigvis
      // fungerer i dag (host-funn, HOST FIX #2).
      const leads = await client.query(
        `SELECT count(*)::int AS n FROM business_leads WHERE tenant_id = $1 AND status IN ('new','contacted','qualified')`, [tenantId]
      );
      const opportunities = await client.query(
        `SELECT count(*)::int AS n, COALESCE(sum(value_ore), 0)::int AS value FROM business_opportunities
         WHERE tenant_id = $1 AND stage NOT IN ('won','lost')`,
        [tenantId]
      );
      const followups = await client.query(
        `SELECT count(*)::int AS n FROM business_followups WHERE tenant_id = $1 AND status = 'open' AND due_at < now()`, [tenantId]
      );
      const won = await client.query(
        `SELECT count(*)::int AS n FROM business_opportunities WHERE tenant_id = $1 AND stage = 'won' AND updated_at > now() - interval '30 days'`,
        [tenantId]
      );
      return {
        open_leads: leads.rows[0].n,
        active_opportunities: opportunities.rows[0].n,
        open_pipeline_value_ore: opportunities.rows[0].value,
        overdue_followups: followups.rows[0].n,
        won_opportunities_30d: won.rows[0].n
      };
    });
  }
}
