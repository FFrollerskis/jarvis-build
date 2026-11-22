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
  /**
   * WP-N1 (Q-66, JARVIS-101): meldingen hører til en tur som var låst til SECRET_RESTRICTED (helse/finans, D-378) og skal behandles som SECRET_RESTRICTED uansett tekst.
   * Settes kun av samtalemotoren med `JARVIS_RESTRICTED_CONTEXT_GUARD=on`; eldre rader og alle rader med flagget AV er `false`. Kolonnen er enveis (migrasjon 140).
   */
  restricted: boolean;
}

/** Sesjonshistorikk i Postgres under tenant-RLS. */
export class MessageStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * `opts.restricted === true` (WP-N1) lagrer meldingen som begrenset fra første stund (assistentsvar fra en låst tur). Uten valget er SQL-en og revisjonsraden NØYAKTIG som før N1 - kolonnen settes aldri
   * (standard `false`). Revisjonen bærer aldri innhold; en begrenset lagring har i tillegg `restricted: true` i nyttelasten.
   */
  async save(identity: IdentityContext, role: MessageRole, content: string, opts: { restricted?: boolean } = {}): Promise<string> {
    return withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      const messageId = `msg-${randomUUID()}`;
      if (opts.restricted === true) {
        await client.query(
          `INSERT INTO messages (message_id, tenant_id, session_id, role, content, restricted)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [messageId, identity.tenant_id, identity.session_id, role, content]
        );
        await writeAudit(client, identity, { type: "message.saved", payload: { role, restricted: true } });
        return messageId;
      }
      await client.query(
        `INSERT INTO messages (message_id, tenant_id, session_id, role, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [messageId, identity.tenant_id, identity.session_id, role, content]
      );
      await writeAudit(client, identity, { type: "message.saved", payload: { role } });
      return messageId;
    });
  }

  /**
   * WP-N1: merker en allerede lagret melding som begrenset (brukermeldingen lagres FØR rutingen er kjent og merkes når en låst rute er avgjort). Idempotent og enveis: en melding som allerede er begrenset
   * endres ikke og gir ingen ny revisjonsrad. Gjelder KUN egen tenant (RLS + eksplisitt `tenant_id`) og egen sesjon (`identity.session_id`) - en annen tenants eller sesjons melding berøres aldri.
   * Returnerer `true` når meldingen finnes i egen tenant/sesjon og nå er (eller allerede var) begrenset, `false` når den ikke finnes der. Revisjonen bærer kun meldings-id-en, aldri innhold.
   */
  async markRestricted(identity: IdentityContext, messageId: string): Promise<boolean> {
    return withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      const updated = await client.query(
        `UPDATE messages SET restricted = true
          WHERE message_id = $1 AND tenant_id = $2 AND session_id = $3 AND restricted = false`,
        [messageId, identity.tenant_id, identity.session_id]
      );
      if ((updated.rowCount ?? 0) > 0) {
        await writeAudit(client, identity, { type: "message.restricted_marked", payload: { message_id: messageId } });
        return true;
      }
      const existing = await client.query(
        `SELECT 1 FROM messages WHERE message_id = $1 AND tenant_id = $2 AND session_id = $3`,
        [messageId, identity.tenant_id, identity.session_id]
      );
      return (existing.rowCount ?? 0) > 0;
    });
  }

  async history(identity: IdentityContext, limit = 20): Promise<StoredMessage[]> {
    return withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      const result = await client.query(
        `SELECT message_id, role, content, created_at, restricted FROM messages
         WHERE session_id = $1 ORDER BY created_at DESC, message_id DESC LIMIT $2`,
        [identity.session_id, limit]
      );
      return (result.rows as StoredMessage[]).reverse();
    });
  }
}
