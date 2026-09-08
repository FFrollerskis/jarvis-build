import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { assertValidOperationsTaskTransition } from "./state-machine.ts";
import type {
  CreateOperationsTaskInput,
  CreateRunbookInput,
  CreateVendorInput,
  OperationsRunbook,
  OperationsTask,
  OperationsTaskEvent,
  OperationsTaskEventType,
  OperationsTaskPriority,
  OperationsTaskStatus,
  OperationsVendor,
  VendorStatus
} from "./types.ts";

export interface SearchOperationsTasksFilter {
  status?: OperationsTaskStatus;
  priority?: OperationsTaskPriority;
  vendor_id?: string;
  owner_person_id?: string;
  /** Fritekst-substring mot `title` - deterministisk `ILIKE`, ingen semantisk søk (samme prinsipp som contracts/product). */
  title_contains?: string;
  task_number?: number;
  limit?: number;
}

/**
 * UA-3 Native Jarvis Operations Core (D-129): kjerne-domenetjeneste for
 * leverandør-/runbook-/driftsoppgave-lifecycle. Gjenbruker
 * `withMemoryTransaction` (SAMME RLS-primitiv som resten av Business OS) -
 * ingen ny sikkerhetsmodell. Leverandør-kontakt kan valgfritt kobles til de
 * EKSISTERENDE `business_companies`/`business_contacts`-entitetene - ingen
 * ny organisasjons-tjeneste.
 */
export class OperationsService {
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------
  // Vendors (§13: "suppliers")
  // ---------------------------------------------------------------------

  async createVendor(tenantId: string, memorySpace: MemorySpace, input: CreateVendorInput): Promise<OperationsVendor> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const vendor_id = `ops-vn-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO operations_vendors (vendor_id, tenant_id, memory_space_id, company_id, contact_id, name, category, escalation_contact_person_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          vendor_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null, input.name,
          input.category ?? "general", input.escalation_contact_person_id ?? null, input.notes ?? null
        ]
      );
      return rows[0] as OperationsVendor;
    });
  }

  async getVendor(tenantId: string, memorySpace: MemorySpace, vendorId: string): Promise<OperationsVendor | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM operations_vendors WHERE tenant_id = $1 AND vendor_id = $2`, [tenantId, vendorId]);
      return (rows[0] as OperationsVendor) ?? null;
    });
  }

  async listVendors(tenantId: string, memorySpace: MemorySpace, status: VendorStatus | "all" = "active"): Promise<OperationsVendor[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM operations_vendors WHERE tenant_id = $1 ORDER BY name ASC`, [tenantId])
          : await client.query(`SELECT * FROM operations_vendors WHERE tenant_id = $1 AND status = $2 ORDER BY name ASC`, [tenantId, status]);
      return rows as OperationsVendor[];
    });
  }

  /** Same-value-mutator no-op-disiplin (D-128-lærdom): repeterte samme-status-kall skriver INGEN ny `updated_at`. */
  async setVendorStatus(tenantId: string, memorySpace: MemorySpace, vendorId: string, status: VendorStatus): Promise<OperationsVendor | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readVendorForUpdate(client, tenantId, vendorId);
      if (!current) return null;
      if (status === current.status) return current;
      const { rows } = await client.query(
        `UPDATE operations_vendors SET status = $1, updated_at = now() WHERE tenant_id = $2 AND vendor_id = $3 RETURNING *`,
        [status, tenantId, vendorId]
      );
      return rows[0] as OperationsVendor;
    });
  }

  private async readVendorForUpdate(client: pg.PoolClient, tenantId: string, vendorId: string): Promise<OperationsVendor | null> {
    const { rows } = await client.query(`SELECT * FROM operations_vendors WHERE tenant_id = $1 AND vendor_id = $2 FOR UPDATE`, [tenantId, vendorId]);
    return (rows[0] as OperationsVendor) ?? null;
  }

  // ---------------------------------------------------------------------
  // Runbooks (§13: "runbooks")
  // ---------------------------------------------------------------------

  async createRunbook(tenantId: string, memorySpace: MemorySpace, input: CreateRunbookInput): Promise<OperationsRunbook> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const runbook_id = `ops-rb-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO operations_runbooks (runbook_id, tenant_id, memory_space_id, vendor_id, title, category, content, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [runbook_id, tenantId, memorySpace, input.vendor_id ?? null, input.title, input.category ?? "general", input.content, input.owner_person_id ?? null]
      );
      return rows[0] as OperationsRunbook;
    });
  }

  async getRunbook(tenantId: string, memorySpace: MemorySpace, runbookId: string): Promise<OperationsRunbook | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM operations_runbooks WHERE tenant_id = $1 AND runbook_id = $2`, [tenantId, runbookId]);
      return (rows[0] as OperationsRunbook) ?? null;
    });
  }

  async listRunbooks(tenantId: string, memorySpace: MemorySpace, activeOnly = true): Promise<OperationsRunbook[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = activeOnly
        ? await client.query(`SELECT * FROM operations_runbooks WHERE tenant_id = $1 AND is_active = true ORDER BY title ASC`, [tenantId])
        : await client.query(`SELECT * FROM operations_runbooks WHERE tenant_id = $1 ORDER BY title ASC`, [tenantId]);
      return rows as OperationsRunbook[];
    });
  }

  async updateRunbookContent(tenantId: string, memorySpace: MemorySpace, runbookId: string, content: string): Promise<OperationsRunbook | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readRunbookForUpdate(client, tenantId, runbookId);
      if (!current) return null;
      if (content === current.content) return current;
      const { rows } = await client.query(
        `UPDATE operations_runbooks SET content = $1, updated_at = now() WHERE tenant_id = $2 AND runbook_id = $3 RETURNING *`,
        [content, tenantId, runbookId]
      );
      return rows[0] as OperationsRunbook;
    });
  }

  async setRunbookActive(tenantId: string, memorySpace: MemorySpace, runbookId: string, isActive: boolean): Promise<OperationsRunbook | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readRunbookForUpdate(client, tenantId, runbookId);
      if (!current) return null;
      if (isActive === current.is_active) return current;
      const { rows } = await client.query(
        `UPDATE operations_runbooks SET is_active = $1, updated_at = now() WHERE tenant_id = $2 AND runbook_id = $3 RETURNING *`,
        [isActive, tenantId, runbookId]
      );
      return rows[0] as OperationsRunbook;
    });
  }

  private async readRunbookForUpdate(client: pg.PoolClient, tenantId: string, runbookId: string): Promise<OperationsRunbook | null> {
    const { rows } = await client.query(`SELECT * FROM operations_runbooks WHERE tenant_id = $1 AND runbook_id = $2 FOR UPDATE`, [tenantId, runbookId]);
    return (rows[0] as OperationsRunbook) ?? null;
  }

  // ---------------------------------------------------------------------
  // Tasks (§13: "Tasks, owners, deadlines" + "escalations")
  // ---------------------------------------------------------------------

  async createTask(tenantId: string, memorySpace: MemorySpace, input: CreateOperationsTaskInput): Promise<OperationsTask> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const task = await insertTask(client, tenantId, memorySpace, input);
      await insertEvent(client, tenantId, memorySpace, {
        task_id: task.task_id,
        event_type: "task_created",
        summary: `Driftsoppgave opprettet: ${input.title}`,
        actor_person_id: input.actor_person_id ?? null,
        metadata: {}
      });
      return task;
    });
  }

  async getTask(tenantId: string, memorySpace: MemorySpace, taskId: string): Promise<OperationsTask | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.readTaskForUpdate(client, tenantId, taskId, false));
  }

  async listTasks(tenantId: string, memorySpace: MemorySpace, status: OperationsTaskStatus | "all" = "open"): Promise<OperationsTask[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM operations_tasks WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])
          : await client.query(`SELECT * FROM operations_tasks WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC`, [tenantId, status]);
      return rows as OperationsTask[];
    });
  }

  /** Deterministisk filter/søk - ingen LLM nødvendig for et strukturert oppslag (samme prinsipp som contracts/product). */
  async searchTasks(tenantId: string, memorySpace: MemorySpace, filter: SearchOperationsTasksFilter): Promise<OperationsTask[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const clauses = ["tenant_id = $1"];
      const params: unknown[] = [tenantId];
      const push = (clause: string, value: unknown) => {
        params.push(value);
        clauses.push(clause.replace("$N", `$${params.length}`));
      };
      if (filter.status !== undefined) push("status = $N", filter.status);
      if (filter.priority !== undefined) push("priority = $N", filter.priority);
      if (filter.vendor_id !== undefined) push("vendor_id = $N", filter.vendor_id);
      if (filter.owner_person_id !== undefined) push("owner_person_id = $N", filter.owner_person_id);
      if (filter.task_number !== undefined) push("task_number = $N", filter.task_number);
      if (filter.title_contains !== undefined) push("title ILIKE $N", `%${filter.title_contains}%`);
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
      const { rows } = await client.query(
        `SELECT * FROM operations_tasks WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
        params
      );
      return rows as OperationsTask[];
    });
  }

  /** "What's outstanding for vendor X?" - deterministisk leverandør-oppslag. */
  async listByVendor(tenantId: string, memorySpace: MemorySpace, vendorId: string, status: OperationsTaskStatus | "all" = "all"): Promise<OperationsTask[]> {
    return this.searchTasks(tenantId, memorySpace, { vendor_id: vendorId, ...(status !== "all" ? { status } : {}), limit: 200 });
  }

  /**
   * Deterministisk statusovergang håndheves i state-machine.ts - ugyldig
   * overgang kaster, endrer INGENTING. Samme-verdi-overgang er en EKTE
   * no-op (ingen UPDATE, ingen event) - samme D-128-lærdom som
   * `ProductService.setStatus`: ellers kunne repeterte `set_status`-kall
   * med samme verdi stille undertrykke `operations_task_overdue`/
   * `operations_task_escalation_needed`-deteksjonen (frisk `updated_at`
   * uten reell fremgang) og overskrive den opprinnelige `closed_at`-
   * terminaltidsstemplingen ved gjentatt `done->done`.
   */
  async setStatus(tenantId: string, memorySpace: MemorySpace, taskId: string, status: OperationsTaskStatus, actorPersonId?: string): Promise<OperationsTask | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readTaskForUpdate(client, tenantId, taskId, true);
      if (!current) return null;
      assertValidOperationsTaskTransition(current.status, status);
      if (status === current.status) return current;
      const closedAtClause =
        (status === "done" || status === "cancelled")
          ? ", closed_at = now()"
          : (current.status === "done" || current.status === "cancelled")
            ? ", closed_at = NULL"
            : "";
      const { rows } = await client.query(
        `UPDATE operations_tasks SET status = $1, updated_at = now()${closedAtClause} WHERE tenant_id = $2 AND task_id = $3 RETURNING *`,
        [status, tenantId, taskId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        task_id: taskId, event_type: "status_changed", summary: `Status endret: ${current.status} -> ${status}`,
        actor_person_id: actorPersonId ?? null, metadata: { from: current.status, to: status }
      });
      return rows[0] as OperationsTask;
    });
  }

  async setPriority(tenantId: string, memorySpace: MemorySpace, taskId: string, priority: OperationsTaskPriority, actorPersonId?: string): Promise<OperationsTask | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readTaskForUpdate(client, tenantId, taskId, true);
      if (!current) return null;
      if (priority === current.priority) return current;
      const { rows } = await client.query(
        `UPDATE operations_tasks SET priority = $1, updated_at = now() WHERE tenant_id = $2 AND task_id = $3 RETURNING *`,
        [priority, tenantId, taskId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        task_id: taskId, event_type: "priority_changed", summary: `Prioritet endret: ${current.priority} -> ${priority}`,
        actor_person_id: actorPersonId ?? null, metadata: { from: current.priority, to: priority }
      });
      return rows[0] as OperationsTask;
    });
  }

  async setOwner(tenantId: string, memorySpace: MemorySpace, taskId: string, ownerPersonId: string | null, actorPersonId?: string): Promise<OperationsTask | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readTaskForUpdate(client, tenantId, taskId, true);
      if (!current) return null;
      if (ownerPersonId === current.owner_person_id) return current;
      const { rows } = await client.query(
        `UPDATE operations_tasks SET owner_person_id = $1, updated_at = now() WHERE tenant_id = $2 AND task_id = $3 RETURNING *`,
        [ownerPersonId, tenantId, taskId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        task_id: taskId, event_type: "owner_changed", summary: ownerPersonId ? `Eier satt til ${ownerPersonId}` : "Eier fjernet",
        actor_person_id: actorPersonId ?? null, metadata: { from: current.owner_person_id, to: ownerPersonId }
      });
      return rows[0] as OperationsTask;
    });
  }

  async setDueAt(tenantId: string, memorySpace: MemorySpace, taskId: string, dueAt: string | null, actorPersonId?: string): Promise<OperationsTask | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readTaskForUpdate(client, tenantId, taskId, true);
      if (!current) return null;
      const currentMs = current.due_at !== null ? new Date(current.due_at).getTime() : null;
      const nextMs = dueAt !== null ? new Date(dueAt).getTime() : null;
      if (currentMs === nextMs) return current;
      const { rows } = await client.query(
        `UPDATE operations_tasks SET due_at = $1, updated_at = now() WHERE tenant_id = $2 AND task_id = $3 RETURNING *`,
        [dueAt, tenantId, taskId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        task_id: taskId, event_type: "due_at_changed", summary: dueAt ? `Frist satt til ${dueAt}` : "Frist fjernet",
        actor_person_id: actorPersonId ?? null, metadata: { from: current.due_at, to: dueAt }
      });
      return rows[0] as OperationsTask;
    });
  }

  /** Leverandør-kobling gjenbruker EKSISTERENDE `operations_vendors` - ingen ny leverandør-tabell her. */
  async linkVendor(tenantId: string, memorySpace: MemorySpace, taskId: string, vendorId: string | null, actorPersonId?: string): Promise<OperationsTask | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readTaskForUpdate(client, tenantId, taskId, true);
      if (!current) return null;
      if (vendorId === current.vendor_id) return current;
      const { rows } = await client.query(
        `UPDATE operations_tasks SET vendor_id = $1, updated_at = now() WHERE tenant_id = $2 AND task_id = $3 RETURNING *`,
        [vendorId, tenantId, taskId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        task_id: taskId, event_type: "vendor_linked", summary: vendorId ? `Leverandør koblet: ${vendorId}` : "Leverandørkobling fjernet",
        actor_person_id: actorPersonId ?? null, metadata: { from: current.vendor_id, to: vendorId }
      });
      return rows[0] as OperationsTask;
    });
  }

  async linkRunbook(tenantId: string, memorySpace: MemorySpace, taskId: string, runbookId: string | null, actorPersonId?: string): Promise<OperationsTask | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readTaskForUpdate(client, tenantId, taskId, true);
      if (!current) return null;
      if (runbookId === current.runbook_id) return current;
      const { rows } = await client.query(
        `UPDATE operations_tasks SET runbook_id = $1, updated_at = now() WHERE tenant_id = $2 AND task_id = $3 RETURNING *`,
        [runbookId, tenantId, taskId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        task_id: taskId, event_type: "runbook_linked", summary: runbookId ? `Runbook koblet: ${runbookId}` : "Runbook-kobling fjernet",
        actor_person_id: actorPersonId ?? null, metadata: { from: current.runbook_id, to: runbookId }
      });
      return rows[0] as OperationsTask;
    });
  }

  /**
   * §13 "escalations": eksplisitt, deterministisk eskalering - ALDRI en
   * automatisk sveip-side-effekt (OpenLoopService overflater KUN behovet
   * som et open loop, se `detectOperationsTasksNeedingEscalation`). Ikke en
   * "same-value setter" i samme forstand som over - hver eskalering er en
   * genuin tilstandsprogresjon (nivå 1, 2, ...), derfor INGEN no-op-guard
   * her. `escalated_to_person_id` faller tilbake til leverandørens
   * `escalation_contact_person_id` dersom ingen eksplisitt mottaker er
   * oppgitt og oppgaven er koblet til en leverandør.
   */
  async escalateTask(tenantId: string, memorySpace: MemorySpace, taskId: string, escalatedToPersonId?: string | null, actorPersonId?: string): Promise<OperationsTask | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readTaskForUpdate(client, tenantId, taskId, true);
      if (!current) return null;
      let target = escalatedToPersonId ?? null;
      if (target === null && current.vendor_id !== null) {
        const { rows: vendorRows } = await client.query(
          `SELECT escalation_contact_person_id FROM operations_vendors WHERE tenant_id = $1 AND vendor_id = $2`,
          [tenantId, current.vendor_id]
        );
        target = (vendorRows[0] as { escalation_contact_person_id: string | null } | undefined)?.escalation_contact_person_id ?? null;
      }
      const nextLevel = current.escalation_level + 1;
      const { rows } = await client.query(
        `UPDATE operations_tasks SET escalation_level = $1, escalated_at = now(), escalated_to_person_id = $2, updated_at = now()
         WHERE tenant_id = $3 AND task_id = $4 RETURNING *`,
        [nextLevel, target, tenantId, taskId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        task_id: taskId, event_type: "escalated", summary: `Eskalert til nivå ${nextLevel}${target ? ` (${target})` : ""}`,
        actor_person_id: actorPersonId ?? null, metadata: { level: nextLevel, escalated_to_person_id: target }
      });
      return rows[0] as OperationsTask;
    });
  }

  async listTaskEvents(tenantId: string, memorySpace: MemorySpace, taskId: string): Promise<OperationsTaskEvent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM operations_task_events WHERE tenant_id = $1 AND task_id = $2 ORDER BY occurred_at ASC`,
        [tenantId, taskId]
      );
      return rows as OperationsTaskEvent[];
    });
  }

  private async readTaskForUpdate(client: pg.PoolClient, tenantId: string, taskId: string, lock: boolean): Promise<OperationsTask | null> {
    const { rows } = await client.query(
      `SELECT * FROM operations_tasks WHERE tenant_id = $1 AND task_id = $2${lock ? " FOR UPDATE" : ""}`,
      [tenantId, taskId]
    );
    return (rows[0] as OperationsTask) ?? null;
  }
}

async function insertTask(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: CreateOperationsTaskInput): Promise<OperationsTask> {
  const task_id = `ops-tk-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO operations_tasks
       (task_id, tenant_id, memory_space_id, vendor_id, runbook_id, title, description, priority, owner_person_id, due_at,
        source_type, source_instance_id, source_message_id, canonical_uri)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [
      task_id, tenantId, memorySpace, input.vendor_id ?? null, input.runbook_id ?? null, input.title,
      input.description ?? null, input.priority ?? "normal", input.owner_person_id ?? null, input.due_at ?? null,
      input.source_type ?? "native", input.source_instance_id ?? null, input.source_message_id ?? null, input.canonical_uri ?? null
    ]
  );
  return rows[0] as OperationsTask;
}

interface InsertEventInput {
  task_id: string;
  event_type: OperationsTaskEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
}

async function insertEvent(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: InsertEventInput): Promise<OperationsTaskEvent> {
  const event_id = `ops-ev-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO operations_task_events (event_id, tenant_id, memory_space_id, task_id, event_type, summary, actor_person_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [event_id, tenantId, memorySpace, input.task_id, input.event_type, input.summary, input.actor_person_id, JSON.stringify(input.metadata)]
  );
  return rows[0] as OperationsTaskEvent;
}
