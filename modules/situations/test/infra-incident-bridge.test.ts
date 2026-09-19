import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { Incident, IncidentStatus } from "@jarvis/incidents";
import type { ToolGateway } from "@jarvis/tool-gateway";
import {
  INFRA_DOMAIN, INFRA_INCIDENT_DETECTION_KEY_PREFIX, isActiveIncidentStatus, mapIncidentToCandidate
} from "../src/infra-incident-bridge.ts";
import type { SituationEngine } from "../src/service.ts";
import { runSituationSweepForAllTenants, type IncidentReader, type OpenLoopReader } from "../src/sweep.ts";

/**
 * D-195 (infra-slice): rene enhetsbevis (ingen database) for infra-broen -
 * SAMME "kun det deterministiske, ikke-DB-avhengige beviset" som
 * `open-loop-bridge.test.ts`.
 */
function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    incident_id: "inc-1", tenant_id: "t-1", memory_space_id: "business",
    title: "API 500-rate over terskel", status: "open", severity: "high",
    owner_person_id: null, opened_at: "2026-09-19T00:00:00Z", resolved_at: null,
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T00:00:00Z",
    ...overrides
  };
}

describe("A: isActiveIncidentStatus - kun resolved/wont_fix er terminale", () => {
  it.each<[IncidentStatus, boolean]>([
    ["open", true], ["diagnosing", true], ["repair_proposed", true], ["repair_in_progress", true],
    ["resolved", false], ["wont_fix", false]
  ])("%s => aktiv=%s", (status, expected) => {
    expect(isActiveIncidentStatus(status)).toBe(expected);
  });
});

describe("B: mapIncidentToCandidate - domene 'infra', prefikset detection_key, ingen eier, ingen source_open_loop_id, deterministisk reason", () => {
  it("bygger kandidaten fra allerede lagrede felter, ingen modell-generert tekst", () => {
    const c = mapIncidentToCandidate(incident({ severity: "critical", status: "diagnosing" }));
    expect(c).toEqual({
      domain: INFRA_DOMAIN,
      detection_key: `${INFRA_INCIDENT_DETECTION_KEY_PREFIX}inc-1`,
      priority: "high",
      reason: "API 500-rate over terskel (status: diagnosing, alvorlighetsgrad: critical)"
    });
    expect("owner_person_id" in c).toBe(false);
    expect("source_open_loop_id" in c).toBe(false);
    expect("confidence" in c).toBe(false);
  });

  it.each<[Incident["severity"], "low" | "normal" | "high"]>([
    ["low", "low"], ["normal", "normal"], ["high", "high"], ["critical", "high"]
  ])("alvorlighetsgrad %s -> prioritet %s", (severity, priority) => {
    expect(mapIncidentToCandidate(incident({ severity })).priority).toBe(priority);
  });

  it("samme incident_id gir SAMME detection_key uansett hvor mange ganger den mappes (idempotent)", () => {
    const a = mapIncidentToCandidate(incident());
    const b = mapIncidentToCandidate(incident());
    expect(a.detection_key).toBe(b.detection_key);
  });
});

describe("C: runSituationSweepForAllTenants - infra-steget er FRIVILLIG (ingen incidents-dep = uendret oppførsel)", () => {
  const fakeEngine = () =>
    ({
      evaluateCandidate: async () => ({ situation: {}, newly_actionable: false }),
      resolveForResolvedSources: async () => 0,
      resolveStaleForDomain: async () => 0,
      deliverPendingInformNotifications: async () => ({ delivered: 0, reconciled_from_evidence: 0, pending: 0, evidence_mismatch: 0 }),
      autoActPending: async () => ({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 })
    }) as unknown as SituationEngine;
  const emptyOpenLoops: OpenLoopReader = { listOpenLoops: async () => [] };
  const identityFor = (tenantId: string) => ({
    person_id: "p", tenant_id: tenantId, memory_space_id: "business" as const, session_id: "s", device_id: "d", channel: "api" as const, auth_strength: "active" as const
  });
  const pool = { query: async () => ({ rows: [{ tenant_id: "t-1" }] }) } as unknown as pg.Pool;

  it("uten `incidents` i deps: listIncidents kalles ALDRI, ingen infra-feil kan oppstå", async () => {
    const results = await runSituationSweepForAllTenants(pool, {
      openLoops: emptyOpenLoops, engine: fakeEngine(), gateway: {} as ToolGateway, identityFor
    });
    expect(results["t-1"]!.errors).toEqual([]);
  });

  it("med `incidents` i deps: aktive incidents ingesteres, terminale utelates, resolveStaleForDomain kalles med KUN de aktives detection_key", async () => {
    const ingested: string[] = [];
    let resolvedWith: readonly string[] | undefined;
    const engine = {
      ...fakeEngine(),
      evaluateCandidate: async (_t: string, _m: string, candidate: { detection_key: string }) => {
        ingested.push(candidate.detection_key);
        return { situation: {}, newly_actionable: false };
      },
      resolveStaleForDomain: async (_t: string, _m: string, _domain: string, activeKeys: readonly string[]) => {
        resolvedWith = activeKeys;
        return 0;
      }
    } as unknown as SituationEngine;
    const incidents: IncidentReader = {
      listIncidents: async () => [
        incident({ incident_id: "inc-open", status: "open" }),
        incident({ incident_id: "inc-resolved", status: "resolved" }),
        incident({ incident_id: "inc-wontfix", status: "wont_fix" }),
        incident({ incident_id: "inc-repairing", status: "repair_in_progress" })
      ]
    };
    const results = await runSituationSweepForAllTenants(pool, {
      openLoops: emptyOpenLoops, incidents, engine, gateway: {} as ToolGateway, identityFor
    });
    expect(ingested).toEqual([
      `${INFRA_INCIDENT_DETECTION_KEY_PREFIX}inc-open`,
      `${INFRA_INCIDENT_DETECTION_KEY_PREFIX}inc-repairing`
    ]);
    expect(resolvedWith).toEqual([
      `${INFRA_INCIDENT_DETECTION_KEY_PREFIX}inc-open`,
      `${INFRA_INCIDENT_DETECTION_KEY_PREFIX}inc-repairing`
    ]);
    expect(results["t-1"]!.errors).toEqual([]);
    expect(results["t-1"]!.ingested).toBe(2);
  });

  it("en kastende listIncidents() hopper over BÅDE ingest og resolve for denne syklusen (aldri resolve mot en tom liste pga. feilet lesning)", async () => {
    let resolveStaleCalled = false;
    const engine = {
      ...fakeEngine(),
      resolveStaleForDomain: async () => {
        resolveStaleCalled = true;
        return 0;
      }
    } as unknown as SituationEngine;
    const incidents: IncidentReader = {
      listIncidents: async () => {
        throw new Error("db_unavailable");
      }
    };
    const results = await runSituationSweepForAllTenants(pool, {
      openLoops: emptyOpenLoops, incidents, engine, gateway: {} as ToolGateway, identityFor
    });
    expect(resolveStaleCalled).toBe(false);
    expect(results["t-1"]!.errors[0]).toMatch(/^infra:Error:db_unavailable/);
  });
});
