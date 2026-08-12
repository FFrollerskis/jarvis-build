import type pg from "pg";
import { EventEnvelopeSchema, type EventEnvelope } from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.js";
import { writeAudit } from "./audit-writer.js";

export interface AppendResult {
  inserted: boolean;
  event_id: string;
}

/**
 * Idempotent, append-only hendelsesskriving (akseptansekriterium 2):
 * samme (tenant_id, idempotency_key) to ganger gir nøyaktig én rad.
 * Konflikt er et normalt utfall (retry/failover), ikke en feil.
 */
export class EventWriter {
  constructor(private readonly pool: pg.Pool) {}

  async append(envelope: EventEnvelope): Promise<AppendResult> {
    const event = EventEnvelopeSchema.parse(envelope);
    return withTenantTransaction(this.pool, event.tenant_id, async (client) => {
      const result = await client.query(
        `INSERT INTO events
           (event_id, idempotency_key, tenant_id, person_id, session_id, task_id,
            source, type, trust_level, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [
          event.event_id,
          event.idempotency_key,
          event.tenant_id,
          event.person_id ?? null,
          event.session_id ?? null,
          event.task_id ?? null,
          event.source,
          event.type,
          event.trust_level,
          JSON.stringify(event.payload),
          event.occurred_at
        ]
      );
      const inserted = (result.rowCount ?? 0) > 0;
      await writeAudit(
        client,
        {
          tenant_id: event.tenant_id,
          person_id: event.person_id ?? "system",
          session_id: event.session_id ?? "none",
          device_id: "none"
        },
        {
          type: inserted ? "event.recorded" : "event.duplicate_ignored",
          payload: { event_type: event.type, idempotency_key: event.idempotency_key }
        }
      );
      return { inserted, event_id: event.event_id };
    });
  }
}
