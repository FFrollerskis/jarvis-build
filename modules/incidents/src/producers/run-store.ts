import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import { redactSecrets } from "../redact.ts";
import type { IncidentProducerName } from "../types.ts";

/**
 * WP-E1 (JARVIS-068): helse for produsentene (`incident_producer_runs`, migrasjon 098). En produsent som STILLE er død er verre enn ingen produsent - eieren tror «ingen hendelser = alt OK» -
 * så hver kjøring registrerer start, slutt, utfall og antall. Kun tall og en kort, redigert feilbeskrivelse; aldri innhold.
 */
export interface ProducerRunRow {
  producer: IncidentProducerName;
  last_started_at: string;
  last_finished_at: string | null;
  last_status: "running" | "ok" | "failed" | "skipped";
  last_error: string | null;
  facts_seen: number;
  opened: number;
  updated: number;
  resolved: number;
  suppressed: number;
  consecutive_failures: number;
}

export interface ProducerRunResult {
  status: "ok" | "failed" | "skipped";
  error?: string;
  facts_seen: number;
  opened: number;
  updated: number;
  resolved: number;
  suppressed: number;
}

export class ProducerRunStore {
  constructor(private readonly pool: pg.Pool) {}

  async start(tenantId: string, producer: IncidentProducerName, at: Date): Promise<void> {
    await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `INSERT INTO incident_producer_runs (tenant_id, producer, last_started_at, last_status) VALUES ($1, $2, $3, 'running')
         ON CONFLICT (tenant_id, producer) DO UPDATE SET last_started_at = EXCLUDED.last_started_at, last_status = 'running'`,
        [tenantId, producer, at]
      )
    );
  }

  async finish(tenantId: string, producer: IncidentProducerName, at: Date, result: ProducerRunResult): Promise<void> {
    const error = result.error === undefined ? null : redactSecrets(result.error).slice(0, 300);
    await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `UPDATE incident_producer_runs
            SET last_finished_at = $3, last_status = $4, last_error = $5, facts_seen = $6, opened = $7, updated = $8, resolved = $9, suppressed = $10,
                consecutive_failures = CASE WHEN $4 = 'failed' THEN consecutive_failures + 1 ELSE 0 END
          WHERE tenant_id = $1 AND producer = $2`,
        [tenantId, producer, at, result.status, error, result.facts_seen, result.opened, result.updated, result.resolved, result.suppressed]
      )
    );
  }

  async list(tenantId: string): Promise<ProducerRunRow[]> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT producer, last_started_at, last_finished_at, last_status, last_error, facts_seen, opened, updated, resolved, suppressed, consecutive_failures
           FROM incident_producer_runs WHERE tenant_id = $1 ORDER BY producer`,
        [tenantId]
      );
      return rows as ProducerRunRow[];
    });
  }
}
