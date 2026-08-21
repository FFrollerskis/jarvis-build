import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { Deployment, RecordDeploymentInput } from "./types.ts";

/**
 * D-104 (D-64 Core-vs-Adapter): kanonisk "hva er live i produksjon"-
 * tilstand. `deployments` er REN infra-audit (tenant-scoped, ingen
 * memory_space_id - samme klasse som `tool_executions`) - IKKE del av
 * Q-20-erasure-planen. Denne tjenesten gjør ALDRI et eget HTTP-kall - den
 * NORMALISERER kun data som allerede er hentet via den eksisterende
 * `github.get_workflow_run`/`get_commit`-ToolGateway-veien (kalleren
 * henter dataene FØR den kaller `recordDeployment`).
 */
export class DeploymentService {
  constructor(private readonly pool: pg.Pool) {}

  async recordDeployment(tenantId: string, input: RecordDeploymentInput): Promise<{ deployment: Deployment; created: boolean }> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const deployment_id = `dep-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO deployments (deployment_id, tenant_id, source, repo, commit_sha, ref, workflow_run_id, status, deployed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, source, repo, workflow_run_id)
           DO UPDATE SET status = EXCLUDED.status, commit_sha = EXCLUDED.commit_sha, deployed_at = EXCLUDED.deployed_at
         RETURNING *, (xmax = 0) AS inserted`,
        [
          deployment_id, tenantId, input.source, input.repo, input.commit_sha,
          input.ref ?? null, input.workflow_run_id ?? null, input.status, input.deployed_at
        ]
      );
      const row = rows[0] as Deployment & { inserted: boolean };
      return { deployment: row, created: row.inserted };
    });
  }

  async listDeployments(tenantId: string, repo: string, limit = 50): Promise<Deployment[]> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const bounded = Math.min(Math.max(limit, 1), 200);
      const { rows } = await client.query(
        `SELECT * FROM deployments WHERE tenant_id = $1 AND repo = $2 ORDER BY deployed_at DESC LIMIT ${bounded}`,
        [tenantId, repo]
      );
      return rows as Deployment[];
    });
  }

  /** Nyeste deploy for repoet uavhengig av tidsvindu - "hva er live nå". */
  async findActiveDeployment(tenantId: string, repo: string): Promise<Deployment | null> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM deployments WHERE tenant_id = $1 AND repo = $2 ORDER BY deployed_at DESC LIMIT 1`,
        [tenantId, repo]
      );
      return (rows[0] as Deployment) ?? null;
    });
  }

  /**
   * Deterministisk (INGEN LLM): nyeste deploy for repoet FØR `beforeIso`
   * - den mest sannsynlige utløsende deployen for en hendelse hvis første
   * observerte bevis skjedde ved `beforeIso`. Returnerer `null` hvis ingen
   * deploy finnes i det hele tatt før tidspunktet (aldri gjettet).
   */
  async findSuspectDeployment(tenantId: string, repo: string, beforeIso: string): Promise<Deployment | null> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM deployments WHERE tenant_id = $1 AND repo = $2 AND deployed_at <= $3 ORDER BY deployed_at DESC LIMIT 1`,
        [tenantId, repo, beforeIso]
      );
      return (rows[0] as Deployment) ?? null;
    });
  }
}
