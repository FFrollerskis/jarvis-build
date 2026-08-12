import type { ClaimedTask, WorkflowAdapter } from "./workflow-adapter.ts";

export type TaskHandler = (task: ClaimedTask) => Promise<Record<string, unknown>>;

/**
 * In-process worker (fase 3): henter jobber fra køen og kjører registrerte
 * handlere per agentprofil. Sandbox-kjøring og eksterne agenter kommer i
 * fase 6 - denne workeren kjører kun interne, ufarlige handlere.
 */
export class InProcessWorker {
  private readonly handlers = new Map<string, TaskHandler>();

  constructor(private readonly queue: WorkflowAdapter) {}

  register(agentProfile: string, handler: TaskHandler): void {
    this.handlers.set(agentProfile, handler);
  }

  /** Kjør én claim/execute-runde. Returnerer task_id hvis en jobb ble kjørt. */
  async tick(): Promise<string | null> {
    const task = await this.queue.claimNext();
    if (!task) {
      return null;
    }
    const handler = this.handlers.get(task.contract.agent_profile);
    try {
      if (!handler) {
        throw new Error(`ingen handler for agentprofil ${task.contract.agent_profile}`);
      }
      const result = await handler(task);
      await this.queue.complete(task.tenant_id, task.task_id, result);
    } catch (err) {
      await this.queue.fail(task.tenant_id, task.task_id, (err as Error).message);
    }
    return task.task_id;
  }

  /** Kjør runder til køen er tom (maks `limit`). */
  async drain(limit = 10): Promise<number> {
    let count = 0;
    while (count < limit && (await this.tick()) !== null) {
      count += 1;
    }
    return count;
  }
}
