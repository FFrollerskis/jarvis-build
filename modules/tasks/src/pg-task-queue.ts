import type pg from "pg";
import { JobContractSchema, type JobContract } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { ClaimedTask, TaskView, WorkflowAdapter } from "./workflow-adapter.ts";

/**
 * Postgres-kø (pg-boss-klasse): claiming via SECURITY DEFINER-funksjonen
 * claim_next_task() (migrasjon 007) slik at app-rollen aldri trenger
 * RLS-bypass; all annen lesing/skriving skjer i riktig tenant-kontekst.
 */
export class PgTaskQueue implements WorkflowAdapter {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(tenantId: string, contract: JobContract): Promise<void> {
    const job = JobContractSchema.parse(contract);
    await withTenantTransaction(this.pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, contract)
         VALUES ($1, $2, $3, $4, $5)`,
        [job.task_id, tenantId, job.owner_person_id, job.goal, JSON.stringify(job)]
      );
    });
  }

  async claimNext(): Promise<ClaimedTask | null> {
    const result = await this.pool.query("SELECT task_id, tenant_id, contract FROM claim_next_task()");
    const row = result.rows[0] as { task_id: string; tenant_id: string; contract: JobContract } | undefined;
    return row ? { task_id: row.task_id, tenant_id: row.tenant_id, contract: row.contract } : null;
  }

  async complete(tenantId: string, taskId: string, result: Record<string, unknown>): Promise<void> {
    await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `UPDATE tasks SET status = 'completed', finished_at = now(), result = $2 WHERE task_id = $1`,
        [taskId, JSON.stringify(result)]
      )
    );
  }

  async fail(tenantId: string, taskId: string, error: string): Promise<void> {
    await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `UPDATE tasks SET status = 'failed', finished_at = now(), result = $2 WHERE task_id = $1`,
        [taskId, JSON.stringify({ error })]
      )
    );
  }

  async get(tenantId: string, taskId: string): Promise<TaskView | null> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query("SELECT task_id, goal, status, result FROM tasks WHERE task_id = $1", [taskId])
    );
    return (result.rows[0] as TaskView | undefined) ?? null;
  }

  async cancel(tenantId: string, taskId: string): Promise<boolean> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `UPDATE tasks SET status = 'cancelled', finished_at = now()
         WHERE task_id = $1 AND status IN ('created', 'running')`,
        [taskId]
      )
    );
    return (result.rowCount ?? 0) > 0;
  }
}
