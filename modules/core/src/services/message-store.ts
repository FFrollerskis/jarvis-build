import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface StoredMessage {
  message_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

/** Sesjonshistorikk i Postgres under tenant-RLS. */
export class MessageStore {
  constructor(private readonly pool: pg.Pool) {}

  async save(identity: IdentityContext, role: MessageRole, content: string): Promise<string> {
    return withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      const messageId = `msg-${randomUUID()}`;
      await client.query(
        `INSERT INTO messages (message_id, tenant_id, session_id, role, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [messageId, identity.tenant_id, identity.session_id, role, content]
      );
      await writeAudit(client, identity, { type: "message.saved", payload: { role } });
      return messageId;
    });
  }

  async history(identity: IdentityContext, limit = 20): Promise<StoredMessage[]> {
    return withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      const result = await client.query(
        `SELECT message_id, role, content, created_at FROM messages
         WHERE session_id = $1 ORDER BY created_at DESC, message_id DESC LIMIT $2`,
        [identity.session_id, limit]
      );
      return (result.rows as StoredMessage[]).reverse();
    });
  }
}
