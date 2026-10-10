import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { BusinessOpenLoop, OpenLoopType } from "@jarvis/business";
import { domainForLoopType, mapOpenLoopToCandidate, OPEN_LOOP_DETECTION_KEY_PREFIX } from "../src/open-loop-bridge.ts";
import { renderAutonomyParameters } from "../src/service.ts";
import {
  assertSituationSweepHealthy, runSituationSweepForAllTenants, SituationSweepFailedError, unhealthySituationSweep,
  type OpenLoopReader, type SituationSweepResult
} from "../src/sweep.ts";
import type { SituationEngine } from "../src/service.ts";
import type { ToolGateway } from "@jarvis/tool-gateway";

/**
 * UA-10 P1 AKTIVERING (D-160): rene enhetsbevis (ingen database) for broen,
 * plassholder-rendringen og tenant-orkestreringen - de deterministiske
 * delene som IKKE trenger Postgres for å være bevist.
 */
function loop(overrides: Partial<BusinessOpenLoop> = {}): BusinessOpenLoop {
  return {
    open_loop_id: "ol-1", tenant_id: "t-1", memory_space_id: "business",
    company_id: null, contact_id: null, opportunity_id: null, lead_id: null, followup_id: null, activity_id: null,
    ticket_id: null, contract_id: null, campaign_id: null, payment_intent_id: null, finance_spend_record_id: null,
    finance_recurring_commitment_id: null, finance_procurement_item_id: null, product_item_id: null, operations_task_id: null,
    loop_type: "overdue_followup", detection_key: "followup:abc", detection_method: "deterministic", confidence: null, confidence_basis: null,
    reason: "Oppfølging er forfalt", next_action: null, canonical_uri: null, priority: "normal", status: "open",
    owner_person_id: "person-x", opened_at: "2026-09-16T00:00:00Z", due_at: null, resolved_at: null, resolution_reason: null, resolution_outcome: null,
    created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z",
    ...overrides
  };
}

describe("A: domene-kartleggingen er uttømmende og deterministisk", () => {
  const expectations: Record<OpenLoopType, string> = {
    overdue_followup: "pipeline", stalled_opportunity: "pipeline",
    support_ticket_needs_reply: "support", support_ticket_overdue: "support", support_ticket_unassigned: "support", support_ticket_waiting_internal: "support",
    contract_renewal_due: "deadlines", contract_termination_deadline: "deadlines", contract_obligation_due: "deadlines", contract_review_required: "deadlines",
    marketing_spend_anomaly: "spend", payment_intent_anomaly: "spend", payment_intent_reconciliation_mismatch: "spend",
    finance_spend_unexpected: "spend", finance_spend_amount_deviation: "spend", finance_recurring_charge_missing: "spend",
    finance_recurring_charge_duplicate: "spend", finance_spend_correction_conflict: "spend", bank_transaction_unmatched: "spend",
    bank_consent_attention: "spend", card_anomaly_attention: "spend", finance_procurement_missing: "spend",
    product_item_needs_triage: "product", product_item_high_priority_stalled: "product",
    operations_task_overdue: "operations", operations_task_escalation_needed: "operations",
    customer_churn_risk: "retention"
  };
  it("hver kjent loop-type får et eksplisitt domene", () => {
    for (const [type, domain] of Object.entries(expectations)) {
      expect(domainForLoopType(type as OpenLoopType)).toBe(domain);
    }
  });
  it("en ukjent type kastes eksplisitt - aldri et tilfeldig domene", () => {
    expect(() => domainForLoopType("something_new" as OpenLoopType)).toThrow(/unmapped_open_loop_type/);
  });
});

describe("B: mapOpenLoopToCandidate - identitet uten eier, kildepeker alltid satt, reason deterministisk", () => {
  it("prefikset detection_key, source_open_loop_id, prioritet/konfidens, ingen owner_person_id", () => {
    const c = mapOpenLoopToCandidate(loop({ confidence: 0.8, priority: "high", next_action: "Ring kunden" }));
    expect(c).toEqual({
      domain: "pipeline",
      detection_key: `${OPEN_LOOP_DETECTION_KEY_PREFIX}followup:abc`,
      priority: "high",
      confidence: 0.8,
      reason: "Oppfølging er forfalt Anbefalt neste handling: Ring kunden",
      source_open_loop_id: "ol-1"
    });
    expect("owner_person_id" in c).toBe(false);
  });
  it("uten konfidens utelates feltet (kontrakten er strict)", () => {
    const c = mapOpenLoopToCandidate(loop());
    expect("confidence" in c).toBe(false);
    expect(c.reason).toBe("Oppfølging er forfalt");
  });
});

describe("C: renderAutonomyParameters - kun immutable plassholdere, identisk ved retry, null ved manglende verdi", () => {
  const situation = { situation_id: "sit-1", source_open_loop_id: "ol-9", domain: "pipeline", detection_key: "open_loop:x" };
  it("erstatter rekursivt i strenger, arrays og objekter", () => {
    const rendered = renderAutonomyParameters(
      { a: "{{situation_id}}", nested: { b: ["{{domain}}", 1, true, null], c: "{{source_open_loop_id}}/{{detection_key}}" } },
      situation
    );
    expect(rendered).toEqual({ a: "sit-1", nested: { b: ["pipeline", 1, true, null], c: "ol-9/open_loop:x" } });
    expect(renderAutonomyParameters({ a: "{{situation_id}}" }, situation)).toEqual(renderAutonomyParameters({ a: "{{situation_id}}" }, situation));
  });
  it("manglende verdi (kildeløs situasjon) gir null, aldri en tom streng", () => {
    expect(renderAutonomyParameters({ a: "{{source_open_loop_id}}" }, { ...situation, source_open_loop_id: null })).toBeNull();
  });
});

describe("D: runSituationSweepForAllTenants - RLS-trygg tenant-katalog, feilisolasjon per tenant", () => {
  const fakeEngine = (fail: string) =>
    ({
      evaluateCandidate: async () => ({ situation: {}, newly_actionable: false }),
      resolveForResolvedSources: async () => 0,
      deliverPendingInformNotifications: async (tenantId: string) => {
        if (tenantId === fail) throw new Error("boom");
        return { delivered: 0, reconciled_from_evidence: 0, pending: 0, evidence_mismatch: 0, deferred: 0, paused: 0 };
      },
      autoActPending: async () => ({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 })
    }) as unknown as SituationEngine;
  const reader: OpenLoopReader = { listOpenLoops: async () => [] };
  const identityFor = (tenantId: string) => ({
    person_id: "p", tenant_id: tenantId, memory_space_id: "business" as const, session_id: "s", device_id: "d", channel: "api" as const, auth_strength: "active" as const
  });

  it("kaller jarvis_list_business_tenant_ids($1) med bounded limit - aldri rå spørring mot tenants - og isolerer én tenants feil", async () => {
    let capturedSql = "";
    const pool = {
      query: async (sql: string) => {
        capturedSql = sql;
        return { rows: [{ tenant_id: "t-ok" }, { tenant_id: "t-boom" }] };
      }
    } as unknown as pg.Pool;
    const results = await runSituationSweepForAllTenants(pool, {
      openLoops: reader, engine: fakeEngine("t-boom"), gateway: {} as ToolGateway, identityFor
    });
    expect(capturedSql).toMatch(/jarvis_list_business_tenant_ids/);
    expect(capturedSql).not.toMatch(/FROM\s+tenants\b/i);
    expect(results["t-ok"]!.errors).toEqual([]);
    expect(results["t-boom"]!.errors[0]).toMatch(/^deliver:Error:boom/);
    expect(results["t-boom"]!.auto_act).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
  });
});

describe("E: assertSituationSweepHealthy (review 5229219808 funn 3) - usunne resultater KASTER, sunne passerer stille", () => {
  const healthy = (): SituationSweepResult => ({
    ingested: 3, identity_conflicts: 0, resolved_from_source: 1,
    delivery: { delivered: 2, reconciled_from_evidence: 0, pending: 0, evidence_mismatch: 0, deferred: 0, paused: 0 },
    auto_act: { attempted: 1, succeeded: 0, denied: 1, skipped: 1 },
    errors: []
  });

  it("sunt resultat (inkl. ærlige denied/skipped auto-ACT-utfall) => null / ingen kast", () => {
    expect(unhealthySituationSweep("t-1", healthy())).toBeNull();
    expect(() => assertSituationSweepHealthy({ "t-1": healthy() })).not.toThrow();
  });

  it.each([
    ["errors[]", { errors: ["deliver:Error:boom"] }],
    ["identity_conflicts", { identity_conflicts: 1 }],
    ["delivery.evidence_mismatch", { delivery: { delivered: 0, reconciled_from_evidence: 0, pending: 0, evidence_mismatch: 1 } }],
    ["delivery.pending", { delivery: { delivered: 0, reconciled_from_evidence: 0, pending: 2, evidence_mismatch: 0, deferred: 0, paused: 0 } }]
  ] as const)("%s => SituationSweepFailedError som navngir tenanten", (_label, override) => {
    const results = { "t-ok": healthy(), "t-bad": { ...healthy(), ...override } as SituationSweepResult };
    let thrown: unknown;
    try {
      assertSituationSweepHealthy(results);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SituationSweepFailedError);
    const failure = thrown as SituationSweepFailedError;
    expect(failure.unhealthy.map((u) => u.tenant_id)).toEqual(["t-bad"]);
    expect(failure.message).toBe("situation_sweep_failed:t-bad");
  });
});
