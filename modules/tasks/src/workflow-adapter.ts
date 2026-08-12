import type { JobContract } from "@jarvis/contracts";

export interface TaskView {
  task_id: string;
  goal: string;
  status: "created" | "running" | "paused" | "completed" | "failed" | "cancelled";
  result: Record<string, unknown> | null;
}

export interface ClaimedTask {
  task_id: string;
  tenant_id: string;
  contract: JobContract;
}

/**
 * Internt adapterlag for durable workflows (D-13): all kø-teknologi skjules
 * bak dette grensesnittet. Fase 3-implementasjonen er en Postgres-kø
 * (pg-boss-klasse, SKIP LOCKED); Trigger.dev/Hatchet evalueres i fase 6 uten
 * at kallere endres.
 */
export interface WorkflowAdapter {
  enqueue(tenantId: string, contract: JobContract): Promise<void>;
  claimNext(): Promise<ClaimedTask | null>;
  complete(tenantId: string, taskId: string, result: Record<string, unknown>): Promise<void>;
  fail(tenantId: string, taskId: string, error: string): Promise<void>;
  get(tenantId: string, taskId: string): Promise<TaskView | null>;
  cancel(tenantId: string, taskId: string): Promise<boolean>;
}
