import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import type { TaskView, WorkflowAdapter } from "./workflow-adapter.ts";

export type TaskServiceResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Task Service (fase 3): opprette/følge/avbryte jobber. Skriveoperasjoner går
 * gjennom Policy Gateway (klasse B) før de når køen - sikkerhetsflyt:
 * IdentityContext → policy → DB-transaksjon → skriv → audit.
 */
export class TaskService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly queue: WorkflowAdapter,
    private readonly policy: PolicyGateway
  ) {}

  async create(identity: IdentityContext, goal: string): Promise<TaskServiceResult<{ task_id: string }>> {
    const decision = await this.policy.authorize({
      identity,
      toolCall: { tool_id: "tasks", action: "create_task", capability_class: "B", parameters: { goal } }
    });
    if (decision.decision !== "ALLOW") {
      return { ok: false, reason: decision.reason };
    }
    const contract: JobContract = {
      task_id: `task-${randomUUID()}`,
      owner_person_id: identity.person_id,
      tenant_id: identity.tenant_id,
      goal,
      acceptance_criteria: ["jobben fullfører med et resultat"],
      input: { data: {}, trust_level: "internal", provenance: `chat:${identity.session_id}` },
      allowed_tools: [],
      allowed_memory_spaces: [identity.memory_space_id],
      allowed_network_targets: [],
      agent_profile: "executive",
      model_budget_ore: 0,
      retry_policy: { max_attempts: 1, backoff_seconds: 0 },
      max_steps: 1
    };
    await this.queue.enqueue(identity.tenant_id, contract);
    await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
      writeAudit(client, identity, { type: "task.created", payload: { task_id: contract.task_id, goal } })
    );
    return { ok: true, value: { task_id: contract.task_id } };
  }

  async get(identity: IdentityContext, taskId: string): Promise<TaskServiceResult<TaskView>> {
    const decision = await this.policy.authorize({
      identity,
      toolCall: { tool_id: "tasks", action: "read_task", capability_class: "A", parameters: { task_id: taskId } }
    });
    if (decision.decision !== "ALLOW") {
      return { ok: false, reason: decision.reason };
    }
    const task = await this.queue.get(identity.tenant_id, taskId);
    return task ? { ok: true, value: task } : { ok: false, reason: "task_not_found" };
  }

  async cancel(identity: IdentityContext, taskId: string): Promise<TaskServiceResult<{ cancelled: boolean }>> {
    const decision = await this.policy.authorize({
      identity,
      toolCall: { tool_id: "tasks", action: "cancel_task", capability_class: "B", parameters: { task_id: taskId } }
    });
    if (decision.decision !== "ALLOW") {
      return { ok: false, reason: decision.reason };
    }
    const cancelled = await this.queue.cancel(identity.tenant_id, taskId);
    await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
      writeAudit(client, identity, { type: "task.cancelled", payload: { task_id: taskId, cancelled } })
    );
    return { ok: true, value: { cancelled } };
  }
}
