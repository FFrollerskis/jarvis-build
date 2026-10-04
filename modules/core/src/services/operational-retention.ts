import type pg from "pg";

/**
 * D-395 (JARVIS-074): daglig oppbevaringssveip for driftsrader som ellers vokser uten grense (`approvals`, `session_grants`,
 * `device_enrollment_tickets`, ferdige `tool_executions`, `scheduler_state`). All sletting skjer i databasefunksjonen
 * `prune_operational_data()` (migrasjon 073) - SECURITY DEFINER med faste gulv i selve RLS-policyene. Runtime-rollen har EXECUTE, ikke DELETE.
 *
 * Sveipet er bevisst begrenset: hver batch sletter høyst `batch` rader per tabell, og løkken stopper etter `maxBatches` (resten tas neste døgn)
 * slik at en stor etterslepskø aldri låser tabellene lenge eller holder en tilkobling opptatt.
 * Revisjon (`audit_events`), hendelseslogg (`events`) og kostnadsledger (`cost_events`) beholdes: oppbevaringspolicy for dem er en eierbeslutning.
 */
export interface OperationalRetentionOptions {
  approvalsDays?: number;
  grantsDays?: number;
  ticketsDays?: number;
  toolExecutionsDays?: number;
  schedulerDays?: number;
  /** Maks rader per tabell per batch (klemmes til 100..50000 i databasefunksjonen). */
  batch?: number;
  /** Maks antall batcher per kjøring. */
  maxBatches?: number;
}

export interface OperationalRetentionResult {
  deleted: Record<string, number>;
  batches: number;
  /** true hvis `maxBatches` ble nådd mens det fortsatt var mer å slette (fortsetter neste kjøring). */
  capped: boolean;
}

const DEFAULT_BATCH = 5000;
const DEFAULT_MAX_BATCHES = 20;

export async function runOperationalRetentionSweep(
  pool: pg.Pool,
  opts: OperationalRetentionOptions = {}
): Promise<OperationalRetentionResult> {
  const batch = opts.batch ?? DEFAULT_BATCH;
  const maxBatches = Math.max(1, opts.maxBatches ?? DEFAULT_MAX_BATCHES);
  const deleted: Record<string, number> = {};
  let batches = 0;
  let more = false;
  while (batches < maxBatches) {
    const { rows } = await pool.query(
      "SELECT table_name, deleted::int AS deleted FROM prune_operational_data($1, $2, $3, $4, $5, $6)",
      [opts.approvalsDays ?? 30, opts.grantsDays ?? 30, opts.ticketsDays ?? 30, opts.toolExecutionsDays ?? 180, opts.schedulerDays ?? 90, batch]
    );
    batches += 1;
    let hitBatchLimit = false;
    for (const row of rows as { table_name: string; deleted: number }[]) {
      deleted[row.table_name] = (deleted[row.table_name] ?? 0) + row.deleted;
      // Databasefunksjonen klemmer `batch` til minst 100 - en full batch betyr at det trolig finnes mer.
      if (row.deleted >= Math.min(Math.max(batch, 100), 50_000)) hitBatchLimit = true;
    }
    more = hitBatchLimit;
    if (!hitBatchLimit) break;
  }
  return { deleted, batches, capped: more && batches >= maxBatches };
}
