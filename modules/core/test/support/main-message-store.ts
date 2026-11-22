import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction } from "../../src/db/pool.ts";
import { writeAudit } from "../../src/services/audit-writer.ts";

/**
 * WP-N1 (fiks-runde 1, F-A3/D07): en ORDRETT kopi av `MessageStore` slik den var på `origin/main` (`git show ec3e684e:modules/core/src/services/message-store.ts`), kun omdøpt til `MainMessageStore` og med importene rettet til denne mappen.
 * Brukes av `wpn1-message-store-sql.test.ts` til å bevise at flagg AV (3 argumenter / ingen valg) gir NØYAKTIG samme setningsfølge mot databasen som main. IKKE produksjonskode - ikke endre denne uten å regenerere fra main.
 */
export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface StoredMessage {
  message_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

/** Sesjonshistorikk i Postgres under tenant-RLS. */
export class MainMessageStore {
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
