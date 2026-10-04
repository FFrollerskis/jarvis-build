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

/** D-393: heartbeat fikk `false` fra `renewLease` - en annen worker har overtatt jobben. */
export class LeaseLostError extends Error {
  constructor() {
    super("lease_lost");
    this.name = "LeaseLostError";
  }
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
    // D-103 (Blokker A): claimet er nå ATOMISK begrenset til agent_profile-
    // verdiene DENNE worker-instansen faktisk har en registrert handler for -
    // en jobb denne prosessen ikke kan utføre claimes ALDRI, forblir 'created'
    // til en kompatibel worker henter den. Erstatter den tidligere agent-
    // profil-blinde claim + "ingen handler"-feilen under (bevart KUN som et
    // forsvar-i-dybden mot programmeringsfeil, aldri forventet i normal drift).
    const task = await this.queue.claimNext(this.workerId, this.leaseSeconds, [...this.handlers.keys()]);
    if (!task) {
      return null;
    }
    // D-393 (JARVIS-040): leasen fornyes mens handleren kjører (heartbeat hvert tredje lease-intervall). Tidligere gikk leasen ut etter 60 s selv om
    // jobben fortsatt kjørte, og `claim_next_task` ga den samme (eller en annen) worker til å kjøre jobben en gang til parallelt.
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.queue.renewLease(task.tenant_id, task.task_id, this.workerId, this.leaseSeconds).then(
        (ok) => { if (!ok) leaseLost = true; },
        (err) => console.error(JSON.stringify({ msg: "lease_renew_failed", task_id: task.task_id, error: (err as Error).message.slice(0, 120) }))
      );
    }, Math.max(1_000, Math.floor((this.leaseSeconds * 1000) / 3)));
    heartbeat.unref();
    const ctx: JobContext = {
      attempts: task.attempts,
      checkpoint: task.checkpoint,
      saveCheckpoint: async (checkpoint) => {
        await this.queue.saveCheckpoint(task.tenant_id, task.task_id, this.workerId, checkpoint);
      },
      assertNotCancelled: async () => {
        if (leaseLost) throw new LeaseLostError();
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
      if (err instanceof LeaseLostError) {
        // Leasen er tapt: en annen worker eier jobben nå - IKKE skriv resultat/feil (fail()/complete() ville uansett avvist som stale).
        console.error(JSON.stringify({ msg: "task_lease_lost", task_id: task.task_id, worker_id: this.workerId }));
      } else if (err instanceof JobCancelledError) {
        await this.queue.markCancelled(task.tenant_id, task.task_id, this.workerId);
      } else {
        await this.queue.fail(task.tenant_id, task.task_id, this.workerId, (err as Error).message);
      }
    } finally {
      clearInterval(heartbeat);
    }
    return task.task_id;
  }

  private draining = false;

  /**
   * D-393 (JARVIS-040): ingen overlappende drain-løkker (2 s-intervallet i worker-main kunne starte en ny `drain()` mens forrige fortsatt
   * kjørte en lang jobb, og samme worker claimet så sin egen kjørende jobb på nytt). Pågår en drain, returnerer et nytt kall umiddelbart 0.
   */
  async drain(limit = 10): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      let count = 0;
      while (count < limit && (await this.tick()) !== null) {
        count += 1;
      }
      return count;
    } finally {
      this.draining = false;
    }
  }
}
