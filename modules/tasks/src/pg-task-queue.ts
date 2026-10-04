import type pg from "pg";
import { JobContractSchema, type JobContract, type JsonValue } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { ClaimedTask, TaskView, WorkflowAdapter } from "./workflow-adapter.ts";

export class PgTaskQueue implements WorkflowAdapter {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(tenantId: string, contract: JobContract): Promise<void> {
    const job = JobContractSchema.parse(contract);
    await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, contract)
         VALUES ($1, $2, $3, $4, $5)`,
        [job.task_id, tenantId, job.owner_person_id, job.goal, JSON.stringify(job)]
      )
    );
  }

  async claimNext(workerId: string, leaseSeconds: number, agentProfiles: string[]): Promise<ClaimedTask | null> {
    const result = await this.pool.query(
      "SELECT task_id, tenant_id, contract, attempts, checkpoint FROM claim_next_task($1, $2, $3)",
      [workerId, leaseSeconds, agentProfiles]
    );
    return (result.rows[0] as ClaimedTask | undefined) ?? null;
  }

  async saveCheckpoint(tenantId: string, taskId: string, workerId: string, checkpoint: Record<string, JsonValue>): Promise<boolean> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `UPDATE tasks SET checkpoint = $3 WHERE task_id = $1 AND worker_id = $2 AND status = 'running'`,
        [taskId, workerId, JSON.stringify(checkpoint)]
      )
    );
    return (result.rowCount ?? 0) > 0;
  }

  async complete(tenantId: string, taskId: string, workerId: string, result: Record<string, unknown>): Promise<boolean> {
    const updated = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `UPDATE tasks SET status = 'completed', finished_at = now(), result = $3, lease_expires_at = NULL
         WHERE task_id = $1 AND worker_id = $2 AND status = 'running'`,
        [taskId, workerId, JSON.stringify(result)]
      )
    );
    return (updated.rowCount ?? 0) > 0;
  }

  async fail(tenantId: string, taskId: string, workerId: string, error: string): Promise<"created" | "failed" | "stale"> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const row = await client.query(
        `SELECT attempts, contract->'retry_policy'->>'max_attempts' AS max_attempts
         FROM tasks WHERE task_id = $1 AND worker_id = $2 AND status = 'running' FOR UPDATE`,
        [taskId, workerId]
      );
      const info = row.rows[0] as { attempts: number; max_attempts: string } | undefined;
      if (!info) {
        return "stale";
      }
      const retry = info.attempts < Number(info.max_attempts);
      await client.query(
        `UPDATE tasks SET status = $2, last_error = $3, worker_id = NULL, lease_expires_at = NULL,
                finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
         WHERE task_id = $1`,
        [taskId, retry ? "created" : "failed", error]
      );
      return retry ? "created" : "failed";
    });
  }

  async renewLease(tenantId: string, taskId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `UPDATE tasks SET lease_expires_at = now() + make_interval(secs => $3)
         WHERE task_id = $1 AND worker_id = $2 AND status = 'running'`,
        [taskId, workerId, leaseSeconds]
      )
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markCancelled(tenantId: string, taskId: string, workerId: string): Promise<boolean> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `UPDATE tasks SET status = 'cancelled', finished_at = now(), lease_expires_at = NULL
         WHERE task_id = $1 AND worker_id = $2 AND status = 'running'`,
        [taskId, workerId]
      )
    );
    return (result.rowCount ?? 0) > 0;
  }

  async get(tenantId: string, taskId: string): Promise<TaskView | null> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `SELECT task_id, goal, status, result, cancel_requested, attempts, last_error
         FROM tasks WHERE task_id = $1`,
        [taskId]
      )
    );
    return (result.rows[0] as TaskView | undefined) ?? null;
  }

  async requestCancel(tenantId: string, taskId: string): Promise<"cancelled" | "requested" | "not_cancellable"> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const direct = await client.query(
        `UPDATE tasks SET status = 'cancelled', finished_at = now()
         WHERE task_id = $1 AND status = 'created'`,
        [taskId]
      );
      if ((direct.rowCount ?? 0) > 0) {
        return "cancelled";
      }
      const flagged = await client.query(
        `UPDATE tasks SET cancel_requested = true WHERE task_id = $1 AND status = 'running'`,
        [taskId]
      );
      return (flagged.rowCount ?? 0) > 0 ? "requested" : "not_cancellable";
    });
  }

  async isCancelRequested(tenantId: string, taskId: string): Promise<boolean> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query("SELECT cancel_requested FROM tasks WHERE task_id = $1", [taskId])
    );
    return Boolean((result.rows[0] as { cancel_requested: boolean } | undefined)?.cancel_requested);
  }
}
