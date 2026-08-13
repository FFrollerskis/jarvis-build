import type { JobContract, JsonValue } from "@jarvis/contracts";

export interface TaskView {
  task_id: string;
  goal: string;
  status: "created" | "running" | "paused" | "completed" | "failed" | "cancelled";
  result: Record<string, unknown> | null;
  cancel_requested: boolean;
  attempts: number;
  last_error: string | null;
}

export interface ClaimedTask {
  task_id: string;
  tenant_id: string;
  contract: JobContract;
  attempts: number;
  checkpoint: Record<string, JsonValue> | null;
}

/**
 * Internt adapterlag for durable workflows (D-13/D-31): all kø-teknologi bak
 * dette grensesnittet. Fase 6-implementasjonen er Postgres (lease/reclaim,
 * checkpoints, retries). complete/fail/checkpoint er worker-guardet: en stale
 * worker (mistet lease) kan aldri overskrive en annen workers resultat.
 */
export interface WorkflowAdapter {
  enqueue(tenantId: string, contract: JobContract): Promise<void>;
  claimNext(workerId: string, leaseSeconds: number): Promise<ClaimedTask | null>;
  saveCheckpoint(tenantId: string, taskId: string, workerId: string, checkpoint: Record<string, JsonValue>): Promise<boolean>;
  complete(tenantId: string, taskId: string, workerId: string, result: Record<string, unknown>): Promise<boolean>;
  /** Requeuer hvis attempts < max_attempts, ellers failed. Returnerer ny status. */
  fail(tenantId: string, taskId: string, workerId: string, error: string): Promise<"created" | "failed" | "stale">;
  markCancelled(tenantId: string, taskId: string, workerId: string): Promise<boolean>;
  get(tenantId: string, taskId: string): Promise<TaskView | null>;
  /** Kansellering: created→cancelled direkte; running→cancel_requested; ferdig→false. */
  requestCancel(tenantId: string, taskId: string): Promise<"cancelled" | "requested" | "not_cancellable">;
  isCancelRequested(tenantId: string, taskId: string): Promise<boolean>;
}
