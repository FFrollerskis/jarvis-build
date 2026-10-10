// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import { INFRA_TARGETS, type InfraIncidentItem, type InfraMeasurements, type InfraStatusSource } from "@jarvis/executive";
import { ProducerRunStore, incidentPhase, incidentPhaseNo, type IncidentStatus } from "@jarvis/incidents";
import { withMemoryTransaction } from "@jarvis/memory";
import { INCIDENT_PRODUCER_MEMORY_SPACE } from "./incident-producers.ts";

/**
 * WP-E1 (UA-5, JARVIS-068): datakilden for `executive.get_infra_status`. Leser KUN eksisterende tabeller som app-rollen under RLS (`incidents`, `incident_transitions`, `incident_evidence`,
 * `infra_executions`, `incident_producer_runs`) - ingen ny tabell, ingen ekstern kall. Kun tall, titler, faser og pekere: BEVISTEKST og hendelses-fritekst forlater aldri databasen her (en produsent-
 * tittel er en fast mal, en manuell tittel er eierens egen). Hver del feiler for seg selv (`errors`), aldri hele rapporten.
 */
const SEVERITY_ORDER = `CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;
const MAX_ITEMS = 21; // 20 + 1 for å kunne melde "avkortet"

interface IncidentRow {
  incident_id: string; title: string; severity: InfraIncidentItem["severity"]; status: IncidentStatus; source_kind: string; opened_at: Date | string; last_seen_at: Date | string | null;
  occurrence_count: number; change_at: Date | string | null; change_actor: string | null; change_to: IncidentStatus | null; verified: number; observed: number; claimed: number;
}

const iso = (v: Date | string): string => new Date(v).toISOString();

export function createInfraStatusSource(pool: pg.Pool): InfraStatusSource {
  return {
    async measure(tenantId: string): Promise<InfraMeasurements> {
      const errors: string[] = [];
      const [incidents, lastChanges, producerRuns] = await Promise.all([
        withMemoryTransaction(pool, tenantId, [INCIDENT_PRODUCER_MEMORY_SPACE], async (client) => {
          const { rows } = await client.query(
            `SELECT i.incident_id, i.title, i.severity, i.status, i.source_kind, i.opened_at, i.last_seen_at, i.occurrence_count,
                    t.occurred_at AS change_at, t.actor_kind AS change_actor, t.to_status AS change_to,
                    coalesce(e.verified, 0) AS verified, coalesce(e.observed, 0) AS observed, coalesce(e.claimed, 0) AS claimed
               FROM incidents i
               LEFT JOIN LATERAL (SELECT occurred_at, actor_kind, to_status FROM incident_transitions x WHERE x.tenant_id = i.tenant_id AND x.incident_id = i.incident_id ORDER BY occurred_at DESC, transition_id DESC LIMIT 1) t ON true
               LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE status = 'VERIFIED')::int AS verified, count(*) FILTER (WHERE status = 'PROVISIONAL')::int AS observed, count(*) FILTER (WHERE status = 'UNVERIFIED')::int AS claimed
                                    FROM incident_evidence ev WHERE ev.tenant_id = i.tenant_id AND ev.incident_id = i.incident_id) e ON true
              WHERE i.tenant_id = $1 AND i.status NOT IN ('resolved', 'wont_fix')
              ORDER BY ${SEVERITY_ORDER}, i.opened_at DESC LIMIT ${MAX_ITEMS}`,
            [tenantId]
          );
          const counts = await client.query(
            `SELECT status, count(*)::int AS n FROM incidents WHERE tenant_id = $1 AND status NOT IN ('resolved', 'wont_fix') GROUP BY status`, [tenantId]
          );
          const resolved = await client.query(
            `SELECT count(*)::int AS n FROM incidents WHERE tenant_id = $1 AND status = 'resolved' AND resolved_at > now() - interval '7 days'`, [tenantId]
          );
          const by_phase: Record<string, number> = {};
          let active_total = 0;
          for (const c of counts.rows as Array<{ status: IncidentStatus; n: number }>) {
            by_phase[incidentPhase(c.status)] = (by_phase[incidentPhase(c.status)] ?? 0) + c.n;
            active_total += c.n;
          }
          const active: InfraIncidentItem[] = (rows as IncidentRow[]).map((r) => ({
            incident_id: r.incident_id, title: r.title, severity: r.severity, source_kind: r.source_kind,
            phase: incidentPhase(r.status), phase_no: incidentPhaseNo(r.status),
            opened_at: iso(r.opened_at), last_seen_at: r.last_seen_at === null ? null : iso(r.last_seen_at), occurrence_count: r.occurrence_count,
            last_change: r.change_at === null || r.change_to === null ? null : { at: iso(r.change_at), actor_kind: r.change_actor ?? "ukjent", to_phase_no: incidentPhaseNo(r.change_to) },
            evidence: { verified: r.verified, observed: r.observed, claimed: r.claimed }
          }));
          return { active, active_total, by_phase, resolved_last_7d: (resolved.rows[0] as { n: number }).n };
        }).catch(() => { errors.push("åpne hendelser: lesingen feilet"); return null; }),
        withTenantTransaction(pool, tenantId, async (client) => {
          const { rows } = await client.query(
            `SELECT DISTINCT ON (tool_id) tool_id, action, verification_outcome, created_at FROM infra_executions
              WHERE tenant_id = $1 AND tool_id = ANY($2::text[]) ORDER BY tool_id, created_at DESC`,
            [tenantId, INFRA_TARGETS.map((t) => t.tool_id)]
          );
          const out: NonNullable<InfraMeasurements["last_changes"]> = {};
          for (const r of rows as Array<{ tool_id: string; action: string; verification_outcome: "SUCCESS" | "PARTIAL" | "FAILED" | "UNKNOWN"; created_at: Date | string }>) {
            out[r.tool_id] = { at: iso(r.created_at), action: r.action, outcome: r.verification_outcome };
          }
          return out;
        }).catch(() => { errors.push("siste endring per skymål: journalen kunne ikke leses"); return null; }),
        new ProducerRunStore(pool).list(tenantId).then((runs) => runs.map((r) => ({
          producer: r.producer, last_status: r.last_status, last_started_at: iso(r.last_started_at), consecutive_failures: r.consecutive_failures,
          opened: r.opened, updated: r.updated, resolved: r.resolved, suppressed: r.suppressed, last_error: r.last_error
        }))).catch(() => { errors.push("produsentenes helse: lesingen feilet"); return null; })
      ]);
      errors.push(`hendelser leses kun fra minne-rommet «${INCIDENT_PRODUCER_MEMORY_SPACE}» (der produsentene og situasjonssveipet jobber)`);
      return { incidents, last_changes: lastChanges, producer_runs: producerRuns, errors };
    }
  };
}
