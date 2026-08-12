import { randomUUID } from "node:crypto";
import type { JsonValue } from "@jarvis/contracts";
import type { ClaimedTask, WorkflowAdapter } from "./workflow-adapter.ts";

export class JobCancelledError extends Error {
  constructor() {
    super("job_cancelled");
  }
}

/** Kjørekontekst per jobb: checkpoints + kanselleringssjekk (durable resume). */
export interface JobContext {
  attempts: number;
  checkpoint: Record<string, JsonValue> | null;
  saveCheckpoint(checkpoint: Record<string, JsonValue>): Promise<void>;
  /** Kastes JobCancelledError hvis kansellering er forespurt (kalles ved trygge punkter). */
  assertNotCancelled(): Promise<void>;
}

export type TaskHandler = (task: ClaimedTask, ctx: JobContext) => Promise<Record<string, unknown>>;

/**
 * Durable worker (fase 6): claim med lease, checkpoints, retries via
 * WorkflowAdapter.fail, kontrollert kansellering. Feil i én jobb tar aldri
 * ned worker-løkka; stale workers (mistet lease) kan ikke overskrive resultat.
 */
export class InProcessWorker {
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly queue: WorkflowAdapter,
    private readonly leaseSeconds = 60
  ) {}

  private readonly handlers = new Map<string, TaskHandler>();

  register(agentProfile: string, handler: TaskHandler): void {
    this.handlers.set(agentProfile, handler);
  }

  async tick(): Promise<string | null> {
    const task = await this.queue.claimNext(this.workerId, this.leaseSeconds);
    if (!task) {
      return null;
    }
    const ctx: JobContext = {
      attempts: task.attempts,
      checkpoint: task.checkpoint,
      saveCheckpoint: async (checkpoint) => {
        await this.queue.saveCheckpoint(task.tenant_id, task.task_id, this.workerId, checkpoint);
      },
      assertNotCancelled: async () => {
        if (await this.queue.isCancelRequested(task.tenant_id, task.task_id)) {
          throw new JobCancelledError();
        }
      }
    };
    try {
      const handler = this.handlers.get(task.contract.agent_profile);
      if (!handler) {
        throw new Error(`ingen handler for agentprofil ${task.contract.agent_profile}`);
      }
      await ctx.assertNotCancelled();
      const result = await handler(task, ctx);
      // Kansellering vinner over "success" hvis den kom inn før fullføring:
      if (await this.queue.isCancelRequested(task.tenant_id, task.task_id)) {
        await this.queue.markCancelled(task.tenant_id, task.task_id, this.workerId);
      } else {
        await this.queue.complete(task.tenant_id, task.task_id, this.workerId, result);
      }
    } catch (err) {
      if (err instanceof JobCancelledError) {
        await this.queue.markCancelled(task.tenant_id, task.task_id, this.workerId);
      } else {
        await this.queue.fail(task.tenant_id, task.task_id, this.workerId, (err as Error).message);
      }
    }
    return task.task_id;
  }

  async drain(limit = 10): Promise<number> {
    let count = 0;
    while (count < limit && (await this.tick()) !== null) {
      count += 1;
    }
    return count;
  }
}
