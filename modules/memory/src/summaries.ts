import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { writeAudit } from "@jarvis/core";
import { withMemoryTransaction } from "./spaces.ts";

/**
 * Sammendragslag v1 (minnelag 6): deterministisk template-sammendrag per
 * dag/space. LLM-genererte sammendrag kobles på senere via samme skrivepunkt.
 */
export class SummaryService {
  constructor(private readonly pool: pg.Pool) {}

  async generateDaily(identity: IdentityContext, space: MemorySpace, day: string): Promise<string> {
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const items = await client.query(
        `SELECT subject, content FROM memory_items
         WHERE status = 'active' AND observed_at::date = $1::date
         ORDER BY observed_at`,
        [day]
      );
      const content =
        items.rows.length === 0
          ? `Ingen nye minner ${day}.`
          : `Dagssammendrag ${day} (${items.rows.length} minner):\n` +
            items.rows.map((r) => `- ${(r as { content: string }).content}`).join("\n");
      await client.query(
        `INSERT INTO summaries (summary_id, tenant_id, space, scope, scope_key, content)
         VALUES ($1, $2, $3, 'daily', $4, $5)
         ON CONFLICT (tenant_id, space, scope, scope_key) DO UPDATE SET content = $5, created_at = now()`,
        [`sum-${randomUUID()}`, identity.tenant_id, space, day, content]
      );
      await writeAudit(client, identity, { type: "memory.summary", payload: { space, day } });
      return content;
    });
  }
}
