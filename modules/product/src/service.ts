import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { assertValidProductItemTransition } from "./state-machine.ts";
import type {
  CreateProductItemInput,
  ProductItem,
  ProductItemEvent,
  ProductItemEventType,
  ProductItemPriority,
  ProductItemStatus
} from "./types.ts";

export interface SearchProductItemsFilter {
  status?: ProductItemStatus;
  priority?: ProductItemPriority;
  company_id?: string;
  contact_id?: string;
  owner_person_id?: string;
  /** Fritekst-substring mot `title` - deterministisk `ILIKE`, ingen semantisk søk (samme prinsipp som contracts/support). */
  title_contains?: string;
  item_number?: number;
  limit?: number;
}

/**
 * UA-3 Native Jarvis Product Core (D-128): kjerne-domenetjeneste for
 * produkt-tilbakemeldings-/roadmap-lifecycle. Gjenbruker `withMemoryTransaction`
 * (SAMME RLS-primitiv som resten av Business OS) - ingen ny sikkerhetsmodell.
 * Rapportør er de EKSISTERENDE `business_companies`/`business_contacts`-
 * entitetene - ingen ny rapportør-tabell/-tjeneste.
 */
export class ProductService {
  constructor(private readonly pool: pg.Pool) {}

  async createItem(tenantId: string, memorySpace: MemorySpace, input: CreateProductItemInput): Promise<ProductItem> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const item = await insertItem(client, tenantId, memorySpace, input);
      await insertEvent(client, tenantId, memorySpace, {
        item_id: item.item_id,
        event_type: "item_created",
        summary: `Produktpunkt opprettet: ${input.title}`,
        actor_person_id: input.actor_person_id ?? null,
        metadata: {}
      });
      return item;
    });
  }

  async getItem(tenantId: string, memorySpace: MemorySpace, itemId: string): Promise<ProductItem | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.readForUpdate(client, tenantId, itemId, false));
  }

  async listItems(tenantId: string, memorySpace: MemorySpace, status: ProductItemStatus | "all" = "new"): Promise<ProductItem[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM product_items WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])
          : await client.query(`SELECT * FROM product_items WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC`, [tenantId, status]);
      return rows as ProductItem[];
    });
  }

  /** Deterministisk filter/søk - ingen LLM nødvendig for et strukturert oppslag (samme prinsipp som contracts.searchContracts). */
  async searchItems(tenantId: string, memorySpace: MemorySpace, filter: SearchProductItemsFilter): Promise<ProductItem[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const clauses = ["tenant_id = $1"];
      const params: unknown[] = [tenantId];
      const push = (clause: string, value: unknown) => {
        params.push(value);
        clauses.push(clause.replace("$N", `$${params.length}`));
      };
      if (filter.status !== undefined) push("status = $N", filter.status);
      if (filter.priority !== undefined) push("priority = $N", filter.priority);
      if (filter.company_id !== undefined) push("company_id = $N", filter.company_id);
      if (filter.contact_id !== undefined) push("contact_id = $N", filter.contact_id);
      if (filter.owner_person_id !== undefined) push("owner_person_id = $N", filter.owner_person_id);
      if (filter.item_number !== undefined) push("item_number = $N", filter.item_number);
      if (filter.title_contains !== undefined) push("title ILIKE $N", `%${filter.title_contains}%`);
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
      const { rows } = await client.query(
        `SELECT * FROM product_items WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
        params
      );
      return rows as ProductItem[];
    });
  }

  /** "What has company X reported?" - deterministisk rapportør-oppslag. */
  async listByCompany(tenantId: string, memorySpace: MemorySpace, companyId: string, status: ProductItemStatus | "all" = "all"): Promise<ProductItem[]> {
    return this.searchItems(tenantId, memorySpace, { company_id: companyId, ...(status !== "all" ? { status } : {}), limit: 200 });
  }

  /**
   * Deterministisk statusovergang håndheves i state-machine.ts - ugyldig overgang kaster, endrer
   * INGENTING. `canTransitionProductItem` tillater `from===to` som en GYLDIG overgang, men det
   * betyr IKKE at et repetert samme-status-kall skal skrive en ny `updated_at`/`status_changed`-
   * event/`closed_at` - en samme-verdi-overgang er en EKTE no-op (ingen UPDATE, ingen event),
   * ellers ville repeterte `set_status`-kall med samme verdi kunne stille undertrykke
   * `product_item_high_priority_stalled`-deteksjonen (frisk `updated_at` uten reell fremgang) og
   * overskrive den opprinnelige `closed_at`-terminaltidsstemplingen ved gjentatt `shipped->shipped`.
   */
  async setStatus(tenantId: string, memorySpace: MemorySpace, itemId: string, status: ProductItemStatus, actorPersonId?: string): Promise<ProductItem | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, itemId, true);
      if (!current) return null;
      assertValidProductItemTransition(current.status, status);
      if (status === current.status) return current;
      const closedAtClause =
        (status === "shipped" || status === "declined" || status === "closed")
          ? ", closed_at = now()"
          : (current.status === "shipped" || current.status === "declined" || current.status === "closed")
            ? ", closed_at = NULL"
            : "";
      const { rows } = await client.query(
        `UPDATE product_items SET status = $1, updated_at = now()${closedAtClause} WHERE tenant_id = $2 AND item_id = $3 RETURNING *`,
        [status, tenantId, itemId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        item_id: itemId, event_type: "status_changed", summary: `Status endret: ${current.status} -> ${status}`,
        actor_person_id: actorPersonId ?? null, metadata: { from: current.status, to: status }
      });
      return rows[0] as ProductItem;
    });
  }

  async setPriority(tenantId: string, memorySpace: MemorySpace, itemId: string, priority: ProductItemPriority, actorPersonId?: string): Promise<ProductItem | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, itemId, true);
      if (!current) return null;
      if (priority === current.priority) return current;
      const { rows } = await client.query(
        `UPDATE product_items SET priority = $1, updated_at = now() WHERE tenant_id = $2 AND item_id = $3 RETURNING *`,
        [priority, tenantId, itemId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        item_id: itemId, event_type: "priority_changed", summary: `Prioritet endret: ${current.priority} -> ${priority}`,
        actor_person_id: actorPersonId ?? null, metadata: { from: current.priority, to: priority }
      });
      return rows[0] as ProductItem;
    });
  }

  async setOwner(tenantId: string, memorySpace: MemorySpace, itemId: string, ownerPersonId: string | null, actorPersonId?: string): Promise<ProductItem | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, itemId, true);
      if (!current) return null;
      if (ownerPersonId === current.owner_person_id) return current;
      const { rows } = await client.query(
        `UPDATE product_items SET owner_person_id = $1, updated_at = now() WHERE tenant_id = $2 AND item_id = $3 RETURNING *`,
        [ownerPersonId, tenantId, itemId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        item_id: itemId, event_type: "owner_changed", summary: ownerPersonId ? `Eier satt til ${ownerPersonId}` : "Eier fjernet",
        actor_person_id: actorPersonId ?? null, metadata: { from: current.owner_person_id, to: ownerPersonId }
      });
      return rows[0] as ProductItem;
    });
  }

  /** Rapportør-kobling gjenbruker EKSISTERENDE Business OS-entiteter - ingen ny rapportør-tabell. */
  async linkReporter(
    tenantId: string,
    memorySpace: MemorySpace,
    itemId: string,
    companyId: string | null,
    contactId: string | null,
    actorPersonId?: string
  ): Promise<ProductItem | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, itemId, true);
      if (!current) return null;
      if (companyId === current.company_id && contactId === current.contact_id) return current;
      const { rows } = await client.query(
        `UPDATE product_items SET company_id = $1, contact_id = $2, updated_at = now() WHERE tenant_id = $3 AND item_id = $4 RETURNING *`,
        [companyId, contactId, tenantId, itemId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        item_id: itemId, event_type: "reporter_linked", summary: "Rapportør oppdatert",
        actor_person_id: actorPersonId ?? null, metadata: { company_id: companyId, contact_id: contactId }
      });
      return rows[0] as ProductItem;
    });
  }

  async listEvents(tenantId: string, memorySpace: MemorySpace, itemId: string): Promise<ProductItemEvent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM product_item_events WHERE tenant_id = $1 AND item_id = $2 ORDER BY occurred_at ASC`,
        [tenantId, itemId]
      );
      return rows as ProductItemEvent[];
    });
  }

  private async readForUpdate(client: pg.PoolClient, tenantId: string, itemId: string, lock: boolean): Promise<ProductItem | null> {
    const { rows } = await client.query(
      `SELECT * FROM product_items WHERE tenant_id = $1 AND item_id = $2${lock ? " FOR UPDATE" : ""}`,
      [tenantId, itemId]
    );
    return (rows[0] as ProductItem) ?? null;
  }
}

async function insertItem(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: CreateProductItemInput): Promise<ProductItem> {
  const item_id = `prd-it-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO product_items
       (item_id, tenant_id, memory_space_id, company_id, contact_id, title, description, item_type, priority, owner_person_id,
        source_type, source_instance_id, source_message_id, canonical_uri)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [
      item_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null, input.title,
      input.description ?? null, input.item_type ?? "feature_request", input.priority ?? "normal", input.owner_person_id ?? null,
      input.source_type ?? "native", input.source_instance_id ?? null, input.source_message_id ?? null, input.canonical_uri ?? null
    ]
  );
  return rows[0] as ProductItem;
}

interface InsertEventInput {
  item_id: string;
  event_type: ProductItemEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
}

async function insertEvent(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: InsertEventInput): Promise<ProductItemEvent> {
  const event_id = `prd-ev-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO product_item_events (event_id, tenant_id, memory_space_id, item_id, event_type, summary, actor_person_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [event_id, tenantId, memorySpace, input.item_id, input.event_type, input.summary, input.actor_person_id, JSON.stringify(input.metadata)]
  );
  return rows[0] as ProductItemEvent;
}
