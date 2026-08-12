import type pg from "pg";
import type { SignedApproval } from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.js";

/**
 * Persistent engangs-lager for signerte godkjenninger (erstatter fase 1 sitt
 * in-memory-lager på tvers av prosessrestart). PRIMARY KEY på nonce gjør
 * forbruket atomisk: nøyaktig én INSERT vinner, uansett samtidighet.
 *
 * Kobles inn i Policy Gateway i fase 3 (gateway-grensesnittet er synkront i
 * fase 1 og endres ikke i denne fasen - se PROJECT_STATUS/avvik).
 */
export class PgApprovalStore {
  constructor(private readonly pool: pg.Pool) {}

  /** true = første forbruk (OK å bruke), false = allerede brukt (replay). */
  async consume(tenantId: string, approval: SignedApproval): Promise<boolean> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO approvals (nonce, tenant_id, action, parameters, approving_device_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (nonce) DO NOTHING`,
        [
          approval.nonce,
          tenantId,
          approval.action,
          JSON.stringify(approval.parameters),
          approval.approving_device_id,
          approval.expires_at
        ]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
