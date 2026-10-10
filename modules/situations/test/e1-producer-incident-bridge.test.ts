import type pg from "pg";
import { describe, expect, it } from "vitest";
import { incidentCorrelationId, incidentDedupeKey, type IncidentRecord } from "@jarvis/incidents";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { INFRA_INCIDENT_DETECTION_KEY_PREFIX, mapIncidentToCandidate } from "../src/infra-incident-bridge.ts";
import type { SituationEngine } from "../src/service.ts";
import { runSituationSweepForAllTenants, type IncidentReader } from "../src/sweep.ts";

/**
 * WP-E1 (JARVIS-068): produsent-åpnede hendelser (med fingeravtrykk, korrelasjons-id og antall) flyter gjennom den EKSISTERENDE infra-broen UENDRET - broen kjenner bare den smale `Incident`-kontrakten.
 * Beviser at (a) situasjonsnøkkelen fortsatt er hendelses-id (ikke fingeravtrykk/korrelasjons-id), (b) ingen produsent-interne felter lekker inn i situasjonsteksten, (c) en regresjon som gjenåpner SAMME hendelse
 * beholder situasjonen, mens en NY rad (etter gjenåpningsvinduet) blir en ny situasjon, og (d) sveipet ingester aktive og avslutter løste.
 */
function producerIncident(over: Partial<IncidentRecord> = {}): IncidentRecord {
  const dedupe = incidentDedupeKey("scheduler", "morning-brief");
  return {
    incident_id: "inc-p1", tenant_id: "t-1", memory_space_id: "business", title: "Bakgrunnsjobben morning-brief ga opp", status: "open", severity: "high", owner_person_id: null,
    opened_at: "2026-10-09T05:00:00Z", resolved_at: null, created_at: "2026-10-09T05:00:00Z", updated_at: "2026-10-09T05:00:00Z",
    source_kind: "scheduler", dedupe_key: dedupe, correlation_id: incidentCorrelationId("t-1", dedupe), occurrence_count: 7, last_seen_at: "2026-10-09T09:00:00Z", ...over
  };
}

describe("produsent-hendelser gjennom infra-broen", () => {
  it("kandidaten bygges kun av tittel/status/alvorlighet - fingeravtrykk, korrelasjons-id og antall lekker aldri inn", () => {
    const record = producerIncident();
    const candidate = mapIncidentToCandidate(record);
    expect(candidate).toEqual({
      domain: "infra", detection_key: `${INFRA_INCIDENT_DETECTION_KEY_PREFIX}inc-p1`, priority: "high",
      reason: "Bakgrunnsjobben morning-brief ga opp (status: open, alvorlighetsgrad: high)"
    });
    const text = JSON.stringify(candidate);
    expect(text).not.toContain(record.correlation_id!);
    expect(text).not.toContain("scheduler:morning-brief");
    expect(text).not.toContain("occurrence");
  });

  it("gjenåpnet regresjon (samme rad) beholder situasjonsnøkkelen; en NY rad med samme korrelasjons-id er en ny situasjon", () => {
    const first = producerIncident();
    const reopened = producerIncident({ status: "open", resolved_at: null, occurrence_count: 8 });
    const fresh = producerIncident({ incident_id: "inc-p2" });
    expect(mapIncidentToCandidate(reopened).detection_key).toBe(mapIncidentToCandidate(first).detection_key);
    expect(fresh.correlation_id).toBe(first.correlation_id);
    expect(mapIncidentToCandidate(fresh).detection_key).not.toBe(mapIncidentToCandidate(first).detection_key);
  });

  it("sveipet tar imot IncidentRecord uendret: aktive ingesteres, løste/lukkede utelates og avslutter situasjonen", async () => {
    const ingested: string[] = [];
    let activeKeys: readonly string[] = [];
    const engine = {
      evaluateCandidate: async (_t: string, _m: string, c: { detection_key: string }) => { ingested.push(c.detection_key); return { situation: {}, newly_actionable: false }; },
      resolveForResolvedSources: async () => 0,
      resolveStaleForDomain: async (_t: string, _m: string, _d: string, keys: readonly string[]) => { activeKeys = keys; return 1; },
      deliverPendingInformNotifications: async () => ({ delivered: 0, reconciled_from_evidence: 0, pending: 0, evidence_mismatch: 0, deferred: 0, paused: 0 }),
      autoActPending: async () => ({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 })
    } as unknown as SituationEngine;
    const incidents: IncidentReader = {
      listIncidents: async () => [
        producerIncident({ incident_id: "inc-open" }),
        producerIncident({ incident_id: "inc-resolved", status: "resolved", resolved_at: "2026-10-09T08:00:00Z" }),
        producerIncident({ incident_id: "inc-muted", status: "wont_fix" }),
        producerIncident({ incident_id: "inc-mitigating", status: "repair_in_progress" })
      ]
    };
    const pool = { query: async () => ({ rows: [{ tenant_id: "t-1" }] }) } as unknown as pg.Pool;
    const results = await runSituationSweepForAllTenants(pool, {
      openLoops: { listOpenLoops: async () => [] }, incidents, engine, gateway: {} as ToolGateway,
      identityFor: (tenantId) => ({ person_id: "p", tenant_id: tenantId, memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" })
    });
    expect(ingested).toEqual([`${INFRA_INCIDENT_DETECTION_KEY_PREFIX}inc-open`, `${INFRA_INCIDENT_DETECTION_KEY_PREFIX}inc-mitigating`]);
    expect(activeKeys).toEqual(ingested);
    expect(results["t-1"]).toMatchObject({ ingested: 2, resolved_from_source: 1, errors: [] });
  });
});
