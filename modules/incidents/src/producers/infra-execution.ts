import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { IncidentFact } from "../types.ts";
import { subjectOf, type IncidentProducer, type ProducerClearing } from "./types.ts";

/**
 * WP-E1 (JARVIS-068): en journalført kritisk infra-handling (`infra_executions`, D-105/D-398 og skymålene) som endte `FAILED`/`PARTIAL`/`UNKNOWN` siste døgn blir en hendelse - eieren skal ikke
 * måtte lete i journalen for å oppdage at en klasse D-handling ikke ble som ment. Én hendelse per eksekusjon (fingeravtrykk = eksekusjons-id). Eksekusjoner som allerede hører til en
 * hendelse (`incident_id` satt) og de som allerede er gjenopprettet (`infra_recovery_actions` SUCCESS) gir ingen ny hendelse.
 *
 * Løses kun når en gjenoppretting med utfall SUCCESS er journalført for akkurat denne eksekusjonen (kompensasjonens egen readback).
 */
export function infraExecutionProducer(deps: { pool: pg.Pool; lookbackHours?: number }): IncidentProducer {
  const lookback = deps.lookbackHours ?? 24;
  return {
    name: "infra_execution",
    async observe(ctx, active) {
      const present: IncidentFact[] = [];
      const cleared: ProducerClearing[] = [];
      await withTenantTransaction(deps.pool, ctx.tenantId, async (client) => {
        const failed = await client.query(
          `SELECT e.execution_id, e.tool_id, e.action, e.target, e.verification_outcome, e.recovery_available, e.created_at
             FROM infra_executions e
            WHERE e.tenant_id = $1 AND e.created_at > now() - make_interval(hours => $2::int) AND e.verification_outcome IN ('FAILED', 'PARTIAL', 'UNKNOWN') AND e.incident_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM infra_recovery_actions r WHERE r.tenant_id = e.tenant_id AND r.recovery_of_execution_id = e.execution_id AND r.status = 'SUCCESS')
            ORDER BY e.created_at DESC LIMIT 25`,
          [ctx.tenantId, lookback]
        );
        for (const e of failed.rows as Array<{ execution_id: string; tool_id: string; action: string; target: string; verification_outcome: string; recovery_available: boolean; created_at: Date | string }>) {
          present.push({
            source_kind: "infra_execution", subject: e.execution_id, title: `Infra-handling ${e.verification_outcome}: ${e.tool_id}.${e.action}`,
            severity: e.verification_outcome === "FAILED" ? "high" : "normal", observed_at: new Date(e.created_at).toISOString(),
            evidence: {
              source_type: "infra_execution", source_ref: e.execution_id,
              summary: `${e.tool_id}.${e.action} mot ${e.target}: ${e.verification_outcome}${e.recovery_available ? " - gjenoppretting er tilgjengelig" : ""}`
            }
          });
        }
        for (const incident of active) {
          const subject = subjectOf("infra_execution", incident.dedupe_key);
          if (subject === null) continue;
          const recovered = await client.query(
            `SELECT recovery_id, attempted_at FROM infra_recovery_actions WHERE tenant_id = $1 AND recovery_of_execution_id = $2 AND status = 'SUCCESS' ORDER BY attempted_at DESC LIMIT 1`,
            [ctx.tenantId, subject]
          );
          const row = recovered.rows[0] as { recovery_id: string; attempted_at: Date | string } | undefined;
          if (!row) continue;
          cleared.push({
            subject,
            check: {
              source_type: "infra_execution", source_ref: subject, summary: `gjenoppretting ${row.recovery_id} ga utfall SUCCESS`, observed_at: new Date(row.attempted_at).toISOString(),
              verified_by: "source_recheck", basis: `infra_recovery_actions ${row.recovery_id}: SUCCESS for eksekusjon ${subject}`
            }
          });
        }
      });
      return { present, cleared };
    }
  };
}
