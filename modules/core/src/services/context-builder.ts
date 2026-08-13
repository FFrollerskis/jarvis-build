import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { MessageStore, type StoredMessage } from "./message-store.ts";

export interface ConversationContext {
  history: StoredMessage[];
  open_tasks: Array<{ task_id: string; goal: string; status: string }>;
}

/**
 * Context Builder v1 (fase 3-avgrensning): sesjonshistorikk + strukturerte
 * oppslag under tenant-RLS. Space-autorisasjonen er validert av
 * IdentityService før konteksten bygges; hybridminne kommer i fase 4.
 */
export class ContextBuilder {
  private readonly messages: MessageStore;

  constructor(private readonly pool: pg.Pool) {
    this.messages = new MessageStore(pool);
  }

  async build(identity: IdentityContext, historyLimit = 20): Promise<ConversationContext> {
    const history = await this.messages.history(identity, historyLimit);
    const openTasks = await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
      client.query(
        `SELECT task_id, goal, status FROM tasks
         WHERE status IN ('created', 'running') ORDER BY created_at DESC LIMIT 10`
      )
    );
    return {
      history,
      open_tasks: openTasks.rows as ConversationContext["open_tasks"]
    };
  }
}
