import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { SignalFacts, SignalSource } from "./signal-types.ts";
import type { SituationPriority, SituationStage } from "./types.ts";

/**
 * WP-G4 (D-466): lesing og opprydding av signalloggen (`situation_signal_log`, migrasjon 139). Loggen er Jarvis' egen, minimerte historikk (aldri rå verdier, bilder, etiketter eller fritekst - se `assertMinimalFacts`);
 * den brukes til forklarbarhet (eierens lesing), simulering («hva om») og statistikk. Tenant/space er eksplisitte argumenter (RLS).
 */
export interface SignalLogEntry {
  signal_id: string;
  tenant_id: string;
  memory_space_id: string;
  source: SignalSource;
  event_type: string;
  domain: string;
  source_ref: string;
  detection_key: string;
  situation_id: string;
  subscription_id: string | null;
  occurred_at: string;
  recorded_at: string;
  outcome: "created" | "updated";
  stage_after: SituationStage;
  priority: SituationPriority;
  notified: boolean;
  facts: SignalFacts;
  task_id: string | null;
  session_id: string | null;
}

export const DEFAULT_SIGNAL_LOG_RETENTION_DAYS = 30;
export const SIGNAL_LOG_RETENTION_BOUNDS = { min: 7, max: 365 } as const;

export class SignalLogService {
  constructor(private readonly pool: pg.Pool) {}

  async list(tenantId: string, memorySpace: MemorySpace, filter: { situation_id?: string; source?: SignalSource; limit?: number } = {}): Promise<SignalLogEntry[]> {
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 50), 1), 200);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1", "memory_space_id = $2"];
      const params: Array<string | number> = [tenantId, memorySpace];
      if (filter.situation_id !== undefined) {
        params.push(filter.situation_id);
        conditions.push(`situation_id = $${params.length}`);
      }
      if (filter.source !== undefined) {
        params.push(filter.source);
        conditions.push(`source = $${params.length}`);
      }
      params.push(limit);
      const { rows } = await client.query(
        `SELECT * FROM situation_signal_log WHERE ${conditions.join(" AND ")} ORDER BY occurred_at DESC, recorded_at DESC LIMIT $${params.length}`,
        params
      );
      return rows as SignalLogEntry[];
    });
  }

  /** Logginnslag for en LISTE av regler (`source:event_type`) siden et tidspunkt - grunnlaget for simulering over registrerte hendelser. */
  async forRules(tenantId: string, memorySpace: MemorySpace, ruleKeys: readonly string[], sinceMs: number, limit = 500): Promise<SignalLogEntry[]> {
    if (ruleKeys.length === 0) return [];
    const pairs = ruleKeys.map((k) => k.split(":") as [string, string]);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM situation_signal_log
         WHERE tenant_id = $1 AND memory_space_id = $2 AND occurred_at >= $3
           AND (source, event_type) IN (SELECT * FROM unnest($4::text[], $5::text[]))
         ORDER BY occurred_at ASC LIMIT $6`,
        [tenantId, memorySpace, new Date(sinceMs).toISOString(), pairs.map((p) => p[0]), pairs.map((p) => p[1]), Math.min(Math.max(limit, 1), 2000)]
      );
      return rows as SignalLogEntry[];
    });
  }

  /** Daglig opprydding: sletter innslag eldre enn `retentionDays` (klemt til [7, 365]). Rører aldri situasjonene. */
  async purge(tenantId: string, memorySpace: MemorySpace, retentionDays: number = DEFAULT_SIGNAL_LOG_RETENTION_DAYS, nowMs: number = Date.now()): Promise<number> {
    const days = Math.min(SIGNAL_LOG_RETENTION_BOUNDS.max, Math.max(SIGNAL_LOG_RETENTION_BOUNDS.min, Math.floor(retentionDays)));
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM situation_signal_log WHERE tenant_id = $1 AND memory_space_id = $2 AND recorded_at < $3`,
        [tenantId, memorySpace, new Date(nowMs - days * 86_400_000).toISOString()]
      );
      return rowCount ?? 0;
    });
  }
}
